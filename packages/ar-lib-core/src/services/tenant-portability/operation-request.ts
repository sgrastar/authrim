import type { TenantBackupStepContext } from './operation-executor';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupOperation } from './operation-store';
import {
  parseTenantBackupSelection,
  type TenantBackupSelection,
  type TenantPortableSourceIdentity,
} from './selection-contract';

export interface TenantBackupRequestIntent {
  version: 1;
  kind: 'export' | 'import';
  source: TenantPortableSourceIdentity;
  selection: TenantBackupSelection;
  /** Authorized, immutable upload handles and exact artifact digests; never object paths. */
  inputs: { id: string; digestSha256: string }[];
}
function invalid(): never {
  throw new Error('invalid_backup_request_intent');
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) invalid();
  return value;
}
/** Canonical field order, detached values and strict v1 scope. */
export function parseTenantBackupRequestIntent(value: unknown): TenantBackupRequestIntent {
  const root = record(value, ['version', 'kind', 'source', 'selection', 'inputs']);
  if (root.version !== 1 || (root.kind !== 'export' && root.kind !== 'import')) invalid();
  const source = record(root.source, ['tenantId', 'issuer', 'productVersion']);
  if (
    typeof source.issuer !== 'string' ||
    source.issuer.length > 2048 ||
    typeof source.productVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(source.productVersion)
  )
    invalid();
  try {
    const url = new URL(source.issuer);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid();
  } catch {
    invalid();
  }
  if (
    !Array.isArray(root.inputs) ||
    root.inputs.length > 32 ||
    (root.kind === 'export' ? root.inputs.length !== 0 : root.inputs.length === 0)
  )
    invalid();
  const inputs = root.inputs.map((value) => {
    const input = record(value, ['id', 'digestSha256']);
    if (typeof input.digestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.digestSha256))
      invalid();
    return { id: identifier(input.id), digestSha256: input.digestSha256 };
  });
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length) invalid();
  return {
    version: 1,
    kind: root.kind,
    source: {
      tenantId: identifier(source.tenantId),
      issuer: source.issuer,
      productVersion: source.productVersion,
    },
    selection: parseTenantBackupSelection(root.selection),
    inputs,
  };
}
async function digest(json: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(new TextEncoder().encode(json)))
  );
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Canonical request bytes and digest shared by atomic import request creation. */
export async function encodeTenantBackupRequestIntent(value: unknown): Promise<{
  intent: TenantBackupRequestIntent;
  json: string;
  digest: string;
}> {
  const intent = parseTenantBackupRequestIntent(value);
  const json = JSON.stringify(intent);
  if (json.length > 32768) invalid();
  return { intent, json, digest: await digest(json) };
}

