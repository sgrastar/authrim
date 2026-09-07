import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { executeD1Command, executeD1Migration, putKVKeyByNamespaceId } from '../core/cloudflare.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const WRANGLER_OAUTH_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const WRANGLER_AUTH_ERROR =
  'Authentication error [code: 10000] while requesting ' +
  `https://api.cloudflare.com/client/v4/accounts/${WRANGLER_OAUTH_ACCOUNT_ID}/d1/database`;
const WRANGLER_WHOAMI_RESULT = {
  exitCode: 0,
  stdout: `You are logged in with an OAuth Token.\nAccount ID: ${WRANGLER_OAUTH_ACCOUNT_ID}`,
  stderr: '',
} as never;

describe('executeD1Migration retry handling', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'authrim-d1-migration-retry-'));
    vi.mocked(execa).mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('retries transient D1 upload failures before succeeding', async () => {
    const migrationPath = join(root, '001_core_foundation.sql');
    writeFileSync(migrationPath, 'CREATE TABLE example (id TEXT PRIMARY KEY);');
    let privateMigrationPath = '';
    vi.mocked(execa)
      .mockImplementationOnce(async (_command, args) => {
        const fileIndex = args.indexOf('--file');
        privateMigrationPath = args[fileIndex + 1];
        const metadata = lstatSync(privateMigrationPath);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        expect(metadata.nlink).toBe(1);
        if (process.platform !== 'win32') {
          expect(metadata.mode & 0o777).toBe(0o600);
          expect(lstatSync(dirname(privateMigrationPath)).mode & 0o777).toBe(0o700);
        }
        expect(readFileSync(privateMigrationPath, 'utf8')).toContain('CREATE TABLE example');
        return {
          exitCode: 1,
          stdout: 'Uploading complete.',
          stderr:
            'ERROR File could not be uploaded. Please retry. Got response: <Error><Code>InternalError</Code></Error>',
        } as never;
      })
      .mockImplementationOnce(async (_command, args) => {
        const fileIndex = args.indexOf('--file');
        expect(args[fileIndex + 1]).toBe(privateMigrationPath);
        const metadata = lstatSync(privateMigrationPath);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o600);
        return { exitCode: 0, stdout: '', stderr: '' } as never;
      });

    const progress: string[] = [];
    const result = await executeD1Migration('test-db', migrationPath, (message) =>
      progress.push(message)
    );

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
    expect(progress.some((message) => message.includes('Transient D1 migration failure'))).toBe(
      true
    );
    expect(existsSync(privateMigrationPath)).toBe(false);
    expect(existsSync(dirname(privateMigrationPath))).toBe(false);
  });

  it('gives Cloudflare authentication error 10000 an extended retry window', async () => {
    const migrationPath = join(root, '002_core_protocol_and_consent.sql');
    writeFileSync(migrationPath, 'CREATE TABLE protocol_state (id TEXT PRIMARY KEY);');
    for (let attempt = 0; attempt < 7; attempt++) {
      vi.mocked(execa).mockResolvedValueOnce({
        exitCode: 1,
        stdout: 'Uploading complete.',
        stderr: WRANGLER_AUTH_ERROR,
      } as never);
      if (attempt === 0) vi.mocked(execa).mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT);
    }
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);

    const progress: string[] = [];
    const result = await executeD1Migration('test-db', migrationPath, (message) =>
      progress.push(message)
    );

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(9);
    expect(
      vi
        .mocked(execa)
        .mock.calls.filter(([, args]) => args.slice(0, 2).join(' ') === 'wrangler whoami')
    ).toHaveLength(1);
    expect(
      progress.some(
        (message) =>
          message.includes('Transient Cloudflare D1 authentication failure') &&
          message.includes('attempt 7/8')
      )
    ).toBe(true);
  });

  it('retries a Cloudflare D1 rate-limit rejection before running the migration', async () => {
    const migrationPath = join(root, '003_rate_limited.sql');
    writeFileSync(migrationPath, 'CREATE TABLE rate_limited (id TEXT PRIMARY KEY);');
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Too many requests [code: 971] HTTP 429',
      } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);

    const result = await executeD1Migration('test-db', migrationPath);

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  it('retries when authentication also prevents the ambiguous-commit check', async () => {
    const migrationPath = join(root, '002_core_protocol_and_consent.sql');
    writeFileSync(migrationPath, 'CREATE TABLE protocol_state (id TEXT PRIMARY KEY);');
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: 'Uploading complete.',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);
    const verifyCommitted = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('Authentication error [code: 10000]'));

    const result = await executeD1Migration('test-db', migrationPath, undefined, {
      verifyCommitted,
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(3);
    expect(verifyCommitted).toHaveBeenCalledTimes(2);
  });

  it('does not re-execute a migration while its commit state remains unverified', async () => {
    const migrationPath = join(root, '002_core_protocol_and_consent.sql');
    writeFileSync(migrationPath, 'CREATE TABLE protocol_state (id TEXT PRIMARY KEY);');
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'Uploading complete.',
      stderr: WRANGLER_AUTH_ERROR,
    } as never);
    const verifyCommitted = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(new Error('Authentication error [code: 10000]'));

    const result = await executeD1Migration('test-db', migrationPath, undefined, {
      verifyCommitted,
    });

    expect(result).toMatchObject({
      success: false,
    });
    expect(result.error).toContain('could not determine whether the migration committed');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
    expect(verifyCommitted).toHaveBeenCalledTimes(8);
  });

  it('does not retry deterministic SQL errors', async () => {
    const migrationPath = join(root, '001_bad.sql');
    writeFileSync(migrationPath, 'SELECT * FROM missing_table;');
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'SQLITE_ERROR: no such table: missing_table',
    } as never);

    const result = await executeD1Migration('test-db', migrationPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing_table');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it('does not mark duplicate column errors as successfully applied', async () => {
    const migrationPath = join(root, '001_duplicate_column.sql');
    writeFileSync(migrationPath, 'ALTER TABLE users_pii_tombstone ADD COLUMN created_at INTEGER;');
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'duplicate column name: created_at: SQLITE_ERROR',
    } as never);

    const result = await executeD1Migration('test-db', migrationPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain('duplicate column name');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });
});

