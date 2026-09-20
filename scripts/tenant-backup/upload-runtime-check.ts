/** Disposable local D1/R2 check; no environment discovery, deployment or remote access. */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { TenantBackupUploadStore } from '../../packages/ar-lib-core/src/services/tenant-portability/upload-store';
import { uploadTenantBackupPart } from '../../packages/ar-lib-core/src/services/tenant-portability/upload-part';
import { completeTenantBackupUpload } from '../../packages/ar-lib-core/src/services/tenant-portability/complete-upload';
import { cleanupExpiredTenantBackupUpload } from '../../packages/ar-lib-core/src/services/tenant-portability/cleanup-upload';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql';
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: `export default {async fetch(_request,env){
    const object=await env.INPUTS.get('tenant-backup-inputs/local-tenant/local-upload');
    if(!object?.body)return new Response('missing',{status:404});
    const digestStream=new crypto.DigestStream('SHA-256');
    await object.body.pipeTo(digestStream);
    const digest=Array.from(new Uint8Array(await digestStream.digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    return Response.json({digest,size:object.size});
  }}`,
  compatibilityDate: '2026-07-08',
  d1Databases: ['DB'],
  r2Buckets: ['INPUTS'],
});
try {
  const database = await runtime.getD1Database('DB');
  const bucket = await runtime.getR2Bucket('INPUTS');
  const sql = readFileSync(
    new URL('../../migrations/admin/d1/022_tenant_backup_uploads.sql', import.meta.url),
    'utf8'
  );
  await database.batch(splitMigrationSql(sql).map((statement) => database.prepare(statement)));
  const cleanupSchema = `CREATE TABLE tenant_backup_operations (
    id TEXT NOT NULL, tenant_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(id,tenant_id)
  );
  CREATE TABLE tenant_backup_operation_inputs (
    operation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE
  );`;
  await database.batch(
    splitMigrationSql(cleanupSchema).map((statement) => database.prepare(statement))
  );
  const store = new TenantBackupUploadStore({
    async queryOne<T>(statement: string, params: unknown[] = []) {
      return database
        .prepare(statement)
        .bind(...params)
        .first<T>();
    },
  });
  const bytes = new Uint8Array(8 * 1024 * 1024 + 174).fill(7);
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  const owner = { tenantId: 'local-tenant', actorId: 'local-admin', uploadId: 'local-upload' };
  const upload = await store.create({
    ...owner,
    idempotencyKey: 'local-request',
    bytes: bytes.length,
    sha256: expectedSha256,
    now: Date.now(),
  });
  const multipart = await bucket.createMultipartUpload(upload.object_key);
  await store.attachMultipart(owner, multipart.uploadId, Date.now());
  const input = {
    store,
    bucket,
    owner,
    number: 1,
    bytes: bytes.subarray(0, 8 * 1024 * 1024),
    signal: new AbortController().signal,
    now: Date.now,
  };
  const part = await uploadTenantBackupPart(input);
  assert.deepEqual(await uploadTenantBackupPart(input), part);
  await assert.rejects(
    uploadTenantBackupPart({ ...input, bytes: new Uint8Array(8 * 1024 * 1024).fill(8) }),
    /part_conflict/
  );
  await uploadTenantBackupPart({
    ...input,
    number: 2,
    bytes: bytes.subarray(8 * 1024 * 1024),
  });
  const nativeCrypto = globalThis.crypto;
  class NodeDigestStream extends WritableStream<Uint8Array> {
    readonly digest: Promise<ArrayBuffer>;
    constructor(_algorithm: string) {
      const hash = createHash('sha256');
      let resolve!: (value: ArrayBuffer) => void;
      const digest = new Promise<ArrayBuffer>((done) => (resolve = done));
      super({
        write(chunk) {
          hash.update(chunk);
        },
        close() {
          const value = hash.digest();
          resolve(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        },
      });
      this.digest = digest;
    }
  }
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { ...webcrypto, subtle: webcrypto.subtle, DigestStream: NodeDigestStream },
  });
  const completed = await completeTenantBackupUpload({
    store,
    bucket: bucket as unknown as Parameters<typeof completeTenantBackupUpload>[0]['bucket'],
    owner,
    signal: new AbortController().signal,
    now: Date.now,
  });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: nativeCrypto });
  assert.equal(completed.size, bytes.length);
  const object = await bucket.get(upload.object_key);
  assert.ok(object);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  const digestResponse = await runtime.dispatchFetch('http://localhost/digest');
  assert.equal(digestResponse.status, 200);
  assert.deepEqual(await digestResponse.json(), { digest: expectedSha256, size: bytes.length });
  await assert.rejects(
    uploadTenantBackupPart({ ...input, owner: { ...owner, tenantId: 'other' } }),
    /unavailable/
  );
  const cleanupOwner = {
    tenantId: 'local-tenant',
    actorId: 'local-admin',
    uploadId: 'expired-upload',
  };
  const cleanupCreatedAt = Date.now() - 86400001;
  const cleanupUpload = await store.create({
    ...cleanupOwner,
    idempotencyKey: 'expired-request',
    bytes: 174,
    sha256: 'ab'.repeat(32),
    now: cleanupCreatedAt,
  });
  const cleanupMultipart = await bucket.createMultipartUpload(cleanupUpload.object_key);
  await store.attachMultipart(cleanupOwner, cleanupMultipart.uploadId, cleanupCreatedAt + 1);
  assert.deepEqual(
    await cleanupExpiredTenantBackupUpload({
      store,
      bucket: bucket as unknown as Parameters<typeof cleanupExpiredTenantBackupUpload>[0]['bucket'],
      workerId: 'local-cleanup-worker',
      now: Date.now,
    }),
    { cleaned: true }
  );
  assert.equal(await bucket.head(cleanupUpload.object_key), null);
  assert.equal(
    await database
      .prepare('SELECT state FROM tenant_backup_uploads WHERE id=?')
      .bind(cleanupOwner.uploadId)
      .first('state'),
    'deleted'
  );
  process.stdout.write(
    JSON.stringify({
      localD1: true,
      localR2Multipart: true,
      samePartReplay: true,
      uploadApiRuntimeTested: false,
      fullDigestValidated: true,
      cloudflareDigestStream: true,
      expiredMultipartCleanup: true,
    }) + '\n'
  );
} finally {
  await runtime.dispose();
}
