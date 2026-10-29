import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  stepAD1Statements,
  stepASchema,
} from '../../services/__tests__/statement-consent-transition-fixture';

const sql = readFileSync(
  new URL(
    '../../../../../migrations/core/d1/037_statement_consent_enforcement.sql',
    import.meta.url
  ),
  'utf8'
);
const pg = readFileSync(
  new URL(
    '../../../../../migrations/core/postgresql/020_statement_consent_enforcement.sql',
    import.meta.url
  ),
  'utf8'
);
const hash = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

describe('M2 destructive statement consent migration', () => {
  it('requires full release activation after all required databases and forbids database-only rollout', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../../../../migrations/release-manifest.draft.json', import.meta.url),
        'utf8'
      )
    ) as { rollout: unknown };
    expect(manifest.rollout).toEqual({
      databaseExecution: 'setup_then_control',
      workerActivation: 'after_required_databases',
      adminMutationMode: 'read_only',
    });
  });
  function seed(n: number) {
    const f = sqliteAdapter('core', 36);
    f.db.exec('PRAGMA foreign_keys=ON');
    f.db
      .exec(`INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at) VALUES('s','t','s',1,1);
      INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,created_at,updated_at) VALUES('v','t','s','20261025',1,1,1);`);
    const insert = f.db
      .prepare(`INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,created_at,updated_at,content_hash,retain_until)
      VALUES(?,'t',?,'s','v','20261025',1,2,?,3)`);
    f.db.exec('BEGIN');
    for (let i = 0; i < n; i++) insert.run(`r${i}`, `u${i}`, 'b'.repeat(64));
    f.db.exec('COMMIT');
    return f;
  }
  function apply(f: ReturnType<typeof seed>, statement = sql) {
    f.db.exec('BEGIN');
    try {
      f.db.exec(statement);
      f.db.exec('COMMIT');
    } catch (error) {
      f.db.exec('ROLLBACK');
      throw error;
    }
  }
  it.each([0, 25000])('preserves every value, rowid, constraint and index for %i rows', (n) => {
    const f = seed(n);
    try {
      const rows = () =>
        f.db.prepare('SELECT rowid,* FROM user_consent_records ORDER BY rowid').all();
      const before = hash(rows());
      const columns = f.db.prepare('PRAGMA table_info(user_consent_records)').all();
      const indexes = f.db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name='user_consent_records' ORDER BY name"
        )
        .all() as Array<{ name: string; sql: string | null }>;
      apply(f);
      expect(hash(rows())).toBe(before);
      expect(f.db.prepare('PRAGMA table_info(user_consent_records)').all()).toEqual(columns);
      const afterIndexes = f.db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name='user_consent_records' ORDER BY name"
        )
        .all() as Array<{ name: string; sql: string | null }>;
      const normalizeIndexes = (entries: typeof afterIndexes) =>
        entries.map((r) => ({ ...r, sql: r.sql?.replaceAll(' ', '') ?? null }));
      expect(normalizeIndexes(afterIndexes)).toEqual(normalizeIndexes(indexes));
      expect(f.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(f.db.prepare('PRAGMA foreign_key_list(user_consent_records)').all()).toEqual([]);
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      f.db.exec(
        "INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,created_at,updated_at) VALUES('new','t','new','absent','absent','20261025',1,1)"
      );
      expect(() =>
        f.db.exec(
          "INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,created_at,updated_at) VALUES('new2','t','new','absent','absent','20261025',1,1)"
        )
      ).toThrow(/UNIQUE/);
    } finally {
      f.db.close();
    }
  });
  it.each(['foreign_key', 'unknown_index', 'failure_after_drop'])(
    'preserves the original table on %s failure',
    (fault) => {
      const f = seed(3);
      try {
        if (fault === 'foreign_key') {
          f.db.exec('PRAGMA foreign_keys=OFF');
          f.db.exec("UPDATE user_consent_records SET version_id='missing' WHERE id='r0'");
          f.db.exec('PRAGMA foreign_keys=ON');
        }
        if (fault === 'unknown_index')
          f.db.exec('CREATE INDEX unexpected_evidence_index ON user_consent_records(content_hash)');
        const before = hash(
          f.db.prepare('SELECT rowid,* FROM user_consent_records ORDER BY rowid').all()
        );
        expect(() =>
          apply(
            f,
            sql +
              (fault === 'failure_after_drop' ? '\nSELECT * FROM injected_migration_failure;' : '')
          )
        ).toThrow();
        expect(
          hash(f.db.prepare('SELECT rowid,* FROM user_consent_records ORDER BY rowid').all())
        ).toBe(before);
        expect(f.db.prepare('PRAGMA foreign_key_list(user_consent_records)').all()).toHaveLength(2);
        expect(
          f.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '__authrim_rebuild_%'").all()
        ).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  );
  it('pins production D1, execution list and PG trigger definitions to the tested fixtures', () => {
    const tail = (s: string, first: string) => s.slice(s.indexOf(first)).trim();
    expect(tail(sql, 'CREATE TRIGGER')).toBe(tail(stepASchema('d1'), 'CREATE TRIGGER'));
    expect(
      stepAD1Statements()
        .filter((s) => s.startsWith('CREATE TRIGGER'))
        .join('\n\n')
        .trim()
    ).toBe(tail(sql, 'CREATE TRIGGER'));
    expect(tail(pg, 'CREATE FUNCTION')).toBe(tail(stepASchema('postgresql'), 'CREATE FUNCTION'));
  });
});
