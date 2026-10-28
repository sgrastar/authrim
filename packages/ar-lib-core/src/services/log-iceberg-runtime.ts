import type { SamlDrWriterEnv } from './tenant-portability/saml-dr-writer';
import {
  logIcebergRestoreVisibleSql,
  assertLogIcebergRestoreHoldScope,
  logIcebergRestoreWriteGuard,
  loadLogIcebergRestoreHold,
  isLogIcebergRestoreHoldVisible,
  isLogIcebergRestoreDenied,
} from './log-iceberg-restore-hold';
import { prepareLogIcebergRetentionScope } from './log-iceberg-retention-scope';
import { LOG_ICEBERG_DB_NOW } from './log-iceberg-lease';
import type { Queue } from '@cloudflare/workers-types';
import {
  assertLogArchiveRecord,
  type LogArchiveRecord,
} from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseSource, DatabaseAdapter } from '../db';
import { ensureDatabaseAdapter } from '../db';
import type { PreparedStatement } from '../db/adapter';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  assertLogIcebergActivated,
  resolveLogIcebergConfig,
  type LogIcebergConfig,
  type LogIcebergSettingsEnv,
} from './log-iceberg-config';
import {
  buildLogIcebergRecord,
  decryptLogIcebergRecord,
  type LogIcebergRecordInput,
} from './log-iceberg-record';
import {
  logIcebergDigest,
  logIcebergRecordId,
  SqlLogIcebergRecordStore,
  logIcebergGuard,
  type LogIcebergSqlGuard,
} from './log-iceberg-store';
import type { ControlServiceBinding } from './control-plane/control-plane-contracts';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';
import {
  readLogIcebergPolicyArtifact,
  type LogIcebergPolicyArtifactRequest,
} from './log-iceberg-policy-artifacts';
import {
  filterUnErasedLogIcebergRecords,
  isErasedLogIcebergSubject,
  assertLogIcebergPiiSubject,
  LOG_ICEBERG_PII_SUBJECT_ID,
} from './log-iceberg-erasure-filter';
import { createLogIcebergKeyResolver, type LogIcebergKeyEnv } from './log-iceberg-keys';
import {
  createSignInAttemptLogPort,
  type SignInAttemptLogCommit,
  type SignInAttemptLogReservation,
} from './log-iceberg-sign-in-attempt';
import { isLogIcebergRetryErasureMarker } from './log-iceberg-retry-marker';
import {
  createCoreLogPublicationPort,
  type CoreLogPublicationRpc,
  type CoreLogPublicationSource,
} from './log-iceberg-core-publication';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export interface LogIcebergQueueReference {
  payload_type: 'iceberg_ingest';
  schema_version: 1;
  id: string;
  storage_generation: string;
  source_dataset: string;
  subject_id: string | null;
  payload_hmac: string;
  payload_key: string;
  payload_digest: string;
  payload_bytes: number;
  expires_at: number | null;
}

export interface LogIcebergWriteRequest {
  tenantId: string;
  storageGeneration: string;
  records: LogArchiveRecord[];
}
export interface LogArchiveWriteServiceBinding extends CoreLogPublicationRpc {
  reserveSignInAttempt(input: SignInAttemptLogReservation): Promise<{ failedAt: number }>;
  commitSignInAttempt(input: SignInAttemptLogCommit): Promise<void>;
  readPolicyArtifact(input: LogIcebergPolicyArtifactRequest): Promise<string | null>;
  resolveTenantKey(tenantId: string): Promise<string>;
  registerPiiPurgeScope(tenantId: string): Promise<void>;
  writeRecords(request: LogIcebergWriteRequest): Promise<{ stored: number; queued: number }>;
  /** Persists a metadata-only preparing intent before the immutable encrypted retry
   * object; the caller atomically promotes its pointer with the Admin business mutation. */
  preparePipelineReferences(request: LogIcebergWriteRequest): Promise<LogIcebergQueueReference[]>;
  dispatchPipelineReferences(input: {
    tenantId: string;
    references: LogIcebergQueueReference[];
  }): Promise<void>;
}

export interface LogIcebergRuntimeEnv
  extends LogIcebergSettingsEnv, LogIcebergKeyEnv, SamlDrWriterEnv {
  AUTHRIM_ENVIRONMENT_NAME?: string;
  AUTHRIM_WORKER_SCRIPT_NAME?: string;
  AUTHRIM_CONFIG?: KVNamespace;
  CONTROL?: Pick<
    ControlServiceBinding,
    | 'acquireTenantBackupMutationPermit'
    | 'completeTenantBackupMutationPermit'
    | 'acquireEnvironmentBackupMutationPermit'
    | 'completeEnvironmentBackupMutationPermit'
  >;
  DB?: DatabaseSource | null;
  DB_ADMIN?: DatabaseSource | null;
  LOG_ARCHIVE?: R2Bucket;
  LOG_ARCHIVE_STREAM?: import('cloudflare:pipelines').Pipeline;
  LOG_ARCHIVE_WRITER?: LogArchiveWriteServiceBinding;
  LOGGING_DELIVERY_QUEUE?: Queue<unknown>;
  LOGGING_TENANT_KEY_SALT?: string;
}

