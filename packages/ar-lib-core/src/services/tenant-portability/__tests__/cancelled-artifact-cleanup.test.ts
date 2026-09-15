import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { cleanupCancelledTenantBackupArtifactPage } from '../cancelled-artifact-cleanup';
import type { TenantBackupStepContext } from '../operation-executor';
import { TenantBackupOperationStore } from '../operation-store';

let sql: DatabaseSync;
let database: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let context: TenantBackupStepContext;
let now: number;
const objects = new Set<string>();

beforeEach(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '003_tenant_backup_operations',
    '004_tenant_backup_validation_index',
    '008_tenant_backup_retry_state',
    '009_tenant_backup_artifact_parts',
    '012_tenant_backup_cipher_journal',
    '020_tenant_backup_publications',
    '021_tenant_backup_export_manifests',
  ])
    sql.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${name}.sql`, import.meta.url),
        'utf8'
      )
    );
  database = {
    async queryOne<T>(statement: string, params: unknown[] = []) {
      return (sql.prepare(statement).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(statement: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(sql.prepare(statement).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  const store = new TenantBackupOperationStore(database);
  await store.create({
    id: 'export-a',
    tenantId: 'tenant-a',
    kind: 'export',
    idempotencyKey: 'request-a',
    requestDigest: 'ab'.repeat(32),
    actorId: 'admin-a',
    now: 100,
  });
  const running = await store.claim('tenant-a', 'export-a', 'writer', 101);
  sql
    .prepare("INSERT INTO tenant_backup_artifact_attempts VALUES (?,?,?,?,'sealed',?,?,?)")
    .run('attempt-a', 'tenant-a', 'export-a', running!.fencing_token, 102, 33, 33);
  for (let ordinal = 0; ordinal < 33; ordinal += 1) {
    const key = `tenant-backup-staging/attempt-a/${ordinal}/cipher`;
    objects.add(key);
    sql
      .prepare('INSERT INTO tenant_backup_artifact_parts VALUES (?,?,?,?,?,?,1)')
      .run('attempt-a', 'tenant-a', ordinal, key, 1, 'ab'.repeat(32));
  }
  sql
    .prepare('INSERT INTO tenant_backup_publications VALUES (?,?,?,?,?,?)')
    .run('export-a', 'tenant-a', 'attempt-a', 'ab'.repeat(32), 103, 604800103);
  sql
    .prepare('INSERT INTO tenant_backup_cipher_streams VALUES (?,?,?,?,?,?,?)')
    .run('attempt-a', 'tenant-a', 'ab'.repeat(125), 101, 101, 1, null);
  for (let sequence = 0; sequence < 101; sequence += 1)
    sql
      .prepare('INSERT INTO tenant_backup_cipher_frames VALUES (?,?,?,?,?,?)')
      .run('attempt-a', sequence, sequence === 100 ? 2 : 1, 'ab'.repeat(32), 1, '{}');
  await store.requestCancel('tenant-a', 'export-a', 104);
  const cancelling = await store.claimCancellation('tenant-a', 'export-a', 'cleaner', 105);
  now = 106;
  context = {
    operation: Object.freeze({ ...cancelling! }),
    lease: Object.freeze({
      tenantId: 'tenant-a',
      operationId: 'export-a',
      owner: 'cleaner',
      fencingToken: cancelling!.fencing_token,
    }),
    signal: new AbortController().signal,
  };
});

afterEach(() => sql.close());

const bucket = {
  async head(key: string) {
    return objects.has(key) ? {} : null;
  },
  async delete(key: string) {
    objects.delete(key);
  },
};

it('removes only the cancelled operation ciphertext in bounded retryable pages', async () => {
  expect(
    await cleanupCancelledTenantBackupArtifactPage({ database, bucket, context, now: () => now })
  ).toEqual({ done: false, objectsRemoved: 32 });
  expect(objects.size).toBe(1);
  expect(sql.prepare('SELECT count(*) n FROM tenant_backup_cipher_frames').get()?.n).toBe(1);

  expect(
    await cleanupCancelledTenantBackupArtifactPage({ database, bucket, context, now: () => now })
  ).toEqual({ done: false, objectsRemoved: 1 });
  expect(objects.size).toBe(0);
  expect(sql.prepare('SELECT count(*) n FROM tenant_backup_artifact_attempts').get()?.n).toBe(0);
  expect(
    await cleanupCancelledTenantBackupArtifactPage({ database, bucket, context, now: () => now })
  ).toEqual({ done: true, objectsRemoved: 0 });
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('retains the receipt when deletion is uncertain and rejects a stale cleanup lease', async () => {
  const uncertain = {
    ...bucket,
    async delete() {
      throw new Error('lost response');
    },
  };
  await expect(
    cleanupCancelledTenantBackupArtifactPage({
      database,
      bucket: uncertain,
      context,
      now: () => now,
    })
  ).rejects.toThrow('lost response');
  expect(sql.prepare('SELECT count(*) n FROM tenant_backup_artifact_parts').get()?.n).toBe(33);

  now = 40_000;
  await expect(
    cleanupCancelledTenantBackupArtifactPage({ database, bucket, context, now: () => now })
  ).rejects.toThrow('backup_artifact_cleanup_fenced');
  expect(objects.size).toBe(33);
});
