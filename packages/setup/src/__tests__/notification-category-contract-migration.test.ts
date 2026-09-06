import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERNAL_NOTIFICATION_EVENT_CATEGORIES } from '@authrim/ar-lib-core/repositories/admin/internal-notification-event';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function migration(path: string): string {
  return renderPortableMigrationSql(
    readFileSync(resolve(REPO_ROOT, path), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000'),
    'sqlite'
  );
}

describe('Admin notification category contract migration', () => {
  const streams = [
    {
      baseline: 'migrations/core/d1/001_0_4_0_core_baseline.sql',
    },
    {
      baseline: 'migrations/admin/d1/001_0_4_0_admin_baseline.sql',
    },
  ] as const;

  for (const stream of streams) {
    it(`accepts every runtime category and rejects unknown values in ${stream.baseline}`, () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(migration(stream.baseline));
      db.exec(
        `INSERT INTO internal_notification_events (
         id, tenant_id, category, event_type, severity, status, deduplication_key,
         payload_json, attempts, created_at, updated_at
       ) VALUES (
         'existing', 'tenant-a', 'storage_registry_security', 'storage.security', 'medium',
         'pending', 'existing-dedup', '{}', 0, '2026-09-06T00:00:00Z',
         '2026-09-06T00:00:00Z'
       )`
      );

      expect(
        db
          .prepare(
            `SELECT category, deduplication_key
             FROM internal_notification_events
            WHERE id = 'existing'`
          )
          .get()
      ).toEqual({
        category: 'storage_registry_security',
        deduplication_key: 'existing-dedup',
      });

      for (const [index, category] of INTERNAL_NOTIFICATION_EVENT_CATEGORIES.entries()) {
        expect(() =>
          db
            .prepare(
              `INSERT INTO internal_notification_events (
               id, tenant_id, category, event_type, severity, payload_json
             ) VALUES (?, 'tenant-a', ?, 'test.event', 'info', '{}')`
            )
            .run(`category-${index}`, category)
        ).not.toThrow();
      }

      expect(() =>
        db
          .prepare(
            `INSERT INTO internal_notification_events (
             id, tenant_id, category, event_type, severity, payload_json
           ) VALUES ('unknown', 'tenant-a', 'unknown', 'test.event', 'info', '{}')`
          )
          .run()
      ).toThrow();
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema
            WHERE type = 'index' AND name = 'idx_internal_notification_events_dedup'`
          )
          .get()
      ).toBeDefined();
      db.close();
    });
  }
});
