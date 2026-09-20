import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TenantBackupUploadStore } from '../upload-store';
import { uploadTenantBackupPart } from '../upload-part';
import { completeTenantBackupUpload } from '../complete-upload';
let db: DatabaseSync;
let store: TenantBackupUploadStore;
const owner = { tenantId: 'a', actorId: 'admin', uploadId: 'upload' };
const request = {
  ...owner,
  idempotencyKey: 'request',
  bytes: 174,
  sha256: 'ab'.repeat(32),
  now: 100,
};
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/022_tenant_backup_uploads.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  store = new TenantBackupUploadStore({
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
  });
});
afterEach(() => db.close());
it('pins owner, length and digest across retries without accepting another tenant or actor', async () => {
  const row = await store.create(request);
  expect((await store.create({ ...request, uploadId: 'another' })).id).toBe(row.id);
  await expect(store.create({ ...request, bytes: 175 })).rejects.toThrow('idempotency_conflict');
  await expect(store.create({ ...request, actorId: 'other' })).rejects.toThrow(
    'idempotency_conflict'
  );
  await expect(store.get({ ...owner, tenantId: 'b' }, 101)).rejects.toThrow('unavailable');
  await expect(store.get({ ...owner, actorId: 'other' }, 101)).rejects.toThrow('unavailable');
  await expect(store.get(owner, 86400100)).rejects.toThrow('unavailable');
  await store.attachMultipart(owner, 'multipart', 101);
  await store.attachMultipart(owner, 'multipart', 102);
  await expect(store.attachMultipart(owner, 'different', 102)).rejects.toThrow(
    'allocation_conflict'
  );
  expect(() => db.exec('UPDATE tenant_backup_uploads SET expected_bytes=175')).toThrow('immutable');
});
it('reserves immutable parts before R2 writes and resumes a lost upload response', async () => {
  await store.create(request);
  await store.attachMultipart(owner, 'multipart', 101);
  const uploadPart = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost_response'))
    .mockResolvedValue({ partNumber: 1, etag: 'etag' });
  const resumeMultipartUpload = vi.fn(() => ({ uploadPart }));
  const input = {
    store,
    owner,
    number: 1,
    bytes: new Uint8Array(174),
    now: () => 102,
    signal: new AbortController().signal,
    bucket: { resumeMultipartUpload } as unknown as Pick<R2Bucket, 'resumeMultipartUpload'>,
  };
  await expect(uploadTenantBackupPart(input)).rejects.toThrow('lost_response');
  expect(
    db.prepare('SELECT count(*) n FROM tenant_backup_upload_parts WHERE etag IS NULL').get()?.n
  ).toBe(1);
  await expect(
    uploadTenantBackupPart({ ...input, bytes: new Uint8Array(174).fill(1) })
  ).rejects.toThrow('part_conflict');
  expect(uploadPart).toHaveBeenCalledTimes(1);
  expect(await uploadTenantBackupPart(input)).toEqual({ partNumber: 1, etag: 'etag' });
  expect(await uploadTenantBackupPart(input)).toEqual({ partNumber: 1, etag: 'etag' });
  expect(uploadPart).toHaveBeenCalledTimes(2);
  expect(resumeMultipartUpload).toHaveBeenCalledWith('tenant-backup-inputs/a/upload', 'multipart');
  expect(() =>
    db.exec("UPDATE tenant_backup_upload_parts SET sha256='cd' || substr(sha256,3)")
  ).toThrow('immutable');
  db.exec("UPDATE tenant_backup_uploads SET state='cancelling'");
  await expect(uploadTenantBackupPart(input)).rejects.toThrow('unavailable');
});
it('enforces part sizing and ordinal bounds, including the shorter final part', async () => {
  await store.create(request);
  await store.attachMultipart(owner, 'multipart', 101);
  for (const part of [
    { number: 0, bytes: 174 },
    { number: 2, bytes: 174 },
    { number: 1, bytes: 173 },
  ])
    await expect(
      store.reservePart(owner, { ...part, sha256: request.sha256 }, 102)
    ).rejects.toThrow('part_input');
  await store.reservePart(owner, { number: 1, bytes: 174, sha256: request.sha256 }, 102);
  expect(() =>
    db.exec(
      "INSERT INTO tenant_backup_upload_parts VALUES ('upload',NULL,1,'" +
        request.sha256 +
        "',NULL)"
    )
  ).toThrow('NOT NULL');
});

