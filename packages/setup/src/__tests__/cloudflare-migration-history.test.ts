import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { calculateD1MigrationChecksum, runD1Migrations } from '../core/cloudflare.js';

describe('D1 migration history safety', () => {
  const tempDirs: string[] = [];
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
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
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sql: 'SELECT filename, checksum, applied_at, execution_time_ms FROM authrim_migrations;',
        }),
      }
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
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
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
});