/** The reserved platform scope belongs only to Management's existing environment authority. */
export function logIcebergMutationScope(
  env: LogIcebergRuntimeEnv,
  tenantId: string
): { tenantId: string } | { environment: true } {
  if (tenantId !== 'platform') return { tenantId };
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    env.AUTHRIM_WORKER_SCRIPT_NAME !== `${env.AUTHRIM_ENVIRONMENT_NAME}-ar-management`
  )
    throw new Error('log_iceberg_platform_writer_denied');
  return { environment: true };
}
export function logIcebergWriterForTenant(
  env: LogIcebergRuntimeEnv,
  config: LogIcebergConfig,
  tenantId: string
): LogArchiveWriteServiceBinding {
  if (tenantId === 'platform') {
    logIcebergMutationScope(env, tenantId);
    return createLogIcebergWritePort(env, config);
  }
  return env.LOG_ARCHIVE_WRITER ?? createLogIcebergWritePort(env, config);
}

interface OutboxRow {
  id: string;
  publication_id: string | null;
  tenant_id: string;
  storage_generation: string;
  source_dataset: string;
  subject_id: string | null;
  payload_hmac: string;
  payload_key: string;
  payload_digest: string | null;
  payload_bytes: number | null;
  expires_at: number | null;
  state: 'preparing' | 'pending' | 'queued' | 'ingested' | 'erased';
  payload_erased_at: number | null;
}

export function captureLogIcebergRequest(request: LogIcebergWriteRequest): LogIcebergWriteRequest {
  if (
    !request ||
    typeof request.tenantId !== 'string' ||
    !request.tenantId ||
    request.tenantId.length > 256 ||
    typeof request.storageGeneration !== 'string' ||
    !Array.isArray(request.records) ||
    request.records.length < 1 ||
    request.records.length > 1000
  )
    throw new Error('log_iceberg_request_invalid');
  return {
    ...request,
    records: request.records.map((record) => {
      assertLogArchiveRecord(record);
      return { ...record };
    }),
  };
}

function reference(row: OutboxRow): LogIcebergQueueReference {
  if (row.payload_digest === null || row.payload_bytes === null)
    throw new Error('log_iceberg_outbox_payload_unconfirmed');
  return {
    payload_type: 'iceberg_ingest',
    schema_version: 1,
    id: row.id,
    storage_generation: row.storage_generation,
    source_dataset: row.source_dataset,
    subject_id: row.subject_id,
    payload_hmac: row.payload_hmac,
    payload_key: row.payload_key,
    payload_digest: row.payload_digest,
    payload_bytes: row.payload_bytes,
    expires_at: row.expires_at,
  };
}

function assertReference(
  value: unknown,
  config: LogIcebergConfig
): asserts value is LogIcebergQueueReference {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('log_iceberg_queue_payload_invalid');
  const row = value as Partial<LogIcebergQueueReference>;
  if (
    Object.keys(row).length !== 11 ||
    row.payload_type !== 'iceberg_ingest' ||
    row.schema_version !== 1 ||
    row.storage_generation !== config.generation ||
    typeof row.source_dataset !== 'string' ||
    !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(row.source_dataset) ||
    (row.source_dataset === 'pii.pii_log'
      ? typeof row.subject_id !== 'string' || !LOG_ICEBERG_PII_SUBJECT_ID.test(row.subject_id)
      : row.subject_id !== null) ||
    ![row.id, row.payload_hmac, row.payload_digest].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
    ) ||
    row.payload_key !== `_authrim_retry/iceberg/v1/${config.generation}/${row.id}.json` ||
    !Number.isSafeInteger(row.payload_bytes) ||
    Number(row.payload_bytes) < 1 ||
    Number(row.payload_bytes) > MAX_PAYLOAD_BYTES ||
    (row.expires_at !== null &&
      (!Number.isSafeInteger(row.expires_at) || Number(row.expires_at) < 0))
  )
    throw new Error('log_iceberg_queue_payload_invalid');
}

