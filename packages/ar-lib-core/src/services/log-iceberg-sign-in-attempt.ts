import { ensureDatabaseAdapter } from '../db';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import type { LogIcebergConfig } from './log-iceberg-config';
import { createLogIcebergKeyResolver } from './log-iceberg-keys';
import {
  decryptLogIcebergRecord,
  logIcebergCanonicalJson,
  logIcebergContentDigest,
} from './log-iceberg-record';
import { decodeLogIcebergRow, type LogIcebergSqlRow } from './log-iceberg-row-codec';
import { SqlLogIcebergRecordStore } from './log-iceberg-store';
import { prepareLogIcebergRetentionScope } from './log-iceberg-retention-scope';
import {
  logIcebergOutboxStatement,
  type LogArchiveWriteServiceBinding,
  type LogIcebergRuntimeEnv,
} from './log-iceberg-runtime';

export interface SignInAttemptLogReservation {
  tenantId: string;
  eventId: string;
  failedAt: number;
  logicalHmac: string;
}
export interface SignInAttemptLogCommit {
  tenantId: string;
  eventId: string;
  record: LogArchiveRecord;
}
const DATASET = 'core.flow_audit_events';
function scope(tenantId: string, eventId: string) {
  if (!tenantId || tenantId.length > 256 || !/^sia:v1:[a-f0-9]{64}$/u.test(eventId))
    throw new Error('log_sign_in_attempt_scope_invalid');
}
function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000)
    throw new Error('log_sign_in_attempt_timestamp_invalid');
}

/** A small reservation fixes identity and first failure time without copying the log body. */
export function signInAttemptLogLogicalHmac(
  env: LogIcebergRuntimeEnv,
  input: {
    tenantId: string;
    eventId: string;
    row: LogIcebergSqlRow;
  }
): Promise<string> {
  scope(input.tenantId, input.eventId);
  const { created_at: _createdAt, ...row } = input.row;
  return logIcebergContentDigest(
    logIcebergCanonicalJson(row),
    createLogIcebergKeyResolver(env)().contentHmacKeyHex,
    {
      domain: 'authrim.sign-in-attempt-receipt.v1',
      tenant_id: input.tenantId,
      event_id: input.eventId,
    }
  );
}

