/** PII access audit metadata. IDs remain inside the encrypted log body. */
import type { BaseEntity } from '../base';
import { generateId, getCurrentTimestamp } from '../base';
import { requireTenantId } from '../tenant';
import type { LogIcebergRuntimeEnv } from '../../services/log-iceberg-runtime';
import { createLogIcebergWritePort } from '../../services/log-iceberg-runtime';
import { buildLogIcebergRecord } from '../../services/log-iceberg-record';
import { encodeLogIcebergRow } from '../../services/log-iceberg-row-codec';
import { createLogIcebergKeyResolver } from '../../services/log-iceberg-keys';
import {
  resolveLogIcebergConfig,
  assertLogIcebergActivated,
} from '../../services/log-iceberg-config';
import { resolveTenantAuditRetentionFromEnv } from '../../utils/audit-log';
import type { Env } from '../../types/env';
import { runTenantBackupCoveredEffect } from '../../services/tenant-portability/covered-mutation';

export type PIIAuditAction =
  | 'pii_accessed'
  | 'pii_created'
  | 'pii_updated'
  | 'pii_deleted'
  | 'pii_exported'
  | 'pii_viewed'
  | 'pii_searched';
export interface PIIAuditLog extends BaseEntity {
  tenant_id: string;
  user_id: string | null;
  action: PIIAuditAction;
  target_user_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
}
export interface CreatePIIAuditLogInput {
  id?: string;
  tenant_id?: string;
  user_id?: string | null;
  action: PIIAuditAction;
  target_user_id?: string | null;
  details?: Record<string, unknown> | null;
  ip_address?: string | null;
  user_agent?: string | null;
}
/** Source-owned bounded batch. No source PII adapter or old export marker is involved. */
export async function writePiiAccessAuditRows(
  env: LogIcebergRuntimeEnv,
  tenantId: string,
  rows: readonly PIIAuditLog[]
): Promise<void> {
  if (rows.length === 0) return;
  if (rows.length > 50) throw new Error('pii_access_log_batch_limit');
  const captured = rows.map((row) => ({ ...row }));
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  const writer = env.LOG_ARCHIVE_WRITER ?? createLogIcebergWritePort(env, config);
  const tenantKey = await writer.resolveTenantKey(tenantId),
    keys = createLogIcebergKeyResolver(env)();
  const retention = await resolveTenantAuditRetentionFromEnv(env as Env, tenantId);
  if (!Number.isSafeInteger(retention.pii.days) || retention.pii.days < 0)
    throw new Error('pii_access_log_retention_invalid');
  const records = [];
  let bytes = 0;
  for (const row of captured) {
    if (row.tenant_id !== tenantId) throw new Error('pii_access_log_tenant_mismatch');
    const expiresAt = row.created_at + retention.pii.days * 86400000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt < row.created_at)
      throw new Error('pii_access_log_retention_invalid');
    const body = await encodeLogIcebergRow({
      context: {
        tenantKey,
        sourceDataset: 'pii.audit_log_pii',
        eventId: row.id,
        generation: config.generation,
        schemaVersion: config.schemaVersion,
      },
      keys,
      row: {
        id: row.id,
        tenant_id: row.tenant_id,
        user_id: row.user_id,
        action: row.action,
        target_user_id: row.target_user_id,
        details: row.details,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
    const record = await buildLogIcebergRecord(
      config,
      {
        eventId: row.id,
        tenantKey,
        sourceDataset: 'pii.audit_log_pii',
        logType: 'pii',
        eventAt: row.created_at,
        ingestedAt: Date.now(),
        expiresAt,
        overview: { action: row.action },
        body,
      },
      keys
    );
    bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (bytes > 4 * 1024 * 1024) throw new Error('pii_access_log_batch_limit');
    records.push(record);
  }
  const request = { tenantId, storageGeneration: config.generation, records };
  if (env.LOG_ARCHIVE_WRITER) await writer.writeRecords(request);
  else
    await runTenantBackupCoveredEffect(
      { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
      { tenantId },
      () => writer.writeRecords(request)
    );
}

/** The old raw-DB readers/export helpers had no production callers and are removed.
 * Authorized log readers use the common tenant-scoped Iceberg backend. */
export class PIIAuditLogRepository {
  constructor(
    private readonly env: LogIcebergRuntimeEnv,
    private readonly tenantId: string
  ) {
    requireTenantId(tenantId, 'PII audit repository');
  }
  async createAuditLog(input: CreatePIIAuditLogInput): Promise<PIIAuditLog> {
    const tenantId = requireTenantId(input.tenant_id, 'PII audit create');
    if (tenantId !== this.tenantId) throw new Error('pii_access_log_tenant_mismatch');
    const now = getCurrentTimestamp();
    const row: PIIAuditLog = {
      id: input.id ?? generateId(),
      tenant_id: tenantId,
      user_id: input.user_id ?? null,
      action: input.action,
      target_user_id: input.target_user_id ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
      ip_address: input.ip_address ?? null,
      user_agent: input.user_agent ?? null,
      created_at: now,
      updated_at: now,
    };
    await writePiiAccessAuditRows(this.env, tenantId, [row]);
    return row;
  }
  async logAccess(
    userId: string | null,
    targetUserId: string,
    action: PIIAuditAction,
    details?: Record<string, unknown>,
    context?: { ip_address?: string; user_agent?: string; tenant_id?: string }
  ): Promise<PIIAuditLog> {
    return this.createAuditLog({
      tenant_id: context?.tenant_id,
      user_id: userId,
      target_user_id: targetUserId,
      action,
      details,
      ip_address: context?.ip_address,
      user_agent: context?.user_agent,
    });
  }
  getDetails(row: PIIAuditLog): Record<string, unknown> | null {
    if (!row.details) return null;
    try {
      return JSON.parse(row.details) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