/** No log body is stored here. Promotion joins the surrounding business batch. */
export function logIcebergOutboxStatement(
  tenantId: string,
  ref: LogIcebergQueueReference,
  now: number,
  guard?: LogIcebergSqlGuard,
  publicationId?: string
): PreparedStatement {
  const capturedRestoreGuard = logIcebergRestoreWriteGuard({
    id: ref.id,
    tenantId,
    hmac: ref.payload_hmac,
    generation: ref.storage_generation,
    expiresAt: ref.expires_at,
  });
  const outer = logIcebergGuard(
    guard
      ? {
          where: `(${guard.where}) AND (${capturedRestoreGuard.where})`,
          params: [...guard.params, ...capturedRestoreGuard.params],
        }
      : capturedRestoreGuard
  );
  const condition = {
    sql: `${outer.sql} AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.record_id=?)) OR EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.id=? AND p.record_id=? AND p.state='published'))`,
    params: [...outer.params, publicationId ?? null, ref.id, publicationId ?? null, ref.id],
  };
  return {
    sql: `INSERT INTO log_iceberg_outbox
      (id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at,publication_id)
      SELECT ?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM log_iceberg_outbox WHERE id=?) THEN ? ELSE NULL END,
        ?,?,?,?,'pending',?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM log_iceberg_subject_erasures WHERE tenant_id=? AND source_dataset=? AND subject_id=?)${condition.sql}
      ON CONFLICT(id) DO UPDATE SET
        payload_hmac=CASE WHEN log_iceberg_outbox.tenant_id=excluded.tenant_id
          AND log_iceberg_outbox.storage_generation=excluded.storage_generation
          AND log_iceberg_outbox.source_dataset=excluded.source_dataset AND log_iceberg_outbox.subject_id IS excluded.subject_id
          AND log_iceberg_outbox.payload_hmac=excluded.payload_hmac AND log_iceberg_outbox.payload_key=excluded.payload_key
          AND log_iceberg_outbox.payload_digest=excluded.payload_digest AND log_iceberg_outbox.payload_bytes=excluded.payload_bytes
          AND log_iceberg_outbox.expires_at IS excluded.expires_at
          AND log_iceberg_outbox.publication_id IS excluded.publication_id THEN log_iceberg_outbox.payload_hmac ELSE NULL END,
        state=CASE WHEN log_iceberg_outbox.state='preparing' THEN 'pending' ELSE log_iceberg_outbox.state END,
        updated_at=excluded.updated_at WHERE log_iceberg_outbox.state!='erased'`,
    params: [
      ref.id,
      tenantId,
      ref.storage_generation,
      ref.source_dataset,
      ref.subject_id,
      ref.id,
      ref.payload_hmac,
      ref.payload_key,
      ref.payload_digest,
      ref.payload_bytes,
      ref.expires_at,
      now,
      now,
      publicationId ?? null,
      tenantId,
      ref.source_dataset,
      ref.subject_id,
      ...condition.params,
    ],
  };
}

function outboxIntentStatement(
  tenantId: string,
  ref: Omit<LogIcebergQueueReference, 'payload_digest' | 'payload_bytes'>,
  now: number,
  publicationId?: string
): PreparedStatement {
  const restoreGuard = logIcebergRestoreWriteGuard({
    id: ref.id,
    tenantId,
    hmac: ref.payload_hmac,
    generation: ref.storage_generation,
    expiresAt: ref.expires_at,
  });
  return {
    sql: `INSERT INTO log_iceberg_outbox
      (id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at,publication_id)
      SELECT ?,?,?,?,?,?,?,NULL,NULL,?,'preparing',?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM log_iceberg_subject_erasures WHERE tenant_id=? AND source_dataset=? AND subject_id=?)
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.record_id=?)) OR EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.id=? AND p.record_id=? AND p.tenant_id=? AND p.payload_hmac=? AND p.state='prepared')) AND (${restoreGuard.where})
      ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE WHEN
        log_iceberg_outbox.tenant_id=excluded.tenant_id AND log_iceberg_outbox.storage_generation=excluded.storage_generation
        AND log_iceberg_outbox.source_dataset=excluded.source_dataset AND log_iceberg_outbox.subject_id IS excluded.subject_id
        AND log_iceberg_outbox.payload_hmac=excluded.payload_hmac AND log_iceberg_outbox.payload_key=excluded.payload_key
        AND log_iceberg_outbox.expires_at IS excluded.expires_at AND log_iceberg_outbox.publication_id IS excluded.publication_id THEN log_iceberg_outbox.payload_hmac ELSE NULL END`,
    params: [
      ref.id,
      tenantId,
      ref.storage_generation,
      ref.source_dataset,
      ref.subject_id,
      ref.payload_hmac,
      ref.payload_key,
      ref.expires_at,
      now,
      now,
      publicationId ?? null,
      tenantId,
      ref.source_dataset,
      ref.subject_id,
      publicationId ?? null,
      ref.id,
      publicationId ?? null,
      ref.id,
      tenantId,
      ref.payload_hmac,
      ...restoreGuard.params,
    ],
  };
}

function assertOutboxIdentity(
  saved: OutboxRow,
  tenantId: string,
  ref: Omit<LogIcebergQueueReference, 'payload_digest' | 'payload_bytes'>
): void {
  if (
    saved.tenant_id !== tenantId ||
    saved.id !== ref.id ||
    saved.storage_generation !== ref.storage_generation ||
    saved.source_dataset !== ref.source_dataset ||
    saved.subject_id !== ref.subject_id ||
    saved.payload_hmac !== ref.payload_hmac ||
    saved.payload_key !== ref.payload_key ||
    saved.expires_at !== ref.expires_at
  )
    throw new Error('log_iceberg_outbox_identity_conflict');
}

