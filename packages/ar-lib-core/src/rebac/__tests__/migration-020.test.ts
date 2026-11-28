/**
 * Migration 020 on the D1 schema: group tuples stay inert (no from_relation), a legacy `user` row
 * becomes `subject`, and a `user` twin of a `subject` row is removed with the longer validity
 * kept on the surviving row.
 */

import { describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

describe('migration 020 (D1)', () => {
  it('rewrites legacy rows and merges the validity of a removed twin', () => {
    // The schema with 020 applied; the rows are written as before it (no from_relation, `user`),
    // then 020's statements run again without its ALTER TABLE.
    const { db } = sqliteAdapter('core');
    const insert = db.prepare(
      `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id, to_type,
         to_id, permission_level, expires_at, is_bidirectional, created_at, updated_at)
       VALUES (?, 't', 'viewer', ?, ?, 'document', ?, 'full', ?, 0, 0, 0)`
    );
    insert.run('g', 'group', 'grp-1', 'doc-1', null);
    insert.run('s1', 'subject', 'u1', 'doc-1', 100);
    insert.run('u1', 'user', 'u1', 'doc-1', 200);
    insert.run('s2', 'subject', 'u2', 'doc-1', 100);
    insert.run('u2', 'user', 'u2', 'doc-1', null);
    insert.run('u3', 'user', 'u3', 'doc-1', 50);

    const sql = renderPortableMigrationSql(
      readMigrationSource(MIGRATIONS, '020_relationship_userset_relation.sql'),
      'sqlite'
    );
    expect(sql).toContain('ALTER TABLE relationships ADD COLUMN from_relation TEXT;');
    db.exec(sql.replace('ALTER TABLE relationships ADD COLUMN from_relation TEXT;', ''));

    expect(
      db
        .prepare('SELECT id, from_type, from_relation, expires_at FROM relationships ORDER BY id')
        .all()
    ).toEqual([
      // A legacy group row stays inert (NULL): it must be written again through the guarded APIs.
      { id: 'g', from_type: 'group', from_relation: null, expires_at: null },
      { id: 's1', from_type: 'subject', from_relation: null, expires_at: 200 },
      { id: 's2', from_type: 'subject', from_relation: null, expires_at: null },
      { id: 'u3', from_type: 'subject', from_relation: null, expires_at: 50 },
    ]);
  });
});
