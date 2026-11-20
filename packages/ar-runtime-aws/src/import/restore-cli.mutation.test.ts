/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- fakes and deliberately malformed inputs are intentionally untyped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readPinned: vi.fn(), restore: vi.fn() }));

vi.mock('./restore-evidence', async () => {
  const actual = await vi.importActual<typeof import('./restore-evidence')>('./restore-evidence');
  return { ...actual, readPinnedRestoreFile: mocks.readPinned };
});
vi.mock('./restore-offline', () => ({ restoreOfflineAwsSamlTenant: mocks.restore }));

import {
  resolveAwsOfflineRestorePlan,
  runAwsOfflineRestoreCli,
  type AwsOfflineRestorePlan,
} from './restore-cli';
import { canonicalRestoreJson } from './restore-evidence';

const ERR = 'aws_restore_plan_invalid';

function fixture(): AwsOfflineRestorePlan {
  return {
    formatVersion: 1,
    backup: {
      partPaths: ['/b'],
      receipt: {} as never,
      selection: {} as never,
      datasets: [],
      maxSnapshotAgeMs: 1,
      passphraseEnv: 'E_PASS',
    },
    supplement: { path: '/s.json', expectedSha256: 'd'.repeat(64) },
    restoreId: 'rid',
    core: { connectionStringEnv: 'E_CORE', targetId: 't1', bindingRefs: ['c'] },
    pii: { connectionStringEnv: 'E_PII', targetId: 't2', bindingRefs: ['p'] },
    state: { connectionStringEnv: 'E_STATE', initializeEmptySchema: true },
    environmentName: 'env',
    spEntityIds: ['sp'],
    allocationScope: 'tenant_exclusive',
    awsFlowRuntimeHmacSecretEnv: 'E_FLOW',
    awsLookupReadKeys: [{ generation: 1, secretEnv: 'E_L1' }],
  };
}
const env: Record<string, string> = {
  E_PASS: 'pass',
  E_CORE: 'core-url',
  E_PII: 'pii-url',
  E_STATE: 'state-url',
  E_FLOW: 'flow',
  E_L1: 'l1',
  E_L2: 'l2',
};
const resolve = (p: unknown, e: Record<string, string | undefined> = env) =>
  resolveAwsOfflineRestorePlan(p as AwsOfflineRestorePlan, e);

describe('resolveAwsOfflineRestorePlan', () => {
  it('maps every field to the right secret and keeps non-secret fields', () => {
    const p = fixture();
    p.awsLookupReadKeys = [
      { generation: 1, secretEnv: 'E_L1' },
      { generation: 2, secretEnv: 'E_L2' },
    ];
    const r = resolve(p);
    expect(r).toMatchObject({
      restoreId: 'rid',
      environmentName: 'env',
      spEntityIds: ['sp'],
      allocationScope: 'tenant_exclusive',
      supplement: p.supplement,
      awsFlowRuntimeHmacSecret: 'flow',
      awsLookupReadKeys: [
        { generation: 1, secret: 'l1' },
        { generation: 2, secret: 'l2' },
      ],
      backup: { passphrase: 'pass', partPaths: ['/b'] },
      core: { connectionString: 'core-url', targetId: 't1' },
      pii: { connectionString: 'pii-url', targetId: 't2' },
      state: { connectionString: 'state-url', initializeEmptySchema: true },
    });
  });
  it.each([
    ['null plan', () => null],
    ['array plan', () => []],
    ['string plan', () => 'x'],
    ['extra top key', (p: any) => ((p.extra = 1), p)],
    ['missing top key', (p: any) => (delete p.restoreId, p)],
    ['formatVersion 2', (p: any) => ((p.formatVersion = 2), p)],
    ['backup extra', (p: any) => ((p.backup.x = 1), p)],
    ['supplement extra', (p: any) => ((p.supplement.x = 1), p)],
    ['supplement missing', (p: any) => (delete p.supplement.path, p)],
    ['core extra', (p: any) => ((p.core.x = 1), p)],
    ['pii extra', (p: any) => ((p.pii.x = 1), p)],
    ['state extra', (p: any) => ((p.state.x = 1), p)],
    ['initializeEmptySchema string', (p: any) => ((p.state.initializeEmptySchema = 'true'), p)],
    ['lookup keys not array', (p: any) => ((p.awsLookupReadKeys = 'x'), p)],
    ['lookup keys empty', (p: any) => ((p.awsLookupReadKeys = []), p)],
    [
      'lookup keys three',
      (p: any) => (
        (p.awsLookupReadKeys = [
          { generation: 1, secretEnv: 'E_L1' },
          { generation: 2, secretEnv: 'E_L2' },
          { generation: 3, secretEnv: 'E_L2' },
        ]),
        p
      ),
    ],
    ['lookup key extra', (p: any) => ((p.awsLookupReadKeys[0].x = 1), p)],
    ['passphraseEnv lowercase', (p: any) => ((p.backup.passphraseEnv = 'e_pass'), p)],
    ['env digit start', (p: any) => ((p.backup.passphraseEnv = '1E'), p)],
    ['env trailing junk', (p: any) => ((p.backup.passphraseEnv = 'E_PASS-'), p)],
    ['env leading junk', (p: any) => ((p.backup.passphraseEnv = '-E_PASS'), p)],
    ['env too long', (p: any) => ((p.backup.passphraseEnv = 'A' + 'B'.repeat(128)), p)],
    ['env non-string', (p: any) => ((p.core.connectionStringEnv = 5), p)],
    ['flow env unset', (p: any) => ((p.awsFlowRuntimeHmacSecretEnv = 'E_MISSING'), p)],
  ])('rejects %s', (_n, mutate: (p: any) => unknown) => {
    const p = fixture();
    const value = mutate(p);
    const result =
      value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
        ? p
        : value;
    expect(() =>
      resolve(result, { ...env, ['A' + 'B'.repeat(128)]: 'x', E_STATE: 'state-url' })
    ).toThrow(new Error(ERR));
  });
  it('rejects unset or empty secret in each position', () => {
    for (const key of ['E_PASS', 'E_CORE', 'E_PII', 'E_STATE', 'E_FLOW', 'E_L1']) {
      expect(() => resolve(fixture(), { ...env, [key]: undefined })).toThrow(ERR);
      expect(() => resolve(fixture(), { ...env, [key]: '' })).toThrow(ERR);
    }
  });
  it('accepts a 128-char env name', () => {
    const name = 'A' + 'B'.repeat(127);
    const p = fixture();
    p.backup.passphraseEnv = name;
    expect(resolve(p, { ...env, [name]: 'v' }).backup.passphrase).toBe('v');
  });
  it('accepts initializeEmptySchema false', () => {
    const p = fixture();
    p.state.initializeEmptySchema = false;
    expect(resolve(p).state.initializeEmptySchema).toBe(false);
  });
});

