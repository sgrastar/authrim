import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHRIM_MIGRATIONS_COLUMN_ALTERS,
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  AUTHRIM_MIGRATION_HISTORY_SQL,
} from '@authrim/ar-lib-core/control-plane';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const WRANGLER_WHOAMI_STDOUT =
  'You are logged in with an OAuth Token.\n' + 'Account ID: 0123456789abcdef0123456789abcdef';
const WRANGLER_AUTH_ERROR =
  'Authentication error [code: 10000] while requesting ' +
  'https://api.cloudflare.com/client/v4/accounts/' +
  '0123456789abcdef0123456789abcdef/d1/database';

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  calculateD1MigrationChecksum,
  collectManifestMigrationChecksumEvidence,
  executeD1Batch,
  findMigrationsRoot,
  getD1MigrationStatus,
  getD1MigrationStatusForEnvironment,
  queryD1Rows,
  runD1Migrations,
  shouldRefreshD1OAuthCredential,
} from '../core/cloudflare.js';
import {
  DRAFT_RELEASE_MANIFEST_FILENAME,
  writeReleaseMigrationManifest,
} from '../core/release-migrations.js';

describe('D1 migration history safety', () => {
  const tempDirs: string[] = [];
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalD1ApiToken = process.env.CLOUDFLARE_D1_API_TOKEN;

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_D1_API_TOKEN;
  });

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
    if (originalD1ApiToken === undefined) {
      delete process.env.CLOUDFLARE_D1_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_D1_API_TOKEN = originalD1ApiToken;
    }
    vi.unstubAllGlobals();
  });

  function createMigrationFixture(): { directory: string; filename: string; path: string } {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-migration-history-'));
    tempDirs.push(directory);
    const filename = '001_existing_schema.sql';
    const path = join(directory, filename);
    writeFileSync(path, 'CREATE TABLE existing_schema (id TEXT PRIMARY KEY);');
    return { directory, filename, path };
  }

  it('does not borrow migrations from the process cwd in strict source mode', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'authrim-source-without-migrations-'));
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'authrim-unrelated-checkout-'));
    tempDirs.push(sourceRoot, fallbackRoot);
    mkdirSync(join(fallbackRoot, 'migrations'), { recursive: true });
    const originalCwd = process.cwd();
    try {
      process.chdir(fallbackRoot);
      await expect(
        findMigrationsRoot(sourceRoot, undefined, { strictRoot: true })
      ).resolves.toEqual({
        path: null,
        searchPaths: [join(sourceRoot, 'migrations'), join(sourceRoot, 'authrim', 'migrations')],
      });
      await expect(findMigrationsRoot(sourceRoot)).resolves.toMatchObject({
        path: join(process.cwd(), 'migrations'),
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('executes D1 statements as one strict provider batch', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          { success: true, results: [] },
          { success: true, results: [{ id: 'row-1' }] },
        ],
      }),
    });
    const batch = [
      { sql: 'CREATE TABLE record (id TEXT PRIMARY KEY)' },
      { sql: 'SELECT id FROM record WHERE id = ?', params: ['row-1'] },
    ] as const;

    await expect(executeD1Batch('11111111-1111-1111-1111-111111111111', batch)).resolves.toEqual([
      { success: true, results: [] },
      { success: true, results: [{ id: 'row-1' }] },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/11111111-1111-1111-1111-111111111111/query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ batch }),
      })
    );
  });

  it('rejects partial D1 batch success and malformed identifiers', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ success: false, results: [] }],
      }),
    });
    await expect(
      executeD1Batch('11111111-1111-1111-1111-111111111111', [{ sql: 'SELECT 1' }])
    ).rejects.toThrow('cloudflare_d1_batch_unsuccessful');
    await expect(executeD1Batch('../database', [{ sql: 'SELECT 1' }])).rejects.toThrow(
      'invalid_d1_database_id'
    );
  });

  it('does not use the Control Worker split D1 token for Setup D1 batches', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'generic-token';
    process.env.CLOUDFLARE_D1_API_TOKEN = 'd1-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [{ success: true, results: [] }] }),
    });

    await executeD1Batch('11111111-1111-1111-1111-111111111111', [{ sql: 'SELECT 1' }]);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer generic-token' }),
      })
    );
  });

  it('refreshes only an OAuth credential once for an authentication rejection', async () => {
    expect(shouldRefreshD1OAuthCredential({ status: 401, source: 'oauth', attempt: 1 })).toBe(true);
    expect(shouldRefreshD1OAuthCredential({ status: 403, source: 'oauth', attempt: 1 })).toBe(true);
    expect(shouldRefreshD1OAuthCredential({ status: 403, source: 'oauth', attempt: 2 })).toBe(
      false
    );
    expect(shouldRefreshD1OAuthCredential({ status: 403, source: 'env', attempt: 1 })).toBe(false);
  });

  it('does not accept a Control Worker D1 token as the Setup operator credential', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_D1_API_TOKEN = 'd1-token';

    await expect(
      executeD1Batch('11111111-1111-1111-1111-111111111111', [{ sql: 'SELECT 1' }])
    ).rejects.toThrow('cloudflare_api_credentials_required');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('uses an explicit target account without repeating Wrangler account discovery', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [{ success: true, results: [] }] }),
    });

    await executeD1Batch('11111111-1111-1111-1111-111111111111', [{ sql: 'SELECT 1' }], {
      accountId: 'fedcba9876543210fedcba9876543210',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/accounts/fedcba9876543210fedcba9876543210/'),
      expect.any(Object)
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('extracts noisy Wrangler JSON and skips an already applied migration', async () => {
    const fixture = createMigrationFixture();
    const checksum = calculateD1MigrationChecksum(fixture.path);
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return {
          exitCode: 0,
          stdout:
            '[wrangler:notice] update available\n' +
            JSON.stringify([
              {
                results: [
                  {
                    filename: fixture.filename,
                    checksum,
                    applied_at: 123,
                    execution_time_ms: 10,
                  },
                ],
              },
            ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runD1Migrations('test-db', fixture.directory)).resolves.toEqual({
      success: true,
      appliedCount: 0,
      skippedCount: 1,
    });
    expect(execaMock.mock.calls.some(([, args]) => args.includes('--file'))).toBe(false);
  });

  it('retries transient authentication failures while preparing migration tracking', async () => {
    const fixture = createMigrationFixture();
    const progress: string[] = [];
    let createAttempts = 0;
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 2).join(' ') === 'wrangler whoami') {
        return { exitCode: 0, stdout: WRANGLER_WHOAMI_STDOUT, stderr: '' };
      }
      const commandIndex = args.indexOf('--command');
      const sql = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
      if (sql === AUTHRIM_MIGRATIONS_TABLE_SQL) {
        createAttempts++;
        if (createAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: WRANGLER_AUTH_ERROR,
          };
        }
      }
      if (sql && AUTHRIM_MIGRATIONS_COLUMN_ALTERS.some((candidate) => candidate === sql)) {
        const column = sql.match(/ADD COLUMN\s+(\w+)/u)?.[1] ?? 'checksum';
        return {
          exitCode: 1,
          stdout: '',
          stderr: `duplicate column name: ${column}: SQLITE_ERROR [code: 7500]`,
        };
      }
      if (sql === AUTHRIM_MIGRATION_HISTORY_SQL) {
        return { exitCode: 0, stdout: JSON.stringify([{ results: [] }]), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      runD1Migrations('test-db', fixture.directory, (message) => progress.push(message))
    ).resolves.toEqual({ success: true, appliedCount: 1, skippedCount: 0 });
    expect(createAttempts).toBe(2);
    expect(
      progress.some(
        (message) =>
          message.includes('Transient Cloudflare D1 authentication failure') &&
          message.includes('test-db') &&
          message.includes('attempt 1/8')
      )
    ).toBe(true);
  });

  it('does not hide deterministic migration tracking preparation failures', async () => {
    const fixture = createMigrationFixture();
    const progress: string[] = [];
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      const commandIndex = args.indexOf('--command');
      const sql = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
      if (sql === AUTHRIM_MIGRATIONS_TABLE_SQL) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (sql === AUTHRIM_MIGRATIONS_COLUMN_ALTERS[0]) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'SQLITE_ERROR: authorization denied while altering migration history',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await runD1Migrations('test-db', fixture.directory, (message) =>
      progress.push(message)
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not update migration tracking for test-db');
    expect(result.error).toContain('authorization denied');
    expect(progress.some((message) => message.includes('authorization denied'))).toBe(true);
    expect(execaMock.mock.calls.some(([, args]) => args.includes('--file'))).toBe(false);
  });

  it('prefers the Cloudflare D1 API for migration history in CI', async () => {
    const fixture = createMigrationFixture();
    const checksum = calculateD1MigrationChecksum(fixture.path);
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ name: 'test-db', uuid: 'database-id' }],
          result_info: { total_count: 1 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [
            {
              success: true,
              results: [
                {
                  filename: fixture.filename,
                  checksum,
                  applied_at: 123,
                  execution_time_ms: 10,
                },
              ],
            },
          ],
        }),
      });
    execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(runD1Migrations('test-db', fixture.directory)).resolves.toEqual({
      success: true,
      appliedCount: 0,
      skippedCount: 1,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL(
        'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/database-id/query'
      ),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sql: AUTHRIM_MIGRATION_HISTORY_SQL,
        }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(
      execaMock.mock.calls.some(([, args]) =>
        args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')
      )
    ).toBe(false);
    expect(execaMock.mock.calls.some(([, args]) => args.includes('--file'))).toBe(false);
  });

  it('falls back to migration history emitted on Wrangler stderr when the API fails', async () => {
    const fixture = createMigrationFixture();
    const checksum = calculateD1MigrationChecksum(fixture.path);
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return {
          exitCode: 0,
          stdout: '[wrangler:notice] JSON result follows on stderr',
          stderr: JSON.stringify([
            {
              success: true,
              results: [
                {
                  filename: fixture.filename,
                  checksum,
                  applied_at: 123,
                  execution_time_ms: 10,
                },
              ],
            },
          ]),
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runD1Migrations('test-db', fixture.directory)).resolves.toEqual({
      success: true,
      appliedCount: 0,
      skippedCount: 1,
    });
    expect(execaMock.mock.calls.some(([, args]) => args.includes('--file'))).toBe(false);
  });

  it('falls back to the D1 API when Wrangler query output does not contain JSON', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '[wrangler:notice] query completed without structured output',
      stderr: '[wrangler:notice] see the dashboard for details',
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ name: 'test-db', uuid: 'database-id' }],
          result_info: { total_count: 1 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ success: true, results: [{ state: 'ready' }] }],
        }),
      });

    await expect(
      queryD1Rows<{ state: string }>('test-db', 'SELECT state FROM rollout')
    ).resolves.toEqual([{ state: 'ready' }]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL(
        'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/database-id/query'
      ),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sql: 'SELECT state FROM rollout' }),
      })
    );
  });

  it('resolves an immutable D1 UUID before unrelated same-name inventory rows', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '[wrangler:notice] query completed without structured output',
      stderr: '',
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [
            { name: 'fixed-name', uuid: 'replacement-id' },
            { name: 'fixed-name', uuid: 'locked-database-id' },
          ],
          result_info: { total_count: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ success: true, results: [{ state: 'ready' }] }],
        }),
      });

    await expect(
      queryD1Rows<{ state: string }>('locked-database-id', 'SELECT state FROM rollout')
    ).resolves.toEqual([{ state: 'ready' }]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL(
        'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/locked-database-id/query'
      ),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('reports both providers when Wrangler and the D1 API query fail', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '[wrangler:notice] no JSON payload',
      stderr: '',
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(queryD1Rows('test-db', 'SELECT state FROM rollout')).rejects.toThrow(
      'Could not query D1 via Wrangler (Wrangler stdout and stderr did not contain a valid D1 query result) or the Cloudflare API (Cloudflare D1 database list failed (503))'
    );
  });

  it('refuses to execute migrations when applied history cannot be parsed', async () => {
    const fixture = createMigrationFixture();
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return {
          exitCode: 0,
          stdout: '[wrangler:notice] no JSON payload',
          stderr: '[wrangler:error] no query result',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await runD1Migrations('test-db', fixture.directory);

    expect(result.success).toBe(false);
    expect(result.appliedCount).toBe(0);
    expect(result.error).toContain('Could not read migration history');
    expect(result.error).toContain('Refusing to run migrations');
    expect(execaMock.mock.calls.some(([, args]) => args.includes('--file'))).toBe(false);
  });

  it('records the migration in the same SQL transaction as its schema changes', async () => {
    const fixture = createMigrationFixture();
    let executedSql = '';
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ results: [] }]),
          stderr: '',
        };
      }
      const fileIndex = args.indexOf('--file');
      if (fileIndex >= 0) executedSql = readFileSync(args[fileIndex + 1], 'utf-8');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runD1Migrations('test-db', fixture.directory)).resolves.toEqual({
      success: true,
      appliedCount: 1,
      skippedCount: 0,
    });
    expect(executedSql).toContain('CREATE TABLE existing_schema');
    expect(executedSql).toContain('INSERT INTO authrim_migrations');
    expect(executedSql).toContain(fixture.filename);
    expect(executedSql).toContain("CAST(strftime('%s', 'now') AS INTEGER) * 1000");
    expect(executedSql).not.toMatch(/applied_at[^\n]*\b\d{13}\b/u);
  });

  it('backfills legacy blank checksums only when a published manifest authorizes it', async () => {
    const fixture = createMigrationFixture();
    const checksum = calculateD1MigrationChecksum(fixture.path);
    let historyQueries = 0;
    let backfillSql = '';
    let backfillAttempts = 0;
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(0, 2).join(' ') === 'wrangler whoami') {
        return { exitCode: 0, stdout: WRANGLER_WHOAMI_STDOUT, stderr: '' };
      }
      const command = args.join(' ');
      if (command.includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        historyQueries += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              results: [
                {
                  filename: fixture.filename,
                  checksum: historyQueries === 1 ? null : checksum,
                  applied_at: 123,
                  execution_time_ms: null,
                },
              ],
            },
          ]),
          stderr: '',
        };
      }
      if (command.includes('UPDATE authrim_migrations SET checksum')) {
        backfillSql = command;
        backfillAttempts += 1;
        if (backfillAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: WRANGLER_AUTH_ERROR,
          };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      runD1Migrations('test-db', fixture.directory, undefined, {
        manifestFiles: [{ path: fixture.filename, checksum }],
        releaseVersion: '1.0.0',
        backfillLegacyChecksums: true,
      })
    ).resolves.toEqual({ success: true, appliedCount: 0, skippedCount: 1 });
    expect(backfillSql).toContain(fixture.filename);
    expect(backfillSql).toContain(checksum);
    expect(backfillAttempts).toBe(2);
  });

  it('backfills legacy superseded rows before materializing a consolidated release file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-release-legacy-superseded-'));
    tempDirs.push(directory);
    const sourcePath = join(directory, '001_draft.sql');
    writeFileSync(sourcePath, 'CREATE TABLE legacy_draft (id TEXT PRIMARY KEY);');
    const sourceChecksum = calculateD1MigrationChecksum(sourcePath);
    rmSync(sourcePath);
    const bundlePath = join(directory, '001_release.sql');
    writeFileSync(bundlePath, 'CREATE TABLE legacy_draft (id TEXT PRIMARY KEY);');
    const bundleChecksum = calculateD1MigrationChecksum(bundlePath);
    let historyQueries = 0;
    let backfillSql = '';
    let consolidatedRecordAttempts = 0;
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      const command = args.join(' ');
      if (command.includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        historyQueries += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              results: [
                {
                  filename: '001_draft.sql',
                  checksum: historyQueries === 1 ? null : sourceChecksum,
                  applied_at: 123,
                  execution_time_ms: null,
                },
              ],
            },
          ]),
          stderr: '',
        };
      }
      if (command.includes('UPDATE authrim_migrations SET checksum')) backfillSql = command;
      if (
        command.includes('INSERT INTO authrim_migrations') &&
        command.includes('001_release.sql')
      ) {
        consolidatedRecordAttempts += 1;
        if (consolidatedRecordAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'HTTP 429: rate limit exceeded [code: 971]',
          };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      runD1Migrations('test-db', directory, undefined, {
        manifestFiles: [
          {
            path: '001_release.sql',
            checksum: bundleChecksum,
            supersedes: [{ path: '001_draft.sql', checksum: sourceChecksum }],
          },
        ],
        releaseVersion: '1.0.0',
        backfillLegacyChecksums: true,
      })
    ).resolves.toEqual({ success: true, appliedCount: 0, skippedCount: 1 });
    expect(backfillSql).toContain('001_draft.sql');
    expect(backfillSql).toContain(sourceChecksum);
    expect(consolidatedRecordAttempts).toBe(2);
  });

  it('rejects conflicting checksum evidence in a published release manifest', () => {
    expect(() =>
      collectManifestMigrationChecksumEvidence([
        { path: '001.sql', checksum: 'a'.repeat(64) },
        {
          path: '002.sql',
          checksum: 'b'.repeat(64),
          supersedes: [{ path: '001.sql', checksum: 'c'.repeat(64) }],
        },
      ])
    ).toThrow('Conflicting release manifest checksums: 001.sql');
  });

  it('fails status when a release manifest checksum does not match the local SQL', async () => {
    const fixture = createMigrationFixture();
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return { exitCode: 0, stdout: JSON.stringify([{ results: [] }]), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const status = await getD1MigrationStatus('test-db', fixture.directory, 'core', {
      manifestFiles: [{ path: fixture.filename, checksum: 'f'.repeat(64) }],
    });
    expect(status.success).toBe(false);
    expect(status.error).toContain('Release manifest checksum mismatch');
  });

  it('queries environment migration status by pinned UUID while preserving display names', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'authrim-environment-migration-status-'));
    tempDirs.push(rootDirectory);
    const migrationsRoot = join(rootDirectory, 'migrations');
    mkdirSync(join(migrationsRoot, 'pii'), { recursive: true });
    mkdirSync(join(migrationsRoot, 'admin'), { recursive: true });
    writeReleaseMigrationManifest(join(migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME), {
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        { id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [] },
        { id: 'd1-pii', dialect: 'sqlite', logicalRoles: ['pii'], files: [] },
        { id: 'd1-admin', dialect: 'sqlite', logicalRoles: ['admin'], files: [] },
      ],
    });
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([{ results: [] }]),
      stderr: '',
    });

    const status = await getD1MigrationStatusForEnvironment('test', rootDirectory, undefined, {
      productVersion: '0.4.0',
      allowDraft: true,
      databaseIdentifiers: {
        core: 'core-immutable-id',
        pii: 'pii-immutable-id',
        admin: 'admin-immutable-id',
      },
    });

    expect(status.databases.map((database) => database.dbName)).toEqual([
      'test-authrim-core-db',
      'test-authrim-pii-db',
      'test-authrim-admin-db',
    ]);
    const queriedIdentifiers = new Set(
      execaMock.mock.calls
        .map(([, args]) => {
          const values = args as string[];
          const executeIndex = values.indexOf('execute');
          return executeIndex >= 0 ? values[executeIndex + 1] : undefined;
        })
        .filter((value): value is string => typeof value === 'string')
    );
    expect(queriedIdentifiers).toEqual(
      new Set(['core-immutable-id', 'pii-immutable-id', 'admin-immutable-id'])
    );
    expect(queriedIdentifiers.has('test-authrim-core-db')).toBe(false);
  });

  it('fails closed when a pinned environment migration identifier set is incomplete', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'authrim-environment-migration-status-'));
    tempDirs.push(rootDirectory);
    const migrationsRoot = join(rootDirectory, 'migrations');
    mkdirSync(join(migrationsRoot, 'pii'), { recursive: true });
    mkdirSync(join(migrationsRoot, 'admin'), { recursive: true });
    writeReleaseMigrationManifest(join(migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME), {
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        { id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [] },
        { id: 'd1-pii', dialect: 'sqlite', logicalRoles: ['pii'], files: [] },
        { id: 'd1-admin', dialect: 'sqlite', logicalRoles: ['admin'], files: [] },
      ],
    });

    await expect(
      getD1MigrationStatusForEnvironment('test', rootDirectory, undefined, {
        productVersion: '0.4.0',
        allowDraft: true,
        databaseIdentifiers: { core: 'core-immutable-id' },
      })
    ).rejects.toThrow('fixed_migration_database_id_required:pii');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('refuses a selected migration file outside the exact release manifest', async () => {
    const fixture = createMigrationFixture();
    const extraFilename = '002_unreleased_schema.sql';
    writeFileSync(join(fixture.directory, extraFilename), 'CREATE TABLE unreleased (id TEXT);');
    const checksum = calculateD1MigrationChecksum(fixture.path);

    const result = await runD1Migrations('test-db', fixture.directory, undefined, {
      manifestFiles: [{ path: fixture.filename, checksum }],
      onlyFiles: new Set([extraFilename]),
      releaseVersion: '1.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not part of the selected release manifest');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('reports only migration files selected by the exact release manifest', async () => {
    const fixture = createMigrationFixture();
    writeFileSync(
      join(fixture.directory, '002_unreleased_schema.sql'),
      'CREATE TABLE unreleased (id TEXT);'
    );
    const checksum = calculateD1MigrationChecksum(fixture.path);
    const progress: string[] = [];
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return { exitCode: 0, stdout: JSON.stringify([{ results: [] }]), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      runD1Migrations('test-db', fixture.directory, (message) => progress.push(message), {
        manifestFiles: [{ path: fixture.filename, checksum }],
        releaseVersion: '0.4.0',
      })
    ).resolves.toEqual({ success: true, appliedCount: 1, skippedCount: 0 });
    expect(progress).toContain('  Found 1 migration files');
    expect(progress).not.toContain('  Found 2 migration files');
  });

  it('auto-discovers supersedes metadata for legacy deploy and tenant call paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-release-auto-discovery-'));
    tempDirs.push(directory);
    const sourceSql = 'CREATE TABLE draft_schema (id TEXT PRIMARY KEY);';
    const sourcePath = join(directory, '001_draft_schema.sql');
    writeFileSync(sourcePath, sourceSql);
    const sourceChecksum = calculateD1MigrationChecksum(sourcePath);
    rmSync(sourcePath);
    const bundlePath = join(directory, '001_release_1_0_0.sql');
    writeFileSync(bundlePath, sourceSql);
    const bundleChecksum = calculateD1MigrationChecksum(bundlePath);
    writeReleaseMigrationManifest(join(directory, DRAFT_RELEASE_MANIFEST_FILENAME), {
      formatVersion: 1,
      productVersion: '1.0.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          logicalRoles: ['core'],
          files: [
            {
              path: '001_release_1_0_0.sql',
              checksum: bundleChecksum,
              supersedes: [{ path: '001_draft_schema.sql', checksum: sourceChecksum }],
            },
          ],
        },
      ],
    });
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              results: [
                {
                  filename: '001_draft_schema.sql',
                  checksum: sourceChecksum,
                  applied_at: 123,
                  execution_time_ms: 1,
                },
              ],
            },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runD1Migrations('test-db', directory)).resolves.toEqual({
      success: true,
      appliedCount: 0,
      skippedCount: 1,
    });
    expect(execaMock.mock.calls.some(([, args]) => args.includes('--file'))).toBe(false);
    expect(
      execaMock.mock.calls.some(([, args]) => args.join(' ').includes('001_release_1_0_0.sql'))
    ).toBe(true);
  });

  it('materializes a consolidated bundle in status when all draft sources were applied', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-release-status-'));
    tempDirs.push(directory);
    const sourceSql = 'CREATE TABLE status_draft (id TEXT PRIMARY KEY);';
    const sourcePath = join(directory, '001_status_draft.sql');
    writeFileSync(sourcePath, sourceSql);
    const sourceChecksum = calculateD1MigrationChecksum(sourcePath);
    rmSync(sourcePath);
    const bundlePath = join(directory, '001_release_1_0_0.sql');
    writeFileSync(bundlePath, sourceSql);
    const bundleChecksum = calculateD1MigrationChecksum(bundlePath);
    writeReleaseMigrationManifest(join(directory, DRAFT_RELEASE_MANIFEST_FILENAME), {
      formatVersion: 1,
      productVersion: '1.0.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          logicalRoles: ['core'],
          files: [
            {
              path: '001_release_1_0_0.sql',
              checksum: bundleChecksum,
              supersedes: [{ path: '001_status_draft.sql', checksum: sourceChecksum }],
            },
          ],
        },
      ],
    });
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              results: [
                {
                  filename: '001_status_draft.sql',
                  checksum: sourceChecksum,
                  applied_at: 123,
                  execution_time_ms: 7,
                },
              ],
            },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const status = await getD1MigrationStatus('test-db', directory, 'core', {
      materializeSuperseded: true,
    });

    expect(status.success).toBe(true);
    expect(status.counts).toEqual({ total: 1, applied: 1, pending: 0, changed: 0, orphaned: 0 });
    expect(status.migrations).toEqual([
      expect.objectContaining({
        filename: '001_release_1_0_0.sql',
        status: 'applied',
        appliedChecksum: bundleChecksum,
        appliedAt: 123,
        executionTimeMs: 7,
      }),
    ]);
  });

  it('treats a transient lost response as committed when the atomic history row exists', async () => {
    const fixture = createMigrationFixture();
    const checksum = calculateD1MigrationChecksum(fixture.path);
    let historyQueries = 0;
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        historyQueries += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              results:
                historyQueries === 1
                  ? []
                  : [
                      {
                        filename: fixture.filename,
                        checksum,
                        applied_at: 123,
                        execution_time_ms: null,
                      },
                    ],
            },
          ]),
          stderr: '',
        };
      }
      if (args.includes('--file')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'InternalError after commit; please retry',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runD1Migrations('test-db', fixture.directory)).resolves.toEqual({
      success: true,
      appliedCount: 1,
      skippedCount: 0,
    });
    expect(execaMock.mock.calls.filter(([, args]) => args.includes('--file'))).toHaveLength(1);
  });

  it('uses the discovered logical stream instead of recursively applying nested database roles', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-stream-filter-'));
    tempDirs.push(directory);
    writeFileSync(join(directory, '001_core.sql'), 'CREATE TABLE core_only (id TEXT);');
    for (const nested of ['pii', 'admin']) {
      const nestedDirectory = join(directory, nested);
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(
        join(nestedDirectory, `001_${nested}.sql`),
        `CREATE TABLE ${nested}_only (id TEXT);`
      );
    }
    const coreChecksum = calculateD1MigrationChecksum(join(directory, '001_core.sql'));
    writeReleaseMigrationManifest(join(directory, DRAFT_RELEASE_MANIFEST_FILENAME), {
      formatVersion: 1,
      productVersion: '1.0.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          logicalRoles: ['core'],
          files: [{ path: '001_core.sql', checksum: coreChecksum }],
        },
      ],
    });
    const executedFiles: string[] = [];
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return { exitCode: 0, stdout: JSON.stringify([{ results: [] }]), stderr: '' };
      }
      const fileIndex = args.indexOf('--file');
      if (fileIndex >= 0) executedFiles.push(readFileSync(args[fileIndex + 1], 'utf-8'));
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(runD1Migrations('tenant-core', directory)).resolves.toEqual({
      success: true,
      appliedCount: 1,
      skippedCount: 0,
    });
    expect(executedFiles).toHaveLength(1);
    expect(executedFiles[0]).toContain('core_only');
    expect(executedFiles[0]).not.toContain('pii_only');
    expect(executedFiles[0]).not.toContain('admin_only');
  });
});
