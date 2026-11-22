/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- fakes and deliberately malformed inputs are intentionally untyped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  unlink: vi.fn(),
  open: vi.fn(),
  readPinned: vi.fn(),
  collectBackup: vi.fn(),
  collectCapture: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat, unlink: mocks.unlink }));
vi.mock('./backup-reader', () => ({ openVerifiedTenantBackupV2: mocks.open }));
vi.mock('./restore-evidence', async () => {
  const actual = await vi.importActual<typeof import('./restore-evidence')>('./restore-evidence');
  return { ...actual, readPinnedRestoreFile: mocks.readPinned };
});
vi.mock('./supplement-collector', () => ({
  collectAwsSamlSupplementFromBackup: mocks.collectBackup,
  collectAwsSamlSupplementFromPinnedCapture: mocks.collectCapture,
}));

import {
  resolveAwsSupplementCollectorPlan,
  runAwsSupplementCollectorCli,
  type AwsSupplementCollectorPlan,
} from './collector-cli';
import { canonicalRestoreJson } from './restore-evidence';

const PLAN_ERR = 'aws_supplement_collector_plan_invalid';

function plan(): AwsSupplementCollectorPlan {
  return {
    formatVersion: 1,
    backup: {
      partPaths: ['/p'],
      receipt: {} as never,
      selection: {} as never,
      datasets: [],
      maxSnapshotAgeMs: 1,
      passphraseEnv: 'PASS_ENV',
    },
    capture: { path: '/c.json', expectedSha256: 'd'.repeat(64) },
    outputPath: '/out.json',
  };
}
const env = { PASS_ENV: 'secret' };
const resolve = (p: unknown, e: Record<string, string | undefined> = env) =>
  resolveAwsSupplementCollectorPlan(p as AwsSupplementCollectorPlan, e);

describe('resolveAwsSupplementCollectorPlan validation', () => {
  it('returns resolved shape without passphraseEnv', () => {
    const r = resolve(plan());
    expect(r.outputPath).toBe('/out.json');
    expect(r.backup).toMatchObject({ passphrase: 'secret', partPaths: ['/p'] });
    expect('passphraseEnv' in r.backup).toBe(false);
  });
  it.each([
    ['capture missing', (p: any) => delete p.capture],
    ['capture null', (p: any) => (p.capture = null)],
    ['capture string', (p: any) => (p.capture = 'x')],
    ['capture bundle with extra key', (p: any) => (p.capture = { source: 'bundle', path: 'x' })],
    ['capture bad source', (p: any) => (p.capture = { source: 'other' })],
    ['capture path not string', (p: any) => (p.capture = { path: 1, expectedSha256: 'x' })],
    ['capture sha not string', (p: any) => (p.capture = { path: 'x', expectedSha256: 1 })],
    ['capture extra key', (p: any) => (p.capture.extra = 1)],
    ['formatVersion 2', (p: any) => (p.formatVersion = 2)],
    ['partPaths not array', (p: any) => (p.backup.partPaths = 'x')],
    ['outputPath not string', (p: any) => (p.outputPath = 1)],
    ['passphraseEnv not string', (p: any) => (p.backup.passphraseEnv = 1)],
    ['passphraseEnv lowercase', (p: any) => (p.backup.passphraseEnv = 'pass')],
    ['passphraseEnv digit start', (p: any) => (p.backup.passphraseEnv = '1PASS')],
    ['passphraseEnv suffix junk', (p: any) => (p.backup.passphraseEnv = 'PASS-x')],
    ['passphraseEnv prefix junk', (p: any) => (p.backup.passphraseEnv = '-PASS')],
    ['passphraseEnv too long', (p: any) => (p.backup.passphraseEnv = 'A' + 'B'.repeat(128))],
    ['top-level extra key', (p: any) => (p.extra = 1)],
    ['backup extra key', (p: any) => (p.backup.extra = 1)],
    ['backup missing key', (p: any) => delete p.backup.datasets],
  ])('rejects %s', (_n, mutate) => {
    const p = plan();
    mutate(p);
    expect(() => resolve(p, { ...env, [p.backup?.passphraseEnv]: 'x' })).toThrow(
      new Error(PLAN_ERR)
    );
  });
  it('rejects non-object plan values and arrays', () => {
    expect(() => resolve(null)).toThrow(PLAN_ERR);
    expect(() => resolve([])).toThrow(PLAN_ERR);
    expect(() => resolve('x')).toThrow(PLAN_ERR);
  });
  it('rejects missing or empty passphrase env', () => {
    expect(() => resolve(plan(), {})).toThrow(PLAN_ERR);
    expect(() => resolve(plan(), { PASS_ENV: '' })).toThrow(PLAN_ERR);
  });
  it('accepts a 128-char env name and a bundle capture', () => {
    const p = plan();
    const name = 'A' + 'B'.repeat(127);
    p.backup.passphraseEnv = name;
    p.capture = { source: 'bundle' };
    expect(resolve(p, { [name]: 'v' }).capture).toEqual({ source: 'bundle' });
  });
});

