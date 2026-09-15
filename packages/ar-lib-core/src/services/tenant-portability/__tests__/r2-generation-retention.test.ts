import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
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
  persistRewrappedLogObjectGeneration,
  retireDeletedLogObjectGeneration,
} from '../r2-generation-retention';

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../../migrations/admin/d1/033_tenant_backup_r2_generation_retention.sql',
      import.meta.url
    )
  ),
  'utf8'
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
    CREATE TABLE logging_key_versions(
      key_registry_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      stale_count INTEGER NOT NULL,
      usage_count INTEGER NOT NULL,
      PRIMARY KEY(key_registry_id, version)
    );
    CREATE TABLE tenant_backup_snapshots(
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL
    );
  `);
  sqlite.exec(migration);
  return { sqlite, adapter: new SqliteAdapter(sqlite) };
}

const rewrap = {
  retirementId: 'retire-rewrap-1',
  tenantKey: 'tenant-key',
  objectCatalogId: 'catalog-1',
  previousObjectKey: 'logs/source.bin',
  objectKey: 'logs-rewrapped/target.bin',
  keyRegistryId: 'registry-1',
  previousKeyVersion: 1,
  keyVersion: 2,
  recordCount: 3,
  byteCount: 128,
  checksumSha256: 'a'.repeat(64),
  encryptionScope: 'tenant:tenant-key:audit:archive',
  updatedAt: 100,
};

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

it('atomically switches a rewrapped generation and applies key accounting once', async () => {
  const { sqlite, adapter } = database();
  try {
    sqlite.exec(`
      INSERT INTO log_object_catalog VALUES (
        'catalog-1','tenant-key','logs/source.bin',64,'${'b'.repeat(64)}',
        'tenant:tenant-key:audit:archive',1,10,'committed',NULL
      );
      INSERT INTO logging_key_versions VALUES ('registry-1',1,3,0);
      INSERT INTO logging_key_versions VALUES ('registry-1',2,0,4);
    `);
    await persistRewrappedLogObjectGeneration(adapter, rewrap);
    expect(
      sqlite
        .prepare(
          'SELECT object_key,byte_count,checksum_sha256,key_version,committed_at,status FROM log_object_catalog'
        )
        .get()
    ).toEqual({
      object_key: rewrap.objectKey,
      byte_count: 128,
      checksum_sha256: rewrap.checksumSha256,
      key_version: 2,
      committed_at: 100,
      status: 'committed',
    });
    expect(
      sqlite
        .prepare(
          'SELECT version,stale_count,usage_count FROM logging_key_versions ORDER BY version'
        )
        .all()
    ).toEqual([
      { version: 1, stale_count: 2, usage_count: 0 },
      { version: 2, stale_count: 0, usage_count: 7 },
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT replacement_object_key,accounting_applied,record_count FROM tenant_backup_r2_retired_generations'
        )
        .get()
    ).toEqual({
      replacement_object_key: rewrap.objectKey,
      accounting_applied: 1,
      record_count: 3,
    });

    await persistRewrappedLogObjectGeneration(adapter, { ...rewrap, updatedAt: 200 });
    expect(
      sqlite
        .prepare(
          'SELECT version,stale_count,usage_count FROM logging_key_versions ORDER BY version'
        )
        .all()
    ).toEqual([
      { version: 1, stale_count: 2, usage_count: 0 },
      { version: 2, stale_count: 0, usage_count: 7 },
    ]);
    expect(sqlite.prepare('SELECT committed_at FROM log_object_catalog').get()).toEqual({
      committed_at: 100,
    });
  } finally {
    sqlite.close();
  }
});

it('keeps the source catalog active until accounting is available and retires deletes safely', async () => {
  const { sqlite, adapter } = database();
  try {
    sqlite.exec(`
      INSERT INTO log_object_catalog VALUES (
        'catalog-1','tenant-key','logs/source.bin',64,'${'b'.repeat(64)}',
        'tenant:tenant-key:audit:archive',1,10,'committed',NULL
      );
      INSERT INTO logging_key_versions VALUES ('registry-1',1,3,0);
    `);
    await expect(persistRewrappedLogObjectGeneration(adapter, rewrap)).rejects.toThrow(
      'tenant_backup_r2_generation_retention_invalid'
    );
    expect(sqlite.prepare('SELECT object_key,key_version FROM log_object_catalog').get()).toEqual({
      object_key: rewrap.previousObjectKey,
      key_version: 1,
    });
    expect(
      sqlite.prepare('SELECT accounting_applied FROM tenant_backup_r2_retired_generations').get()
    ).toEqual({ accounting_applied: 0 });

    sqlite.exec("INSERT INTO logging_key_versions VALUES ('registry-1',2,0,4)");
    await persistRewrappedLogObjectGeneration(adapter, rewrap);
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
    expect(retired).toHaveLength(2);
    const deleted = retired.find((row) => row.id === 'retire-delete-2')!;
    expect(deleted.reason).toBe('catalog_delete');
    await completeRetiredTenantBackupR2Generation(adapter, {
      id: deleted.id,
      objectKey: deleted.object_key,
    });
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM tenant_backup_r2_retired_generations').get()
    ).toEqual({ count: 1 });
  } finally {
    sqlite.close();
  }
});