export async function readLogIcebergRetryPayload(
  env: LogIcebergRuntimeEnv,
  ref: LogIcebergQueueReference
): Promise<LogArchiveRecord> {
  if (!env.LOG_ARCHIVE) throw new Error('log_iceberg_retry_bucket_unavailable');
  const object = await env.LOG_ARCHIVE.get(ref.payload_key);
  if (!object) throw new Error('log_iceberg_retry_payload_missing');
  if (isLogIcebergRetryErasureMarker(object, ref.id)) {
    await object.body.cancel();
    throw new Error('log_iceberg_retry_payload_erased');
  }
  if (
    object.size !== ref.payload_bytes ||
    object.size > MAX_PAYLOAD_BYTES ||
    object.customMetadata?.authrim_payload_sha256 !== ref.payload_digest ||
    object.customMetadata?.authrim_record_id !== ref.id ||
    object.customMetadata?.authrim_storage_generation !== ref.storage_generation ||
    object.customMetadata?.authrim_payload_hmac !== ref.payload_hmac
  ) {
    await object.body.cancel();
    throw new Error('log_iceberg_retry_payload_identity_mismatch');
  }
  const reader = object.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk: unknown = await reader.read();
      if (!chunk || typeof chunk !== 'object' || !('done' in chunk))
        throw new Error('log_iceberg_retry_stream_invalid');
      if (chunk.done === true) break;
      if (chunk.done !== false) throw new Error('log_iceberg_retry_stream_invalid');
      const value = 'value' in chunk ? chunk.value : undefined;
      if (!(value instanceof Uint8Array)) throw new Error('log_iceberg_retry_stream_invalid');
      bytes += value.byteLength;
      if (bytes > ref.payload_bytes) {
        await reader.cancel();
        throw new Error('log_iceberg_retry_payload_too_large');
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  const text = parts.join('');
  if (bytes !== ref.payload_bytes || (await logIcebergDigest(text)) !== ref.payload_digest)
    throw new Error('log_iceberg_retry_payload_digest_mismatch');
  const record: unknown = JSON.parse(text);
  assertLogArchiveRecord(record);
  if (
    record.storage_generation !== ref.storage_generation ||
    record.source_dataset !== ref.source_dataset ||
    (record.source_dataset === 'pii.pii_log' && record.subject_id !== ref.subject_id) ||
    record.payload_hmac !== ref.payload_hmac ||
    record.expires_at !== ref.expires_at ||
    (await logIcebergRecordId(record)) !== ref.id
  )
    throw new Error('log_iceberg_retry_payload_scope_mismatch');
  return record;
}

/** Only the named internal core RPC and Management consumer instantiate this port.
 * The public runtime wrapper/entrypoint enforces the compile-time activation gate. */
type WritePortDependencies = {
  resolveCorePublicationSource?: (source: CoreLogPublicationSource) => Promise<DatabaseAdapter>;
};
type PublicationDependencies = Pick<
  import('./log-iceberg-core-publication').CoreLogPublicationPorts,
  'tenantKey' | 'preparePipeline' | 'dispatchPipeline'
>;
export function createLogIcebergWritePort(
  env: LogIcebergRuntimeEnv,
  config: LogIcebergConfig,
  now = Date.now,
  supplied: WritePortDependencies = {}
): LogArchiveWriteServiceBinding {
  return createWritePortImplementation(env, config, now, supplied).writer;
}
function createWritePortImplementation(
  env: LogIcebergRuntimeEnv,
  config: LogIcebergConfig,
  now: () => number,
  supplied: WritePortDependencies
): { writer: LogArchiveWriteServiceBinding; publication: PublicationDependencies } {
  const admin = () =>
    ensureDatabaseAdapter(
      env.DB_ADMIN ?? missing('log_iceberg_admin_database_unavailable'),
      'log-iceberg-writer'
    );
  const resolveTenantKey = async (tenantId: string) => {
    if (!tenantId || tenantId.length > 256) throw new Error('log_iceberg_tenant_invalid');
    if (tenantId === 'platform')
      return deriveTenantKeyFromTenantId(tenantId, env.LOGGING_TENANT_KEY_SALT);
    const db = ensureDatabaseAdapter(
      env.DB ?? missing('log_iceberg_tenant_database_unavailable'),
      'log-iceberg-tenant'
    );
    const tenant = await db.queryOne<{ tenant_key: string | null }>(
      'SELECT tenant_key FROM tenants WHERE id=?',
      [tenantId],
      { consistencyClass: 'primary_required' }
    );
    if (!tenant) throw new Error('log_iceberg_tenant_not_found');
    return (
      tenant.tenant_key ??
      (await deriveTenantKeyFromTenantId(tenantId, env.LOGGING_TENANT_KEY_SALT))
    );
  };
  const validate = async (request: LogIcebergWriteRequest) => {
    logIcebergMutationScope(env, request.tenantId);
    const resolveKeys = createLogIcebergKeyResolver(env);
    if (
      request.storageGeneration !== config.generation ||
      !Array.isArray(request.records) ||
      request.records.length < 1 ||
      request.records.length > 1000
    )
      throw new Error('log_iceberg_request_invalid');
    const tenantKey = await resolveTenantKey(request.tenantId);
    let bytes = 0;
    for (const record of request.records) {
      assertLogArchiveRecord(record);
      assertLogIcebergPiiSubject(record.source_dataset, record.subject_id);
      bytes += encoder.encode(JSON.stringify(record)).byteLength;
      if (
        bytes > MAX_PAYLOAD_BYTES ||
        record.tenant_key !== tenantKey ||
        record.storage_generation !== config.generation ||
        record.ingested_at < config.activatedAt
      )
        throw new Error('log_iceberg_request_scope_or_budget_invalid');
      // Reject an accidentally unencrypted/altered body before any destination
      // receives it. All plaintext stays in this Worker for this validation.
      await decryptLogIcebergRecord(
        record,
        {
          tenantKey,
          sourceDataset: record.source_dataset,
          eventId: record.event_id,
        },
        async (version) => resolveKeys(version)
      );
    }
  };
  const preparePipelineReferences = async (
    request: LogIcebergWriteRequest,
    publicationId?: string
  ) => {
    request = captureLogIcebergRequest(request);
    if (config.mode !== 'pipeline') throw new Error('log_iceberg_pipeline_mode_required');
    await validate(request);
    request.records = await filterUnErasedLogIcebergRecords(
      admin(),
      request.tenantId,
      request.records
    );
    const bucket = env.LOG_ARCHIVE ?? missing('log_iceberg_retry_bucket_unavailable');
    const refs: LogIcebergQueueReference[] = [];
    for (const record of request.records) {
      const id = await logIcebergRecordId(record);
      const identity = {
        payload_type: 'iceberg_ingest' as const,
        schema_version: 1 as const,
        id,
        storage_generation: config.generation,
        source_dataset: record.source_dataset,
        subject_id: record.source_dataset === 'pii.pii_log' ? record.subject_id : null,
        payload_hmac: record.payload_hmac,
        payload_key: `_authrim_retry/iceberg/v1/${config.generation}/${id}.json`,
        expires_at: record.expires_at,
      };
      const intent = outboxIntentStatement(request.tenantId, identity, now(), publicationId);
      await admin().execute(intent.sql, intent.params);
      const load = () =>
        admin().queryOne<OutboxRow>('SELECT * FROM log_iceberg_outbox WHERE id=?', [id], {
          consistencyClass: 'primary_required',
        });
      const denied = async () =>
        (await isLogIcebergRestoreDenied(admin(), id)) ||
        (await load())?.state === 'erased' ||
        (await isErasedLogIcebergSubject(
          admin(),
          request.tenantId,
          identity.source_dataset,
          identity.subject_id
        ));
      const saved = await load();
      if (!saved) {
        if (await denied()) continue;
        throw new Error('log_iceberg_outbox_intent_missing');
      }
      assertOutboxIdentity(saved, request.tenantId, identity);
      if (saved.state === 'ingested' || saved.state === 'erased') continue;
      // No candidate digest is committed until R2 has selected its first immutable envelope.
      // A retry after an interrupted PUT may have a different nonce or ingest timestamp.
      let createdDigest: string | undefined;
      let createdBytes: number | undefined;
      if (saved.state === 'preparing' && saved.payload_digest === null) {
        const text = JSON.stringify(record);
        const digest = await logIcebergDigest(text);
        const created = await bucket.put(identity.payload_key, text, {
          sha256: Uint8Array.from({ length: 32 }, (_, index) =>
            Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16)
          ).buffer,
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType: 'application/authrim.iceberg-retry+json' },
          customMetadata: {
            authrim_payload_sha256: digest,
            authrim_record_id: id,
            authrim_payload_hmac: record.payload_hmac,
            authrim_storage_generation: config.generation,
            authrim_created_at: String(now()),
          },
        });
        if (created) {
          createdDigest = digest;
          createdBytes = encoder.encode(text).byteLength;
        }
      }
      const head = await bucket.head(identity.payload_key);
      if (isLogIcebergRetryErasureMarker(head, id)) {
        if (await denied()) continue;
        throw new Error('log_iceberg_retry_marker_without_erasure');
      }
      if (
        !head ||
        head.customMetadata?.authrim_record_id !== id ||
        head.customMetadata?.authrim_storage_generation !== config.generation ||
        head.customMetadata?.authrim_payload_hmac !== record.payload_hmac ||
        !/^[a-f0-9]{64}$/.test(head.customMetadata?.authrim_payload_sha256 ?? '') ||
        !Number.isSafeInteger(head.size) ||
        head.size < 1 ||
        head.size > MAX_PAYLOAD_BYTES
      )
        throw new Error('log_iceberg_retry_payload_identity_mismatch');
      const ref: LogIcebergQueueReference = {
        ...identity,
        payload_digest: head.customMetadata.authrim_payload_sha256,
        payload_bytes: head.size,
      };
      let original: LogArchiveRecord;
      try {
        // A successful conditional PUT is our already authenticated candidate. An existing
        // object is always reloaded so retries keep its original nonce and ingest timestamp.
        original =
          createdDigest === ref.payload_digest && createdBytes === ref.payload_bytes
            ? record
            : await readLogIcebergRetryPayload(env, ref);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'log_iceberg_retry_payload_erased' &&
          (await denied())
        )
          continue;
        throw error;
      }
      const resolveKeys = createLogIcebergKeyResolver(env);
      await decryptLogIcebergRecord(
        original,
        {
          tenantKey: record.tenant_key,
          sourceDataset: record.source_dataset,
          eventId: record.event_id,
        },
        async (version) => resolveKeys(version)
      );
      if (original.ingested_at < config.activatedAt)
        throw new Error('log_iceberg_retry_payload_scope_mismatch');
      await admin().execute(
        `UPDATE log_iceberg_outbox SET payload_digest=?,payload_bytes=?,updated_at=?
        WHERE id=? AND tenant_id=? AND state='preparing' AND payload_hmac=? AND (payload_digest IS NULL OR payload_digest=?)`,
        [
          ref.payload_digest,
          ref.payload_bytes,
          now(),
          id,
          request.tenantId,
          record.payload_hmac,
          ref.payload_digest,
        ]
      );
      const confirmed = await load();
      if (!confirmed) throw new Error('log_iceberg_outbox_intent_missing');
      assertOutboxIdentity(confirmed, request.tenantId, identity);
      if (confirmed.state === 'ingested' || confirmed.state === 'erased' || (await denied()))
        continue;
      if (
        confirmed.payload_digest !== ref.payload_digest ||
        confirmed.payload_bytes !== ref.payload_bytes
      )
        throw new Error('log_iceberg_outbox_envelope_conflict');
      refs.push(ref);
    }
    return refs;
  };
  const dispatchPipelineReferences = async (input: {
    tenantId: string;
    references: LogIcebergQueueReference[];
  }) => {
    logIcebergMutationScope(env, input.tenantId);
    if (config.mode !== 'pipeline' || input.references.length > 1000)
      throw new Error('log_iceberg_pipeline_dispatch_invalid');
    if (input.references.length === 0) return;
    const queue = env.LOGGING_DELIVERY_QUEUE ?? missing('log_iceberg_delivery_queue_unavailable');
    for (const ref of input.references) {
      assertReference(ref, config);
      const saved = await admin().queryOne<OutboxRow>(
        'SELECT * FROM log_iceberg_outbox WHERE id=? AND tenant_id=?',
        [ref.id, input.tenantId],
        { consistencyClass: 'primary_required' }
      );
      if (
        !saved &&
        (await isErasedLogIcebergSubject(
          admin(),
          input.tenantId,
          ref.source_dataset,
          ref.subject_id
        ))
      )
        continue;
      if (
        !saved ||
        saved.payload_hmac !== ref.payload_hmac ||
        saved.storage_generation !== config.generation
      )
        throw new Error('log_iceberg_outbox_not_committed');
      if (saved.state === 'ingested' || saved.state === 'erased') continue;
      const restoreHold = await loadLogIcebergRestoreHold(admin(), ref.id);
      assertLogIcebergRestoreHoldScope(restoreHold, {
        id: ref.id,
        tenantId: input.tenantId,
        hmac: ref.payload_hmac,
        generation: ref.storage_generation,
        expiresAt: ref.expires_at,
      });
      if (!isLogIcebergRestoreHoldVisible(restoreHold)) continue;
      if (
        saved.state === 'preparing' ||
        (saved.publication_id &&
          !(await admin().queryOne(
            "SELECT id FROM log_iceberg_publications WHERE id=? AND state='published'",
            [saved.publication_id],
            { consistencyClass: 'primary_required' }
          )))
      )
        throw new Error('log_iceberg_outbox_not_committed');
      const original = reference(saved);
      assertReference(original, config);
      await queue.send(original);
      await admin().execute(
        `UPDATE log_iceberg_outbox SET state='queued',updated_at=? WHERE id=? AND payload_digest=? AND state='pending'`,
        [now(), original.id, original.payload_digest]
      );
    }
  };
  const writer: LogArchiveWriteServiceBinding = {
    ...createCoreLogPublicationPort(env, config, {
      tenantKey: resolveTenantKey,
      preparePipeline: preparePipelineReferences,
      dispatchPipeline: dispatchPipelineReferences,
      rebind: (covered) =>
        createWritePortImplementation(covered, config, now, supplied).publication,
      ...(supplied.resolveCorePublicationSource
        ? { resolveSource: supplied.resolveCorePublicationSource }
        : {}),
    }),
    ...createSignInAttemptLogPort(env, config, {
      resolveTenantKey,
      preparePipelineReferences,
      dispatchPipelineReferences,
    }),
    resolveTenantKey,
    async registerPiiPurgeScope(tenantId: string) {
      logIcebergMutationScope(env, tenantId);
      const tenantKey = await resolveTenantKey(tenantId);
      const statements = await prepareLogIcebergRetentionScope(config, {
        tenantId,
        tenantKey,
        sourceDataset: 'pii.pii_log',
      });
      if (statements.length) await admin().batch(statements);
    },
    readPolicyArtifact: (input) => readLogIcebergPolicyArtifact(env, input),
    preparePipelineReferences,
    dispatchPipelineReferences,
    async writeRecords(request) {
      request = captureLogIcebergRequest(request);
      await validate(request);
      request.records = await filterUnErasedLogIcebergRecords(
        admin(),
        request.tenantId,
        request.records
      );
      if (!request.records.length) return { stored: 0, queued: 0 };
      if (config.mode === 'scheduled') {
        const store = new SqlLogIcebergRecordStore(admin());
        for (const record of request.records)
          await store.put(
            request.tenantId,
            record,
            undefined,
            await prepareLogIcebergRetentionScope(config, {
              tenantId: request.tenantId,
              tenantKey: record.tenant_key,
              sourceDataset: record.source_dataset,
            })
          );
        return { stored: request.records.length, queued: 0 };
      }
      const refs = await preparePipelineReferences(request);
      for (const ref of refs)
        await admin().batch([
          ...(await prepareLogIcebergRetentionScope(config, {
            tenantId: request.tenantId,
            tenantKey: await resolveTenantKey(request.tenantId),
            sourceDataset: ref.source_dataset,
          })),
          logIcebergOutboxStatement(request.tenantId, ref, now()),
        ]);
      await dispatchPipelineReferences({ tenantId: request.tenantId, references: refs });
      return { stored: 0, queued: refs.length };
    },
  };
  return {
    writer,
    publication: {
      tenantKey: resolveTenantKey,
      preparePipeline: preparePipelineReferences,
      dispatchPipeline: dispatchPipelineReferences,
    },
  };
}

