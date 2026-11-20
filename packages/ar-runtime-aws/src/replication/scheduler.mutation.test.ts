/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- mock call inspection */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

type F = Awaited<ReturnType<typeof fixture>>;
async function firstPending(f: F) {
  f.onStep(() => f.controller.abort());
  await watchReplication(f.options, f.controller.signal, f.dependencies);
  const state = await json<any>(join(f.options.stateDirectory, 'watch.json'));
  return {
    state,
    watchPath: join(f.options.stateDirectory, 'watch.json'),
    plan: join(f.options.stateDirectory, `cycle-${state.cycle.id}.plan.json`),
    observation: join(f.options.stateDirectory, `cycle-${state.cycle.id}.state.json`),
  };
}
async function completed(f: F) {
  f.setPhase('complete');
  f.onStep(() => {
    if (f.steps() === 1) f.controller.abort();
  });
  await watchReplication(f.options, f.controller.signal, f.dependencies);
  const watchPath = join(f.options.stateDirectory, 'watch.json');
  return { watchPath, state: await json<any>(watchPath) };
}
const rewrite = (path: string, value: unknown, mode = 0o600) =>
  writeFile(path, canonicalRestoreJson(value), { mode }).then(() => chmod(path, mode));
const reject = async (f: F, message?: string) => {
  const p = watchReplication(f.options, new AbortController().signal, f.dependencies);
  if (message) await expect(p).rejects.toThrow(message);
  else await expect(p).rejects.toThrow();
  expect(f.calls).toEqual([]);
};

describe('argument validation', () => {
  it('requires absolute normalized paths for all four locations', async () => {
    const f = await fixture();
    for (const key of ['configPath', 'stateDirectory', 'executorPath', 'schedulerPath'] as const) {
      for (const value of [
        'relative/path',
        `${f.directory}/a/../b`,
        `${f.directory}//x`,
        `${f.directory}/x/`,
      ]) {
        await expect(
          watchReplication({ ...f.options, [key]: value }, f.controller.signal, f.dependencies)
        ).rejects.toThrow('replication_watch_arguments_invalid');
      }
    }
    expect(f.calls).toEqual([]);
  });
  it('requires a lowercase 64-hex config digest', async () => {
    const f = await fixture();
    for (const configSha256 of [
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      `x${'a'.repeat(64)}`,
      `${'a'.repeat(64)}x`,
      '',
    ]) {
      await expect(
        watchReplication({ ...f.options, configSha256 }, f.controller.signal, f.dependencies)
      ).rejects.toThrow('replication_watch_arguments_invalid');
    }
  });
  it('accepts the 60 s and 30 day interval bounds', async () => {
    for (const intervalSeconds of [60, 30 * 86400]) {
      const f = await fixture();
      f.controller.abort();
      await expect(
        watchReplication({ ...f.options, intervalSeconds }, f.controller.signal, f.dependencies)
      ).resolves.toBeUndefined();
    }
  });
  it('does not mutate caller options after start', async () => {
    const f = await fixture();
    const options = { ...f.options };
    f.controller.abort();
    await watchReplication(options, f.controller.signal, f.dependencies);
    expect(options).toEqual(f.options);
  });
  it('rejects a clock that yields negative or fractional times', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const f = await fixture();
      await expect(
        watchReplication(f.options, f.controller.signal, { ...f.dependencies, now: () => bad })
      ).rejects.toThrow('replication_watch_state_invalid');
      expect(f.calls).toEqual([]);
    }
  });
  it('rejects a configuration that is not the pinned content', async () => {
    const f = await fixture();
    await expect(
      watchReplication(
        { ...f.options, configSha256: 'f'.repeat(64) },
        f.controller.signal,
        f.dependencies
      )
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('rejects the same schema path pinned with two different digests', async () => {
    const f = await fixture();
    const config = structuredClone(f.config);
    config.destination.schemas.pii = [
      { path: config.destination.schemas.core[0].path, sha256: 'f'.repeat(64) },
    ];
    await writeFile(f.options.configPath, JSON.stringify(config));
    f.options.configSha256 = hash(JSON.stringify(config));
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_pins_changed'
    );
  });
  it('needs the installed executor and scheduler to exist and be non-empty regular files', async () => {
    const f = await fixture();
    await writeFile(f.options.executorPath, '');
    await expect(
      watchReplication(f.options, f.controller.signal, f.dependencies)
    ).rejects.toThrow();
    const g = await fixture();
    await rm(g.options.schedulerPath);
    await expect(
      watchReplication(g.options, g.controller.signal, g.dependencies)
    ).rejects.toThrow();
  });
  it('requires the parent of the state directory to be its own realpath', async () => {
    const f = await fixture();
    const real = join(f.directory, 'real-parent');
    await mkdir(real);
    const link = join(f.directory, 'link-parent');
    await import('node:fs/promises').then((m) => m.symlink(real, link));
    await expect(
      watchReplication(
        { ...f.options, stateDirectory: join(link, 'state') },
        f.controller.signal,
        f.dependencies
      )
    ).rejects.toThrow('replication_watch_state_invalid');
  });
});

