import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

interface StreamFixture {
  baseline: string;
  removedTables: readonly string[];
  retainedTables: readonly string[];
}

const STREAMS: readonly StreamFixture[] = [
  {
    baseline: 'migrations/core/d1/001_0_4_0_core_baseline.sql',
    removedTables: [
      'support_operation_break_glass_reveals',
      'support_operation_break_glass_requests',
      'identifier_change_notification_outbox',
      'websocket_subscriptions',
      'trust_groups',
      'linked_identities',
      'subject_identifiers',
      'verified_attributes',
    ],
    retainedTables: [
      'account_routing_outbox',
      'plugin_hook_outbox',
      'user_verified_attributes',
      'attribute_verifications',
    ],
  },
  {
    baseline: 'migrations/admin/d1/001_0_4_0_admin_baseline.sql',
    removedTables: [
      'recovery_set_artifacts',
      'restore_validation_jobs',
      'recovery_sets',
      'quota_usage_snapshots',
      'quota_policies',
      'retention_cleanup_jobs',
      'federation_trust_rank_profiles',
      'federation_trust_fail_policies',
      'persistent_identifier_values',
      'tenant_database_migration_job_targets',
      'tenant_database_migration_jobs',
      'tenant_database_slot_audit_events',
      'tenant_database_slots',
    ],
    retainedTables: ['logging_quota_policies', 'admin_users', 'admin_sessions'],
  },
  {
    baseline: 'migrations/control/d1/001_0_4_0_control_baseline.sql',
    removedTables: [
      'control_lookup_rebalance_bucket_targets',
      'control_lookup_rebalance_batches',
      'control_lookup_retention_targets',
      'control_lookup_retention_operations',
    ],
    retainedTables: [
      'control_lookup_bucket_assignments',
      'control_lookup_bucket_migrations',
      'control_lookup_retention_policy_projections',
      'control_lookup_scale_out_forecasts',
    ],
  },
];

function migration(path: string): string {
  const sql = readFileSync(resolve(REPO_ROOT, path), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000');
  return renderPortableMigrationSql(sql, 'sqlite');
}

function schemaObjectNames(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name)
  );
}

describe('final baseline deferred schema cleanup', () => {
  for (const stream of STREAMS) {
    it(`omits deferred tables and retains canonical replacements in ${stream.baseline}`, () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(migration(stream.baseline));

      const schemaObjects = schemaObjectNames(db);
      for (const table of stream.removedTables) {
        expect(schemaObjects.has(table), table).toBe(false);
        const tableIdentifier = new RegExp(
          `(^|[^a-z0-9_])${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`,
          'i'
        );
        const staleReferences = (
          db
            .prepare(
              `SELECT type, name, sql
                 FROM sqlite_schema
                WHERE type IN ('index', 'trigger', 'view')
                  AND sql IS NOT NULL`
            )
            .all() as Array<{ type: string; name: string; sql: string }>
        ).filter(({ sql }) => tableIdentifier.test(sql));
        expect(staleReferences, table).toEqual([]);
      }
      for (const table of stream.retainedTables) {
        expect(schemaObjects.has(table), table).toBe(true);
      }

      db.close();
    });
  }
});
