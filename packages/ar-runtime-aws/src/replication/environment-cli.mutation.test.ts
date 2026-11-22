/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- mock call inspection */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { environmentTestConfiguration } from './environment-test-fixture';

const m = vi.hoisted(() => ({
  poolOptions: vi.fn(),
  poolEnd: vi.fn(),
  poolOn: vi.fn(),
  rpc: vi.fn(),
  createRpc: vi.fn(),
  readPinned: vi.fn(),
  parsePlan: vi.fn(),
  secret: vi.fn(),
  dbUrl: vi.fn(),
  initDb: vi.fn(),
  journalCtor: vi.fn(),
  withOperation: vi.fn(),
  sync: vi.fn(),
  failover: vi.fn(),
  inventory: vi.fn(),
  exportControl: vi.fn(),
  advanceChild: vi.fn(),
  download: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(o: unknown) {
      m.poolOptions(o);
    }
    on(...a: unknown[]) {
      m.poolOn(...a);
    }
    async end() {
      m.poolEnd();
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/deployment-replication/transport', () => ({
  createReplicationRpcClient: (...a: unknown[]) => {
    m.createRpc(...a);
    return m.rpc;
  },
}));
vi.mock('../import/restore-evidence', async (orig) => ({
  ...(await orig<typeof import('../import/restore-evidence')>()),
  readPinnedRestoreFile: (...a: unknown[]) => m.readPinned(...a),
}));
vi.mock('./plan', () => ({ replicationSecret: (...a: unknown[]) => m.secret(...a) }));
vi.mock('./authority-database-url', () => ({
  replicationAuthorityDatabaseUrl: (...a: unknown[]) => m.dbUrl(...a),
}));
vi.mock('./initialize', () => ({
  initializeReplicationAuthorityDatabase: (...a: unknown[]) => m.initDb(...a),
}));
vi.mock('./journal', () => ({
  ReplicationJournal: class {
    constructor(...a: unknown[]) {
      m.journalCtor(...a);
    }
    withOperation(...a: unknown[]) {
      return m.withOperation(...a);
    }
  },
}));
vi.mock('./environment-plan', () => ({
  parseEnvironmentReplicationPlan: (...a: unknown[]) => m.parsePlan(...a),
}));
vi.mock('./environment-coordinator', () => ({
  advanceEnvironmentReplicationOperation: (...a: unknown[]) => m.sync(...a),
  advanceEnvironmentFailover: (...a: unknown[]) => m.failover(...a),
}));
vi.mock('./environment-inventory-client', () => ({
  readEnvironmentReplicationInventory: (...a: unknown[]) => m.inventory(...a),
}));
vi.mock('./export-control-client', () => ({
  createReplicationExportControl: (...a: unknown[]) => m.exportControl(...a),
}));
vi.mock('./export-client', () => ({
  downloadReplicationExport: (...a: unknown[]) => m.download(...a),
}));
vi.mock('./restore-generation', () => ({
  restoreReplicationGeneration: (...a: unknown[]) => m.restore(...a),
}));

import {
  environmentAuthorityClient,
  environmentObservationSummary,
  readEnvironmentObservation,
  runEnvironmentReplicationCommand,
} from './environment-cli';

const SHA = 'a'.repeat(64);
let root: string;
let out: ReturnType<typeof vi.spyOn>;

function obs(over: Record<string, unknown> = {}) {
  return {
    formatVersion: 2,
    kind: 'operation',
    planPath: '/plan.json',
    planSha256: SHA,
    observedAtMs: 1000,
    mode: 'sync',
    journal: null,
    ...over,
  };
}
async function writeState(path: string, value: unknown, mode = 0o600) {
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'authrim-envcli-mut-'));
  Object.values(m).forEach((f) => f.mockReset());
  out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  m.secret.mockImplementation((_e: unknown, name: string) => `secret:${name}`);
  m.dbUrl.mockReturnValue('postgres://db');
  m.rpc.mockResolvedValue({ registered: true });
  m.initDb.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('readEnvironmentObservation', () => {
  it('returns null for a missing file and rethrows other stat errors', async () => {
    expect(await readEnvironmentObservation(join(root, 'none.json'))).toBeNull();
    await expect(readEnvironmentObservation(join(root, 'f', 'x\0y'))).rejects.toBeTruthy();
    const file = join(root, 'file');
    await writeFile(file, 'x');
    await expect(readEnvironmentObservation(join(file, 'child'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
  it('returns the parsed value for a valid file', async () => {
    const p = join(root, 's.json');
    await writeState(p, obs({ observedAtMs: 0 }));
    expect(await readEnvironmentObservation(p)).toEqual(obs({ observedAtMs: 0 }));
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ['formatVersion', { formatVersion: 1 }],
    ['kind', { kind: 'x' }],
    ['mode', { mode: 'resume' }],
    ['float time', { observedAtMs: 1.5 }],
    ['negative time', { observedAtMs: -1 }],
    ['short sha', { planSha256: 'a'.repeat(63) }],
    ['sha prefix', { planSha256: `z${SHA}` }],
    ['sha suffix', { planSha256: `${SHA}z` }],
    ['uppercase sha', { planSha256: 'A'.repeat(64) }],
    ['relative planPath', { planPath: 'p.json' }],
  ];
  for (const [name, over] of bad) {
    it(`rejects invalid ${name}`, async () => {
      const p = join(root, 's.json');
      await writeState(p, obs(over));
      await expect(readEnvironmentObservation(p)).rejects.toThrow(
        'environment_replication_cli_invalid'
      );
    });
  }
  it('rejects null content', async () => {
    const p = join(root, 's.json');
    await writeState(p, null);
    await expect(readEnvironmentObservation(p)).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
  });
  it('rejects loose permissions, directories, symlinks and relative paths', async () => {
    const p = join(root, 's.json');
    for (const mode of [0o640, 0o604, 0o660, 0o606]) {
      await rm(p, { force: true });
      await writeState(p, obs(), mode);
      await expect(readEnvironmentObservation(p)).rejects.toThrow(
        'environment_replication_cli_invalid'
      );
    }
    await expect(readEnvironmentObservation(root)).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
    const real = join(root, 'real.json');
    await writeState(real, obs());
    const link = join(root, 'link.json');
    await symlink(real, link);
    await expect(readEnvironmentObservation(link)).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
  });
  it('rejects a path that is not its own realpath', async () => {
    const dir = join(root, 'd');
    await mkdir(dir);
    const link = join(root, 'dl');
    await symlink(dir, link);
    await writeState(join(dir, 's.json'), obs());
    await expect(readEnvironmentObservation(join(link, 's.json'))).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
  });
  it('accepts the 8 MiB boundary but rejects larger files', async () => {
    const p = join(root, 's.json');
    const base = JSON.stringify(obs());
    const pad = (n: number) => base + ' '.repeat(n - base.length);
    await writeFile(p, pad(8 * 1024 * 1024), { mode: 0o600 });
    await chmod(p, 0o600);
    expect((await readEnvironmentObservation(p))?.planSha256).toBe(SHA);
    await writeFile(p, pad(8 * 1024 * 1024 + 1), { mode: 0o600 });
    await expect(readEnvironmentObservation(p)).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
  });
});

describe('environmentObservationSummary', () => {
  it('summarises initialize and journal-less operations', () => {
    expect(
      environmentObservationSummary(obs({ kind: 'initialize', mode: 'initialize' }) as any)
    ).toEqual({
      status: 'initialized',
      scope: 'environment',
      mode: 'initialize',
      observedAtMs: 1000,
      live: false,
      planSha256: SHA,
      trafficSwitched: false,
    });
    expect(environmentObservationSummary(obs() as any)).toEqual({
      status: 'unknown',
      scope: 'environment',
      mode: 'sync',
      observedAtMs: 1000,
      live: false,
      planSha256: SHA,
      trafficSwitched: false,
    });
  });
  it('includes progress counters', () => {
    const value = obs({
      journal: {
        value: {
          phase: 'restoring',
          plan: { operationId: 'op', environmentId: 'env' },
          generationId: 'g',
          writerAuthorityChanged: true,
          children: [{ phase: 'verified' }, { phase: 'pending' }, { phase: 'verified' }],
        },
      },
    });
    expect(environmentObservationSummary(value as any)).toEqual({
      status: 'restoring',
      scope: 'environment',
      mode: 'sync',
      observedAtMs: 1000,
      live: false,
      planSha256: SHA,
      trafficSwitched: false,
      operationId: 'op',
      environmentId: 'env',
      generationId: 'g',
      tenants: 3,
      verifiedTenants: 2,
      writerAuthorityChanged: true,
    });
  });
});

describe('environmentAuthorityClient', () => {
  it('maps each method to its RPC action and payload', async () => {
    const rpc = vi.fn(async () => 'R');
    const a = environmentAuthorityClient(rpc) as any;
    expect(await a.initialize({ p: 1 })).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentInitialize', { p: 1 });
    expect(await a.get('pair', 'env')).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentGet', {
      pairId: 'pair',
      environmentId: 'env',
    });
    expect(await a.beginDrain({ p: 2 })).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentBeginDrain', { p: 2 });
    expect(await a.getOperation({ p: 3 })).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentGetOperation', { p: 3 });
    expect(await a.getGeneration({ p: 4 })).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentGetGeneration', { p: 4 });
    expect(await a.verifyGeneration({ p: 5 }, 'proof')).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentVerifyGeneration', { p: 5, proof: 'proof' });
    expect(await a.promote({ p: 6 })).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentPromote', { p: 6 });
    expect(await a.cancelDrain({ p: 7 })).toBe('R');
    expect(rpc).toHaveBeenLastCalledWith('environmentCancelDrain', { p: 7 });
    await expect(a.enter()).rejects.toThrow('controller_cannot_enter');
    await expect(a.complete()).rejects.toThrow('controller_cannot_complete');
    await expect(a.getServingGeneration()).rejects.toThrow('controller_cannot_serve');
  });
  it('requires registered === true for registerGeneration', async () => {
    const rpc = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ registered: true }));
    const a = environmentAuthorityClient(rpc) as any;
    await expect(a.registerGeneration({ g: 1 })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenLastCalledWith('environmentRegisterGeneration', { g: 1 });
    for (const bad of [{ registered: false }, {}, null, undefined, { registered: 'true' }]) {
      rpc.mockResolvedValue(bad);
      await expect(a.registerGeneration({ g: 1 })).rejects.toThrow(
        'environment_replication_cli_invalid'
      );
    }
  });
});

type RunInput = {
  pairId: string;
  operationId: string;
  planSha256: string;
  initial: any;
  run: (j: { current: () => any; save: (v: any) => Promise<any> }) => Promise<void>;
};

function setup(configOver: (c: any) => void = () => {}) {
  const config: any = environmentTestConfiguration(join(root, 'schema.sql'), 'a'.repeat(64));
  config.inventory = { credentialEnv: 'INV_CRED' };
  configOver(config);
  m.parsePlan.mockImplementation(() => ({
    planId: 'plan-1',
    authoritySchemaSha256: 'schema-sha',
    configuration: config,
  }));
  let journal: any;
  const saved: any[] = [];
  const initialOverride: { value?: any } = {};
  m.withOperation.mockImplementation(async (input: RunInput) => {
    journal = { value: initialOverride.value ?? input.initial };
    await input.run({
      current: () => journal,
      save: async (v) => {
        saved.push(v);
        journal = { value: v };
        return journal;
      },
    });
  });
  return { config, saved, initialOverride };
}
function input(command: string, over: Record<string, unknown> = {}) {
  return {
    command,
    planPath: join(root, 'plan.json'),
    planSha256: SHA,
    statePath: join(root, 'state.json'),
    rawPlan: 'RAW',
    executorSha256: 'exec-sha',
    environment: { E: '1' },
    ...over,
  };
}

describe('runEnvironmentReplicationCommand', () => {
  it('parses the plan with raw bytes and executor digest', async () => {
    setup();
    m.sync.mockResolvedValue(undefined);
    await runEnvironmentReplicationCommand(input('sync'));
    expect(m.parsePlan).toHaveBeenCalledWith('RAW', 'exec-sha');
  });

  it('initializes the database and authority', async () => {
    const { config } = setup((c) => {
      c.authority.bootstrap = { databaseUrlEnv: 'O', serviceRole: 'svc', journalRole: 'jrn' };
    });
    await runEnvironmentReplicationCommand(input('initialize'));
    expect(m.dbUrl).toHaveBeenCalledWith(config.authority, 'initialize', expect.any(Function));
    expect(m.poolOptions).toHaveBeenCalledWith({
      connectionString: 'postgres://db',
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30_000,
    });
    expect(m.poolOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(m.poolOn.mock.calls[0][1]()).toBeUndefined();
    expect(m.createRpc).toHaveBeenCalledWith({
      endpoint: config.authority.endpoint,
      credentialId: config.authority.credentialId,
      secret: 'secret:AUTHORITY_SECRET',
    });
    expect(m.initDb).toHaveBeenCalledWith(expect.anything(), 'schema-sha', {
      serviceRole: 'svc',
      journalRole: 'jrn',
    });
    expect(m.rpc).toHaveBeenCalledWith('environmentInitialize', config.pair);
    const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    expect(disk).toMatchObject({
      formatVersion: 2,
      kind: 'initialize',
      mode: 'initialize',
      planPath: join(root, 'plan.json'),
      planSha256: SHA,
      journal: null,
    });
    expect(Number.isSafeInteger(disk.observedAtMs)).toBe(true);
    expect(JSON.parse(out.mock.calls[0][0] as string).status).toBe('initialized');
    expect(out.mock.calls[0][0]).toMatch(/\n$/);
    expect(m.poolEnd).toHaveBeenCalledTimes(1);
    expect(m.withOperation).not.toHaveBeenCalled();
  });
  it('passes undefined bootstrap when not configured', async () => {
    setup((c) => {
      c.authority.bootstrap = undefined;
    });
    await runEnvironmentReplicationCommand(input('initialize'));
    expect(m.initDb).toHaveBeenCalledWith(expect.anything(), 'schema-sha', undefined);
  });
  it('closes the pool when initialization throws', async () => {
    setup();
    m.initDb.mockRejectedValue(new Error('x'));
    await expect(runEnvironmentReplicationCommand(input('initialize'))).rejects.toThrow('x');
    expect(m.poolEnd).toHaveBeenCalledTimes(1);
  });
  it('the secret closure forwards the environment', async () => {
    setup();
    await runEnvironmentReplicationCommand(input('initialize'));
    m.secret.mockClear();
    const resolver = m.dbUrl.mock.calls[0][2];
    resolver('N');
    expect(m.secret).toHaveBeenCalledWith({ E: '1' }, 'N');
  });

  it('updates an existing observation for the same plan', async () => {
    setup();
    await runEnvironmentReplicationCommand(input('initialize'));
    const first = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    await runEnvironmentReplicationCommand(input('initialize'));
    const second = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    expect(second.observedAtMs).toBeGreaterThanOrEqual(first.observedAtMs);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter((n) => n.startsWith('.environment-replication-'))).toEqual(
      []
    );
  });

  const mismatches: Array<[string, Record<string, unknown>]> = [
    ['plan path', { planPath: '/other.json' }],
    ['plan digest', { planSha256: 'b'.repeat(64) }],
    ['mode', { mode: 'switch' }],
  ];
  for (const [name, over] of mismatches) {
    it(`rejects prior state with different ${name} before touching the pool`, async () => {
      setup();
      await writeState(
        join(root, 'state.json'),
        obs({ planPath: join(root, 'plan.json'), ...over })
      );
      await expect(runEnvironmentReplicationCommand(input('sync'))).rejects.toThrow(
        'environment_replication_cli_invalid'
      );
      expect(m.poolOptions).not.toHaveBeenCalled();
    });
  }

  it('resume without prior state is invalid; with prior it reuses the mode', async () => {
    setup();
    await expect(runEnvironmentReplicationCommand(input('resume'))).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
    await writeState(
      join(root, 'state.json'),
      obs({ planPath: join(root, 'plan.json'), kind: 'initialize', mode: 'initialize' })
    );
    await runEnvironmentReplicationCommand(input('resume'));
    expect(m.dbUrl.mock.calls[0][1]).toBe('initialize');
  });
  it('rejects unknown commands', async () => {
    setup();
    await expect(runEnvironmentReplicationCommand(input('bogus'))).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
    expect(m.poolOptions).not.toHaveBeenCalled();
  });
  it('cancel on a sync observation is invalid (only switch/failover)', async () => {
    setup();
    await writeState(
      join(root, 'state.json'),
      obs({ planPath: join(root, 'plan.json'), mode: 'sync' })
    );
    await expect(runEnvironmentReplicationCommand(input('cancel'))).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
    expect(m.poolOptions).not.toHaveBeenCalled();
  });
  it('cancel without prior state is invalid', async () => {
    setup();
    await expect(runEnvironmentReplicationCommand(input('cancel'))).rejects.toThrow(
      'environment_replication_cli_invalid'
    );
  });

  describe('sync / switch', () => {
    it('builds the expected plan and initial progress', async () => {
      const { config } = setup();
      await runEnvironmentReplicationCommand(input('sync'));
      expect(m.journalCtor.mock.calls[0][1]).toBe('environment');
      const arg = m.withOperation.mock.calls[0][0] as RunInput;
      expect(arg.pairId).toBe('pair-a');
      expect(arg.operationId).toBe('plan-1:sync');
      expect(arg.planSha256).toBe(SHA);
      expect(arg.initial).toMatchObject({
        formatVersion: 2,
        phase: 'pending',
        children: [],
        writerAuthorityChanged: false,
        plan: {
          operationId: 'plan-1:sync',
          pairId: config.pair.pairId,
          environmentId: config.pair.environmentId,
          sourceDeploymentId: config.sourceDeploymentId,
          destinationDeploymentId: config.destinationDeploymentId,
          expectedEpoch: config.expectedEpoch,
          mode: 'sync',
        },
      });
      expect(arg.initial.generationId.length).toBeGreaterThan(30);
      const call = m.sync.mock.calls[0][0];
      expect(call.maximumSnapshotAgeMs).toBe(config.maxSnapshotAgeMs);
      expect(call.expectedPlan).toEqual(arg.initial.plan);
      expect(m.failover).not.toHaveBeenCalled();
      const last = JSON.parse(out.mock.calls.at(-1)![0] as string);
      expect(last.operationId).toBe('plan-1:sync');
      expect(m.poolEnd).toHaveBeenCalledTimes(1);
    });
    it('uses switch mode for the operation id', async () => {
      setup();
      await runEnvironmentReplicationCommand(input('switch'));
      expect((m.withOperation.mock.calls[0][0] as RunInput).operationId).toBe('plan-1:switch');
    });
    it('checkpoint saves and observes', async () => {
      setup();
      m.sync.mockImplementation(async (a: any) => {
        expect(a.checkpoint.current()).toBeTruthy();
        const r = await a.checkpoint.save({
          phase: 'x',
          plan: { operationId: 'o', environmentId: 'e' },
          generationId: 'g',
          writerAuthorityChanged: false,
          children: [],
        });
        expect(r.value.phase).toBe('x');
      });
      await runEnvironmentReplicationCommand(input('sync'));
      const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
      expect(disk.journal.value.phase).toBe('x');
    });
    it('observes the initial journal before advancing', async () => {
      setup();
      m.sync.mockImplementation(async () => {
        const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
        expect(disk.journal.value.phase).toBe('pending');
      });
      await runEnvironmentReplicationCommand(input('sync'));
    });
    it('source.inventory reads with credential and minimum observation time', async () => {
      const { config } = setup();
      let source: any;
      m.sync.mockImplementation(async (a: any) => {
        source = a.source;
      });
      m.inventory.mockResolvedValue('INV');
      await runEnvironmentReplicationCommand(input('sync'));
      expect(await source.inventory(99)).toBe('INV');
      expect(m.inventory).toHaveBeenCalledWith({
        configuration: config,
        credential: 'secret:INV_CRED',
        minimumObservedAtMs: 99,
      });
    });
    it('source.advance selects the tenant child and forwards the idempotency key', async () => {
      const { config } = setup();
      let source: any;
      m.sync.mockImplementation(async (a: any) => {
        source = a.source;
      });
      const advance = vi.fn(async () => 'ADV');
      m.exportControl.mockReturnValue({ advance });
      await runEnvironmentReplicationCommand(input('sync'));
      const child = config.tenants[1];
      expect(await source.advance('tenant-b', 'key-1')).toBe('ADV');
      expect(m.exportControl).toHaveBeenCalledWith({
        origin: child.source.managementOrigin,
        grantId: child.source.grantId,
        tenantId: 'tenant-b',
        credential: `secret:${child.source.credentialEnv}`,
        passphrase: `secret:${child.source.passphraseEnv}`,
      });
      expect(advance).toHaveBeenCalledWith('key-1');
      expect(() => source.advance('nope', 'k')).toThrow('environment_replication_cli_invalid');
    });
    it('source.download is bound to the tenant and a fresh output directory', async () => {
      const { config } = setup();
      let source: any;
      m.sync.mockImplementation(async (a: any) => {
        source = a.source;
      });
      m.download.mockResolvedValue('DL');
      await runEnvironmentReplicationCommand(input('sync'));
      expect(await source.download('tenant-a', 'op', 7)).toBe('DL');
      const child = config.tenants[0];
      const d = m.download.mock.calls[0][0];
      expect(d).toMatchObject({
        managementOrigin: child.source.managementOrigin,
        grantId: child.source.grantId,
        operationId: 'op',
        authorization: `Bearer secret:${child.source.credentialEnv}`,
        expectedSource: child.source.identity,
        maxSnapshotAgeMs: config.maxSnapshotAgeMs,
        minimumBoundaryUnixMs: 7,
      });
      expect(d.outputDirectory).toMatch(
        new RegExp(
          `^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/environment-export-[0-9a-f-]{36}$`
        )
      );
      await source.download('tenant-a', 'op', 7);
      expect(m.download.mock.calls[1][0].outputDirectory).not.toBe(d.outputDirectory);
      expect(() => source.download('nope', 'op', 7)).toThrow('environment_replication_cli_invalid');
    });
    it('target.restore binds the environment writer to the destination', async () => {
      const { config } = setup();
      let target: any;
      m.sync.mockImplementation(async (a: any) => {
        target = a.target;
      });
      m.restore.mockResolvedValue('RESTORED');
      await runEnvironmentReplicationCommand(input('sync'));
      const value = {
        tenantId: 'tenant-b',
        snapshot: 'snap',
        restoreId: 'rid',
        servingEpoch: 5,
        generationId: 'gid',
      };
      expect(await target.restore(value)).toBe('RESTORED');
      const child = config.tenants[1];
      expect(m.restore).toHaveBeenCalledWith({
        configuration: child,
        environment: { E: '1' },
        snapshot: 'snap',
        generationId: 'rid',
        servingEpoch: 5,
        environmentWriter: {
          version: 2,
          endpoint: config.authority.endpoint,
          credentialId: child.destination.writerCredentialId,
          pairId: config.pair.pairId,
          environmentId: config.pair.environmentId,
          deploymentId: config.destinationDeploymentId,
          generationId: 'gid',
          epoch: 5,
          tenantId: 'tenant-b',
          restoreId: 'rid',
        },
      });
      expect(() => target.restore({ ...value, tenantId: 'zzz' })).toThrow(
        'environment_replication_cli_invalid'
      );
    });
  });

  describe('cancel', () => {
    async function runCancel(before: any, cutoverState: string, mode = 'switch') {
      const { saved, initialOverride } = setup();
      initialOverride.value = before;
      await writeState(join(root, 'state.json'), obs({ planPath: join(root, 'plan.json'), mode }));
      m.rpc.mockResolvedValue({ state: cutoverState, id: 'c' });
      return { saved };
    }
    it('cancels an outstanding drain and records the cancelled phase', async () => {
      const before = {
        phase: 'draining',
        writerAuthorityChanged: false,
        cutover: { state: 'draining' },
        plan: { operationId: 'o', environmentId: 'e' },
        generationId: 'g',
        children: [],
      };
      const { saved } = await runCancel(before, 'cancelled');
      await runEnvironmentReplicationCommand(input('cancel'));
      expect(m.rpc).toHaveBeenCalledWith('environmentCancelDrain', {
        pairId: 'pair-a',
        environmentId: 'env-a',
        operationId: 'plan-1:switch',
      });
      expect(saved).toEqual([
        {
          ...before,
          cutover: { state: 'cancelled', id: 'c' },
          phase: 'cancelled',
          writerAuthorityChanged: false,
        },
      ]);
      expect(m.sync).not.toHaveBeenCalled();
      expect(m.failover).not.toHaveBeenCalled();
      expect(JSON.parse(out.mock.calls.at(-1)![0] as string).status).toBe('cancelled');
    });
    it('works for failover mode too', async () => {
      const before = {
        phase: 'draining',
        writerAuthorityChanged: false,
        cutover: { state: 'draining' },
        plan: { operationId: 'o', environmentId: 'e' },
        generationId: 'g',
        children: [],
      };
      const { saved } = await runCancel(before, 'cancelled', 'failover');
      await runEnvironmentReplicationCommand(input('cancel'));
      expect(saved).toHaveLength(1);
      expect(m.rpc.mock.calls[0][1].operationId).toBe('plan-1:failover');
    });
    const refusals: Array<[string, any, string]> = [
      [
        'writer authority already changed',
        { phase: 'draining', writerAuthorityChanged: true, cutover: {} },
        'cancelled',
      ],
      [
        'complete phase',
        { phase: 'complete', writerAuthorityChanged: false, cutover: {} },
        'cancelled',
      ],
      ['no cutover', { phase: 'draining', writerAuthorityChanged: false }, 'cancelled'],
      [
        'authority did not cancel',
        { phase: 'draining', writerAuthorityChanged: false, cutover: {} },
        'draining',
      ],
    ];
    for (const [name, before, st] of refusals) {
      it(`refuses when ${name}`, async () => {
        const { saved } = await runCancel({ ...before, plan: {}, children: [] }, st);
        await expect(runEnvironmentReplicationCommand(input('cancel'))).rejects.toThrow(
          'environment_replication_cli_invalid'
        );
        expect(saved).toEqual([]);
        expect(m.poolEnd).toHaveBeenCalledTimes(1);
      });
    }
    it('does not call the authority when preconditions fail', async () => {
      await runCancel(
        { phase: 'complete', writerAuthorityChanged: false, cutover: {}, plan: {}, children: [] },
        'cancelled'
      );
      await expect(runEnvironmentReplicationCommand(input('cancel'))).rejects.toThrow();
      expect(m.rpc).not.toHaveBeenCalled();
    });
  });

  describe('failover', () => {
    const approval = {
      standbyStatePath: '/standby.json',
      standbyStateSha256: 'c'.repeat(64),
      maximumSnapshotAgeMs: 777,
    };
    function standby(
      config: any,
      over: Record<string, unknown> = {},
      tenantsOver: (t: any[]) => any[] = (t) => t
    ) {
      return {
        formatVersion: 2,
        kind: 'operation',
        mode: 'sync',
        planSha256: SHA,
        journal: {
          planSha256: SHA,
          value: {
            phase: 'complete',
            inventory: {
              tenants: tenantsOver(
                config.tenants.map((c: any) => ({
                  tenantId: c.pair.tenantId,
                  issuer: c.source.identity.issuer,
                  productVersion: c.source.identity.productVersion,
                }))
              ),
            },
          },
        },
        ...over,
      };
    }
    async function run(build: (config: any) => unknown, withApproval = true) {
      const { config } = setup((c) => {
        if (withApproval) c.failover = approval;
      });
      m.readPinned.mockResolvedValue(Buffer.from(JSON.stringify(build(config))));
      await runEnvironmentReplicationCommand(input('failover'));
      return config;
    }
    it('advances failover with the reviewed standby', async () => {
      const config = await run((c) => standby(c));
      expect(m.readPinned).toHaveBeenCalledWith('/standby.json', 'c'.repeat(64), 8 * 1024 * 1024);
      const f = m.failover.mock.calls[0][0];
      expect(f.maximumSnapshotAgeMs).toBe(777);
      expect(f.reviewedStandby.planSha256).toBe(SHA);
      expect(f.reviewedStandby.progress.phase).toBe('complete');
      expect(f.expectedPlan.mode).toBe('failover');
      expect(f.expectedPlan.environmentId).toBe(config.pair.environmentId);
      expect(m.sync).not.toHaveBeenCalled();
      expect(m.dbUrl.mock.calls[0][1]).toBe('failover');
    });
    it('requires an approval', async () => {
      setup();
      await expect(runEnvironmentReplicationCommand(input('failover'))).rejects.toThrow(
        'environment_replication_cli_invalid'
      );
      expect(m.readPinned).not.toHaveBeenCalled();
    });
    const bads: Array<[string, (c: any) => unknown]> = [
      ['formatVersion', (c) => standby(c, { formatVersion: 1 })],
      ['kind', (c) => standby(c, { kind: 'initialize' })],
      ['mode', (c) => standby(c, { mode: 'switch' })],
      ['journal missing', (c) => standby(c, { journal: null })],
      ['journal digest mismatch', (c) => standby(c, { planSha256: 'd'.repeat(64) })],
      ['inventory missing', (c) => standby(c, { journal: { planSha256: SHA, value: {} } })],
      ['tenant count', (c) => standby(c, {}, (t) => t.slice(0, 1))],
      ['extra tenant', (c) => standby(c, {}, (t) => [...t, t[0]])],
      ['tenant id', (c) => standby(c, {}, (t) => [{ ...t[0], tenantId: 'x' }, t[1]])],
      ['issuer', (c) => standby(c, {}, (t) => [t[0], { ...t[1], issuer: 'https://x' }])],
      ['product version', (c) => standby(c, {}, (t) => [{ ...t[0], productVersion: '9' }, t[1]])],
    ];
    for (const [name, build] of bads) {
      it(`rejects standby with bad ${name}`, async () => {
        await expect(run(build)).rejects.toThrow('environment_replication_cli_invalid');
        expect(m.failover).not.toHaveBeenCalled();
      });
    }
    it('rejects invalid UTF-8 in the standby file', async () => {
      setup((c) => {
        c.failover = approval;
      });
      m.readPinned.mockResolvedValue(Buffer.from([0xff, 0xfe]));
      await expect(runEnvironmentReplicationCommand(input('failover'))).rejects.toThrow();
      expect(m.failover).not.toHaveBeenCalled();
    });
  });
});
