import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchReplication, type ReplicationWatchDependencies } from './scheduler';
import { createReplicationPlan, type ReplicationConfiguration, type ReplicationPlan } from './plan';
import { canonicalRestoreJson } from '../import/restore-evidence';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-replication-watch-'));
  roots.push(directory);
  const schemaPath = join(directory, 'schema.sql');
  const sql = 'CREATE TABLE fixture(id text PRIMARY KEY);';
  await writeFile(schemaPath, sql, { mode: 0o600 });
  const pin = { path: schemaPath, sha256: hash(sql) };
  const config: ReplicationConfiguration = {
    formatVersion: 1,
    pair: {
      pairId: 'pair-a',
      tenantId: 'tenant-a',
      deployments: [
        { deploymentId: 'cf-a', provider: 'cloudflare' },
        { deploymentId: 'aws-a', provider: 'aws' },
      ],
      initialOwnerDeploymentId: 'cf-a',
      initialGenerationId: 'initial-a',
    },
    sourceDeploymentId: 'cf-a',
    destinationDeploymentId: 'aws-a',
    expectedEpoch: 1,
    maxSnapshotAgeMs: 3_600_000,
    authority: {
      endpoint: 'https://authority.example.test/replication/v1/rpc',
      credentialId: 'controller-a',
      secretEnv: 'AUTHORITY_SECRET',
      databaseUrlEnv: 'AUTHORITY_DB',
    },
    source: {
      kind: 'cloudflare',
      managementOrigin: 'https://source.example.test',
      grantId: 'grant-a',
      credentialEnv: 'EXPORT_TOKEN',
      passphraseEnv: 'BACKUP_PASSPHRASE',
      identity: {
        tenantId: 'tenant-a',
        issuer: 'https://issuer.example.test',
        productVersion: '0.4.2',
      },
    },
    destination: {
      kind: 'aws',
      sql: 'postgresql',
      environmentName: 'aws-a',
      masterUrlEnv: 'TARGET_MASTER_DB',
      credentialSeedEnv: 'GENERATION_SEED',
      databasePrefix: 'replica',
      coreBindingRefs: ['core-a'],
      piiBindingRefs: ['pii-a'],
      spEntityIds: ['https://sp.example.test/entity'],
      allocationScope: 'tenant_exclusive',
      flowHmacSecretEnv: 'FLOW_SECRET',
      lookupReadKeys: [{ generation: 1, secretEnv: 'LOOKUP_SECRET' }],
      ui: {
        components: { loginUi: false, adminUi: false },
        ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
      },
      authState: { backend: 'postgresql' },
      writerCredentialId: 'aws-writer',
      writerSecretEnv: 'AWS_WRITER_SECRET',
      artifacts: {
        region: 'ap-northeast-1',
        bucket: 'replication-example',
        bucketOwner: '123456789012',
        keyPrefix: 'generations',
        kmsKeyArn:
          'arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
        secretNamePrefix: 'authrim-replication',
      },
      schemas: { core: [pin], pii: [pin], state: [pin] },
    },
  };
  const configPath = join(directory, 'config.json');
  const executorPath = join(directory, 'replication-cli.mjs');
  const schedulerPath = join(directory, 'replication-scheduler.mjs');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(executorPath, '// test executor', { mode: 0o600 });
  await writeFile(schedulerPath, '// test scheduler', { mode: 0o600 });
  const options = {
    configPath,
    configSha256: hash(JSON.stringify(config)),
    stateDirectory: join(directory, 'state'),
    intervalSeconds: 60,
    executorPath,
    schedulerPath,
  };
  const controller = new AbortController();
  const calls: string[][] = [];
  let clock = 1000;
  let steps = 0;
  let phase = 'exporting';
  let onStep: (() => Promise<void> | void) | undefined;
  const execute: NonNullable<ReplicationWatchDependencies['execute']> = async (bundle, args) => {
    expect(bundle).toBe(executorPath);
    calls.push([...args]);
    const flags = Object.fromEntries(
      Array.from({ length: (args.length - 1) / 2 }, (_, index) => [
        args[index * 2 + 1],
        args[index * 2 + 2],
      ])
    );
    if (args[0] === 'plan') {
      const pinned = await json<ReplicationConfiguration>(flags['--config']);
      const plan = await createReplicationPlan(pinned, hash(await readFile(bundle)), clock);
      await writeFile(flags['--out'], canonicalRestoreJson(plan), { mode: 0o600, flag: 'wx' });
      return 0;
    }
    expect(['sync', 'resume']).toContain(args[0]);
    const plan = await json<ReplicationPlan>(flags['--plan']);
    expect(hash(await readFile(flags['--plan']))).toBe(flags['--plan-sha256']);
    steps++;
    await onStep?.();
    const operation = {
      operationId: `${plan.planId}:sync`,
      pairId: config.pair.pairId,
      tenantId: config.pair.tenantId,
      sourceDeploymentId: config.sourceDeploymentId,
      destinationDeploymentId: config.destinationDeploymentId,
      expectedEpoch: config.expectedEpoch,
      mode: 'sync',
    };
    await writeFile(
      flags['--state'],
      canonicalRestoreJson({
        formatVersion: 1,
        kind: 'operation',
        mode: 'sync',
        planPath: flags['--plan'],
        planSha256: flags['--plan-sha256'],
        observedAtMs: clock,
        journal: {
          operationId: operation.operationId,
          planSha256: flags['--plan-sha256'],
          revision: steps,
          value: {
            formatVersion: 1,
            phase,
            plan: operation,
            generationId: 'test-generation',
            attempt: 1,
            writerAuthorityChanged: false,
          },
        },
      }),
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
    config,
    options,
    controller,
    calls,
    dependencies,
    execute,
    steps: () => steps,
    setPhase: (value: string) => {
      phase = value;
    },
    onStep: (callback: () => Promise<void> | void) => {
      onStep = callback;
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

interface SavedWatch {
  cycle: { id: string; planSha256: string; completeAtMs: number | null };
  nextCycleAtMs: number;
}
async function saved(f: Awaited<ReturnType<typeof fixture>>) {
  return json<SavedWatch>(join(f.options.stateDirectory, 'watch.json'));
}
async function firstPending(f: Awaited<ReturnType<typeof fixture>>) {
  f.onStep(() => f.controller.abort());
  await watchReplication(f.options, f.controller.signal, f.dependencies);
  const state = await saved(f);
  return {
    state,
    plan: join(f.options.stateDirectory, `cycle-${state.cycle.id}.plan.json`),
    observation: join(f.options.stateDirectory, `cycle-${state.cycle.id}.state.json`),
  };
}

describe('explicit periodic replication watcher', () => {
  it('plans locally, polls one durable sync, waits after completion and never promotes', async () => {
    const f = await fixture();
    const network = vi.fn(() => {
      throw new Error('unexpected network');
    });
    vi.stubGlobal('fetch', network);
    f.onStep(() => {
      if (f.steps() === 2) f.setPhase('complete');
    });
    const waits: number[] = [];
    f.dependencies.wait = async (ms) => {
      waits.push(ms);
      f.advanceClock(ms);
      if (waits.length === 2) f.controller.abort();
    };
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync', 'resume']);
    expect(waits).toEqual([5000, 60000]);
    expect((await saved(f)).nextCycleAtMs).toBe(66000);
    expect((await saved(f)).cycle.completeAtMs).toBe(6000);
    expect(network).not.toHaveBeenCalled();
    expect((await lstat(f.options.stateDirectory)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(f.options.stateDirectory))
      expect((await lstat(join(f.options.stateDirectory, file))).mode & 0o777).toBe(0o600);
    expect(await readdir(f.options.stateDirectory)).not.toContain('watch.lock');
  });
  it('uses the actual bounded child runner and stops when its CLI reports failure', async () => {
    const f = await fixture();
    await writeFile(f.options.executorPath, 'process.exitCode = 2;\n');
    const { execute: _unused, ...dependencies } = f.dependencies;
    await expect(watchReplication(f.options, f.controller.signal, dependencies)).rejects.toThrow(
      'replication_watch_step_failed'
    );
    expect((await saved(f)).cycle.planSha256).toBeNull();
    expect(await readdir(f.options.stateDirectory)).not.toContain('watch.lock');
  });
  it('interrupts the real poll timer without invoking another CLI step', async () => {
    const f = await fixture();
    const { wait: _unused, ...dependencies } = f.dependencies;
    f.onStep(() => {
      setTimeout(() => f.controller.abort(), 20);
    });
    await watchReplication(f.options, f.controller.signal, dependencies);
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync']);
  });
  it('starts a unique next cycle only after the persisted interval', async () => {
    const f = await fixture();
    f.setPhase('complete');
    f.onStep(() => {
      if (f.steps() === 2) f.controller.abort();
    });
    f.dependencies.wait = async (ms) => {
      f.advanceClock(ms);
    };
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    const plans = f.calls.filter(([mode]) => mode === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[0][4]).not.toBe(plans[1][4]);
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync', 'plan', 'sync']);
  });
  it('restarts the same unfinished plan and observation with resume', async () => {
    const f = await fixture();
    const initial = await firstPending(f);
    const controller = new AbortController();
    f.calls.length = 0;
    f.onStep(() => {
      f.setPhase('complete');
      controller.abort();
    });
    await watchReplication(f.options, controller.signal, f.dependencies);
    expect(f.calls.map(([mode]) => mode)).toEqual(['resume']);
    expect(f.calls[0][2]).toBe(initial.plan);
    expect((await saved(f)).cycle.id).toBe(initial.state.cycle.id);
  });
  it.each(['config', 'executor', 'scheduler', 'interval', 'plan'])(
    'rejects changed %s pins without another step',
    async (kind) => {
      const f = await fixture();
      const initial = await firstPending(f);
      f.calls.length = 0;
      if (kind === 'config') await writeFile(f.options.configPath, '{}');
      if (kind === 'executor') await writeFile(f.options.executorPath, '// changed');
      if (kind === 'scheduler') await writeFile(f.options.schedulerPath, '// changed');
      if (kind === 'interval') f.options.intervalSeconds++;
      if (kind === 'plan') {
        const value = await json<ReplicationPlan>(initial.plan);
        value.createdAtMs++;
        await writeFile(initial.plan, canonicalRestoreJson(value));
      }
      await expect(
        watchReplication(f.options, new AbortController().signal, f.dependencies)
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it.each(['switch', 'failover', 'initialize'])(
    'rejects an altered observation mode %s BEFORE invoking resume',
    async (mode) => {
      const f = await fixture();
      const initial = await firstPending(f);
      f.calls.length = 0;
      const value = await json<Record<string, unknown>>(initial.observation);
      value.mode = mode;
      await writeFile(initial.observation, canonicalRestoreJson(value));
      await expect(
        watchReplication(f.options, new AbortController().signal, f.dependencies)
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it('stops on grant/owner/epoch/transport failure and retains unfinished state without retry', async () => {
    const f = await fixture();
    f.dependencies.execute = async (bundle, args) => {
      const result = await f.execute(bundle, args);
      return args[0] === 'plan' ? result : 1;
    };
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_step_failed'
    );
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync']);
    expect((await saved(f)).cycle.completeAtMs).toBeNull();
    expect(
      (await readdir(f.options.stateDirectory)).some((name) => name.endsWith('.state.json'))
    ).toBe(true);
    expect(await readdir(f.options.stateDirectory)).not.toContain('watch.lock');
  });
  it('graceful stop waits for the active step, retains its state and starts no additional poll', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const active = new Promise<void>((done) => {
      release = done;
    });
    f.onStep(async () => {
      entered();
      await active;
    });
    let finished = false;
    const watching = watchReplication(f.options, f.controller.signal, f.dependencies).then(() => {
      finished = true;
    });
    await inside;
    f.controller.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await watching;
    expect(f.calls.map(([mode]) => mode)).toEqual(['plan', 'sync']);
    expect((await saved(f)).cycle.completeAtMs).toBeNull();
  });
  it('refuses a simultaneous watcher and does not remove its lock', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const active = new Promise<void>((done) => {
      release = done;
    });
    f.onStep(async () => {
      entered();
      await active;
      f.controller.abort();
    });
    const watching = watchReplication(f.options, f.controller.signal, f.dependencies);
    await inside;
    const lock = await readFile(join(f.options.stateDirectory, 'watch.lock'), 'utf8');
    await expect(
      watchReplication(f.options, new AbortController().signal, f.dependencies)
    ).rejects.toThrow('replication_watch_locked');
    expect(await readFile(join(f.options.stateDirectory, 'watch.lock'), 'utf8')).toBe(lock);
    release();
    await watching;
  });
  it('does not infer death or clear a stale lock', async () => {
    const f = await fixture();
    await mkdir(f.options.stateDirectory, { mode: 0o700 });
    await writeFile(join(f.options.stateDirectory, 'watch.lock'), 'old-owner', { mode: 0o600 });
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_locked'
    );
    expect(await readFile(join(f.options.stateDirectory, 'watch.lock'), 'utf8')).toBe('old-owner');
    expect(f.calls).toEqual([]);
  });
  it.each(['public-directory', 'unowned-files', 'symlink-directory', 'symlink-executor'])(
    'rejects %s without overwriting or deleting files',
    async (kind) => {
      const f = await fixture();
      const sentinel = join(f.directory, 'sentinel');
      await writeFile(sentinel, 'keep');
      if (kind === 'public-directory') {
        await mkdir(f.options.stateDirectory);
        await chmod(f.options.stateDirectory, 0o755);
      }
      if (kind === 'unowned-files') {
        await mkdir(f.options.stateDirectory, { mode: 0o700 });
        await writeFile(join(f.options.stateDirectory, 'existing'), 'keep');
      }
      if (kind === 'symlink-directory') await symlink(f.directory, f.options.stateDirectory);
      if (kind === 'symlink-executor') {
        await rm(f.options.executorPath);
        await symlink(sentinel, f.options.executorPath);
      }
      await expect(
        watchReplication(f.options, f.controller.signal, f.dependencies)
      ).rejects.toThrow();
      expect(await readFile(sentinel, 'utf8')).toBe('keep');
      expect(f.calls).toEqual([]);
    }
  );
  it.each([0, 59, 60.5, Number.NaN, 2592001])(
    'rejects invalid interval %s before state creation',
    async (intervalSeconds) => {
      const f = await fixture();
      await expect(
        watchReplication({ ...f.options, intervalSeconds }, f.controller.signal, f.dependencies)
      ).rejects.toThrow('replication_watch_arguments_invalid');
      await expect(lstat(f.options.stateDirectory)).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );
  it('rejects failover approval in watch configuration', async () => {
    const f = await fixture();
    const value = {
      ...f.config,
      failover: {
        standbyStatePath: join(f.directory, 'state.json'),
        standbyStateSha256: 'a'.repeat(64),
        maximumSnapshotAgeMs: 1000,
      },
    };
    await writeFile(f.options.configPath, JSON.stringify(value));
    f.options.configSha256 = hash(JSON.stringify(value));
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_configuration_invalid'
    );
    expect(f.calls).toEqual([]);
  });
});