describe('runAwsSupplementCollectorCli', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const oldExit = process.exitCode;
  const backup = { close: vi.fn() };
  const receipt = { outputPath: '/out.json', rows: 3 };
  const goodPlan = () => plan();
  const raw = () => canonicalRestoreJson(goodPlan());
  const goodArgs = ['--plan', '/plan.json', '--plan-sha256', 'abc'];

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.stubEnv('PASS_ENV', 'secret');
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    backup.close.mockResolvedValue(undefined);
    mocks.open.mockResolvedValue(backup);
    mocks.readPinned.mockResolvedValue(new TextEncoder().encode(raw()));
    mocks.collectBackup.mockResolvedValue(receipt);
    mocks.collectCapture.mockResolvedValue(receipt);
    mocks.lstat.mockResolvedValue({ dev: 1n, ino: 2n });
    mocks.unlink.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.exitCode = oldExit;
    vi.restoreAllMocks();
  });

  it('prints usage for --help only', async () => {
    await runAwsSupplementCollectorCli(['--help']);
    expect(out).toHaveBeenCalledWith(
      'Usage: node dist/collector-cli.mjs --plan /absolute/plan.json --plan-sha256 <trusted SHA256>\n'
    );
    expect(mocks.readPinned).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [[]],
    [['--plan', '/p', '--plan-sha256']],
    [['--help', 'x']],
    [['--plan', '/p', '--plan-sha256', 'h', 'extra']],
    [['--bad', '/p', '--plan-sha256', 'h']],
    [['--plan', '/p', '--bad', 'h']],
  ])('fails on bad args %j', async (args) => {
    await runAwsSupplementCollectorCli(args);
    expect(err).toHaveBeenCalledWith('aws_supplement_collector_failed\n');
    expect(process.exitCode).toBe(1);
    expect(mocks.readPinned).not.toHaveBeenCalled();
  });

  it('reads the pinned file with a 4 MiB limit and collects from a pinned capture', async () => {
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.readPinned).toHaveBeenCalledWith('/plan.json', 'abc', 4 * 1024 * 1024);
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'secret', partPaths: ['/p'] })
    );
    expect(mocks.collectCapture).toHaveBeenCalledWith({
      backup,
      capturePath: '/c.json',
      expectedCaptureSha256: 'd'.repeat(64),
      outputPath: '/out.json',
    });
    expect(mocks.collectBackup).not.toHaveBeenCalled();
    expect(mocks.lstat).toHaveBeenCalledWith('/out.json', { bigint: true });
    expect(backup.close).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledWith(
      `${canonicalRestoreJson({ status: 'collected', ...receipt })}\n`
    );
    expect(process.exitCode).toBeUndefined();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('collects from the bundle capture', async () => {
    const p = goodPlan();
    p.capture = { source: 'bundle' };
    mocks.readPinned.mockResolvedValue(new TextEncoder().encode(canonicalRestoreJson(p)));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.collectBackup).toHaveBeenCalledWith({ backup, outputPath: '/out.json' });
    expect(mocks.collectCapture).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical plan', async () => {
    mocks.readPinned.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(goodPlan(), null, 2))
    );
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects non-UTF8 plan bytes', async () => {
    mocks.readPinned.mockResolvedValue(new Uint8Array([0xff, 0xfe]));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('removes the output it created and closes the backup on later failure', async () => {
    backup.close.mockRejectedValueOnce(new Error('close'));
    mocks.lstat.mockResolvedValue({ dev: 1n, ino: 2n });
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.unlink).toHaveBeenCalledWith('/out.json');
    expect(backup.close).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith('aws_supplement_collector_failed\n');
    expect(out).not.toHaveBeenCalled();
  });

  it('does not unlink when the output identity changed', async () => {
    backup.close.mockRejectedValueOnce(new Error('close'));
    mocks.lstat
      .mockResolvedValueOnce({ dev: 1n, ino: 2n })
      .mockResolvedValueOnce({ dev: 1n, ino: 3n });
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.unlink).not.toHaveBeenCalled();
    mocks.lstat
      .mockResolvedValueOnce({ dev: 1n, ino: 2n })
      .mockResolvedValueOnce({ dev: 9n, ino: 2n });
    backup.close.mockRejectedValueOnce(new Error('close'));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('does not unlink when the output vanished and tolerates unlink failure', async () => {
    backup.close.mockRejectedValueOnce(new Error('close'));
    mocks.lstat.mockResolvedValueOnce({ dev: 1n, ino: 2n }).mockRejectedValueOnce(new Error('x'));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    backup.close.mockRejectedValueOnce(new Error('close'));
    mocks.unlink.mockRejectedValueOnce(new Error('u'));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(process.exitCode).toBe(1);
  });

  it('closes the backup (swallowing close errors) when collection fails', async () => {
    mocks.collectCapture.mockRejectedValue(new Error('boom'));
    backup.close.mockRejectedValue(new Error('close'));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(backup.close).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith('aws_supplement_collector_failed\n');
  });

  it('does not close a backup that was never opened', async () => {
    mocks.open.mockRejectedValue(new Error('open'));
    await runAwsSupplementCollectorCli(goodArgs);
    expect(backup.close).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('module entrypoint', () => {
  const oldArgv = process.argv;
  afterEach(() => {
    process.argv = oldArgv;
    vi.restoreAllMocks();
  });
  const modulePath = new URL('./collector-cli.ts', import.meta.url).pathname;

  it('runs the CLI with argv.slice(2) when executed as the main module', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', modulePath, '--help'];
    vi.resetModules();
    await import('./collector-cli');
    expect(out).toHaveBeenCalledTimes(1);
    expect(pathToFileURL(modulePath).href).toBe(
      new URL('./collector-cli.ts', import.meta.url).href
    );
  });

  it('does not run when imported from another entrypoint or without argv[1]', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', '/somewhere/else.js', '--help'];
    vi.resetModules();
    await import('./collector-cli');
    process.argv = ['node'];
    vi.resetModules();
    await import('./collector-cli');
    expect(out).not.toHaveBeenCalled();
  });
});
