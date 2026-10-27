import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { prepareLogIcebergRowWrite } from '@authrim/ar-lib-core/services/log-iceberg-emitter';
import {
  adminAuditReceiptStatement,
  confirmAdminAuditReceipt,
} from '@authrim/ar-lib-core/services/admin-audit-receipts';

export const SUPPORT_OPS_LOGOUT_JOB_TYPE = 'support-ops/action-execute-logout';
export async function supportOpsEvidenceId(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parts))
  );
  return (
    'so_' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
export interface SupportOpsAuditActor {
  adminUserId: string | null;
  metadata: Record<string, unknown>;
}
/** One bounded page, one stable job. A lost response is recovered by primary payload comparison. */
export async function keepSupportOpsLogoutPage(
  db: DatabaseAdapter,
  input: {
    jobId: string;
    tenantId: string;
    actionId: string;
    accountId: string;
    userId: string;
    operationId: string;
    sequence: number;
    sourceVersionMs: number;
    sessionIds: string[];
    executor: string;
  },
  beforeEffect: () => Promise<void>
): Promise<string> {
  if (input.sessionIds.length < 1 || input.sessionIds.length > 10)
    throw new Error('support_ops_logout_page_limit');
  const id = await supportOpsEvidenceId(
    'logout',
    input.tenantId,
    input.actionId,
    input.accountId,
    input.userId,
    input.operationId,
    String(input.sourceVersionMs),
    String(input.sequence)
  );
  const config = JSON.stringify({
    execute_job_id: input.jobId,
    trigger: {
      action: 'support_ops.action.execute',
      operationId: input.actionId,
      actorId: input.executor,
    },
    sessions: input.sessionIds.map((sessionId) => ({ userId: input.userId, sessionId })),
  });
  if (new TextEncoder().encode(config).byteLength > 16 * 1024)
    throw new Error('support_ops_logout_page_bytes');
  const now = Math.floor(input.sourceVersionMs / 1000);
  await beforeEffect();
  await db.execute(
    `INSERT INTO admin_jobs
    (id,tenant_id,job_type,status,progress,config,created_by,created_at,updated_at)
    VALUES (?,?,?,'pending',?,?,?, ?,?) ON CONFLICT(id) DO NOTHING`,
    [
      id,
      input.tenantId,
      SUPPORT_OPS_LOGOUT_JOB_TYPE,
      JSON.stringify({
        stage: 'queued',
        total: input.sessionIds.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
      }),
      config,
      input.executor,
      now,
      now,
    ]
  );
  const stored = await db.queryOne<{ tenant_id: string; job_type: string; config: string }>(
    'SELECT tenant_id,job_type,config FROM admin_jobs WHERE id=?',
    [id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !stored ||
    stored.tenant_id !== input.tenantId ||
    stored.job_type !== SUPPORT_OPS_LOGOUT_JOB_TYPE ||
    stored.config !== config
  )
    throw new Error('support_ops_logout_job_conflict');
  return id;
}
/** Commit minimal business evidence and durable log delivery in one Admin batch. */
export async function keepSupportOpsFinalAudit(
  env: Env,
  db: DatabaseAdapter,
  input: {
    tenantId: string;
    actionId: string;
    jobId: string;
    decidedAtMs: number;
    result: 'success' | 'failure';
    actor: SupportOpsAuditActor;
    summary: Record<string, unknown>;
  },
  beforeEffect: () => Promise<void>
): Promise<void> {
  const id = await supportOpsEvidenceId('final-audit', input.tenantId, input.actionId, input.jobId);
  const metadata = {
    ...input.actor.metadata,
    phase: 'completed',
    job_id: input.jobId,
    decided_at: input.decidedAtMs,
    result: input.summary,
  };
  const prepared = await prepareLogIcebergRowWrite(env, db, {
    tenantId: input.tenantId,
    sourceDataset: 'admin.admin_audit_log',
    logType: 'admin_audit',
    eventAt: input.decidedAtMs,
    expiresAt: null,
    adminInlineMetadata: input.actor.metadata,
    overview: {
      action: 'support_ops.action.execute',
      result: input.result,
      severity: input.result === 'success' ? 'info' : 'warn',
      resource_id: input.actionId,
      subject_id: input.actor.adminUserId,
    },
    row: {
      id,
      tenant_id: input.tenantId,
      admin_user_id: input.actor.adminUserId,
      admin_email: null,
      action: 'support_ops.action.execute',
      resource_type: 'support_ops',
      resource_id: input.actionId,
      result: input.result,
      severity: input.result === 'success' ? 'info' : 'warn',
      error_code: null,
      error_message: null,
      ip_address: null,
      user_agent: null,
      request_id: null,
      session_id: null,
      before_json: null,
      after_json: null,
      metadata_json: JSON.stringify(metadata),
      created_at: input.decidedAtMs,
      detail_object_catalog_id: null,
    },
  });
  await beforeEffect();
  try {
    await db.batch([
      adminAuditReceiptStatement(prepared.record, input.tenantId),
      ...prepared.statements,
    ]);
  } catch {
    // Recover a lost commit reply only when the exact business receipt survived.
    await confirmAdminAuditReceipt(db, prepared.record, input.tenantId);
  }
  await confirmAdminAuditReceipt(db, prepared.record, input.tenantId);
  await beforeEffect();
  await prepared.dispatch();
}