describe('executeD1Command retry handling', () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalD1Token = process.env.CLOUDFLARE_D1_API_TOKEN;
  const originalWorkersToken = process.env.CLOUDFLARE_WORKERS_API_TOKEN;
  const originalKvToken = process.env.CLOUDFLARE_KV_API_TOKEN;
  const originalR2Token = process.env.CLOUDFLARE_R2_API_TOKEN;

  beforeEach(() => {
    vi.mocked(execa).mockReset();
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_D1_API_TOKEN;
    delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
    delete process.env.CLOUDFLARE_KV_API_TOKEN;
    delete process.env.CLOUDFLARE_R2_API_TOKEN;
  });

  afterEach(() => {
    if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    if (originalD1Token === undefined) delete process.env.CLOUDFLARE_D1_API_TOKEN;
    else process.env.CLOUDFLARE_D1_API_TOKEN = originalD1Token;
    if (originalWorkersToken === undefined) delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
    else process.env.CLOUDFLARE_WORKERS_API_TOKEN = originalWorkersToken;
    if (originalKvToken === undefined) delete process.env.CLOUDFLARE_KV_API_TOKEN;
    else process.env.CLOUDFLARE_KV_API_TOKEN = originalKvToken;
    if (originalR2Token === undefined) delete process.env.CLOUDFLARE_R2_API_TOKEN;
    else process.env.CLOUDFLARE_R2_API_TOKEN = originalR2Token;
  });

  it('retries an exact Cloudflare authentication error 10000 before succeeding', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' } as never);
    const progress: string[] = [];

    await expect(
      executeD1Command('control-db', 'SELECT 1;', {
        json: true,
        onProgress: (message) => progress.push(message),
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' });

    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler d1 execute',
      'wrangler whoami',
      'wrangler d1 execute',
    ]);
    expect(progress).toContain(
      '  ⚠️ Transient Cloudflare D1 authentication failure for control-db ' +
        '(attempt 1/8); retrying in 0s'
    );
  });

  it('uses the failed request account path as authority when no account env is set', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'You are logged in with an OAuth Token.\n' +
          'Account ID: fedcba9876543210fedcba9876543210',
        stderr: '',
      } as never);

    await expect(executeD1Command('control-db', 'SELECT 1;')).rejects.toThrow(
      'cloudflare_oauth_account_id_mismatch_after_refresh'
    );
    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler d1 execute',
      'wrangler whoami',
    ]);
  });

  it('does not refresh OAuth without pre-refresh account authority', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Authentication error [code: 10000]',
    } as never);

    await expect(executeD1Command('control-db', 'SELECT 1;')).rejects.toThrow(
      'cloudflare_oauth_account_id_required_before_refresh'
    );
    expect(vi.mocked(execa)).toHaveBeenCalledOnce();
  });

  it('does not refresh Wrangler OAuth when an explicit API token is authoritative', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'operator-selected-token';
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' } as never);

    await expect(executeD1Command('control-db', 'SELECT 1;', { json: true })).resolves.toEqual({
      stdout: '[]',
      stderr: '',
    });
    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler d1 execute',
      'wrangler d1 execute',
    ]);
  });

  it('does not mistake an unrelated Workers resource secret for Wrangler credentials', async () => {
    process.env.CLOUDFLARE_WORKERS_API_TOKEN = 'control-worker-secret';
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' } as never);

    await expect(executeD1Command('control-db', 'SELECT 1;', { json: true })).resolves.toEqual({
      stdout: '[]',
      stderr: '',
    });
    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler d1 execute',
      'wrangler whoami',
      'wrangler d1 execute',
    ]);
  });

  it('fails closed when refreshed Wrangler OAuth belongs to another account', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = WRANGLER_OAUTH_ACCOUNT_ID;
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'You are logged in with an OAuth Token.\n' +
          'Account ID: fedcba9876543210fedcba9876543210',
        stderr: '',
      } as never);

    await expect(executeD1Command('control-db', 'SELECT 1;')).rejects.toThrow(
      'cloudflare_oauth_account_id_mismatch_after_refresh'
    );
    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler d1 execute',
      'wrangler whoami',
    ]);
  });

  it('does not retry a deterministic D1 command failure', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'SQLITE_ERROR: no such table: missing_table',
    } as never);

    await expect(executeD1Command('control-db', 'SELECT * FROM missing_table;')).rejects.toThrow(
      'missing_table'
    );
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it('retries a rejected D1 command after provider rate limiting', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 429: rate limit exceeded [code: 971]',
      } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' } as never);

    await expect(executeD1Command('control-db', 'SELECT 1;', { json: true })).resolves.toEqual({
      stdout: '[]',
      stderr: '',
    });
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });
});

