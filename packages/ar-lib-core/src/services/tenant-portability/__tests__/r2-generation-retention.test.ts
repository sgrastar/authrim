import { readMigrationSource } from '../../../../../../test/helpers/migration-source.mjs';

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { expect, it } from 'vitest';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  TransactionContext,
} from '../../../db/adapter';
import {
  completeRetiredTenantBackupR2Generation,
  hasCapturingTenantBackupSnapshot,
  listRetiredTenantBackupR2Generations,
  retireDeletedLogObjectGeneration,
} from '../r2-generation-retention';

const migration = readMigrationSource(
  new URL('../../../../../../migrations/admin/d1/', import.meta.url),
  '033_tenant_backup_r2_generation_retention.sql'
);

function parameters(values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

class SqliteAdapter implements DatabaseAdapter {
  constructor(readonly database: DatabaseSync) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...parameters(params)) as T[];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.database.prepare(sql).get(...parameters(params)) as T | undefined) ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const result = this.database.prepare(sql).run(...parameters(params));
    return { success: true, rowsAffected: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        const result = this.database
          .prepare(statement.sql)
          .run(...parameters(statement.params ?? []));
        return { success: true, rowsAffected: Number(result.changes) };
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'sqlite' };
  }

  getType(): string {
    return 'sqlite';
  }

  async close(): Promise<void> {}
}

function database(): { sqlite: DatabaseSync; adapter: SqliteAdapter } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE existing_admin_data(id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO existing_admin_data VALUES ('preserved', 'yes');
    CREATE TABLE log_object_catalog(
      id TEXT PRIMARY KEY NOT NULL,
      tenant_key TEXT NOT NULL,
      object_key TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      checksum_sha256 TEXT,
      encryption_scope TEXT,
      key_version INTEGER,
      committed_at INTEGER,
      status TEXT NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE log_chunk_record_index(
      id TEXT PRIMARY KEY NOT NULL,
      object_catalog_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE tenant_backup_snapshots(
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL
    );
  `);
  sqlite.exec(migration);
  return { sqlite, adapter: new SqliteAdapter(sqlite) };
}

it('adds the retirement schema without changing existing Admin data and enforces invariants', () => {
  const { sqlite } = database();
  try {
    expect(sqlite.prepare('SELECT * FROM existing_admin_data').get()).toEqual({
      id: 'preserved',
      value: 'yes',
    });
    expect(() =>
      sqlite.exec(`INSERT INTO tenant_backup_r2_retired_generations (
        id, tenant_key, bucket_binding, object_catalog_id, object_key, reason,
        accounting_applied, created_at
      ) VALUES ('bad', 'tenant', 'AUDIT_ARCHIVE', 'object', 'key', 'catalog_delete', 0, 1)`)
    ).toThrow();
    sqlite.exec(`INSERT INTO tenant_backup_r2_retired_generations (
      id, tenant_key, bucket_binding, object_catalog_id, object_key, reason,
      accounting_applied, created_at
    ) VALUES ('delete', 'tenant', 'AUDIT_ARCHIVE', 'object', 'key', 'catalog_delete', 1, 1)`);
    expect(() =>
      sqlite.exec(
        "UPDATE tenant_backup_r2_retired_generations SET object_key='changed' WHERE id='delete'"
      )
    ).toThrow('tenant_backup_r2_retired_generation_immutable');
    expect(() =>
      sqlite.exec(
        "UPDATE tenant_backup_r2_retired_generations SET accounting_applied=0 WHERE id='delete'"
      )
    ).toThrow('tenant_backup_r2_retired_generation_accounting');
  } finally {
    sqlite.close();
  }
});

it('retires a deleted catalog generation atomically and lets the cleanup complete it', async () => {
  const { sqlite, adapter } = database();
  try {
    sqlite.exec(`
      INSERT INTO log_object_catalog VALUES (
        'catalog-2','tenant-key','logs/delete.bin',12,'${'c'.repeat(64)}',
        'tenant:tenant-key:audit:archive',2,20,'committed',NULL
      );
      INSERT INTO log_chunk_record_index VALUES ('record-2','catalog-2','committed');
      INSERT INTO tenant_backup_snapshots VALUES ('snapshot','capturing');
    `);
    expect(await hasCapturingTenantBackupSnapshot(adapter)).toBe(true);
    await retireDeletedLogObjectGeneration(adapter, {
      retirementId: 'retire-delete-2',
      tenantKey: 'tenant-key',
      objectCatalogId: 'catalog-2',
      objectKey: 'logs/delete.bin',
      deletedAt: 150,
      bucketBinding: 'AUDIT_ARCHIVE',
    });
    expect(
      sqlite.prepare("SELECT status,deleted_at FROM log_object_catalog WHERE id='catalog-2'").get()
    ).toEqual({ status: 'deleted', deleted_at: 150 });
    expect(
      sqlite.prepare("SELECT status FROM log_chunk_record_index WHERE id='record-2'").get()
    ).toEqual({ status: 'deleted' });
    const retired = await listRetiredTenantBackupR2Generations(adapter, 10);
    expect(retired).toHaveLength(1);
    const deleted = retired.find((row) => row.id === 'retire-delete-2')!;
    expect(deleted.reason).toBe('catalog_delete');
    await completeRetiredTenantBackupR2Generation(adapter, {
      id: deleted.id,
      objectKey: deleted.object_key,
    });
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM tenant_backup_r2_retired_generations').get()
    ).toEqual({ count: 0 });
  } finally {
    sqlite.close();
  }
});