describe('runAwsOfflineRestoreCli', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const oldExit = process.exitCode;
  const close = vi.fn();
  const goodArgs = ['--plan', '/plan.json', '--plan-sha256', 'abc'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    close.mockResolvedValue(undefined);
    mocks.readPinned.mockResolvedValue(new TextEncoder().encode(canonicalRestoreJson(fixture())));
    mocks.restore.mockResolvedValue({ evidence: { id: 'ev' }, close });
  });
  afterEach(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.exitCode = oldExit;
    vi.restoreAllMocks();
  });

  it('prints usage for --help', async () => {
    await runAwsOfflineRestoreCli(['--help']);
    expect(out).toHaveBeenCalledWith(
      'Usage: node dist/restore-cli.mjs --plan /absolute/plan.json --plan-sha256 <trusted SHA256>\n'
    );
    expect(mocks.readPinned).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [[]],
    [['--plan', '/p', '--plan-sha256']],
    [['--help', 'x']],
    [['--plan', '/p', '--plan-sha256', 'h', 'x']],
    [['--bad', '/p', '--plan-sha256', 'h']],
    [['--plan', '/p', '--bad', 'h']],
  ])('fails on bad args %j', async (args) => {
    await runAwsOfflineRestoreCli(args);
    expect(err).toHaveBeenCalledWith('aws_offline_restore_failed\n');
    expect(process.exitCode).toBe(1);
    expect(mocks.readPinned).not.toHaveBeenCalled();
  });

  it('restores from the pinned plan, prints evidence and closes', async () => {
    await runAwsOfflineRestoreCli(goodArgs);
    expect(mocks.readPinned).toHaveBeenCalledWith('/plan.json', 'abc', 4 * 1024 * 1024);
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        restoreId: 'rid',
        backup: expect.objectContaining({ passphrase: 'pass' }),
      })
    );
    expect(out).toHaveBeenCalledWith(
      `${canonicalRestoreJson({ status: 'active', evidence: { id: 'ev' } })}\n`
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  it('closes the restore even when printing fails', async () => {
    out.mockImplementation(() => {
      throw new Error('stdout');
    });
    await runAwsOfflineRestoreCli(goodArgs);
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith('aws_offline_restore_failed\n');
  });

  it('rejects a non-canonical plan and non-UTF8 bytes', async () => {
    mocks.readPinned.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(fixture(), null, 2))
    );
    await runAwsOfflineRestoreCli(goodArgs);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    mocks.readPinned.mockResolvedValue(new Uint8Array([0xff, 0xfe]));
    await runAwsOfflineRestoreCli(goodArgs);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails when the restore itself fails', async () => {
    mocks.restore.mockRejectedValue(new Error('x'));
    await runAwsOfflineRestoreCli(goodArgs);
    expect(process.exitCode).toBe(1);
    expect(out).not.toHaveBeenCalled();
  });
});

describe('module entrypoint', () => {
  const oldArgv = process.argv;
  afterEach(() => {
    process.argv = oldArgv;
    vi.restoreAllMocks();
  });
  const modulePath = new URL('./restore-cli.ts', import.meta.url).pathname;

  it('runs the CLI with argv.slice(2) when executed as the main module', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', modulePath, '--help'];
    vi.resetModules();
    await import('./restore-cli');
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('does not run when imported from another entrypoint or without argv[1]', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', '/somewhere/else.js', '--help'];
    vi.resetModules();
    await import('./restore-cli');
    process.argv = ['node'];
    vi.resetModules();
    await import('./restore-cli');
    expect(out).not.toHaveBeenCalled();
  });
});