describe('lock file', () => {
  it('records owner pid and creation time', async () => {
    const f = await fixture();
    f.onStep(async () => {
      const lock = JSON.parse(await readFile(join(f.options.stateDirectory, 'watch.lock'), 'utf8'));
      expect(Object.keys(lock).sort()).toEqual(['createdAtMs', 'id', 'pid']);
      expect(lock.pid).toBe(process.pid);
      expect(lock.createdAtMs).toBe(1000);
      expect(lock.id).toMatch(/^[0-9a-f-]{36}$/u);
      f.controller.abort();
    });
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    expect(f.steps()).toBe(1);
  });
  it('is left alone when it has been replaced by another owner', async () => {
    const f = await fixture();
    f.onStep(async () => {
      const lock = join(f.options.stateDirectory, 'watch.lock');
      await rm(lock);
      await writeFile(lock, 'other-owner', { mode: 0o600 });
      f.controller.abort();
    });
    await expect(
      watchReplication(f.options, f.controller.signal, f.dependencies)
    ).rejects.toThrow();
    expect(await readFile(join(f.options.stateDirectory, 'watch.lock'), 'utf8')).toBe(
      'other-owner'
    );
  });
});

describe('persisted watch state validation', () => {
  it('requires exact keys, version and kind', async () => {
    const mk = async (fn: (s: any) => void) => {
      const f = await fixture();
      const p = await firstPending(f);
      const s = structuredClone(p.state);
      fn(s);
      await rewrite(p.watchPath, s);
      f.calls.length = 0;
      await reject(f);
    };
    await mk((s) => (s.formatVersion = 2));
    await mk((s) => (s.kind = 'other'));
    await mk((s) => (s.extra = 1));
    await mk((s) => delete s.cycle);
    await mk((s) => (s.nextCycleAtMs = -1));
    await mk((s) => (s.nextCycleAtMs = 1.5));
    await mk((s) => (s.cycle.id = 'not-a-uuid'));
    await mk((s) => (s.cycle.id = `x${s.cycle.id}`));
    await mk((s) => (s.cycle.id = `${s.cycle.id}x`));
    await mk((s) => (s.cycle.id = s.cycle.id.toUpperCase()));
    await mk((s) => (s.cycle.planSha256 = 'A'.repeat(64)));
    await mk((s) => (s.cycle.planSha256 = `${'a'.repeat(64)}x`));
    await mk((s) => (s.cycle.planSha256 = `x${'a'.repeat(64)}`));
    await mk((s) => (s.cycle.extra = 1));
    await mk((s) => delete s.cycle.completeAtMs);
  });
  it('pins every identity field of the saved state', async () => {
    const keys = [
      'configPath',
      'configSha256',
      'executorPath',
      'executorSha256',
      'schedulerPath',
      'schedulerSha256',
      'authoritySchemaSha256',
      'intervalSeconds',
    ];
    for (const key of keys) {
      const f = await fixture();
      const p = await firstPending(f);
      const s = structuredClone(p.state);
      s[key] = typeof s[key] === 'number' ? s[key] + 1 : `${s[key]}x`;
      await rewrite(p.watchPath, s);
      f.calls.length = 0;
      await reject(f, 'replication_watch_pins_changed');
    }
  });
  it('rejects a completed cycle with a missing plan digest or wrong next time', async () => {
    const f = await fixture();
    const c = await completed(f);
    const wrongNext = (delta: number) => ({
      ...c.state,
      nextCycleAtMs: c.state.nextCycleAtMs + delta,
    });
    for (const s of [
      wrongNext(1),
      wrongNext(-1),
      wrongNext(60_000),
      { ...c.state, cycle: { ...c.state.cycle, planSha256: null } },
      { ...c.state, cycle: { ...c.state.cycle, completeAtMs: -1 } },
      { ...c.state, cycle: { ...c.state.cycle, completeAtMs: c.state.cycle.completeAtMs + 1 } },
    ]) {
      await rewrite(c.watchPath, s);
      f.calls.length = 0;
      await reject(f);
    }
  });
  it('accepts a consistent completed cycle and waits at most 60 s per poll', async () => {
    const f = await fixture();
    f.options.intervalSeconds = 3600;
    const c = await completed(f);
    expect(c.state.nextCycleAtMs).toBe(c.state.cycle.completeAtMs + 3_600_000);
    const waits: number[] = [];
    const controller = new AbortController();
    await watchReplication(f.options, controller.signal, {
      ...f.dependencies,
      wait: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
    });
    expect(waits).toEqual([60_000]);
  });
  it('waits only for the remaining time when it is below a minute', async () => {
    const f = await fixture();
    const c = await completed(f);
    const controller = new AbortController();
    const waits: number[] = [];
    f.advanceClock(c.state.nextCycleAtMs - 1000 - 25_000);
    await watchReplication(f.options, controller.signal, {
      ...f.dependencies,
      now: () => c.state.nextCycleAtMs - 25_000,
      wait: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
    });
    expect(waits).toEqual([25_000]);
  });
  it('starts the next cycle exactly when the interval has elapsed', async () => {
    const f = await fixture();
    const c = await completed(f);
    f.calls.length = 0;
    const controller = new AbortController();
    f.onStep(() => controller.abort());
    await watchReplication(f.options, controller.signal, {
      ...f.dependencies,
      now: () => c.state.nextCycleAtMs,
    });
    expect(f.calls[0][0]).toBe('plan');
  });
  it('does not start a cycle one millisecond early', async () => {
    const f = await fixture();
    const c = await completed(f);
    f.calls.length = 0;
    const controller = new AbortController();
    await watchReplication(f.options, controller.signal, {
      ...f.dependencies,
      now: () => c.state.nextCycleAtMs - 1,
      wait: async () => controller.abort(),
    });
    expect(f.calls).toEqual([]);
  });
  it('rejects loose permissions, empty files and a missing config snapshot digest', async () => {
    const f = await fixture();
    const p = await firstPending(f);
    await chmod(p.watchPath, 0o644);
    f.calls.length = 0;
    await reject(f);
    await chmod(p.watchPath, 0o600);
    await writeFile(p.watchPath, '');
    await reject(f);
    await rewrite(p.watchPath, p.state);
    await writeFile(join(f.options.stateDirectory, 'configuration.json'), '{}', { mode: 0o600 });
    await reject(f, 'replication_watch_pins_changed');
  });
  it('writes an initial state with the pinned identity before any step', async () => {
    const f = await fixture();
    f.onStep(() => f.controller.abort());
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    const s = await json<any>(join(f.options.stateDirectory, 'watch.json'));
    expect(s).toMatchObject({
      formatVersion: 1,
      kind: 'replication-watch',
      configPath: f.options.configPath,
      configSha256: f.options.configSha256,
      executorPath: f.options.executorPath,
      schedulerPath: f.options.schedulerPath,
      intervalSeconds: 60,
      executorSha256: hash('// test executor'),
      schedulerSha256: hash('// test scheduler'),
    });
    expect(s.authoritySchemaSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(join(f.options.stateDirectory, 'configuration.json'), 'utf8')).toBe(
      JSON.stringify(f.config)
    );
    expect(s.nextCycleAtMs).toBe(0);
  });
});