export function createSignInAttemptLogPort(
  env: LogIcebergRuntimeEnv,
  config: LogIcebergConfig,
  writer: Pick<
    LogArchiveWriteServiceBinding,
    'resolveTenantKey' | 'preparePipelineReferences' | 'dispatchPipelineReferences'
  >
) {
  const admin = () => {
    if (!env.DB_ADMIN) throw new Error('log_sign_in_attempt_admin_database_required');
    return ensureDatabaseAdapter(env.DB_ADMIN, 'log-sign-in-attempt');
  };
  return {
    async reserveSignInAttempt(input: SignInAttemptLogReservation): Promise<{ failedAt: number }> {
      input = { ...input };
      scope(input.tenantId, input.eventId);
      timestamp(input.failedAt);
      if (!/^[a-f0-9]{64}$/u.test(input.logicalHmac))
        throw new Error('log_sign_in_attempt_digest_invalid');
      await admin().execute(
        `INSERT INTO log_sign_in_attempt_receipts(tenant_id,event_id,failed_at,logical_hmac,payload_hmac,state)
        VALUES(?,?,?,?,NULL,'reserved') ON CONFLICT(tenant_id,event_id) DO UPDATE SET logical_hmac=CASE
        WHEN log_sign_in_attempt_receipts.logical_hmac=excluded.logical_hmac THEN log_sign_in_attempt_receipts.logical_hmac ELSE NULL END`,
        [input.tenantId, input.eventId, input.failedAt, input.logicalHmac]
      );
      const saved = await admin().queryOne<{ failed_at: number; logical_hmac: string }>(
        'SELECT failed_at,logical_hmac FROM log_sign_in_attempt_receipts WHERE tenant_id=? AND event_id=?',
        [input.tenantId, input.eventId],
        { consistencyClass: 'primary_required' }
      );
      if (!saved || saved.logical_hmac !== input.logicalHmac)
        throw new Error('sign_in_attempt_event_id_collision');
      timestamp(saved.failed_at);
      return { failedAt: saved.failed_at };
    },
    async commitSignInAttempt(input: SignInAttemptLogCommit): Promise<void> {
      input = { ...input, record: { ...input.record } };
      scope(input.tenantId, input.eventId);
      const record = input.record;
      if (
        record.event_id !== input.eventId ||
        record.source_dataset !== DATASET ||
        record.storage_generation !== config.generation ||
        record.expires_at !== null ||
        record.log_type !== 'normal' ||
        record.ingested_at < config.activatedAt
      )
        throw new Error('log_sign_in_attempt_record_invalid');
      const receipt = await admin().queryOne<{
        failed_at: number;
        logical_hmac: string;
        payload_hmac: string | null;
        state: string;
      }>(
        'SELECT failed_at,logical_hmac,payload_hmac,state FROM log_sign_in_attempt_receipts WHERE tenant_id=? AND event_id=?',
        [input.tenantId, input.eventId],
        { consistencyClass: 'primary_required' }
      );
      if (!receipt) throw new Error('log_sign_in_attempt_reservation_required');
      timestamp(receipt.failed_at);
      const keys = createLogIcebergKeyResolver(env);
      const body = await decryptLogIcebergRecord(
        record,
        {
          tenantKey: await writer.resolveTenantKey(input.tenantId),
          sourceDataset: DATASET,
          eventId: input.eventId,
        },
        async (version) => keys(version)
      );
      const row = decodeLogIcebergRow(body, input.tenantId, input.eventId);
      if (
        row.created_at !== receipt.failed_at ||
        record.event_at !== receipt.failed_at * 1000 ||
        row.event_type !== 'flow.sign_in_attempt.failed' ||
        row.user_id !== null ||
        receipt.logical_hmac !== (await signInAttemptLogLogicalHmac(env, { ...input, row })) ||
        (receipt.payload_hmac !== null && receipt.payload_hmac !== record.payload_hmac)
      )
        throw new Error('sign_in_attempt_event_id_collision');
      const refs =
        config.mode === 'pipeline'
          ? await writer.preparePipelineReferences({
              tenantId: input.tenantId,
              storageGeneration: config.generation,
              records: [record],
            })
          : [];
      const committedReceipt = {
        where: `EXISTS(SELECT 1 FROM log_sign_in_attempt_receipts WHERE tenant_id=? AND event_id=? AND state='committed' AND logical_hmac=? AND failed_at=? AND payload_hmac=?)`,
        params: [
          input.tenantId,
          input.eventId,
          receipt.logical_hmac,
          receipt.failed_at,
          record.payload_hmac,
        ],
      };
      const scopes = await prepareLogIcebergRetentionScope(
        config,
        { tenantId: input.tenantId, tenantKey: record.tenant_key, sourceDataset: DATASET },
        committedReceipt
      );
      const statements =
        config.mode === 'scheduled'
          ? (
              await new SqlLogIcebergRecordStore(admin()).preparePut(
                input.tenantId,
                record,
                committedReceipt
              )
            ).statements
          : refs.map((ref) =>
              logIcebergOutboxStatement(input.tenantId, ref, Date.now(), committedReceipt)
            );
      const result = await admin().batch([
        {
          sql: `UPDATE log_sign_in_attempt_receipts SET state='committed',payload_hmac=CASE
          WHEN logical_hmac=? AND failed_at=? AND (payload_hmac IS NULL OR payload_hmac=?) THEN ? ELSE NULL END
          WHERE tenant_id=? AND event_id=?`,
          params: [
            receipt.logical_hmac,
            receipt.failed_at,
            record.payload_hmac,
            record.payload_hmac,
            input.tenantId,
            input.eventId,
          ],
        },
        ...statements,
        ...scopes,
      ]);
      if (result[0]?.rowsAffected !== 1) throw new Error('log_sign_in_attempt_reservation_changed');
      if (refs.length)
        await writer.dispatchPipelineReferences({ tenantId: input.tenantId, references: refs });
    },
  };
}
