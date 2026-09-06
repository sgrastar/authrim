import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OBJECT_CLASSES } from '@authrim/ar-lib-core/services/object-catalog';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const STREAMS = [
  {
    baseline: 'migrations/core/d1/001_0_4_0_core_baseline.sql',
  },
  {
    baseline: 'migrations/admin/d1/001_0_4_0_admin_baseline.sql',
  },
] as const;

function migration(path: string): string {
  return renderPortableMigrationSql(
    readFileSync(resolve(REPO_ROOT, path), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000'),
    'sqlite'
  );
}

describe('D1 object catalog contract migration', () => {
  for (const stream of STREAMS) {
    it(`accepts every ObjectClass and preserves child foreign keys in ${stream.baseline}`, () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(migration(stream.baseline));
      db.exec(
        `INSERT INTO object_catalog (
           id, public_artifact_id, tenant_id, object_class, created_at, updated_at
         ) VALUES ('existing', 'artifact-existing', 'tenant-a', 'user_export', 1, 1)`
      );
      db.exec(
        `INSERT INTO object_catalog_objects (
           id, catalog_id, representation, object_kind, bucket_binding, object_key, created_at
         ) VALUES (
           'object-existing', 'existing', 'canonical_json', 'single',
           'EXPORT_ARTIFACTS', 'existing.json', 1
         )`
      );
      if (stream.baseline.includes('/admin/')) {
        db.exec(
          `INSERT INTO approval_requests (
             id, public_request_id, investigation_id, requester_subject_type,
             requester_subject_id, target_subject_type, target_subject_id,
             request_surface, requested_action, redaction_level, status,
             scope_canonical, scope_json, reason_code, policy_preset,
             requested_at, expires_at, detail_object_catalog_id, created_at, updated_at
           ) VALUES (
             'approval-existing', 'approval-public-existing', 'investigation-existing',
             'admin_user', 'admin-existing', 'artifact', 'artifact-existing',
             'admin', 'inspect', 'summary_only', 'pending', 'artifact:existing', '{}',
             'support', 'default', 1, 2, 'existing', 1, 1
           )`
        );
      } else {
        db.exec(
          `INSERT INTO sensitive_detail_chunk_index (
             catalog_id, tenant_id, object_class, bucket_binding, object_key,
             line_number, created_at
           ) VALUES (
             'existing', 'tenant-a', 'user_export', 'SENSITIVE_DETAILS',
             'existing.ndjson.gz', 1, 1
           )`
        );
      }

      expect(
        db.prepare(`SELECT object_class FROM object_catalog WHERE id = 'existing'`).get()
      ).toEqual({ object_class: 'user_export' });
      expect(
        db
          .prepare(`SELECT catalog_id FROM object_catalog_objects WHERE id = 'object-existing'`)
          .get()
      ).toEqual({ catalog_id: 'existing' });
      if (stream.baseline.includes('/admin/')) {
        expect(
          db
            .prepare(
              `SELECT detail_object_catalog_id
                 FROM approval_requests
                WHERE id = 'approval-existing'`
            )
            .get()
        ).toEqual({ detail_object_catalog_id: 'existing' });
      } else {
        expect(
          db
            .prepare(
              `SELECT catalog_id
                 FROM sensitive_detail_chunk_index
                WHERE catalog_id = 'existing'`
            )
            .get()
        ).toEqual({ catalog_id: 'existing' });
      }
      expect(db.prepare(`PRAGMA foreign_key_list('object_catalog_objects')`).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'object_catalog', from: 'catalog_id', to: 'id' }),
        ])
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      for (const [index, objectClass] of OBJECT_CLASSES.entries()) {
        expect(() =>
          db
            .prepare(
              `INSERT INTO object_catalog (
                 id, public_artifact_id, tenant_id, object_class, created_at, updated_at
               ) VALUES (?, ?, 'tenant-a', ?, 1, 1)`
            )
            .run(`class-${index}`, `artifact-${index}`, objectClass)
        ).not.toThrow();
      }

      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema
              WHERE type = 'table'
                AND name IN (
                  'object_catalog_pre_0_4_0_contract',
                  'authrim_object_catalog_objects_backup',
                  'authrim_sensitive_detail_chunk_index_backup',
                  'authrim_approval_object_refs_backup'
                )`
          )
          .all()
      ).toEqual([]);
      db.close();
    });
  }
});