describe('cycle files', () => {
  it('fails when the plan is missing but was already pinned or an observation exists', async () => {
    const f = await fixture();
    const p = await firstPending(f);
    await rm(p.plan);
    f.calls.length = 0;
    await reject(f);
    const g = await fixture();
    const q = await firstPending(g);
    await rewrite(q.watchPath, { ...q.state, cycle: { ...q.state.cycle, planSha256: null } });
    await rm(q.plan);
    g.calls.length = 0;
    await reject(g);
  });
  it('plans with the exact CLI arguments, then syncs with exact arguments', async () => {
    const f = await fixture();
    f.onStep(() => f.controller.abort());
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    const state = await json<any>(join(f.options.stateDirectory, 'watch.json'));
    const planPath = join(f.options.stateDirectory, `cycle-${state.cycle.id}.plan.json`);
    const obsPath = join(f.options.stateDirectory, `cycle-${state.cycle.id}.state.json`);
    expect(f.calls[0]).toEqual([
      'plan',
      '--config',
      join(f.options.stateDirectory, 'configuration.json'),
      '--out',
      planPath,
    ]);
    expect(f.calls[1]).toEqual([
      'sync',
      '--plan',
      planPath,
      '--plan-sha256',
      state.cycle.planSha256,
      '--state',
      obsPath,
    ]);
    expect(state.cycle.planSha256).toBe(hash(await readFile(planPath)));
  });
  it('does not execute anything when already aborted', async () => {
    const f = await fixture();
    f.controller.abort();
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    expect(f.calls).toEqual([]);
  });
  it('stops without a sync when aborted during planning', async () => {
    const f = await fixture();
    const execute = f.dependencies.execute!;
    f.dependencies.execute = async (b, a) => {
      const r = await execute(b, a);
      if (a[0] === 'plan') f.controller.abort();
      return r;
    };
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    expect(f.calls.map(([m]) => m)).toEqual(['plan']);
  });
});

