/** Operational reasons remain encrypted behind their additional detail permission. */
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import type { LogIcebergRuntimeEnv } from '../log-iceberg-runtime';

export interface StoreOperationalLogParams {
  tenantId: string;
  subjectType: 'user' | 'client' | 'session';
  subjectId: string;
  actorId: string;
  action: string;
  reasonDetail: string;
  requestId?: string;
  retentionDays?: number;
}

/** The caller authorizes its business action. Reading the nested reason requires its extra ACL. */
export async function storeOperationalLog(
  env: LogIcebergRuntimeEnv,
  params: StoreOperationalLogParams
): Promise<string> {
  if (!params.reasonDetail) return '';
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const retentionSeconds = (params.retentionDays ?? 90) * 86400;
  const expiresAt = now + retentionSeconds;
  if (
    !Number.isSafeInteger(retentionSeconds) ||
    retentionSeconds < 0 ||
    !Number.isSafeInteger(expiresAt * 1000)
  )
    throw new Error('operational_log_retention_invalid');
  await emitLogIcebergRow(env, {
    tenantId: params.tenantId,
    sourceDataset: 'core.operational_logs',
    logType: 'operational',
    eventAt: now * 1000,
    expiresAt: expiresAt * 1000,
    overview: {
      action: params.action,
      subject_id: params.subjectId,
      request_id: params.requestId ?? null,
    },
    row: {
      id,
      tenant_id: params.tenantId,
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      actor_id: params.actorId,
      action: params.action,
      reason_detail_encrypted: null,
      encryption_key_version: 0,
      detail_object_catalog_id: null,
      request_id: params.requestId ?? null,
      created_at: now,
      expires_at: expiresAt,
    },
    protectedDetail: { reason_detail: params.reasonDetail },
  });
  return id;
}
