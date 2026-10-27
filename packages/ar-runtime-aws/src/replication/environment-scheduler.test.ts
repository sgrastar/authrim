import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  environmentGenerationDigest,
  type EnvironmentGenerationRecord,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { environmentTestConfiguration } from './environment-test-fixture';
import * as initialization from './initialize';
import {
  createEnvironmentReplicationPlan,
  type EnvironmentReplicationPlan,
} from './environment-plan';
import type { EnvironmentOperationProgress } from './environment-coordinator';
import { watchReplication, type ReplicationWatchDependencies } from './scheduler';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;
interface Observation {
  formatVersion: 2;
  kind: 'operation';
  mode: string;
  planPath: string;
  planSha256: string;
  observedAtMs: number;
  journal: {
    operationId: string;
    planSha256: string;
    revision: number;
    value: EnvironmentOperationProgress;
  };
}
interface SavedWatch {
  cycle: { id: string; planSha256: string; completeAtMs: number | null };
  nextCycleAtMs: number;
}

async function observation(
  plan: EnvironmentReplicationPlan,
  planPath: string,
  planSha256: string,
  complete: boolean
): Promise<Observation> {
  const config = plan.configuration;
  const generationId = randomUUID();
  const children = config.tenants.map((tenant) => ({
    tenantId: tenant.pair.tenantId,
    restoreId: randomUUID(),
    attempt: 1,
    phase: complete ? ('verified' as const) : ('exporting' as const),
  }));
  const operation = {
    operationId: `${plan.planId}:sync`,
    pairId: config.pair.pairId,
    environmentId: config.pair.environmentId,
    sourceDeploymentId: config.sourceDeploymentId,
    destinationDeploymentId: config.destinationDeploymentId,
    expectedEpoch: config.expectedEpoch,
    mode: 'sync' as const,
  };
  const value: EnvironmentOperationProgress = {
    formatVersion: 2,
    plan: operation,
    phase: complete ? 'complete' : 'exporting',
    generationId,
    children,
    writerAuthorityChanged: false,
  };
  if (complete) {
    const body: Omit<EnvironmentGenerationRecord, 'digestSha256'> = {
      formatVersion: 1,
      pairId: config.pair.pairId,
      environmentId: config.pair.environmentId,
      sourceDeploymentId: config.sourceDeploymentId,
      deploymentId: config.destinationDeploymentId,
      generationId,
      epoch: 2,
      sourceEpoch: 1,
      sourceFenceRevision: 0,
      sourceOperationId: operation.operationId,
      sourcePlanSha256: planSha256,
      inventory: {
        formatVersion: 1,
        environmentId: config.pair.environmentId,
        sourceDeploymentId: config.sourceDeploymentId,
        sourceEpoch: 1,
        sourceFenceRevision: 0,
        capturedAtMs: 1000,
        sourceReceiptSha256: 'a'.repeat(64),
        complete: true,
        tenants: config.tenants.map((tenant) => ({
          tenantId: tenant.pair.tenantId,
          issuer: tenant.source.identity.issuer,
          lifecycle: 'active',
        })),
      },
      children: children.map((child, index) => ({
        tenantId: child.tenantId,
        restoreId: child.restoreId,
        sourceEpoch: 1,
        sourceFenceRevision: 0,
        capturedAtMs: 1000,
        verificationSha256: 'b'.repeat(64),
        location: {
          region: 'ap-northeast-1',
          issuerOrigin: config.tenants[index].source.identity.issuer,
          secretArn: `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:synthetic-${index}-ABCDEF`,
          secretVersionId: randomUUID(),
          bucket: 'replication-example',
          bucketOwner: '123456789012',
          manifestKey: `generation/${child.restoreId}/manifest.json`,
          manifestVersionId: `version-${index}`,
          manifestSha256: 'c'.repeat(64),
        },
      })),
    };
    value.generation = { ...body, digestSha256: await environmentGenerationDigest(body) };
  }
  return {
    formatVersion: 2,
    kind: 'operation',
    mode: 'sync',
    planPath,
    planSha256,
    observedAtMs: 1000,
    journal: { operationId: operation.operationId, planSha256, revision: 1, value },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-environment-watch-'));
  directories.push(directory);
  const schemaPath = join(directory, 'schema.sql');
  const schema = 'CREATE TABLE synthetic(id text PRIMARY KEY);';
  await writeFile(schemaPath, schema, { mode: 0o600 });
  const config = environmentTestConfiguration(schemaPath, hash(schema));
  const configPath = join(directory, 'config.json');
  const executorPath = join(directory, 'replication-cli.mjs');
  const schedulerPath = join(directory, 'replication-scheduler.mjs');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(executorPath, '// synthetic CLI', { mode: 0o600 });
  await writeFile(schedulerPath, '// synthetic scheduler', { mode: 0o600 });
  const options = {
    configPath,
    configSha256: hash(JSON.stringify(config)),
    stateDirectory: join(directory, 'state'),
    intervalSeconds: 60,
    executorPath,
    schedulerPath,
  };
  let clock = 1000;
  let complete = false;
  let onStep: (() => void | Promise<void>) | undefined;
  const calls: string[][] = [];
  const controller = new AbortController();
  const execute: NonNullable<ReplicationWatchDependencies['execute']> = async (bundle, args) => {
    calls.push([...args]);
    expect(bundle).toBe(executorPath);
    const flags = Object.fromEntries(
      Array.from({ length: (args.length - 1) / 2 }, (_, i) => [args[i * 2 + 1], args[i * 2 + 2]])
    );
    if (args[0] === 'plan') {
      const raw = await readJson<unknown>(flags['--config']);
      const plan = await createEnvironmentReplicationPlan(raw, hash(await readFile(bundle)), clock);
      await writeFile(flags['--out'], canonicalRestoreJson(plan), { mode: 0o600, flag: 'wx' });
      return 0;
    }
    expect(['sync', 'resume']).toContain(args[0]);
    const plan = await readJson<EnvironmentReplicationPlan>(flags['--plan']);
    expect(hash(await readFile(flags['--plan']))).toBe(flags['--plan-sha256']);
    await onStep?.();
    await writeFile(
      flags['--state'],
      canonicalRestoreJson(
        await observation(plan, flags['--plan'], flags['--plan-sha256'], complete)
      ),
      { mode: 0o600 }
    );
    return 0;
  };
  const dependencies: ReplicationWatchDependencies = {
    execute,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      controller.abort();
    },
  };
  return {
    directory,
    schemaPath,
    config,
    options,
    calls,
    controller,
    execute,
    dependencies,
    setComplete: (value: boolean) => {
      complete = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    onStep: (fn: () => void | Promise<void>) => {
      onStep = fn;
    },
  };
}
async function firstPending(f: Awaited<ReturnType<typeof fixture>>) {
  f.onStep(() => f.controller.abort());
  await watchReplication(f.options, f.controller.signal, f.dependencies);
  const saved = await readJson<SavedWatch>(join(f.options.stateDirectory, 'watch.json'));
  const planPath = join(f.options.stateDirectory, `cycle-${saved.cycle.id}.plan.json`);
  return {
    saved,
    planPath,
    observationPath: join(f.options.stateDirectory, `cycle-${saved.cycle.id}.state.json`),
  };
}

describe('all-tenant periodic replication watcher', () => {
  it('completes two-tenant cycles with local plans and only sync/resume commands', async () => {
    const f = await fixture();
    const network = vi.fn(() => {
      throw new Error('unexpected network');
    });
    vi.stubGlobal('fetch', network);
    let completed = 0;
    f.onStep(() => {
      if (f.calls.at(-1)?.[0] === 'resume') f.setComplete(true);
      if (f.calls.filter(([mode]) => mode === 'plan').length === 2) {
        f.setComplete(true);
        f.controller.abort();
      }
    });
    f.dependencies.wait = async (ms) => {
      f.advance(ms);
      if (ms >= 60000) completed++;
    };
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync', 'resume', 'plan', 'sync']);
    expect(completed).toBe(1);
    expect(network).not.toHaveBeenCalled();
    expect(new Set(f.calls.filter(([mode]) => mode === 'plan').map((args) => args[4])).size).toBe(
      2
    );
    expect(
      (await readJson<SavedWatch>(join(f.options.stateDirectory, 'watch.json'))).cycle.completeAtMs
    ).not.toBeNull();
  });
  it('resumes an unfinished two-tenant cycle using the exact original plan', async () => {
    const f = await fixture();
    const initial = await firstPending(f);
    f.calls.length = 0;
    const stop = new AbortController();
    f.onStep(() => {
      f.setComplete(true);
      stop.abort();
    });
    await watchReplication(f.options, stop.signal, f.dependencies);
    expect(f.calls.map(([mode]) => mode)).toEqual(['resume']);
    expect(f.calls[0][2]).toBe(initial.planPath);
    expect(
      (await readJson<SavedWatch>(join(f.options.stateDirectory, 'watch.json'))).cycle.id
    ).toBe(initial.saved.cycle.id);
  });
  it.each(['switch', 'failover', 'cancel', 'initialize'])(
    'refuses observation mode %s before any resume',
    async (mode) => {
      const f = await fixture();
      const initial = await firstPending(f);
      f.calls.length = 0;
      const value = await readJson<Observation>(initial.observationPath);
      value.mode = mode;
      await writeFile(initial.observationPath, canonicalRestoreJson(value));
      await expect(
        watchReplication(f.options, new AbortController().signal, f.dependencies)
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it.each(['configuration', 'executor', 'scheduler', 'schema', 'plan'])(
    'stops on changed %s pins before a child command',
    async (kind) => {
      const f = await fixture();
      const initial = await firstPending(f);
      f.calls.length = 0;
      const path =
        kind === 'configuration'
          ? f.options.configPath
          : kind === 'executor'
            ? f.options.executorPath
            : kind === 'scheduler'
              ? f.options.schedulerPath
              : kind === 'schema'
                ? f.schemaPath
                : initial.planPath;
      await writeFile(path, 'changed');
      await expect(
        watchReplication(f.options, new AbortController().signal, f.dependencies)
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it.each(['missing', 'extra', 'reordered', 'duplicate'])(
    'rejects %s tenant progress before resume while exporting',
    async (kind) => {
      const f = await fixture();
      const initial = await firstPending(f);
      f.calls.length = 0;
      const value = await readJson<Observation>(initial.observationPath);
      const children = value.journal.value.children;
      if (kind === 'missing') children.pop();
      if (kind === 'extra')
        children.push({ ...children[0], tenantId: 'tenant-c', restoreId: randomUUID() });
      if (kind === 'reordered') children.reverse();
      if (kind === 'duplicate') children[1] = { ...children[0] };
      await writeFile(initial.observationPath, canonicalRestoreJson(value));
      await expect(
        watchReplication(f.options, new AbortController().signal, f.dependencies)
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it.each([
    'partial-child',
    'missing-generation',
    'wrong-generation-tenant',
    'wrong-generation-plan',
    'wrong-generation-digest',
    'authority-changed',
  ])('rejects incoherent completion %s without recording success', async (kind) => {
    const f = await fixture();
    const initial = await firstPending(f);
    f.calls.length = 0;
    const plan = await readJson<EnvironmentReplicationPlan>(initial.planPath);
    const value = await observation(plan, initial.planPath, initial.saved.cycle.planSha256, true);
    const progress = value.journal.value;
    if (kind === 'partial-child') progress.children[1].phase = 'restoring';
    if (kind === 'missing-generation') delete progress.generation;
    if (kind === 'authority-changed') progress.writerAuthorityChanged = true;
    if (kind.startsWith('wrong-generation')) {
      const generation = progress.generation;
      if (!generation) throw new Error('fixture_generation_missing');
      if (kind === 'wrong-generation-tenant') generation.children[1].tenantId = 'tenant-c';
      if (kind === 'wrong-generation-plan') generation.sourcePlanSha256 = 'd'.repeat(64);
      if (kind === 'wrong-generation-digest') generation.digestSha256 = 'e'.repeat(64);
      else {
        const { digestSha256: _digest, ...body } = generation;
        generation.digestSha256 = await environmentGenerationDigest(body);
      }
    }
    await writeFile(initial.observationPath, canonicalRestoreJson(value));
    await expect(
      watchReplication(f.options, new AbortController().signal, f.dependencies)
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(
      (await readJson<SavedWatch>(join(f.options.stateDirectory, 'watch.json'))).cycle.completeAtMs
    ).toBeNull();
  });
  it('refuses a reviewed failover configuration even though its fields are otherwise valid', async () => {
    const f = await fixture();
    f.config.failover = {
      standbyStatePath: join(f.directory, 'standby.json'),
      standbyStateSha256: 'f'.repeat(64),
      maximumSnapshotAgeMs: 60000,
    };
    const text = JSON.stringify(f.config);
    await writeFile(f.options.configPath, text);
    f.options.configSha256 = hash(text);
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_configuration_invalid'
    );
    expect(f.calls).toEqual([]);
  });
  it('keeps the cycle unfinished and stops after one failed source/owner/grant step', async () => {
    const f = await fixture();
    f.dependencies.execute = async (bundle, args) => {
      const code = await f.execute(bundle, args);
      return args[0] === 'plan' ? code : 1;
    };
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_step_failed'
    );
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync']);
    expect(
      (await readJson<SavedWatch>(join(f.options.stateDirectory, 'watch.json'))).cycle.completeAtMs
    ).toBeNull();
  });
  it('rejects changed installed authority schemas instead of silently planning against new SQL', async () => {
    const f = await fixture();
    await firstPending(f);
    f.calls.length = 0;
    const original = await initialization.readReplicationAuthoritySchema();
    vi.spyOn(initialization, 'readReplicationAuthoritySchema').mockResolvedValue({
      ...original,
      digest: 'a'.repeat(64),
    });
    await expect(
      watchReplication(f.options, new AbortController().signal, f.dependencies)
    ).rejects.toThrow('replication_watch_pins_changed');
    expect(f.calls).toEqual([]);
  });
});
