/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- mock call inspection */
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  poolOptions: vi.fn(),
  poolEnd: vi.fn(),
  poolOn: vi.fn(),
  rpc: vi.fn(),
  createRpc: vi.fn(),
  readPinned: vi.fn(),
  createPlan: vi.fn(),
  parsePlan: vi.fn(),
  planDigest: vi.fn(),
  secret: vi.fn(),
  dbUrl: vi.fn(),
  initDb: vi.fn(),
  journalCtor: vi.fn(),
  withOperation: vi.fn(),
  advance: vi.fn(),
  exportControl: vi.fn(),
  download: vi.fn(),
  restore: vi.fn(),
  failover: vi.fn(),
  envPlan: vi.fn(),
  envDigest: vi.fn(),
  envRead: vi.fn(),
  envSummary: vi.fn(),
  envRun: vi.fn(),
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
vi.mock('./plan', () => ({
  createReplicationPlan: (...a: unknown[]) => m.createPlan(...a),
  parseReplicationPlan: (...a: unknown[]) => m.parsePlan(...a),
  replicationPlanDigest: (...a: unknown[]) => m.planDigest(...a),
  replicationSecret: (...a: unknown[]) => m.secret(...a),
}));
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
vi.mock('./coordinator', () => ({
  advanceReplicationOperation: (...a: unknown[]) => m.advance(...a),
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
vi.mock('./failover', () => ({
  advanceReplicationFailover: (...a: unknown[]) => m.failover(...a),
}));
vi.mock('./environment-plan', () => ({
  createEnvironmentReplicationPlan: (...a: unknown[]) => m.envPlan(...a),
  environmentReplicationPlanDigest: (...a: unknown[]) => m.envDigest(...a),
}));
vi.mock('./environment-cli', () => ({
  readEnvironmentObservation: (...a: unknown[]) => m.envRead(...a),
  environmentObservationSummary: (...a: unknown[]) => m.envSummary(...a),
  runEnvironmentReplicationCommand: (...a: unknown[]) => m.envRun(...a),
}));

import { runReplicationCli } from './cli';

const FAIL =
  'replication_operation_failed; inspect the saved state and resume with the same plan\n';
const SHA = 'a'.repeat(64);
let root: string;
let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
let cliSha: string;

const configuration = {
  authority: {
    endpoint: 'https://auth.example',
    credentialId: 'cred-1',
    secretEnv: 'RPC_SECRET',
    databaseUrlEnv: 'DB',
    bootstrap: undefined as undefined | { serviceRole: string; journalRole: string },
  },
  pair: { pairId: 'pair-1', tenantId: 'tenant-1' },
  sourceDeploymentId: 'src',
  destinationDeploymentId: 'dst',
  expectedEpoch: 7,
  maxSnapshotAgeMs: 1234,
  source: {
    managementOrigin: 'https://mgmt.example',
    grantId: 'grant-1',
    credentialEnv: 'SRC_CRED',
    passphraseEnv: 'SRC_PASS',
    identity: { id: 'ident' },
  },
  failover: undefined as
    | undefined
    | { standbyStatePath: string; standbyStateSha256: string; maximumSnapshotAgeMs: number },
};

function writeState(path: string, value: unknown, mode = 0o600) {
  return writeFile(path, JSON.stringify(value), { mode }).then(() => chmod(path, mode));
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'authrim-cli-mut-'));
  cliSha = createHash('sha256')
    .update(await readFile(new URL('./cli.ts', import.meta.url)))
    .digest('hex');
  Object.values(m).forEach((f) => f.mockReset());
  out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
  m.secret.mockImplementation((_e: unknown, name: string) => `secret:${name}`);
  m.dbUrl.mockReturnValue('postgres://db');
  m.parsePlan.mockImplementation(() => ({
    planId: 'plan-1',
    configuration: structuredClone(configuration),
    authoritySchemaSha256: 'schema-sha',
  }));
  m.readPinned.mockResolvedValue(Buffer.from('{"formatVersion":1}'));
  m.rpc.mockResolvedValue({ registered: true });
  m.initDb.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

async function expectFailed() {
  expect(err).toHaveBeenCalledWith(FAIL);
  expect(process.exitCode).toBe(1);
}

describe('help and option parsing', () => {
  it('prints exact usage for --help and nothing else', async () => {
    await runReplicationCli(['--help']);
    expect(out).toHaveBeenCalledWith(
      'replication-cli plan --config ABS --out ABS | status --state ABS | initialize|sync|switch|failover|resume|cancel --plan ABS --plan-sha256 SHA256 --state ABS\n'
    );
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
  it('--help with extra args is not help', async () => {
    await runReplicationCli(['--help', 'x']);
    expect(out).not.toHaveBeenCalled();
    await expectFailed();
  });
  const cases: Array<[string, () => string[]]> = [
    ['no args', () => []],
    ['unknown command', () => ['bogus']],
    ['plan missing option', () => ['plan', '--config', join(root, 'c')]],
    [
      'plan with extra option',
      () => ['plan', '--config', join(root, 'c'), '--out', join(root, 'o'), '--x', '/y'],
    ],
    ['plan with status key', () => ['plan', '--state', join(root, 's'), '--out', join(root, 'o')]],
    ['status with config key', () => ['status', '--config', join(root, 's')]],
    ['relative path', () => ['status', '--state', 'rel.json']],
    ['non normalized path', () => ['status', '--state', join(root, 'a', '..', 's')]],
    ['missing dashes', () => ['status', 'state', join(root, 's')]],
    ['empty value', () => ['status', '--state', '']],
    [
      'bad sha uppercase',
      () => [
        'sync',
        '--plan',
        join(root, 'p'),
        '--plan-sha256',
        'A'.repeat(64),
        '--state',
        join(root, 's'),
      ],
    ],
    [
      'short sha',
      () => [
        'sync',
        '--plan',
        join(root, 'p'),
        '--plan-sha256',
        'a'.repeat(63),
        '--state',
        join(root, 's'),
      ],
    ],
    [
      'long sha',
      () => [
        'sync',
        '--plan',
        join(root, 'p'),
        '--plan-sha256',
        'a'.repeat(65),
        '--state',
        join(root, 's'),
      ],
    ],
    [
      'duplicate key',
      () => [
        'sync',
        '--plan',
        join(root, 'p'),
        '--plan',
        join(root, 'q'),
        '--state',
        join(root, 's'),
      ],
    ],
    [
      'sha as path',
      () => ['sync', '--plan', SHA, '--plan-sha256', SHA, '--state', join(root, 's')],
    ],
  ];
  for (const [name, args] of cases) {
    it(`fails closed: ${name}`, async () => {
      await runReplicationCli(args());
      await expectFailed();
      expect(out).not.toHaveBeenCalled();
    });
  }
  it('closes no pool on early failure', async () => {
    await runReplicationCli(['bogus']);
    expect(m.poolEnd).not.toHaveBeenCalled();
  });
});

describe('plan command', () => {
  it('writes a v1 plan with the executor digest and prints canonical summary', async () => {
    const config = join(root, 'config.json');
    const outPath = join(root, 'plan.json');
    await writeFile(config, '{"formatVersion":1,"a":1}');
    const plan = { planId: 'p1', z: 1 };
    m.createPlan.mockResolvedValue(plan);
    m.planDigest.mockReturnValue('digest1');
    await runReplicationCli(['plan', '--config', config, '--out', outPath]);
    expect(m.createPlan).toHaveBeenCalledWith({ formatVersion: 1, a: 1 }, cliSha);
    expect(m.planDigest).toHaveBeenCalledWith(plan);
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(plan);
    expect((await stat(outPath)).mode & 0o777).toBe(0o600);
    expect(out).toHaveBeenCalledWith(
      '{"cloudChanges":false,"planId":"p1","planSha256":"digest1","status":"planned"}\n'
    );
    expect(m.envPlan).not.toHaveBeenCalled();
  });
  it('writes a v2 plan using the environment planner', async () => {
    const config = join(root, 'config.json');
    const outPath = join(root, 'plan.json');
    await writeFile(config, '{"formatVersion":2}');
    m.envPlan.mockResolvedValue({ planId: 'e1' });
    m.envDigest.mockReturnValue('edigest');
    await runReplicationCli(['plan', '--config', config, '--out', outPath]);
    expect(m.envPlan).toHaveBeenCalledWith({ formatVersion: 2 }, cliSha);
    expect(m.createPlan).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledWith(
      '{"cloudChanges":false,"planId":"e1","planSha256":"edigest","scope":"environment","status":"planned"}\n'
    );
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual({ planId: 'e1' });
  });
  it('treats formatVersion 2 strictly (string "2" is v1)', async () => {
    const config = join(root, 'config.json');
    await writeFile(config, '{"formatVersion":"2"}');
    m.createPlan.mockResolvedValue({ planId: 'p' });
    await runReplicationCli(['plan', '--config', config, '--out', join(root, 'o.json')]);
    expect(m.createPlan).toHaveBeenCalled();
    expect(m.envPlan).not.toHaveBeenCalled();
  });
  it('tolerates null configuration', async () => {
    const config = join(root, 'config.json');
    await writeFile(config, 'null');
    m.createPlan.mockResolvedValue({ planId: 'p' });
    await runReplicationCli(['plan', '--config', config, '--out', join(root, 'o.json')]);
    expect(m.createPlan).toHaveBeenCalledWith(null, cliSha);
  });
  it('refuses to overwrite an existing output file', async () => {
    const config = join(root, 'config.json');
    const outPath = join(root, 'plan.json');
    await writeFile(config, '{"formatVersion":1}');
    await writeFile(outPath, 'keep');
    m.createPlan.mockResolvedValue({ planId: 'p' });
    await runReplicationCli(['plan', '--config', config, '--out', outPath]);
    await expectFailed();
    expect(await readFile(outPath, 'utf8')).toBe('keep');
  });
  it('refuses output in a symlinked directory', async () => {
    const real = join(root, 'real');
    await import('node:fs/promises').then((f) => f.mkdir(real));
    const link = join(root, 'link');
    await symlink(real, link);
    const config = join(root, 'config.json');
    await writeFile(config, '{"formatVersion":1}');
    m.createPlan.mockResolvedValue({ planId: 'p' });
    await runReplicationCli(['plan', '--config', config, '--out', join(link, 'p.json')]);
    await expectFailed();
  });
  it('rejects config that is a symlink, empty, or oversized', async () => {
    const real = join(root, 'real.json');
    await writeFile(real, '{"formatVersion":1}');
    const link = join(root, 'link.json');
    await symlink(real, link);
    await runReplicationCli(['plan', '--config', link, '--out', join(root, 'o1')]);
    await expectFailed();
    err.mockClear();
    process.exitCode = undefined;
    const empty = join(root, 'empty.json');
    await writeFile(empty, '');
    await runReplicationCli(['plan', '--config', empty, '--out', join(root, 'o2')]);
    await expectFailed();
    err.mockClear();
    process.exitCode = undefined;
    const big = join(root, 'big.json');
    await writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    await runReplicationCli(['plan', '--config', big, '--out', join(root, 'o3')]);
    await expectFailed();
    expect(m.createPlan).not.toHaveBeenCalled();
  });
  it('accepts a config of exactly 1 byte and exactly 8 MiB', async () => {
    m.createPlan.mockResolvedValue({ planId: 'p' });
    const one = join(root, 'one.json');
    await writeFile(one, '1');
    await runReplicationCli(['plan', '--config', one, '--out', join(root, 'o1')]);
    expect(m.createPlan).toHaveBeenCalledWith(1, cliSha);
    const max = join(root, 'max.json');
    const body = Buffer.alloc(8 * 1024 * 1024, 0x20);
    body[0] = 0x31;
    await writeFile(max, body);
    m.createPlan.mockClear();
    await runReplicationCli(['plan', '--config', max, '--out', join(root, 'o2')]);
    expect(m.createPlan).toHaveBeenCalledWith(1, cliSha);
  });
  it('rejects a config path that is a directory', async () => {
    await runReplicationCli(['plan', '--config', root, '--out', join(root, 'o')]);
    await expectFailed();
  });
});

function obs(over: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    kind: 'operation',
    planPath: '/plan.json',
    planSha256: SHA,
    observedAtMs: 1000,
    mode: 'sync',
    journal: null,
    ...over,
  };
}

describe('status command', () => {
  it('prints initialized summary for an initialize observation', async () => {
    const p = join(root, 's.json');
    await writeState(p, obs({ kind: 'initialize', mode: 'initialize' }));
    await runReplicationCli(['status', '--state', p]);
    expect(out).toHaveBeenCalledWith(
      `{"live":false,"mode":"initialize","observedAtMs":1000,"planSha256":"${SHA}","status":"initialized","trafficSwitched":false}\n`
    );
  });
  it('prints unknown phase when an operation has no journal', async () => {
    const p = join(root, 's.json');
    await writeState(p, obs());
    await runReplicationCli(['status', '--state', p]);
    expect(JSON.parse(out.mock.calls[0][0] as string)).toEqual({
      live: false,
      mode: 'sync',
      observedAtMs: 1000,
      planSha256: SHA,
      status: 'unknown',
      trafficSwitched: false,
    });
  });
  it('prints journal progress including drain flag', async () => {
    const p = join(root, 's.json');
    const progress = (phase: string) => ({
      value: {
        phase,
        plan: { operationId: 'op1' },
        generationId: 'gen1',
        attempt: 3,
        writerAuthorityChanged: true,
      },
    });
    await writeState(p, obs({ journal: progress('draining') }));
    await runReplicationCli(['status', '--state', p]);
    expect(JSON.parse(out.mock.calls[0][0] as string)).toEqual({
      status: 'draining',
      mode: 'sync',
      observedAtMs: 1000,
      live: false,
      planSha256: SHA,
      operationId: 'op1',
      generationId: 'gen1',
      attempt: 3,
      writerAuthorityChanged: true,
      outstandingDrain: true,
      trafficSwitched: false,
    });
    out.mockClear();
    await rm(p);
    await writeState(p, obs({ journal: progress('restoring') }));
    await runReplicationCli(['status', '--state', p]);
    const parsed = JSON.parse(out.mock.calls[0][0] as string);
    expect(parsed.outstandingDrain).toBe(false);
    expect(parsed.status).toBe('restoring');
  });
  it('delegates formatVersion 2 state to the environment reader', async () => {
    const p = join(root, 's.json');
    await writeState(p, { formatVersion: 2 });
    m.envRead.mockResolvedValue({ env: 1 });
    m.envSummary.mockReturnValue({ s: 'env' });
    await runReplicationCli(['status', '--state', p]);
    expect(m.envRead).toHaveBeenCalledWith(p);
    expect(m.envSummary).toHaveBeenCalledWith({ env: 1 });
    expect(out).toHaveBeenCalledWith('{"s":"env"}\n');
  });
  it('fails when the environment observation is missing', async () => {
    const p = join(root, 's.json');
    await writeState(p, { formatVersion: 2 });
    m.envRead.mockResolvedValue(null);
    await runReplicationCli(['status', '--state', p]);
    await expectFailed();
    expect(out).not.toHaveBeenCalled();
  });
  it('fails when the state file does not exist', async () => {
    await runReplicationCli(['status', '--state', join(root, 'missing.json')]);
    await expectFailed();
  });
  const invalids: Array<[string, Record<string, unknown>]> = [
    ['formatVersion', { formatVersion: 3 }],
    ['kind', { kind: 'other' }],
    ['mode', { mode: 'cancel' }],
    ['observedAtMs float', { observedAtMs: 1.5 }],
    ['observedAtMs string', { observedAtMs: '1' }],
    ['planSha256 short', { planSha256: 'a'.repeat(63) }],
    ['planSha256 upper', { planSha256: 'A'.repeat(64) }],
    ['planSha256 prefix junk', { planSha256: `x${SHA}` }],
    ['planSha256 suffix junk', { planSha256: `${SHA}x` }],
    ['planPath relative', { planPath: 'plan.json' }],
  ];
  for (const [name, over] of invalids) {
    it(`rejects state with invalid ${name}`, async () => {
      const p = join(root, 's.json');
      await writeState(p, obs(over));
      await runReplicationCli(['status', '--state', p]);
      await expectFailed();
    });
  }
  it('rejects a state file with group/other permissions', async () => {
    const p = join(root, 's.json');
    await writeState(p, obs(), 0o640);
    await runReplicationCli(['status', '--state', p]);
    await expectFailed();
    err.mockClear();
    process.exitCode = undefined;
    await chmod(p, 0o604);
    await runReplicationCli(['status', '--state', p]);
    await expectFailed();
  });
  it('rejects a state file with literal null content', async () => {
    const p = join(root, 's.json');
    await writeState(p, null);
    await runReplicationCli(['status', '--state', p]);
    await expectFailed();
  });
  it('accepts every valid kind/mode', async () => {
    for (const mode of ['initialize', 'sync', 'switch', 'failover']) {
      const p = join(root, `s-${mode}.json`);
      await writeState(p, obs({ mode }));
      out.mockClear();
      await runReplicationCli(['status', '--state', p]);
      expect(JSON.parse(out.mock.calls[0][0] as string).mode).toBe(mode);
    }
  });
});

function args(command: string, extra: Partial<Record<'plan' | 'state', string>> = {}) {
  return [
    command,
    '--plan',
    extra.plan ?? join(root, 'plan.json'),
    '--plan-sha256',
    SHA,
    '--state',
    extra.state ?? join(root, 'state.json'),
  ];
}

describe('mutating commands', () => {
  it('reads the pinned plan with the reviewed digest and 8 MiB limit', async () => {
    m.readPinned.mockResolvedValue(Buffer.from('{"formatVersion":1}'));
    m.parsePlan.mockImplementation(() => {
      throw new Error('stop');
    });
    await runReplicationCli(args('initialize'));
    expect(m.readPinned).toHaveBeenCalledWith(join(root, 'plan.json'), SHA, 8 * 1024 * 1024);
    expect(m.parsePlan).toHaveBeenCalledWith('{"formatVersion":1}', cliSha);
    await expectFailed();
  });
  it('strips a UTF-8 BOM (ignoreBOM false) and rejects invalid UTF-8', async () => {
    m.readPinned.mockResolvedValue(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    m.parsePlan.mockImplementation(() => {
      throw new Error('stop');
    });
    await runReplicationCli(args('initialize'));
    expect(m.parsePlan).toHaveBeenCalledWith('{}', cliSha);
    m.parsePlan.mockClear();
    err.mockClear();
    process.exitCode = undefined;
    m.readPinned.mockResolvedValue(Buffer.from([0xff, 0xfe]));
    await runReplicationCli(args('initialize'));
    await expectFailed();
    expect(m.parsePlan).not.toHaveBeenCalled();
  });
  it('delegates formatVersion 2 plans to the environment runner', async () => {
    m.readPinned.mockResolvedValue(Buffer.from('{"formatVersion":2}'));
    await runReplicationCli(args('sync'));
    expect(m.envRun).toHaveBeenCalledTimes(1);
    const input = m.envRun.mock.calls[0][0];
    expect(input).toMatchObject({
      command: 'sync',
      planPath: join(root, 'plan.json'),
      planSha256: SHA,
      statePath: join(root, 'state.json'),
      rawPlan: '{"formatVersion":2}',
      executorSha256: cliSha,
    });
    expect(input.environment).toBe(process.env);
    expect(m.parsePlan).not.toHaveBeenCalled();
    expect(m.poolOptions).not.toHaveBeenCalled();
  });
  it('passes a caller supplied environment to the environment runner', async () => {
    m.readPinned.mockResolvedValue(Buffer.from('{"formatVersion":2}'));
    const env = { X: '1' };
    await runReplicationCli(args('cancel'), env);
    expect(m.envRun.mock.calls[0][0].environment).toBe(env);
  });
  it('treats null plan JSON as v1', async () => {
    m.readPinned.mockResolvedValue(Buffer.from('null'));
    m.parsePlan.mockImplementation(() => {
      throw new Error('stop');
    });
    await runReplicationCli(args('initialize'));
    expect(m.envRun).not.toHaveBeenCalled();
    expect(m.parsePlan).toHaveBeenCalled();
  });

  it('initializes: builds pool, initializes database and authority, saves observation', async () => {
    const env = { E: '1' };
    await runReplicationCli(args('initialize'), env);
    expect(m.secret).toHaveBeenCalledWith(env, 'RPC_SECRET');
    expect(m.dbUrl).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://auth.example' }),
      'initialize',
      expect.any(Function)
    );
    expect(m.poolOptions).toHaveBeenCalledWith({
      connectionString: 'postgres://db',
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30_000,
    });
    expect(m.poolOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(m.poolOn.mock.calls[0][1]()).toBeUndefined();
    expect(m.createRpc).toHaveBeenCalledWith({
      endpoint: 'https://auth.example',
      credentialId: 'cred-1',
      secret: 'secret:RPC_SECRET',
    });
    expect(m.initDb).toHaveBeenCalledWith(expect.anything(), 'schema-sha', undefined);
    expect(m.rpc).toHaveBeenCalledWith('initialize', { pairId: 'pair-1', tenantId: 'tenant-1' });
    const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    expect(saved).toMatchObject({
      formatVersion: 1,
      kind: 'initialize',
      planPath: join(root, 'plan.json'),
      planSha256: SHA,
      mode: 'initialize',
      journal: null,
    });
    expect(Number.isSafeInteger(saved.observedAtMs)).toBe(true);
    expect(JSON.parse(out.mock.calls[0][0] as string).status).toBe('initialized');
    expect(m.poolEnd).toHaveBeenCalledTimes(1);
    expect(m.journalCtor).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
  it('the secret resolver closure passes the environment through', async () => {
    const env = { E: '1' };
    await runReplicationCli(args('initialize'), env);
    const resolver = m.dbUrl.mock.calls[0][2];
    m.secret.mockClear();
    expect(resolver('NAME')).toBe('secret:NAME');
    expect(m.secret).toHaveBeenCalledWith(env, 'NAME');
  });
  it('passes only bootstrap roles to database initialization', async () => {
    m.parsePlan.mockImplementation(() => ({
      planId: 'plan-1',
      configuration: {
        ...structuredClone(configuration),
        authority: {
          ...configuration.authority,
          bootstrap: { serviceRole: 'svc', journalRole: 'jrn', databaseUrlEnv: 'OWNER' },
        },
      },
      authoritySchemaSha256: 'schema-sha',
    }));
    await runReplicationCli(args('initialize'));
    expect(m.initDb).toHaveBeenCalledWith(expect.anything(), 'schema-sha', {
      serviceRole: 'svc',
      journalRole: 'jrn',
    });
  });
  it('closes the pool and reports failure when initialization fails', async () => {
    m.initDb.mockRejectedValue(new Error('secret row data'));
    await runReplicationCli(args('initialize'));
    await expectFailed();
    expect(m.poolEnd).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.flat().join('')).not.toContain('secret row');
    expect(out).not.toHaveBeenCalled();
  });
  it('resume without prior state fails; resume reuses the prior mode', async () => {
    await runReplicationCli(args('resume'));
    await expectFailed();
    expect(m.poolOptions).not.toHaveBeenCalled();
    err.mockClear();
    process.exitCode = undefined;
    await writeState(
      join(root, 'state.json'),
      obs({ kind: 'initialize', mode: 'initialize', planPath: join(root, 'plan.json') })
    );
    await runReplicationCli(args('resume'));
    expect(m.dbUrl.mock.calls[0][1]).toBe('initialize');
    expect(err).not.toHaveBeenCalled();
  });
  it('rejects prior state of a different plan path, digest, or mode', async () => {
    const state = join(root, 'state.json');
    await writeState(state, obs({ planPath: '/other.json' }));
    await runReplicationCli(args('sync'));
    await expectFailed();
    for (const over of [{ planSha256: 'b'.repeat(64) }, { mode: 'switch' }]) {
      err.mockClear();
      process.exitCode = undefined;
      await rm(state);
      await writeState(state, obs({ planPath: join(root, 'plan.json'), ...over }));
      await runReplicationCli(args('sync'));
      await expectFailed();
    }
    expect(m.poolOptions).not.toHaveBeenCalled();
  });
  it('cancel is not a valid operation mode', async () => {
    await runReplicationCli(args('cancel'));
    await expectFailed();
    expect(m.poolOptions).not.toHaveBeenCalled();
  });
});

type RunInput = {
  planSha256: string;
  pairId: string;
  operationId: string;
  initial: Record<string, unknown>;
  run: (journal: {
    current: () => unknown;
    save: (v: unknown) => Promise<unknown>;
  }) => Promise<void>;
};

describe('operation commands', () => {
  let journalState: { value: Record<string, unknown> };
  let saved: unknown[];
  beforeEach(() => {
    saved = [];
    m.withOperation.mockImplementation(async (input: RunInput) => {
      journalState = { value: input.initial };
      await input.run({
        current: () => journalState,
        save: async (v) => {
          saved.push(v);
          journalState = { value: v as Record<string, unknown> };
          return journalState;
        },
      });
    });
    m.exportControl.mockReturnValue({ begin: 'b', status: 's' });
    m.advance.mockResolvedValue(undefined);
  });

  it('runs a sync operation with the expected plan and journal scope', async () => {
    await runReplicationCli(args('sync'));
    expect(m.journalCtor).toHaveBeenCalledTimes(1);
    const input = m.withOperation.mock.calls[0][0] as RunInput;
    expect(input.pairId).toBe('pair-1');
    expect(input.operationId).toBe('plan-1:sync');
    expect(input.planSha256).toBe(SHA);
    expect(input.initial).toMatchObject({
      formatVersion: 1,
      phase: 'pending',
      attempt: 1,
      writerAuthorityChanged: false,
      plan: {
        operationId: 'plan-1:sync',
        pairId: 'pair-1',
        tenantId: 'tenant-1',
        sourceDeploymentId: 'src',
        destinationDeploymentId: 'dst',
        expectedEpoch: 7,
        mode: 'sync',
      },
    });
    expect(typeof input.initial.generationId).toBe('string');
    expect((input.initial.generationId as string).length).toBeGreaterThan(30);
    expect(m.advance).toHaveBeenCalledTimes(1);
    const call = m.advance.mock.calls[0][0];
    expect(call.expectedPlan).toEqual(input.initial.plan);
    expect(m.dbUrl.mock.calls[0][1]).toBe('sync');
    expect(m.initDb).not.toHaveBeenCalled();
    expect(m.failover).not.toHaveBeenCalled();
    const final = JSON.parse(out.mock.calls.at(-1)![0] as string);
    expect(final.status).toBe('pending');
    expect(final.operationId).toBe('plan-1:sync');
    expect(final.attempt).toBe(1);
    expect(final.writerAuthorityChanged).toBe(false);
    expect(final.outstandingDrain).toBe(false);
    const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    expect(disk.kind).toBe('operation');
    expect(disk.mode).toBe('sync');
    expect(m.poolEnd).toHaveBeenCalledTimes(1);
  });
  it('uses the mode name for switch operations', async () => {
    await runReplicationCli(args('switch'));
    const input = m.withOperation.mock.calls[0][0] as RunInput;
    expect(input.operationId).toBe('plan-1:switch');
    expect((input.initial.plan as { mode: string }).mode).toBe('switch');
  });
  it('checkpoint saves through the journal and observes the saved record', async () => {
    m.advance.mockImplementation(async (a: { checkpoint: any }) => {
      expect(a.checkpoint.current()).toBe(journalState);
      const rec = await a.checkpoint.save({ phase: 'draining', plan: { operationId: 'x' } });
      expect(rec).toBe(journalState);
    });
    await runReplicationCli(args('sync'));
    expect(saved).toEqual([{ phase: 'draining', plan: { operationId: 'x' } }]);
    const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    expect(disk.journal.value.phase).toBe('draining');
  });
  it('observes the initial journal before running (state file exists during advance)', async () => {
    m.advance.mockImplementation(async () => {
      const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
      expect(disk.journal.value.phase).toBe('pending');
    });
    await runReplicationCli(args('sync'));
    expect(err).not.toHaveBeenCalled();
  });

  it('authority client forwards each RPC with exact payloads', async () => {
    let authority: any;
    m.advance.mockImplementation(async (a: { authority: unknown }) => {
      authority = a.authority;
    });
    await runReplicationCli(args('sync'));
    m.rpc.mockReset();
    m.rpc.mockResolvedValue('R');
    expect(await authority.initialize({ d: 1 })).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('initialize', { d: 1 });
    expect(await authority.get('p', 't')).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('get', { pairId: 'p', tenantId: 't' });
    expect(await authority.beginDrain({ b: 1 })).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('beginDrain', { b: 1 });
    expect(await authority.beginFailoverDrain({ f: 1 })).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('beginFailoverDrain', { f: 1 });
    expect(await authority.verifyFailoverGeneration({ i: 1 }, 'proof')).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('verifyFailoverGeneration', { i: 1, proof: 'proof' });
    expect(await authority.getOperation({ i: 2 })).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('getOperation', { i: 2 });
    expect(await authority.verifyGeneration({ i: 3 }, 'gen')).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('verifyGeneration', { i: 3, generation: 'gen' });
    expect(await authority.promote({ i: 4 })).toBe('R');
    expect(m.rpc).toHaveBeenLastCalledWith('promote', { i: 4 });
    await expect(authority.enter()).rejects.toThrow('controller_cannot_enter');
    await expect(authority.complete()).rejects.toThrow('controller_cannot_complete');
    m.rpc.mockResolvedValue({ registered: true });
    await expect(authority.registerStandbyGeneration({ g: 1 })).resolves.toBeUndefined();
    expect(m.rpc).toHaveBeenLastCalledWith('registerStandbyGeneration', { g: 1 });
    for (const bad of [{ registered: false }, {}, null, undefined, { registered: 'true' }]) {
      m.rpc.mockResolvedValue(bad);
      await expect(authority.registerStandbyGeneration({ g: 1 })).rejects.toThrow(
        'replication_cli_invalid'
      );
    }
  });

  it('wires the export source and download with reviewed configuration', async () => {
    let source: any;
    m.advance.mockImplementation(async (a: { source: unknown }) => {
      source = a.source;
    });
    m.download.mockResolvedValue('downloaded');
    await runReplicationCli(args('sync'));
    expect(m.exportControl).toHaveBeenCalledWith({
      origin: 'https://mgmt.example',
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      credential: 'secret:SRC_CRED',
      passphrase: 'secret:SRC_PASS',
    });
    expect(source.begin).toBe('b');
    expect(source.status).toBe('s');
    expect(await source.download('op-9', 555)).toBe('downloaded');
    const d = m.download.mock.calls[0][0];
    expect(d).toMatchObject({
      managementOrigin: 'https://mgmt.example',
      grantId: 'grant-1',
      operationId: 'op-9',
      authorization: 'Bearer secret:SRC_CRED',
      expectedSource: { id: 'ident' },
      maxSnapshotAgeMs: 1234,
      minimumBoundaryUnixMs: 555,
    });
    expect(d.outputDirectory).toMatch(
      new RegExp(
        `^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/replication-export-[0-9a-f-]{36}$`
      )
    );
    await source.download('op-9', 556);
    expect(m.download.mock.calls[1][0].outputDirectory).not.toBe(d.outputDirectory);
  });

  it('wires target restore and register', async () => {
    let target: any;
    m.advance.mockImplementation(async (a: { target: unknown }) => {
      target = a.target;
    });
    m.restore.mockResolvedValue('restored');
    const env = { Z: '1' };
    await runReplicationCli(args('sync'), env);
    expect(await target.restore({ extra: 1 })).toBe('restored');
    const r = m.restore.mock.calls[0][0];
    expect(r.environment).toBe(env);
    expect(r.extra).toBe(1);
    expect(r.configuration.pair.pairId).toBe('pair-1');
    m.rpc.mockReset();
    m.rpc.mockResolvedValue({ registered: true });
    await target.register({ gen: 1 });
    expect(m.rpc).toHaveBeenCalledWith('registerGeneration', { gen: 1 });
    for (const bad of [{ registered: false }, {}, null, { registered: 1 }]) {
      m.rpc.mockResolvedValue(bad);
      await expect(target.register({ gen: 1 })).rejects.toThrow('replication_cli_invalid');
    }
  });
});

describe('failover command', () => {
  async function setup(standby: unknown, approval: unknown) {
    m.withOperation.mockImplementation(async (input: RunInput) => {
      const cur = { value: input.initial };
      await input.run({ current: () => cur, save: async (v) => ({ value: v }) });
    });
    m.parsePlan.mockImplementation(() => ({
      planId: 'plan-1',
      configuration: { ...structuredClone(configuration), failover: approval },
      authoritySchemaSha256: 's',
    }));
    m.readPinned.mockImplementation(async (path: string) =>
      path === '/standby.json'
        ? Buffer.from(JSON.stringify(standby))
        : Buffer.from('{"formatVersion":1}')
    );
    m.failover.mockResolvedValue(undefined);
  }
  const approval = {
    standbyStatePath: '/standby.json',
    standbyStateSha256: 'c'.repeat(64),
    maximumSnapshotAgeMs: 4321,
  };
  const goodStandby = {
    formatVersion: 1,
    kind: 'operation',
    mode: 'sync',
    planSha256: SHA,
    journal: { planSha256: SHA, value: { phase: 'done' } },
  };

  it('verifies the reviewed standby and advances failover', async () => {
    await setup(goodStandby, approval);
    await runReplicationCli(args('failover'));
    expect(m.readPinned).toHaveBeenCalledWith('/standby.json', 'c'.repeat(64), 8 * 1024 * 1024);
    expect(m.failover).toHaveBeenCalledTimes(1);
    const f = m.failover.mock.calls[0][0];
    expect(f.reviewedStandby).toEqual({ planSha256: SHA, progress: { phase: 'done' } });
    expect(f.maximumSnapshotAgeMs).toBe(4321);
    expect(f.expectedPlan.mode).toBe('failover');
    expect(f.expectedPlan.operationId).toBe('plan-1:failover');
    expect(typeof f.authority.get).toBe('function');
    expect(typeof f.checkpoint.save).toBe('function');
    expect(m.advance).not.toHaveBeenCalled();
    expect(m.dbUrl.mock.calls[0][1]).toBe('failover');
    expect(err).not.toHaveBeenCalled();
  });
  it('requires a failover approval', async () => {
    await setup(goodStandby, undefined);
    await runReplicationCli(args('failover'));
    await expectFailed();
    expect(m.failover).not.toHaveBeenCalled();
  });
  const bads: Array<[string, Record<string, unknown>]> = [
    ['formatVersion', { formatVersion: 2 }],
    ['kind', { kind: 'initialize' }],
    ['mode', { mode: 'switch' }],
    ['journal', { journal: null }],
    ['planSha256 mismatch', { planSha256: 'd'.repeat(64) }],
  ];
  for (const [name, over] of bads) {
    it(`rejects standby with bad ${name}`, async () => {
      await setup({ ...goodStandby, ...over }, approval);
      await runReplicationCli(args('failover'));
      await expectFailed();
      expect(m.failover).not.toHaveBeenCalled();
    });
  }
});
