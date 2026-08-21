import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const migrationsDir = fileURLToPath(new URL('../../../../migrations', import.meta.url));

function findSqlite3(): string | null {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

describe('screen locale tag normalization migrations', () => {
  it('renames legacy Chinese localization keys in D1', () => {
    const sqlite3 = findSqlite3();
    if (!sqlite3) return;

    const directory = mkdtempSync(join(tmpdir(), 'authrim-screen-locales-'));
    const database = join(directory, 'core.db');
    try {
      const migration = renderPortableMigrationSql(
        readFileSync(join(migrationsDir, '001_pre_1_0_core_baseline.sql'), 'utf8'),
        'sqlite'
      );
      execFileSync(sqlite3, [database], {
        input: migration,
        encoding: 'utf8',
      });

      const result = execFileSync(
        sqlite3,
        [
          database,
          `SELECT COUNT(*) || ':' ||
                  SUM(json_type(localizations_json, '$."zh-CN"') IS NOT NULL) || ':' ||
                  SUM(json_type(localizations_json, '$."zh-TW"') IS NOT NULL) || ':' ||
                  SUM(json_type(localizations_json, '$.zh_CN') IS NOT NULL) || ':' ||
                  SUM(json_type(localizations_json, '$.zh_TW') IS NOT NULL)
             FROM screens WHERE localizations_json IS NOT NULL;`,
        ],
        { encoding: 'utf8' }
      ).trim();

      expect(result).toBe('3:3:3:0:0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses matching BCP 47 keys in the PostgreSQL migration', () => {
    const migration = readFileSync(
      join(migrationsDir, 'external/postgres/001_pre_1_0_external_postgres_core_baseline.sql'),
      'utf8'
    );
    expect(migration).toContain('zh-CN');
    expect(migration).toContain('zh-TW');
    expect(migration).not.toContain('zh_CN');
    expect(migration).not.toContain('zh_TW');
  });
});
