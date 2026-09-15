import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupR2RestoreStore } from '../r2-restore-store';

let database: DatabaseSync;
let store: TenantBackupR2RestoreStore;

function migration(name: string): string {
  return readFileSync(
    new URL(`../../../../../../migrations/admin/d1/${name}`, import.meta.url),
    'utf8'
  );
}

const owner = {
  operationId: 'operation-a',
  tenantId: 'tenant-a',
  leaseOwner: 'worker-a',
  fencingToken: 1,
  datasetId: 'artifacts.object_catalog_bodies' as const,
  objectId: 'core:object-a',
};
const chunk = {
  tenantId: 'tenant-a',
  objectId: 'core:object-a',
  bucketBinding: 'IMPORT_ARTIFACTS' as const,
  objectKey: 'source/tenant-a/input.csv',
  sourceEncoding: 'plaintext' as const,
  objectSha256: 'a'.repeat(64),
  totalBytes: 3,
  chunkIndex: 0,
  chunkCount: 1,
  chunkSha256: 'b'.repeat(64),
  bytes: Uint8Array.from([1, 2, 3]),
  context: { tenantId: 'tenant-a', catalogId: 'catalog-a' },
  httpMetadata: { contentType: 'text/csv' },
  customMetadata: { tenant: 'tenant-a' },
};

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '031_tenant_backup_r2_restores.sql',
  ])
    database.exec(migration(name));
  database
    .prepare(
      `INSERT INTO tenant_backup_operations(
        id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,
        created_at,updated_at,fencing_token,lease_owner,lease_expires_at
      ) VALUES (?,?,?,?,?,'running','restore_other_stores','admin-a',100,100,1,'worker-a',1000)`
    )
    .run('operation-a', 'tenant-a', 'import', 'request-a', 'c'.repeat(64));
  const adapter: Pick<DatabaseAdapter, 'query' | 'queryOne'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
  };
  store = new TenantBackupR2RestoreStore(adapter);
});

afterEach(() => database.close());

describe('tenant backup R2 restore store', () => {
  it('pins target identity, immutable chunks and completion evidence across retries', async () => {
    const target = {
      writeMode: 'multipart' as const,
      targetBucketBinding: 'IMPORT_ARTIFACTS' as const,
      targetObjectKey: 'restored/tenant-a/operation-a/input.csv',
      now: 101,
    };
    await store.create(owner, { chunk, ...target });
    await store.create(owner, { chunk, ...target, now: 102 });
    await store.attachMultipart(owner, 'multipart-a', 103);
    await store.attachMultipart(owner, 'multipart-a', 104);
    await store.acknowledgePart(owner, {
      chunkIndex: 0,
      byteCount: 3,
      sha256: chunk.chunkSha256,
      targetPartEtag: 'part-etag-a',
      now: 105,
    });
    await store.acknowledgePart(owner, {
      chunkIndex: 0,
      byteCount: 3,
      sha256: chunk.chunkSha256,
      targetPartEtag: 'part-etag-a',
      now: 106,
    });

    const prepared = await store.prepareCompletion(owner, 107);
    expect(prepared.object.state).toBe('completing');
    expect(prepared.parts).toEqual([
      {
        chunk_index: 0,
        byte_count: 3,
        chunk_sha256: chunk.chunkSha256,
        target_part_etag: 'part-etag-a',
        staging_object_key: null,
      },
    ]);
    const completed = await store.markCompleted(owner, {
      version: 'version-a',
      etag: 'etag-a',
      storedSha256: chunk.objectSha256,
      now: 108,
    });
    expect(completed.state).toBe('completed');
    await expect(
      store.markCompleted(owner, {
        version: 'version-a',
        etag: 'etag-a',
        storedSha256: chunk.objectSha256,
        now: 109,
      })
    ).resolves.toMatchObject({ state: 'completed' });

    expect(() =>
      database
        .prepare("UPDATE tenant_backup_r2_restore_objects SET target_object_key='changed'")
        .run()
    ).toThrow('backup_r2_restore_identity');
    expect(() =>
      database
        .prepare(
          "UPDATE tenant_backup_r2_restore_parts SET chunk_sha256='d' || substr(chunk_sha256,2)"
        )
        .run()
    ).toThrow('backup_r2_restore_part_identity');
  });

  it('rejects target reuse, conflicting retry and an incomplete object', async () => {
    await expect(
      store.create(owner, {
        chunk,
        writeMode: 'multipart',
        targetBucketBinding: 'IMPORT_ARTIFACTS',
        targetObjectKey: chunk.objectKey,
        now: 101,
      })
    ).rejects.toThrow('backup_r2_restore_store_invalid');
    await store.create(owner, {
      chunk,
      writeMode: 'multipart',
      targetBucketBinding: 'IMPORT_ARTIFACTS',
      targetObjectKey: 'restored/tenant-a/input.csv',
      now: 102,
    });
    await expect(
      store.create(owner, {
        chunk: { ...chunk, objectSha256: 'd'.repeat(64) },
        writeMode: 'multipart',
        targetBucketBinding: 'IMPORT_ARTIFACTS',
        targetObjectKey: 'restored/tenant-a/input.csv',
        now: 103,
      })
    ).rejects.toThrow('backup_r2_restore_store_invalid');
    await store.attachMultipart(owner, 'multipart-a', 104);
    await expect(store.prepareCompletion(owner, 105)).rejects.toThrow(
      'backup_r2_restore_store_invalid'
    );

    database
      .prepare(
        "UPDATE tenant_backup_operations SET state='failed',lease_owner=NULL,lease_expires_at=NULL"
      )
      .run();
    await expect(
      store.create(
        { ...owner, objectId: 'core:object-b' },
        {
          chunk: { ...chunk, objectId: 'core:object-b' },
          writeMode: 'multipart',
          targetBucketBinding: 'IMPORT_ARTIFACTS',
          targetObjectKey: 'restored/tenant-a/input-b.csv',
          now: 106,
        }
      )
    ).rejects.toThrow('backup_r2_restore_store_invalid');
  });

  it('supports staged empty objects and rejects a stale fencing token', async () => {
    const stagedOwner = { ...owner, objectId: 'core:object-empty' };
    const stagedChunk = {
      ...chunk,
      objectId: stagedOwner.objectId,
      objectKey: 'source/tenant-a/empty',
      objectSha256: 'd'.repeat(64),
      totalBytes: 0,
      chunkSha256: 'd'.repeat(64),
      bytes: new Uint8Array(),
    };
    await store.create(stagedOwner, {
      chunk: stagedChunk,
      writeMode: 'staged',
      targetBucketBinding: 'IMPORT_ARTIFACTS',
      targetObjectKey: 'restored/tenant-a/empty',
      now: 101,
    });
    await expect(store.attachMultipart(stagedOwner, 'multipart-a', 102)).rejects.toThrow(
      'backup_r2_restore_store_invalid'
    );
    await store.beginStaging(stagedOwner, 103);
    await store.acknowledgePart(stagedOwner, {
      chunkIndex: 0,
      byteCount: 0,
      sha256: stagedChunk.chunkSha256,
      stagingObjectKey: 'staging/operation-a/object-empty/0',
      now: 104,
    });
    await expect(store.prepareCompletion(stagedOwner, 105)).resolves.toMatchObject({
      object: { state: 'completing', write_mode: 'staged', multipart_id: null },
    });
    await expect(store.get({ ...stagedOwner, fencingToken: 2 }, 106)).rejects.toThrow(
      'backup_r2_restore_store_invalid'
    );
  });
});
