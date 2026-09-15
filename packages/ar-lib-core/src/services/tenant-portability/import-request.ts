import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupOperation } from './operation-store';
import type { TenantBackupStepContext } from './operation-executor';
import {
  encodeTenantBackupRequestIntent,
  type TenantBackupRequestIntent,
} from './operation-request';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'batch'>;
interface UploadedInput {
  id: string;
  object_key: string;
  object_version: string;
  object_etag: string;
  expected_bytes: number;
  verified_sha256: string;
}
interface BoundInput {
  ordinal: number;
  upload_id: string;
  object_key: string;
  object_version: string;
  object_etag: string;
  size_bytes: number;
  digest_sha256: string;
  bound_at: number;
}
export interface TenantBackupBoundInput {
  inputId: string;
  ordinal: number;
  identity: { key: string; version: string; etag: string; size: number };
  digestSha256: string;
  boundAt: number;
}
type RequestOperation = TenantBackupOperation & { request_json: string | null };

function invalid(): never {
  throw new Error('invalid_backup_import_request');
}
function identifier(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) invalid();
  return value;
}

/** Atomically create an import operation and pin every verified R2 object identity. */
export class TenantBackupImportRequestStore {
  constructor(private readonly database: Database) {}

  async create(input: {
    id: string;
    tenantId: string;
    actorId: string;
    idempotencyKey: string;
    source: TenantBackupRequestIntent['source'];
    selection: TenantBackupRequestIntent['selection'];
    uploadIds: string[];
    now: number;
  }): Promise<TenantBackupOperation> {
    for (const value of [input.id, input.tenantId, input.actorId, input.idempotencyKey])
      identifier(value);
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      !Array.isArray(input.uploadIds) ||
      input.uploadIds.length < 1 ||
      input.uploadIds.length > 32
    )
      invalid();
    const uploadIds = input.uploadIds.map(identifier);
    if (new Set(uploadIds).size !== uploadIds.length) invalid();

    const existing = await this.find(input.tenantId, input.idempotencyKey);
    if (existing)
      return this.verifyExisting(existing, input.actorId, input.source, input.selection, uploadIds);