it('moves to completion only with every immutable part and records one verified object identity', async () => {
  await store.create(request);
  await store.attachMultipart(owner, 'multipart', 101);
  await expect(store.prepareCompletion(owner, 102)).rejects.toThrow('incomplete');
  await store.acknowledgePart(
    owner,
    { number: 1, bytes: 174, sha256: request.sha256, etag: 'part-etag' },
    102
  );
  const prepared = await store.prepareCompletion(owner, 103);
  expect(prepared.upload.state).toBe('completing');
  expect(prepared.parts).toEqual([{ partNumber: 1, etag: 'part-etag' }]);
  await expect(
    store.markUploaded(
      owner,
      { version: 'v1', etag: 'object-etag', size: 173 },
      request.sha256,
      104
    )
  ).rejects.toThrow('verification_failed');
  await expect(
    store.markUploaded(
      owner,
      { version: 'v1', etag: 'object-etag', size: 174 },
      'cd'.repeat(32),
      104
    )
  ).rejects.toThrow('verification_failed');
  const uploaded = await store.markUploaded(
    owner,
    { version: 'v1', etag: 'object-etag', size: 174 },
    request.sha256,
    104
  );
  expect(uploaded).toMatchObject({
    state: 'uploaded',
    object_version: 'v1',
    object_etag: 'object-etag',
    verified_sha256: request.sha256,
    completed_at: 104,
  });
  expect(
    await store.markUploaded(
      owner,
      { version: 'v1', etag: 'object-etag', size: 174 },
      request.sha256,
      105
    )
  ).toEqual(uploaded);
  expect(() => db.exec("UPDATE tenant_backup_uploads SET state='uploading'")).toThrow(
    'state_transition'
  );
});

it('leases one completion job and permits takeover only after the database lease expires', async () => {
  await store.create(request);
  await store.attachMultipart(owner, 'multipart', 101);
  await store.acknowledgePart(
    owner,
    { number: 1, bytes: 174, sha256: request.sha256, etag: 'part-etag' },
    102
  );
  await store.prepareCompletion(owner, 103);
  expect(await store.claimCompletion('worker-a', 104)).toMatchObject({
    id: owner.uploadId,
    completion_lease_owner: 'worker-a',
    completion_lease_until: 30104,
  });
  expect(await store.claimCompletion('worker-b', 105)).toBeNull();
  expect(await store.claimCompletion('worker-b', 30104)).toMatchObject({
    id: owner.uploadId,
    completion_lease_owner: 'worker-b',
  });
});

it('recovers a lost multipart completion response, hashes the R2 object, and seals its identity', async () => {
  const nativeCrypto = globalThis.crypto;
  const bytes = new Uint8Array(174).fill(7);
  const digest = Array.from(
    new Uint8Array(await nativeCrypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  await store.create({ ...request, sha256: digest });
  await store.attachMultipart(owner, 'multipart', 101);
  await store.acknowledgePart(
    owner,
    { number: 1, bytes: bytes.length, sha256: digest, etag: 'part-etag' },
    102
  );
  class TestDigestStream extends WritableStream<Uint8Array> {
    readonly digest: Promise<ArrayBuffer>;
    constructor(_algorithm: string) {
      const chunks: Uint8Array[] = [];
      let resolve!: (value: ArrayBuffer) => void;
      const digest = new Promise<ArrayBuffer>((done) => (resolve = done));
      super({
        write(chunk) {
          chunks.push(new Uint8Array(chunk));
        },
        async close() {
          const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.length;
          }
          resolve(await nativeCrypto.subtle.digest('SHA-256', joined));
        },
      });
      this.digest = digest;
    }
  }
  vi.stubGlobal('crypto', {
    ...nativeCrypto,
    subtle: nativeCrypto.subtle,
    DigestStream: TestDigestStream,
  });
  let completed = false;
  const identity = { version: 'version', etag: 'object-etag', size: bytes.length };
  const complete = vi.fn(async () => {
    completed = true;
    throw new Error('lost_response');
  });
  const bucket = {
    head: vi.fn(async () => (completed ? identity : null)),
    get: vi.fn(async () => ({ ...identity, body: new Blob([bytes]).stream() })),
    resumeMultipartUpload: vi.fn(() => ({ complete })),
  };
  const input = { store, bucket, owner, signal: new AbortController().signal, now: () => 103 };
  await expect(completeTenantBackupUpload(input)).rejects.toThrow('lost_response');
  expect((await store.get(owner, 103)).state).toBe('completing');
  expect(await completeTenantBackupUpload(input)).toEqual(identity);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(bucket.get).toHaveBeenCalledWith('tenant-backup-inputs/a/upload', {
    onlyIf: { etagMatches: 'object-etag' },
  });
  expect((await store.get(owner, 103)).state).toBe('uploaded');
  expect(await completeTenantBackupUpload(input)).toEqual(identity);
  expect(bucket.get).toHaveBeenCalledTimes(1);
  bucket.head.mockResolvedValueOnce(null);
  await expect(completeTenantBackupUpload(input)).rejects.toThrow('verification_failed');
  vi.unstubAllGlobals();
});