function missing(code: string): never {
  throw new Error(code);
}

/** Emits one canonical record through the activated storage mode. */
export async function emitLogIcebergRecord(input: {
  env: LogIcebergRuntimeEnv;
  tenantId: string;
  record: Omit<LogIcebergRecordInput, 'tenantKey' | 'ingestedAt'>;
  ingestedAt?: number;
}): Promise<void> {
  const config = resolveLogIcebergConfig(input.env);
  assertLogIcebergActivated(config);
  const writer = logIcebergWriterForTenant(input.env, config, input.tenantId);
  const tenantKey = await writer.resolveTenantKey(input.tenantId);
  const keys = createLogIcebergKeyResolver(input.env)();
  const record = await buildLogIcebergRecord(
    config,
    {
      ...input.record,
      tenantKey,
      ingestedAt: input.ingestedAt ?? Date.now(),
    },
    keys
  );
  const request = {
    tenantId: input.tenantId,
    storageGeneration: config.generation,
    records: [record],
  };
  if (input.env.LOG_ARCHIVE_WRITER && input.tenantId !== 'platform')
    await writer.writeRecords(request);
  else
    await runTenantBackupCoveredEffect(
      { CONTROL: input.env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
      logIcebergMutationScope(input.env, input.tenantId),
      () => writer.writeRecords(request)
    );
}

/** Other durable delivery protocols are handled by the shared Queue consumer. */
export async function consumeLogIcebergMessage(
  body: unknown,
  env: LogIcebergRuntimeEnv,
  now = Date.now()
): Promise<boolean> {
  if (
    !body ||
    typeof body !== 'object' ||
    !('payload_type' in body) ||
    body.payload_type !== 'iceberg_ingest'
  )
    return false;
  const config = resolveLogIcebergConfig(env);
  if (config.mode !== 'pipeline') throw new Error('log_iceberg_pipeline_consumer_not_configured');
  assertLogIcebergActivated(config);
  assertReference(body, config);
  const admin = ensureDatabaseAdapter(
    env.DB_ADMIN ?? missing('log_iceberg_admin_database_unavailable'),
    'log-iceberg-queue'
  );
  const saved = await admin.queryOne<OutboxRow>(
    'SELECT * FROM log_iceberg_outbox WHERE id=?',
    [body.id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !saved ||
    saved.payload_digest !== body.payload_digest ||
    saved.payload_hmac !== body.payload_hmac ||
    saved.storage_generation !== config.generation
  )
    throw new Error('log_iceberg_queue_outbox_identity_mismatch');
  if (saved.state === 'ingested' || saved.state === 'erased') return true;
  const restoreHold = await loadLogIcebergRestoreHold(admin, body.id);
  assertLogIcebergRestoreHoldScope(restoreHold, {
    id: body.id,
    tenantId: saved.tenant_id,
    hmac: body.payload_hmac,
    generation: body.storage_generation,
    expiresAt: body.expires_at,
  });
  if (!isLogIcebergRestoreHoldVisible(restoreHold)) return true;
  if (
    saved.state === 'preparing' ||
    (saved.publication_id &&
      !(await admin.queryOne(
        "SELECT id FROM log_iceberg_publications WHERE id=? AND state='published'",
        [saved.publication_id],
        { consistencyClass: 'primary_required' }
      )))
  )
    throw new Error('log_iceberg_outbox_not_committed');
  let record: LogArchiveRecord;
  try {
    record = await readLogIcebergRetryPayload(env, body);
  } catch (error) {
    if (error instanceof Error && error.message === 'log_iceberg_retry_payload_erased') {
      const latest = await admin.queryOne<{ state: string }>(
        'SELECT state FROM log_iceberg_outbox WHERE id=?',
        [body.id],
        { consistencyClass: 'primary_required' }
      );
      if (
        latest?.state === 'erased' ||
        (await isErasedLogIcebergSubject(
          admin,
          saved.tenant_id,
          saved.source_dataset,
          saved.subject_id
        ))
      )
        return true;
    }
    throw error;
  }
  if (!(await filterUnErasedLogIcebergRecords(admin, saved.tenant_id, [record])).length) {
    await admin.execute(
      "UPDATE log_iceberg_outbox SET state='erased',updated_at=? WHERE id=? AND payload_digest=?",
      [now, body.id, body.payload_digest]
    );
    return true;
  }
  // Delayed/retried delivery never extends the original log expiry.
  if (record.expires_at === null || record.expires_at > now) {
    const resolveKeys = createLogIcebergKeyResolver(env);
    const tenantKey = await createLogIcebergWritePort(env, config).resolveTenantKey(
      saved.tenant_id
    );
    await decryptLogIcebergRecord(
      record,
      {
        tenantKey,
        sourceDataset: saved.source_dataset,
        eventId: record.event_id,
      },
      async (version) => resolveKeys(version)
    );
    const stream = env.LOG_ARCHIVE_STREAM ?? missing('log_iceberg_stream_unavailable');
    // Persist the possibility of provider acceptance BEFORE crossing the Stream boundary.
    // Erasure commits its deny first, so either it sees this obligation or this CAS sends nothing.
    const obligation = await admin.execute(
      `UPDATE log_iceberg_outbox SET stream_obligation_at=COALESCE(stream_obligation_at,${LOG_ICEBERG_DB_NOW}),
        stream_attempt_count=stream_attempt_count+1,updated_at=${LOG_ICEBERG_DB_NOW}
       WHERE id=? AND payload_digest=? AND state IN('pending','queued') AND ${logIcebergRestoreVisibleSql('log_iceberg_outbox')}
        AND NOT EXISTS(SELECT 1 FROM log_iceberg_subject_erasures e WHERE e.tenant_id=log_iceberg_outbox.tenant_id
          AND e.source_dataset=log_iceberg_outbox.source_dataset AND e.subject_id=log_iceberg_outbox.subject_id)
        AND (publication_id IS NULL OR EXISTS(SELECT 1 FROM log_iceberg_publications p
          WHERE p.id=log_iceberg_outbox.publication_id AND p.record_id=log_iceberg_outbox.id
            AND p.payload_hmac=log_iceberg_outbox.payload_hmac AND p.state='published'))`,
      [body.id, body.payload_digest]
    );
    if (obligation.rowsAffected !== 1) {
      const latest = await admin.queryOne<{ state: string }>(
        'SELECT state FROM log_iceberg_outbox WHERE id=?',
        [body.id],
        { consistencyClass: 'primary_required' }
      );
      if (
        latest?.state === 'ingested' ||
        latest?.state === 'erased' ||
        (await isErasedLogIcebergSubject(
          admin,
          saved.tenant_id,
          saved.source_dataset,
          saved.subject_id
        ))
      )
        return true;
      const held = await loadLogIcebergRestoreHold(admin, body.id);
      if (!isLogIcebergRestoreHoldVisible(held)) return true;
      throw new Error('log_iceberg_stream_obligation_unconfirmed');
    }
    // A thrown/unknown response leaves the obligation intact. A later visible row alone
    // cannot prove that every retried provider acceptance has finished committing.
    await stream.send([{ ...record }]);
    await admin.execute(
      `UPDATE log_iceberg_outbox SET stream_acknowledged_at=COALESCE(stream_acknowledged_at,${LOG_ICEBERG_DB_NOW}) WHERE id=? AND payload_digest=?`,
      [body.id, body.payload_digest]
    );
  }
  await admin.execute(
    `UPDATE log_iceberg_outbox SET state='ingested',updated_at=? WHERE id=? AND payload_digest=? AND state!='erased'`,
    [now, body.id, body.payload_digest]
  );
  return true;
}
