import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { executeD1Migration } from '../core/cloudflare.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

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
    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: 'Uploading complete.',
        stderr:
          'ERROR File could not be uploaded. Please retry. Got response: <Error><Code>InternalError</Code></Error>',
      } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);

    const progress: string[] = [];
    const result = await executeD1Migration('test-db', migrationPath, (message) =>
      progress.push(message)
    );

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
    expect(progress.some((message) => message.includes('Transient D1 migration failure'))).toBe(
      true
    );
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
