import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from './bundle-manifest';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { encodeTenantBundle, type TenantBundleDatasetSource } from './bundle-codec';

const PART_BYTES = 4 * 1024 * 1024;
type Database = Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
interface ObjectReceipt {
  size: number;
  checksums: { sha256?: ArrayBuffer };
}
interface Bucket {
  put(
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options: { onlyIf: { etagDoesNotMatch: string }; sha256: string }
  ): Promise<ObjectReceipt | null>;
  head(key: string): Promise<ObjectReceipt | null>;
}
const ACTIVE = `EXISTS (SELECT 1 FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
  ON o.id=a.operation_id AND o.tenant_id=a.tenant_id WHERE a.id=? AND a.tenant_id=? AND a.state='writing'
  AND a.fencing_token=? AND o.fencing_token=a.fencing_token AND o.state='running'
  AND o.lease_owner=? AND o.lease_expires_at>? AND o.updated_at<=?)`;
function fail(): never {
  throw new Error('backup_artifact_write_failed');
}
function hex(value: Uint8Array): string {
  return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
}
interface Part {
  object_key: string;
  byte_count: number;
  sha256: string;
  uploaded: number;
}

/** Every prospective R2 key is durably reserved before writing, including uncertain writes. */
export class TenantBackupArtifactWriter {
  private constructor(
    private readonly db: Database,
    private readonly bucket: Bucket,
    readonly attemptId: string,
    private readonly lease: TenantBackupLease,
    private readonly now: () => number
  ) {}
  static async create(
    db: Database,
    bucket: Bucket,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<TenantBackupArtifactWriter> {
    return this.createOrResume(db, bucket, crypto.randomUUID(), lease, now);
  }

  /** The preparation phase derives this stable ID before its first side effect. */
  static async createOrResume(
    db: Database,
    bucket: Bucket,
    id: string,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<TenantBackupArtifactWriter> {
    if (!/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(id))
      fail();
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    await db.queryOne<{ id: string }>(
      `INSERT INTO tenant_backup_artifact_attempts
      (id,tenant_id,operation_id,fencing_token,state,created_at)
      SELECT ?,tenant_id,id,fencing_token,'writing',? FROM tenant_backup_operations WHERE tenant_id=? AND id=?
      AND state='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=? ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        id,
        timestamp,
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    return this.resume(db, bucket, id, lease, now);
  }
  /**
   * Adopt the recorded attempt under the current operation lease. Ciphertext parts stay immutable.
   * This does not restore an encoder: callers must resume from a durable encoder checkpoint, never
   * regenerate a new randomized stream and append it to the existing ciphertext.
   */
  static async resume(
    db: Database,
    bucket: Bucket,
    attemptId: string,
    lease: TenantBackupLease,
    now: () => number
  ): Promise<TenantBackupArtifactWriter> {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    const row = await db.queryOne<{ id: string }>(
      `UPDATE tenant_backup_artifact_attempts SET fencing_token=?
      WHERE id=? AND tenant_id=? AND operation_id=? AND fencing_token<=?
      AND state IN ('writing','sealed') AND EXISTS (SELECT 1 FROM tenant_backup_operations o
      WHERE o.id=? AND o.tenant_id=? AND o.state='running' AND o.lease_owner=?
      AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?) RETURNING id`,
      [
        lease.fencingToken,
        attemptId,
        lease.tenantId,
        lease.operationId,
        lease.fencingToken,
        lease.operationId,
        lease.tenantId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    if (!row) fail();
    return new TenantBackupArtifactWriter(db, bucket, attemptId, { ...lease }, now);
  }

  /** Inspect saved receipts under a live lease; pending uploads are never counted as completed. */
  async progress(): Promise<{
    state: 'writing' | 'sealed';
    reservedParts: number;
    uploadedParts: number;
    uploadedBytes: number;
  }> {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    const row = await this.db.queryOne<{
      state: 'writing' | 'sealed';
      reservedParts: number;
      uploadedParts: number;
      uploadedBytes: number;
      lastOrdinal: number;
      part_count: number | null;
      byte_count: number | null;
    }>(
      `SELECT a.state,a.part_count,a.byte_count,count(p.ordinal) AS reservedParts,
      coalesce(sum(p.uploaded),0) AS uploadedParts,
      coalesce(sum(CASE WHEN p.uploaded=1 THEN p.byte_count ELSE 0 END),0) AS uploadedBytes,
      coalesce(max(p.ordinal),-1) AS lastOrdinal
      FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
      ON o.id=a.operation_id AND o.tenant_id=a.tenant_id
      LEFT JOIN tenant_backup_artifact_parts p ON p.attempt_id=a.id AND p.tenant_id=a.tenant_id
      WHERE a.id=? AND a.tenant_id=? AND a.operation_id=? AND a.fencing_token=?
      AND a.state IN ('writing','sealed') AND o.state='running' AND o.fencing_token=a.fencing_token
      AND o.lease_owner=? AND o.lease_expires_at>? AND o.updated_at<=? GROUP BY a.id`,
      [
        this.attemptId,
        this.lease.tenantId,
        this.lease.operationId,
        this.lease.fencingToken,
        this.lease.owner,
        timestamp,
        timestamp,
      ]
    );
    if (!row || row.lastOrdinal !== row.reservedParts - 1) fail();
    if (
      row.state === 'sealed' &&
      (row.part_count !== row.reservedParts ||
        row.uploadedParts !== row.reservedParts ||
        row.byte_count !== row.uploadedBytes)
    )
      fail();
    return {
      state: row.state,
      reservedParts: row.reservedParts,
      uploadedParts: row.uploadedParts,
      uploadedBytes: row.uploadedBytes,
    };
  }
  private params(): unknown[] {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    return [
      this.attemptId,
      this.lease.tenantId,
      this.lease.fencingToken,
      this.lease.owner,
      timestamp,
      timestamp,
    ];
  }
  async writePart(ordinal: number, source: Uint8Array): Promise<void> {
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > 1_000_000 ||
      !(source instanceof Uint8Array) ||
      !source.length ||
      source.length > PART_BYTES
    )
      fail();
    const value = new Uint8Array(source);
    const sha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
    const key = `tenant-backup-staging/${this.attemptId}/${ordinal}/${crypto.randomUUID()}`;
    await this.db.execute(
      `INSERT INTO tenant_backup_artifact_parts (attempt_id,tenant_id,ordinal,object_key,byte_count,sha256)
      SELECT ?,?,?,?,?,? WHERE ${ACTIVE} ON CONFLICT(attempt_id,ordinal) DO NOTHING`,
      [this.attemptId, this.lease.tenantId, ordinal, key, value.length, sha, ...this.params()]
    );
    const part = await this.db.queryOne<Part>(
      `SELECT object_key,byte_count,sha256,uploaded FROM tenant_backup_artifact_parts
      WHERE attempt_id=? AND tenant_id=? AND ordinal=? AND ${ACTIVE}`,
      [this.attemptId, this.lease.tenantId, ordinal, ...this.params()]
    );
    if (!part || part.byte_count !== value.length || part.sha256 !== sha) fail();
    if (!part.uploaded) {
      const object =
        (await this.bucket.put(part.object_key, value, {
          onlyIf: { etagDoesNotMatch: '*' },
          sha256: sha,
        })) ?? (await this.bucket.head(part.object_key));
      if (
        !object ||
        object.size !== value.length ||
        !object.checksums.sha256 ||
        hex(new Uint8Array(object.checksums.sha256)) !== sha
      )
        fail();
    }
    const receipt = await this.db.queryOne<{ ordinal: number }>(
      `UPDATE tenant_backup_artifact_parts SET uploaded=1
      WHERE attempt_id=? AND tenant_id=? AND ordinal=? AND sha256=? AND ${ACTIVE} RETURNING ordinal`,
      [this.attemptId, this.lease.tenantId, ordinal, sha, ...this.params()]
    );
    if (!receipt) fail();
  }
  async seal(parts: number, bytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(parts) ||
      parts < 1 ||
      parts > 1_000_001 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1
    )
      fail();
    const row = await this.db.queryOne<{ id: string }>(
      `UPDATE tenant_backup_artifact_attempts SET state='sealed',part_count=?,byte_count=?
      WHERE id=? AND tenant_id=? AND ${ACTIVE}
      AND (SELECT count(*) FROM tenant_backup_artifact_parts WHERE attempt_id=?)=?
      AND (SELECT count(*) FROM tenant_backup_artifact_parts WHERE attempt_id=? AND uploaded=1)=?
      AND (SELECT MAX(ordinal) FROM tenant_backup_artifact_parts WHERE attempt_id=?)=?
      AND (SELECT SUM(byte_count) FROM tenant_backup_artifact_parts WHERE attempt_id=?)=? RETURNING id`,
      [
        parts,
        bytes,
        this.attemptId,
        this.lease.tenantId,
        ...this.params(),
        this.attemptId,
        parts,
        this.attemptId,
        parts,
        this.attemptId,
        parts - 1,
        this.attemptId,
        bytes,
      ]
    );
    if (!row) {
      const progress = await this.progress();
      if (
        progress.state !== 'sealed' ||
        progress.reservedParts !== parts ||
        progress.uploadedBytes !== bytes
      )
        fail();
    }
  }
}

/** Uses the product encoder; never seal after a truncated or failed dataset producer. */
export async function writeTenantBackupArtifact(
  writer: TenantBackupArtifactWriter,
  manifest: TenantBundleManifest,
  datasets: AsyncIterable<TenantBundleDatasetSource>,
  session: TenantBundleKeyEnvelope,
  expected: TenantBundleManifestExpectation,
  signal: AbortSignal
): Promise<{ attemptId: string; parts: number; bytes: number }> {
  let buffer = new Uint8Array(PART_BYTES),
    filled = 0,
    parts = 0,
    bytes = 0;
  for await (const chunk of encodeTenantBundle(manifest, datasets, session, expected)) {
    signal.throwIfAborted();
    let offset = 0;
    while (offset < chunk.length) {
      const size = Math.min(PART_BYTES - filled, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + size), filled);
      filled += size;
      offset += size;
      if (filled === PART_BYTES) {
        await writer.writePart(parts++, buffer);
        bytes += filled;
        buffer = new Uint8Array(PART_BYTES);
        filled = 0;
      }
    }
  }
  signal.throwIfAborted();
  if (filled) {
    await writer.writePart(parts++, buffer.subarray(0, filled));
    bytes += filled;
  }
  signal.throwIfAborted();
  await writer.seal(parts, bytes);
  return { attemptId: writer.attemptId, parts, bytes };
}