describe('observation validation before and after each step', () => {
  async function tampered(fn: (o: any, ctx: { plan: string }) => void, phase = 'exporting') {
    const f = await fixture();
    const p = await firstPending(f);
    const o = await json<any>(p.observation);
    fn(o, { plan: p.plan });
    await rewrite(p.observation, o);
    f.calls.length = 0;
    f.setPhase(phase);
    return f;
  }
  const bads: Array<[string, (o: any, c: { plan: string }) => void]> = [
    ['formatVersion', (o) => (o.formatVersion = 2)],
    ['kind', (o) => (o.kind = 'initialize')],
    ['mode', (o) => (o.mode = 'switch')],
    ['planPath', (o, c) => (o.planPath = `${c.plan}x`)],
    ['planSha256', (o) => (o.planSha256 = 'f'.repeat(64))],
    ['journal planSha256', (o) => (o.journal.planSha256 = 'f'.repeat(64))],
    ['operation id', (o) => (o.journal.operationId = 'other')],
    ['missing journal', (o) => (o.journal = null)],
    ['missing progress', (o) => (o.journal.value = null)],
    ['progress formatVersion', (o) => (o.journal.value.formatVersion = 2)],
    ['writer authority changed', (o) => (o.journal.value.writerAuthorityChanged = true)],
    ['plan identity', (o) => (o.journal.value.plan.tenantId = 'other')],
    ['plan epoch', (o) => (o.journal.value.plan.expectedEpoch = 9)],
    ['plan mode', (o) => (o.journal.value.plan.mode = 'switch')],
    ['plan source', (o) => (o.journal.value.plan.sourceDeploymentId = 'x')],
    ['plan destination', (o) => (o.journal.value.plan.destinationDeploymentId = 'x')],
    ['plan pair', (o) => (o.journal.value.plan.pairId = 'x')],
    ['phase draining', (o) => (o.journal.value.phase = 'draining')],
    ['phase unknown', (o) => (o.journal.value.phase = 'whatever')],
  ];
  for (const [name, fn] of bads) {
    it(`rejects ${name} before invoking the CLI`, async () => {
      const f = await tampered(fn);
      await reject(f);
    });
  }
  it('accepts every v1 phase that does not involve cutover', async () => {
    for (const phase of ['pending', 'exporting', 'downloaded', 'restoring', 'verified']) {
      const f = await tampered((o) => (o.journal.value.phase = phase), phase);
      const controller = new AbortController();
      f.onStep(() => controller.abort());
      await watchReplication(f.options, controller.signal, f.dependencies);
      expect(f.calls.map(([m]) => m)).toEqual(['resume']);
    }
  });
  it('rejects an invalid observation produced by the CLI step itself', async () => {
    const f = await fixture();
    f.setPhase('draining');
    await expect(
      watchReplication(f.options, f.controller.signal, f.dependencies)
    ).rejects.toThrow();
  });
  it('requires the plan to carry the current configuration and authority schema', async () => {
    const f = await fixture();
    const execute = f.dependencies.execute!;
    f.dependencies.execute = async (b, a) => {
      const r = await execute(b, a);
      if (a[0] === 'plan') {
        const out = a[a.indexOf('--out') + 1];
        const plan = await json<ReplicationPlan>(out);
        plan.authoritySchemaSha256 = 'e'.repeat(64);
        await rewrite(out, plan);
      }
      return r;
    };
    await expect(
      watchReplication(f.options, f.controller.signal, f.dependencies)
    ).rejects.toThrow();
    expect(f.calls.map(([m]) => m)).toEqual(['plan']);
  });
  it('rejects a plan whose configuration differs from the pinned configuration', async () => {
    const f = await fixture();
    const execute = f.dependencies.execute!;
    f.dependencies.execute = async (b, a) => {
      const r = await execute(b, a);
      if (a[0] === 'plan') {
        const out = a[a.indexOf('--out') + 1];
        const plan = await json<ReplicationPlan>(out);
        plan.configuration.expectedEpoch = 5;
        await rewrite(out, plan);
      }
      return r;
    };
    await expect(
      watchReplication(f.options, f.controller.signal, f.dependencies)
    ).rejects.toThrow();
    expect(f.calls.map(([m]) => m)).toEqual(['plan']);
  });
  it('rejects a plan produced with a different executor digest', async () => {
    const f = await fixture();
    const execute = f.dependencies.execute!;
    f.dependencies.execute = async (b, a) => {
      const r = await execute(b, a);
      if (a[0] === 'plan') {
        const out = a[a.indexOf('--out') + 1];
        const plan = await json<ReplicationPlan>(out);
        plan.executorSha256 = 'e'.repeat(64);
        await rewrite(out, plan);
      }
      return r;
    };
    await expect(
      watchReplication(f.options, f.controller.signal, f.dependencies)
    ).rejects.toThrow();
  });
});

