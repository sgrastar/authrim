import { readdirSync, readFileSync } from 'node:fs';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLInputValue } from '../test-sqlite';
import type {
  DatabaseAdapter,
  PreparedStatement,
  GuestDeletionReceiptV2,
} from '@authrim/ar-lib-core';

/** Executable current D1 migrations; transport doubles never stand in for source SQL effects. */
export function openGuestStore(plane: 'core' | 'pii' | 'lookup') {
  const db = new DatabaseSync(':memory:');
  const folder = new URL(`../../../../../migrations/${plane}/d1/`, import.meta.url);
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, folder), 'utf8'), 'sqlite'));
  const values = (p: unknown[] = []) => p.map((v) => (v ?? null) as SQLInputValue);
  const run = (s: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(s.sql).run(...values(s.params)).changes),
  });
  const adapter: DatabaseAdapter = {
    query: async <T>(sql: string, p: unknown[] = []) => db.prepare(sql).all(...values(p)) as T[],
    queryOne: async <T>(sql: string, p: unknown[] = []) =>
      (db.prepare(sql).get(...values(p)) as T) ?? null,
    execute: async (sql, p = []) => run({ sql, params: p }),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: async () => {
      throw new Error('ordered batch required');
    },
    getType: () => 'd1',
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    close: async () => {},
  };
  return { db, adapter };
}
export function guestReceiptFixture(): GuestDeletionReceiptV2 {
  return {
    schemaVersion: 2,
    tenantId: 'tenant-guest',
    userId: '10000000-0000-4000-8000-000000000001',
    accountId: '20000000-0000-4000-8000-000000000001',
    operationId: 'guest-delete:original',
    accountRouteGeneration: 1,
    completionAuditMode: 'outbox',
    completionAuditId: 'guest-audit:original',
    origin: 'admin',
    corePin: {
      databaseId: 'physical-core',
      bindingRef: 'DB_USERS_A',
      dataRole: 'tenant_core/users',
      residencyPartition: 'region-a',
      shardId: 'users-a',
      assignmentGeneration: 1,
      bindingRouteGeneration: 1,
    },
    piiPin: {
      databaseId: 'physical-pii',
      bindingRef: 'DB_PII_A',
      dataRole: 'tenant_pii',
      residencyPartition: 'region-a',
      shardId: 'pii-a',
      assignmentGeneration: 1,
      bindingRouteGeneration: 1,
    },
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'residency:fixture',
      targets: [
        {
          dataRole: 'tenant_core/users',
          bindingRef: 'DB_USERS_A',
          residencyPartition: 'region-a',
          shardId: 'users-a',
          requiredBindingRouteGeneration: 1,
        },
        {
          dataRole: 'tenant_pii',
          bindingRef: 'DB_PII_A',
          residencyPartition: 'region-a',
          shardId: 'pii-a',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    execution: { phase: 'accepted', boundaryId: null, erasureStartedAtMs: null },
  };
}
