import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
      const migration = readFileSync(
        join(migrationsDir, '031_normalize_screen_locale_tags.sql'),
        'utf8'
      );
      execFileSync(sqlite3, [database], {
        input: `
          CREATE TABLE screens (localizations_json TEXT);
          INSERT INTO screens VALUES ('{"en":{"label":"Sign in"},"zh_CN":{"label":"登录"},"zh_TW":{"label":"登入"}}');
          ${migration}
        `,
        encoding: 'utf8',
      });

      const result = execFileSync(
        sqlite3,
        [
          database,
          `SELECT json_extract(localizations_json, '$."zh-CN".label') || ':' ||
                  json_extract(localizations_json, '$."zh-TW".label') || ':' ||
                  COALESCE(json_type(localizations_json, '$.zh_CN'), 'missing') || ':' ||
                  COALESCE(json_type(localizations_json, '$.zh_TW'), 'missing')
             FROM screens;`,
        ],
        { encoding: 'utf8' }
      ).trim();

      expect(result).toBe('登录:登入:missing:missing');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses matching BCP 47 keys in the PostgreSQL migration', () => {
    const migration = readFileSync(
      join(migrationsDir, 'external/postgres/016_external_normalize_screen_locale_tags.sql'),
      'utf8'
    );
    expect(migration).toContain("jsonb_build_object('zh-CN'");
    expect(migration).toContain("jsonb_build_object('zh-TW'");
    expect(migration).toContain("localizations_json - 'zh_CN'");
    expect(migration).toContain("localizations_json - 'zh_TW'");
  });
});