describe('putKVKeyByNamespaceId retry handling', () => {
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalD1Token = process.env.CLOUDFLARE_D1_API_TOKEN;
  const originalWorkersToken = process.env.CLOUDFLARE_WORKERS_API_TOKEN;
  const originalKvToken = process.env.CLOUDFLARE_KV_API_TOKEN;
  const originalR2Token = process.env.CLOUDFLARE_R2_API_TOKEN;

  beforeEach(() => {
    vi.mocked(execa).mockReset();
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_D1_API_TOKEN;
    delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
    delete process.env.CLOUDFLARE_KV_API_TOKEN;
    delete process.env.CLOUDFLARE_R2_API_TOKEN;
  });

  afterEach(() => {
    if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    if (originalD1Token === undefined) delete process.env.CLOUDFLARE_D1_API_TOKEN;
    else process.env.CLOUDFLARE_D1_API_TOKEN = originalD1Token;
    if (originalWorkersToken === undefined) delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
    else process.env.CLOUDFLARE_WORKERS_API_TOKEN = originalWorkersToken;
    if (originalKvToken === undefined) delete process.env.CLOUDFLARE_KV_API_TOKEN;
    else process.env.CLOUDFLARE_KV_API_TOKEN = originalKvToken;
    if (originalR2Token === undefined) delete process.env.CLOUDFLARE_R2_API_TOKEN;
    else process.env.CLOUDFLARE_R2_API_TOKEN = originalR2Token;
  });

  it('refreshes Wrangler OAuth once before retrying a rejected KV write', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);

    await expect(putKVKeyByNamespaceId('namespace-id', 'setup:key', 'value')).resolves.toBe(
      undefined
    );
    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler kv key',
      'wrangler whoami',
      'wrangler kv key',
    ]);
  });

  it('does not mistake a Control KV resource secret for Wrangler credentials', async () => {
    process.env.CLOUDFLARE_KV_API_TOKEN = 'control-kv-secret';
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: WRANGLER_AUTH_ERROR,
      } as never)
      .mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);

    await expect(putKVKeyByNamespaceId('namespace-id', 'setup:key', 'value')).resolves.toBe(
      undefined
    );
    expect(vi.mocked(execa).mock.calls.map(([, args]) => args.slice(0, 3).join(' '))).toEqual([
      'wrangler kv key',
      'wrangler whoami',
      'wrangler kv key',
    ]);
  });
});
