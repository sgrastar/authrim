import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function migration(path: string): string {
  const sql = readFileSync(resolve(REPO_ROOT, path), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000');
  return renderPortableMigrationSql(sql, 'sqlite');
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
    ({ name }) => name
  );
}

describe('PII identity ownership migration', () => {
  it('keeps pairwise subjects separate from the repository-compatible identifier registry', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(migration('migrations/pii/d1/001_0_4_0_pii_baseline.sql'));
    db.exec(`
      INSERT INTO pairwise_subject_identifiers (
        id, tenant_id, user_id, client_id, sector_identifier, subject, created_at
      ) VALUES (
        'pairwise-a', 'tenant-a', 'user-a', 'client-a', 'example.test', 'opaque-subject', 1
      );
    `);

    expect(tableColumns(db, 'pairwise_subject_identifiers')).toEqual(
      expect.arrayContaining(['tenant_id', 'user_id', 'client_id', 'sector_identifier', 'subject'])
    );
    expect(
      db
        .prepare(
          `SELECT tenant_id, user_id, client_id, sector_identifier, subject
             FROM pairwise_subject_identifiers WHERE id = 'pairwise-a'`
        )
        .get()
    ).toEqual({
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      client_id: 'client-a',
      sector_identifier: 'example.test',
      subject: 'opaque-subject',
    });

    expect(tableColumns(db, 'subject_identifiers')).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'subject_id',
        'identifier_type',
        'identifier_value',
        'destination_type',
        'destination_id',
        'identifier_value_hash',
        'lifecycle_state',
      ])
    );
    db.exec(`
      INSERT INTO subject_identifiers (
        id, tenant_id, subject_id, identifier_type, identifier_value,
        is_primary, destination_type, destination_id, identifier_value_hash,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'identifier-a', 'tenant-a', 'user-a', 'oidc_sub', 'destination-subject',
        1, 'oidc_client', 'client-a', 'digest-a', 'active', 1, 1
      );
    `);
    expect(
      db
        .prepare(
          `SELECT identifier_value, destination_type, destination_id
             FROM subject_identifiers
            WHERE tenant_id = 'tenant-a' AND subject_id = 'user-a'`
        )
        .get()
    ).toEqual({
      identifier_value: 'destination-subject',
      destination_type: 'oidc_client',
      destination_id: 'client-a',
    });

    expect(() =>
      db.exec(`
        INSERT INTO subject_identifiers (
          id, tenant_id, subject_id, identifier_type, identifier_value,
          is_primary, created_at, updated_at
        ) VALUES (
          'identifier-cross-tenant', 'tenant-b', 'user-b', 'oidc_sub',
          'destination-subject', 1, 1, 1
        );
      `)
    ).not.toThrow();
    expect(() =>
      db.exec(`
        INSERT INTO subject_identifiers (
          id, tenant_id, subject_id, identifier_type, identifier_value,
          is_primary, created_at, updated_at
        ) VALUES (
          'identifier-duplicate', 'tenant-a', 'other-user', 'oidc_sub',
          'destination-subject', 1, 1, 1
        );
      `)
    ).toThrow(/UNIQUE constraint failed/i);

    db.close();
  });

  it('scopes pairwise subject uniqueness to the owning tenant', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/pii/d1/001_0_4_0_pii_baseline.sql'));
    db.exec(`
      INSERT INTO pairwise_subject_identifiers (
        id, tenant_id, user_id, client_id, sector_identifier, subject, created_at
      ) VALUES (
        'pairwise-a', 'tenant-a', 'user-a', 'client-a', 'example.test', 'opaque-subject-a', 1
      );
    `);

    expect(() =>
      db.exec(`
        INSERT INTO pairwise_subject_identifiers (
          id, tenant_id, user_id, client_id, sector_identifier, subject, created_at
        ) VALUES (
          'pairwise-duplicate', 'tenant-a', 'user-a', 'client-b', 'example.test',
          'opaque-subject-b', 1
        );
      `)
    ).toThrow(/UNIQUE constraint failed/i);
    expect(() =>
      db.exec(`
        INSERT INTO pairwise_subject_identifiers (
          id, tenant_id, user_id, client_id, sector_identifier, subject, created_at
        ) VALUES (
          'pairwise-other-tenant', 'tenant-b', 'user-a', 'client-b', 'example.test',
          'opaque-subject-b', 1
        );
      `)
    ).not.toThrow();

    db.close();
  });
});