    const placeholders = uploadIds.map(() => '?').join(',');
    const rows = await this.database.query<UploadedInput>(
      `SELECT id,object_key,object_version,object_etag,expected_bytes,verified_sha256
       FROM tenant_backup_uploads WHERE tenant_id=? AND created_by=? AND state='uploaded'
       AND completed_at IS NOT NULL AND completed_at<=? AND expires_at>? AND id IN (${placeholders})`,
      [input.tenantId, input.actorId, input.now, input.now, ...uploadIds]
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = uploadIds.map((id) => byId.get(id));
    if (
      rows.length !== uploadIds.length ||
      ordered.some(
        (row) =>
          !row?.object_key ||
          !row.object_version ||
          !row.object_etag ||
          !/^[a-f0-9]{64}$/.test(row.verified_sha256)
      )
    )
      invalid();
    const uploads = ordered as UploadedInput[];
    const encoded = await encodeTenantBackupRequestIntent({
      version: 1,
      kind: 'import',
      source: input.source,
      selection: input.selection,
      inputs: uploads.map((upload) => ({
        id: upload.id,
        digestSha256: upload.verified_sha256,
      })),
    });
    if (encoded.intent.source.tenantId !== input.tenantId) invalid();
    const statements = [
      {
        sql: `INSERT INTO tenant_backup_operations
          (id,tenant_id,kind,idempotency_key,request_digest,created_by,created_at,updated_at,request_json,state,phase)
          VALUES (?,?,?,?,?,?,?,?,?,'waiting','unlock')`,
        params: [
          input.id,
          input.tenantId,
          'import',
          input.idempotencyKey,
          encoded.digest,
          input.actorId,
          input.now,
          input.now,
          encoded.json,
        ],
      },
      ...uploads.map((upload, ordinal) => ({
        sql: `INSERT INTO tenant_backup_operation_inputs
          (operation_id,tenant_id,ordinal,upload_id,object_key,object_version,object_etag,size_bytes,digest_sha256,bound_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [
          input.id,
          input.tenantId,
          ordinal,
          upload.id,
          upload.object_key,
          upload.object_version,
          upload.object_etag,
          upload.expected_bytes,
          upload.verified_sha256,
          input.now,
        ],
      })),
    ];
    try {
      const results = await this.database.batch(statements);
      if (results.length !== statements.length || results.some((result) => !result.success))
        invalid();
    } catch {
      // A concurrent idempotent creator may have won. The complete durable identity is rechecked.
    }
    const created = await this.find(input.tenantId, input.idempotencyKey);
    if (!created) invalid();
    return this.verifyExisting(created, input.actorId, input.source, input.selection, uploadIds);
  }

  private find(tenantId: string, idempotencyKey: string): Promise<RequestOperation | null> {
    return this.database.queryOne<RequestOperation>(
      'SELECT * FROM tenant_backup_operations WHERE tenant_id=? AND idempotency_key=?',
      [tenantId, idempotencyKey]
    );
  }

  private async verifyExisting(
    operation: RequestOperation,
    actorId: string,
    source: TenantBackupRequestIntent['source'],
    selection: TenantBackupRequestIntent['selection'],
    uploadIds: string[]
  ): Promise<TenantBackupOperation> {
    const inputs = await this.database.query<BoundInput>(
      `SELECT ordinal,upload_id,object_key,object_version,object_etag,size_bytes,digest_sha256,bound_at
       FROM tenant_backup_operation_inputs WHERE operation_id=? AND tenant_id=? ORDER BY ordinal`,
      [operation.id, operation.tenant_id]
    );
    if (
      operation.kind !== 'import' ||
      operation.created_by !== actorId ||
      inputs.length !== uploadIds.length ||
      inputs.some(
        (item, ordinal) => item.ordinal !== ordinal || item.upload_id !== uploadIds[ordinal]
      )
    )
      invalid();
    const encoded = await encodeTenantBackupRequestIntent({
      version: 1,
      kind: 'import',
      source,
      selection,
      inputs: inputs.map((item) => ({ id: item.upload_id, digestSha256: item.digest_sha256 })),
    });
    if (
      encoded.intent.source.tenantId !== operation.tenant_id ||
      operation.request_json !== encoded.json ||
      operation.request_digest !== encoded.digest
    )
      invalid();
    return operation;
  }

  /** Recover only the immutable input set owned by the exact live import slice. */
  async loadForExecution(
    context: TenantBackupStepContext,
    now: () => number
  ): Promise<{ intent: TenantBackupRequestIntent; inputs: TenantBackupBoundInput[] }> {
    const { operation, lease, signal } = context;
    if (
      operation.kind !== 'import' ||
      operation.state !== 'running' ||
      operation.id !== lease.operationId ||
      operation.tenant_id !== lease.tenantId
    )
      invalid();
    const current = async () => {
      signal.throwIfAborted();
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) invalid();
      if (
        !(await this.database.queryOne(
          `SELECT 1 AS live FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND kind='import'
           AND state='running' AND lease_owner=? AND fencing_token=? AND revision=? AND phase=?
           AND cursor_json IS ? AND lease_expires_at>? AND updated_at<=?`,
          [
            lease.operationId,
            lease.tenantId,
            lease.owner,
            lease.fencingToken,
            operation.revision,
            operation.phase,
            operation.cursor_json,
            timestamp,
            timestamp,
          ]
        ))
      )
        invalid();
      signal.throwIfAborted();
    };
    await current();
    const saved = await this.database.queryOne<RequestOperation>(
      'SELECT * FROM tenant_backup_operations WHERE id=? AND tenant_id=?',
      [lease.operationId, lease.tenantId]
    );
    const inputs = await this.database.query<BoundInput>(
      `SELECT ordinal,upload_id,object_key,object_version,object_etag,size_bytes,digest_sha256,bound_at
       FROM tenant_backup_operation_inputs WHERE operation_id=? AND tenant_id=? ORDER BY ordinal`,
      [lease.operationId, lease.tenantId]
    );
    if (!saved?.request_json || inputs.length < 1 || inputs.length > 32) invalid();
    let encoded: Awaited<ReturnType<typeof encodeTenantBackupRequestIntent>>;
    try {
      encoded = await encodeTenantBackupRequestIntent(JSON.parse(saved.request_json));
    } catch {
      return invalid();
    }
    if (
      encoded.intent.kind !== 'import' ||
      encoded.intent.source.tenantId !== lease.tenantId ||
      saved.kind !== 'import' ||
      saved.request_json !== encoded.json ||
      saved.request_digest !== encoded.digest ||
      encoded.intent.inputs.length !== inputs.length ||
      inputs.some(
        (item, ordinal) =>
          item.ordinal !== ordinal ||
          item.upload_id !== encoded.intent.inputs[ordinal]?.id ||
          item.digest_sha256 !== encoded.intent.inputs[ordinal]?.digestSha256 ||
          !item.object_key ||
          !item.object_version ||
          !item.object_etag ||
          !Number.isSafeInteger(item.size_bytes) ||
          item.size_bytes < 174 ||
          !Number.isSafeInteger(item.bound_at) ||
          item.bound_at < 0
      )
    )
      invalid();
    await current();
    return {
      intent: encoded.intent,
      inputs: inputs.map((item) => ({
        inputId: item.upload_id,
        ordinal: item.ordinal,
        identity: {
          key: item.object_key,
          version: item.object_version,
          etag: item.object_etag,
          size: item.size_bytes,
        },
        digestSha256: item.digest_sha256,
        boundAt: item.bound_at,
      })),
    };
  }
}
