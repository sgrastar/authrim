import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { calculateD1MigrationChecksum, runD1Migrations } from '../core/cloudflare.js';

describe('D1 migration history safety', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    execaMock.mockReset();
  });

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('refuses to execute migrations when applied history cannot be parsed', async () => {
    const fixture = createMigrationFixture();
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ').includes('SELECT filename, checksum, applied_at, execution_time_ms')) {
        return { exitCode: 0, stdout: '[wrangler:notice] no JSON payload', stderr: '' };
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