type RequestOperation = TenantBackupOperation & { request_json: string | null };
export class TenantBackupRequestStore {
  constructor(private readonly db: Pick<DatabaseAdapter, 'queryOne' | 'execute'>) {}
  /** Caller authenticates source and upload handles before invoking this method. */
  async create(input: {
    id: string;
    tenantId: string;
    actorId: string;
    idempotencyKey: string;
    intent: unknown;
    now: number;
  }): Promise<TenantBackupOperation> {
    const encoded = await encodeTenantBackupRequestIntent(input.intent);
    const { intent } = encoded;
    for (const id of [input.id, input.tenantId, input.actorId, input.idempotencyKey])
      identifier(id);
    if (
      intent.source.tenantId !== input.tenantId ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0
    )
      invalid();
    const { json, digest: requestDigest } = encoded;
    await this.db.execute(
      `INSERT INTO tenant_backup_operations
      (id,tenant_id,kind,idempotency_key,request_digest,created_by,created_at,updated_at,request_json,state,phase)
      VALUES (?,?,?,?,?,?,?,?,?,'waiting','unlock') ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
      [
        input.id,
        input.tenantId,
        intent.kind,
        input.idempotencyKey,
        requestDigest,
        input.actorId,
        input.now,
        input.now,
        json,
      ]
    );
    const row = await this.db.queryOne<RequestOperation>(
      'SELECT * FROM tenant_backup_operations WHERE tenant_id=? AND idempotency_key=?',
      [input.tenantId, input.idempotencyKey]
    );
    if (
      !row ||
      row.request_json !== json ||
      row.request_digest !== requestDigest ||
      row.created_by !== input.actorId ||
      row.kind !== intent.kind
    )
      throw new Error('backup_operation_idempotency_conflict');
    return row;
  }
  /** Bind one accepted key and queue preparation in the same database statement. */
  async start(input: {
    tenantId: string;
    operationId: string;
    actorId: string;
    challengeId: string;
    revision: number;
    now: number;
  }): Promise<TenantBackupOperation | null> {
    for (const id of [input.tenantId, input.operationId, input.actorId, input.challengeId])
      identifier(id);
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0
    )
      invalid();
    return this.db.queryOne<TenantBackupOperation>(
      `UPDATE tenant_backup_operations
      SET state='queued',phase='prepare',active_key_challenge_id=?,revision=revision+1,fencing_token=fencing_token+1,updated_at=?
      WHERE id=? AND tenant_id=? AND created_by=? AND revision=? AND state='waiting' AND phase='unlock'
      AND kind='export'
      AND request_json IS NOT NULL AND updated_at<=? AND EXISTS (SELECT 1 FROM tenant_backup_key_handoffs k
      WHERE k.id=? AND k.operation_id=tenant_backup_operations.id AND k.tenant_id=tenant_backup_operations.tenant_id
      AND k.request_digest=tenant_backup_operations.request_digest AND k.state='accepted'
      AND k.accepted_at<=? AND k.key_expires_at>?) RETURNING *`,
      [
        input.challengeId,
        input.now,
        input.operationId,
        input.tenantId,
        input.actorId,
        input.revision,
        input.now,
        input.challengeId,
        input.now,
        input.now,
      ]
    );
  }

  /** Atomically bind all accepted input keys and queue import preparation. */
  async startImport(input: {
    tenantId: string;
    operationId: string;
    actorId: string;
    challenges: { inputId: string; challengeId: string }[];
    revision: number;
    now: number;
  }): Promise<TenantBackupOperation | null> {
    for (const id of [input.tenantId, input.operationId, input.actorId]) identifier(id);
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      !Array.isArray(input.challenges) ||
      input.challenges.length < 1 ||
      input.challenges.length > 32
    )
      invalid();
    const challenges = input.challenges.map((item) => ({
      inputId: identifier(item.inputId),
      challengeId: identifier(item.challengeId),
    }));
    if (
      new Set(challenges.map((item) => item.inputId)).size !== challenges.length ||
      new Set(challenges.map((item) => item.challengeId)).size !== challenges.length
    )
      invalid();
    const json = JSON.stringify(challenges);
    return this.db.queryOne<TenantBackupOperation>(
      `UPDATE tenant_backup_operations
       SET state='queued',phase='prepare',active_input_key_challenges_json=?,revision=revision+1,
         fencing_token=fencing_token+1,updated_at=?
       WHERE id=? AND tenant_id=? AND created_by=? AND revision=? AND kind='import'
         AND state='waiting' AND phase='unlock' AND request_json IS NOT NULL AND updated_at<=?
         AND (SELECT count(*) FROM tenant_backup_operation_inputs i
           WHERE i.operation_id=tenant_backup_operations.id AND i.tenant_id=tenant_backup_operations.tenant_id)=?
         AND NOT EXISTS (
           SELECT 1 FROM tenant_backup_operation_inputs i
           LEFT JOIN json_each(?) j ON CAST(j.key AS INTEGER)=i.ordinal
           LEFT JOIN tenant_backup_key_handoffs k ON k.id=json_extract(j.value,'$.challengeId')
             AND k.operation_id=i.operation_id AND k.tenant_id=i.tenant_id
             AND k.input_upload_id=i.upload_id AND k.request_digest=tenant_backup_operations.request_digest
             AND k.state='accepted' AND k.created_at<=? AND k.key_expires_at>?
           WHERE i.operation_id=tenant_backup_operations.id AND i.tenant_id=tenant_backup_operations.tenant_id
             AND (json_extract(j.value,'$.inputId') IS NOT i.upload_id OR k.id IS NULL)
         ) RETURNING *`,
      [
        json,
        input.now,
        input.operationId,
        input.tenantId,
        input.actorId,
        input.revision,
        input.now,
        challenges.length,
        json,
        input.now,
        input.now,
      ]
    );
  }

  /** Read the authenticated request only for the exact live slice, including phase and cursor. */
  async loadForExecution(
    context: TenantBackupStepContext,
    now: () => number
  ): Promise<TenantBackupRequestIntent> {
    const { operation, lease, signal } = context;
    if (
      operation.id !== lease.operationId ||
      operation.tenant_id !== lease.tenantId ||
      operation.state !== 'running'
    )
      throw new Error('backup_request_execution_fenced');
    const assertCurrent = async () => {
      signal.throwIfAborted();
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) invalid();
      const current = await this.db.queryOne(
        `SELECT id FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND state='running'
         AND lease_owner=? AND fencing_token=? AND revision=? AND phase=? AND cursor_json IS ?
         AND lease_expires_at>? AND updated_at<=?`,
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
      );
      signal.throwIfAborted();
      if (!current) throw new Error('backup_request_execution_fenced');
    };
    await assertCurrent();
    const intent = await this.load(lease.tenantId, lease.operationId);
    await assertCurrent();
    return intent;
  }

  async load(tenantId: string, operationId: string): Promise<TenantBackupRequestIntent> {
    const row = await this.db.queryOne<RequestOperation>(
      'SELECT * FROM tenant_backup_operations WHERE tenant_id=? AND id=?',
      [identifier(tenantId), identifier(operationId)]
    );
    if (!row?.request_json || row.request_json.length > 32768) invalid();
    let intent: TenantBackupRequestIntent;
    try {
      intent = parseTenantBackupRequestIntent(JSON.parse(row.request_json));
    } catch {
      return invalid();
    }
    if (
      intent.source.tenantId !== tenantId ||
      intent.kind !== row.kind ||
      JSON.stringify(intent) !== row.request_json ||
      (await digest(row.request_json)) !== row.request_digest
    )
      invalid();
    return intent;
  }
}
