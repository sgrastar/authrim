import type { DatabaseAdapter } from '../../db/adapter';

export const TENANT_BACKUP_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export interface TenantBackupUpload {
  id: string;
  tenant_id: string;
  created_by: string;
  expected_bytes: number;
  expected_sha256: string;
  object_key: string;
  multipart_id: string | null;
  object_version: string | null;
  object_etag: string | null;
  verified_sha256: string | null;
  completed_at: number | null;
  completion_lease_owner: string | null;
  completion_lease_until: number | null;
  state: 'allocating' | 'uploading' | 'completing' | 'uploaded' | 'cancelling' | 'deleted';
  created_at: number;
  expires_at: number;
}
interface Owner {
  tenantId: string;
  actorId: string;
  uploadId: string;
}
function identifiers(...values: string[]) {
  if (values.some((value) => !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)))
    throw new Error('backup_upload_input');
}
function timestamp(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 86400000))
    throw new Error('backup_upload_clock');
}
/** Durable reservations precede multipart writes. Uploaded bytes still require cryptographic validation. */
export class TenantBackupUploadStore {
  constructor(private readonly database: Pick<DatabaseAdapter, 'queryOne'>) {}
  async create(
    input: Owner & { idempotencyKey: string; bytes: number; sha256: string; now: number }
  ): Promise<TenantBackupUpload> {
    identifiers(input.uploadId, input.tenantId, input.actorId, input.idempotencyKey);
    timestamp(input.now);
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 174 ||
      input.bytes > TENANT_BACKUP_UPLOAD_PART_BYTES * 10000 ||
      !/^[a-f0-9]{64}$/.test(input.sha256)
    )
      throw new Error('backup_upload_input');
    const key = `tenant-backup-inputs/${encodeURIComponent(input.tenantId)}/${encodeURIComponent(input.uploadId)}`;
    await this.database.queryOne(
      `INSERT INTO tenant_backup_uploads(id,tenant_id,created_by,idempotency_key,expected_bytes,expected_sha256,object_key,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
      [
        input.uploadId,
        input.tenantId,
        input.actorId,
        input.idempotencyKey,
        input.bytes,
        input.sha256,
        key,
        input.now,
        input.now + 86400000,
      ]
    );
    const row = await this.database.queryOne<TenantBackupUpload>(
      'SELECT * FROM tenant_backup_uploads WHERE tenant_id=? AND idempotency_key=?',
      [input.tenantId, input.idempotencyKey]
    );
    if (
      !row ||
      row.created_by !== input.actorId ||
      row.expected_bytes !== input.bytes ||
      row.expected_sha256 !== input.sha256 ||
      row.expires_at <= input.now ||
      row.state === 'deleted' ||
      row.state === 'cancelling'
    )
      throw new Error('backup_upload_idempotency_conflict');
    return row;
  }
  async get(owner: Owner, now: number): Promise<TenantBackupUpload> {
    identifiers(owner.uploadId, owner.tenantId, owner.actorId);
    timestamp(now);
    const row = await this.database.queryOne<TenantBackupUpload>(
      `SELECT * FROM tenant_backup_uploads WHERE id=? AND tenant_id=? AND created_by=? AND expires_at>? AND created_at<=? AND state NOT IN ('cancelling','deleted')`,
      [owner.uploadId, owner.tenantId, owner.actorId, now, now]
    );
    if (!row) throw new Error('backup_upload_unavailable');
    return row;
  }
  async requestCancel(owner: Owner, now: number): Promise<TenantBackupUpload> {
    identifiers(owner.uploadId, owner.tenantId, owner.actorId);
    timestamp(now);
    const row = await this.database.queryOne<TenantBackupUpload>(
      `UPDATE tenant_backup_uploads SET state='cancelling',completion_lease_owner=NULL,completion_lease_until=NULL
       WHERE id=? AND tenant_id=? AND created_by=? AND created_at<=? AND state!='deleted'
         AND NOT EXISTS (SELECT 1 FROM tenant_backup_operation_inputs i WHERE i.upload_id=tenant_backup_uploads.id)
       RETURNING *`,
      [owner.uploadId, owner.tenantId, owner.actorId, now]
    );
    if (!row || row.state !== 'cancelling') throw new Error('backup_upload_cancel_conflict');
    return row;
  }
  async attachMultipart(
    owner: Owner,
    multipartId: string,
    now: number
  ): Promise<TenantBackupUpload> {
    if (!multipartId || multipartId.length > 1024) throw new Error('backup_upload_input');
    await this.get(owner, now);
    await this.database.queryOne(
      `UPDATE tenant_backup_uploads SET multipart_id=?,state='uploading' WHERE id=? AND tenant_id=? AND created_by=? AND state='allocating' AND multipart_id IS NULL AND expires_at>? RETURNING id`,
      [multipartId, owner.uploadId, owner.tenantId, owner.actorId, now]
    );
    const row = await this.get(owner, now);
    if (row.multipart_id !== multipartId || row.state !== 'uploading')
      throw new Error('backup_upload_allocation_conflict');
    return row;
  }
  async reservePart(
    owner: Owner,
    part: { number: number; bytes: number; sha256: string },
    now: number
  ): Promise<{ etag: string | null }> {
    const upload = await this.get(owner, now);
    const parts = Math.ceil(upload.expected_bytes / TENANT_BACKUP_UPLOAD_PART_BYTES);
    const bytes =
      part.number === parts
        ? upload.expected_bytes - (parts - 1) * TENANT_BACKUP_UPLOAD_PART_BYTES
        : TENANT_BACKUP_UPLOAD_PART_BYTES;
    if (
      upload.state !== 'uploading' ||
      !Number.isSafeInteger(part.number) ||
      part.number < 1 ||
      part.number > parts ||
      part.bytes !== bytes ||
      !/^[a-f0-9]{64}$/.test(part.sha256)
    )
      throw new Error('backup_upload_part_input');
    await this.database.queryOne(
      `INSERT INTO tenant_backup_upload_parts(upload_id,part_number,byte_count,sha256)
       SELECT id,?,?,? FROM tenant_backup_uploads WHERE id=? AND tenant_id=? AND created_by=? AND state='uploading' AND expires_at>?
       ON CONFLICT(upload_id,part_number) DO NOTHING RETURNING upload_id`,
      [part.number, part.bytes, part.sha256, owner.uploadId, owner.tenantId, owner.actorId, now]
    );
    const row = await this.database.queryOne<{
      etag: string | null;
      byte_count: number;
      sha256: string;
    }>(
      `SELECT p.* FROM tenant_backup_upload_parts p JOIN tenant_backup_uploads u ON u.id=p.upload_id
       WHERE u.id=? AND u.tenant_id=? AND u.created_by=? AND u.state='uploading' AND u.expires_at>? AND p.part_number=?`,
      [owner.uploadId, owner.tenantId, owner.actorId, now, part.number]
    );
    if (!row || row.byte_count !== part.bytes || row.sha256 !== part.sha256)
      throw new Error('backup_upload_part_conflict');
    return { etag: row.etag };
  }
  async acknowledgePart(
    owner: Owner,
    part: { number: number; bytes: number; sha256: string; etag: string },
    now: number
  ): Promise<void> {
    if (!part.etag || part.etag.length > 1024) throw new Error('backup_upload_part_input');
    await this.reservePart(owner, part, now);
    await this.database.queryOne(
      `UPDATE tenant_backup_upload_parts SET etag=? WHERE upload_id=? AND part_number=? AND etag IS NULL
       AND EXISTS(SELECT 1 FROM tenant_backup_uploads u WHERE u.id=upload_id AND u.tenant_id=? AND u.created_by=? AND u.state='uploading' AND u.expires_at>?) RETURNING upload_id`,
      [part.etag, owner.uploadId, part.number, owner.tenantId, owner.actorId, now]
    );
    const saved = await this.reservePart(owner, part, now);
    if (saved.etag !== part.etag) throw new Error('backup_upload_part_conflict');
  }

  async prepareCompletion(
    owner: Owner,
    now: number
  ): Promise<{ upload: TenantBackupUpload; parts: { partNumber: number; etag: string }[] }> {
    let upload = await this.get(owner, now);
    if (!['uploading', 'completing', 'uploaded'].includes(upload.state))
      throw new Error('backup_upload_completion_state');
    const expectedParts = Math.ceil(upload.expected_bytes / TENANT_BACKUP_UPLOAD_PART_BYTES);
    const aggregate = await this.database.queryOne<{
      count: number;
      bytes: number;
      first_part: number;
      last_part: number;
      incomplete: number;
      parts_json: string;
    }>(
      `SELECT count(*) count,coalesce(sum(byte_count),0) bytes,coalesce(min(part_number),0) first_part,
       coalesce(max(part_number),0) last_part,sum(CASE WHEN etag IS NULL THEN 1 ELSE 0 END) incomplete,
       json_group_array(json_object('partNumber',part_number,'etag',etag) ORDER BY part_number) parts_json
       FROM tenant_backup_upload_parts WHERE upload_id=?`,
      [owner.uploadId]
    );
    if (
      !aggregate ||
      aggregate.count !== expectedParts ||
      aggregate.bytes !== upload.expected_bytes ||
      aggregate.first_part !== 1 ||
      aggregate.last_part !== expectedParts ||
      aggregate.incomplete !== 0
    )
      throw new Error('backup_upload_incomplete');
    let parts: { partNumber: number; etag: string }[];
    try {
      parts = JSON.parse(aggregate.parts_json) as typeof parts;
    } catch {
      throw new Error('backup_upload_incomplete');
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== expectedParts ||
      parts.some(
        (part, index) =>
          !part ||
          Object.keys(part).sort().join(',') !== 'etag,partNumber' ||
          part.partNumber !== index + 1 ||
          typeof part.etag !== 'string' ||
          !part.etag ||
          part.etag.length > 1024
      )
    )
      throw new Error('backup_upload_incomplete');
    if (upload.state === 'uploading') {
      await this.database.queryOne(
        `UPDATE tenant_backup_uploads SET state='completing' WHERE id=? AND tenant_id=? AND created_by=?
         AND state='uploading' AND expires_at>? RETURNING id`,
        [owner.uploadId, owner.tenantId, owner.actorId, now]
      );
      upload = await this.get(owner, now);
    }
    if (!['completing', 'uploaded'].includes(upload.state))
      throw new Error('backup_upload_completion_state');
    return { upload, parts };
  }

  /** Claim one durable completion job so overlapping scheduled ticks do not complete it concurrently. */
  async claimCompletion(workerId: string, now: number): Promise<TenantBackupUpload | null> {
    identifiers(workerId);
    timestamp(now);
    return this.database.queryOne<TenantBackupUpload>(
      `WITH candidate AS (
         SELECT id FROM tenant_backup_uploads
         WHERE state='completing' AND expires_at>? AND created_at<=?
           AND (completion_lease_until IS NULL OR completion_lease_until<=?)
         ORDER BY created_at,id LIMIT 1
       )
       UPDATE tenant_backup_uploads SET completion_lease_owner=?,completion_lease_until=?
       WHERE id=(SELECT id FROM candidate) AND state='completing'
         AND (completion_lease_until IS NULL OR completion_lease_until<=?)
       RETURNING *`,
      [now, now, now, workerId, now + 30000, now]
    );
  }

  /** Claim one expired input whose importing operation no longer needs its ciphertext. */
  async claimCleanup(workerId: string, now: number): Promise<TenantBackupUpload | null> {
    identifiers(workerId);
    timestamp(now);
    return this.database.queryOne<TenantBackupUpload>(
      `WITH candidate AS (
         SELECT u.id FROM tenant_backup_uploads u
         WHERE (u.state='cancelling' OR u.expires_at<=?) AND u.created_at<=? AND u.state!='deleted'
           AND (u.completion_lease_until IS NULL OR u.completion_lease_until<=?)
           AND NOT EXISTS (
             SELECT 1 FROM tenant_backup_operation_inputs i
             JOIN tenant_backup_operations o ON o.id=i.operation_id AND o.tenant_id=i.tenant_id
             WHERE i.upload_id=u.id AND o.state NOT IN ('completed','cancelled','failed')
           )
         ORDER BY u.expires_at,u.id LIMIT 1
       )
       UPDATE tenant_backup_uploads SET state='cancelling',completion_lease_owner=?,completion_lease_until=?
       WHERE id=(SELECT id FROM candidate) AND state!='deleted'
         AND (completion_lease_until IS NULL OR completion_lease_until<=?)
       RETURNING *`,
      [now, now, now, workerId, now + 30000, now]
    );
  }

  /** Keep a tombstone and immutable identity after external R2 cleanup has succeeded. */
  async markDeleted(uploadId: string, workerId: string, now: number): Promise<void> {
    identifiers(uploadId, workerId);
    timestamp(now);
    const saved = await this.database.queryOne<{ id: string }>(
      `UPDATE tenant_backup_uploads SET state='deleted',completion_lease_owner=NULL,completion_lease_until=NULL
       WHERE id=? AND state='cancelling' AND completion_lease_owner=? AND completion_lease_until>?
         AND NOT EXISTS (
           SELECT 1 FROM tenant_backup_operation_inputs i
           JOIN tenant_backup_operations o ON o.id=i.operation_id AND o.tenant_id=i.tenant_id
           WHERE i.upload_id=tenant_backup_uploads.id AND o.state NOT IN ('completed','cancelled','failed')
         ) RETURNING id`,
      [uploadId, workerId, now]
    );
    if (!saved) throw new Error('backup_upload_cleanup_fenced');
  }

  async markUploaded(
    owner: Owner,
    object: { version: string; etag: string; size: number },
    verifiedSha256: string,
    now: number
  ): Promise<TenantBackupUpload> {
    const upload = await this.get(owner, now);
    if (
      upload.state === 'uploaded' &&
      upload.object_version === object.version &&
      upload.object_etag === object.etag &&
      upload.expected_bytes === object.size &&
      upload.verified_sha256 === verifiedSha256
    )
      return upload;
    if (
      upload.state !== 'completing' ||
      !object.version ||
      object.version.length > 1024 ||
      !object.etag ||
      object.etag.length > 1024 ||
      object.size !== upload.expected_bytes ||
      verifiedSha256 !== upload.expected_sha256
    )
      throw new Error('backup_upload_verification_failed');
    await this.database.queryOne(
      `UPDATE tenant_backup_uploads SET state='uploaded',object_version=?,object_etag=?,verified_sha256=?,completed_at=?,completion_lease_owner=NULL,completion_lease_until=NULL
       WHERE id=? AND tenant_id=? AND created_by=? AND state='completing' AND expected_bytes=?
       AND expected_sha256=? AND expires_at>? RETURNING id`,
      [
        object.version,
        object.etag,
        verifiedSha256,
        now,
        owner.uploadId,
        owner.tenantId,
        owner.actorId,
        object.size,
        verifiedSha256,
        now,
      ]
    );
    const saved = await this.get(owner, now);
    if (
      saved.state !== 'uploaded' ||
      saved.object_version !== object.version ||
      saved.object_etag !== object.etag ||
      saved.verified_sha256 !== verifiedSha256 ||
      saved.completed_at === null
    )
      throw new Error('backup_upload_verification_failed');
    return saved;
  }
}