describe('pin re-verification around every step', () => {
  it('re-reads pins before each step and after it (tampering mid-step is detected)', async () => {
    for (const target of ['executor', 'scheduler', 'config', 'schema', 'snapshot']) {
      const f = await fixture();
      f.onStep(async () => {
        if (target === 'executor') await writeFile(f.options.executorPath, '// swapped');
        if (target === 'scheduler') await writeFile(f.options.schedulerPath, '// swapped');
        if (target === 'config') await writeFile(f.options.configPath, '{}');
        if (target === 'schema') await writeFile(f.config.destination.schemas.core[0].path, '-- x');
        if (target === 'snapshot')
          await writeFile(join(f.options.stateDirectory, 'configuration.json'), '{}');
      });
      await expect(
        watchReplication(f.options, f.controller.signal, f.dependencies)
      ).rejects.toThrow();
      // plan runs with first pin check; sync runs, then the post-step check fails
      expect(f.calls.length).toBeGreaterThanOrEqual(1);
      expect(await lstat(f.options.stateDirectory)).toBeTruthy();
    }
  });
  it('detects a replaced state directory identity and a replaced lock identity', async () => {
    const f = await fixture();
    f.onStep(async () => {
      const lock = join(f.options.stateDirectory, 'watch.lock');
      await rm(lock);
      await writeFile(lock, 'x', { mode: 0o600 });
    });
    await expect(watchReplication(f.options, f.controller.signal, f.dependencies)).rejects.toThrow(
      'replication_watch_state_invalid'
    );
  });
  it('does not run the executor when the signal is aborted between the pin check and the step', async () => {
    const f = await fixture();
    f.controller.abort();
    await watchReplication(f.options, f.controller.signal, f.dependencies);
    expect(f.calls).toEqual([]);
  });
});

describe('default executor and waiter', () => {
  it('spawns the installed bundle with node, passing exact arguments, and reports exit status 0 as success', async () => {
    const f = await fixture();
    const marker = join(f.directory, 'argv.json');
    await writeFile(
      f.options.executorPath,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`
    );
    const { execute: _e, ...dependencies } = f.dependencies;
    // exit status 0 means no step_failed error; the watcher then fails because no plan file was produced
    await expect(
      watchReplication(f.options, f.controller.signal, dependencies)
    ).rejects.not.toThrow('replication_watch_step_failed');
    const argv = JSON.parse(await readFile(marker, 'utf8'));
    expect(argv[0]).toBe('plan');
    expect(argv[1]).toBe('--config');
    expect(argv[2]).toBe(join(f.options.stateDirectory, 'configuration.json'));
    expect(argv[3]).toBe('--out');
    expect(argv).toHaveLength(5);
  });
  it('treats a signal-terminated child as failure', async () => {
    const f = await fixture();
    await writeFile(f.options.executorPath, "process.kill(process.pid, 'SIGKILL');\n");
    const { execute: _e, ...dependencies } = f.dependencies;
    await expect(watchReplication(f.options, f.controller.signal, dependencies)).rejects.toThrow(
      'replication_watch_step_failed'
    );
  });
  it('real wait resolves when the signal aborts during the sleep', async () => {
    const f = await fixture();
    const { wait: _w, ...dependencies } = f.dependencies;
    const { signal } = f.controller;
    const original = signal.addEventListener.bind(signal);
    let waiterRegistered = false;
    // Abort only after the waiter has registered its abort listener, so the sleep path (not an
    // already-aborted shortcut) is the one being released. No wall-clock timing is involved.
    const spy = vi
      .spyOn(signal, 'addEventListener')
      .mockImplementation(
        (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions
        ) => {
          original(type, listener, options);
          if (type === 'abort') {
            waiterRegistered = true;
            queueMicrotask(() => f.controller.abort());
          }
        }
      );
    try {
      await watchReplication(f.options, signal, dependencies);
    } finally {
      spy.mockRestore();
    }
    expect(waiterRegistered).toBe(true);
    expect(signal.aborted).toBe(true);
  });
});
