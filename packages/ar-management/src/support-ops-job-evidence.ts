import { AdminAuditLogRepository, type DatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { emitRuntimeLogRecords } from '@authrim/ar-lib-core/services/logging-runtime-emitter';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

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
/** D1 audit evidence is idempotent. Archive delivery retries at least once using the same event ID. */
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
  const encoded = JSON.stringify(metadata);
  type Row = {
    tenant_id: string;
    admin_user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string;
    result: string;
    metadata_json: string;
    created_at: number;
  };
  const read = () =>
    db.queryOne<Row>(
      'SELECT tenant_id,admin_user_id,action,resource_type,resource_id,result,metadata_json,created_at FROM admin_audit_log WHERE id=?',
      [id],
      { consistencyClass: 'primary_required' }
    );
  let row = await read();
  if (!row) {
    try {
      await beforeEffect();
      await new AdminAuditLogRepository(db).createAuditLog({
        id,
        tenant_id: input.tenantId,
        admin_user_id: input.actor.adminUserId ?? undefined,
        action: 'support_ops.action.execute',
        resource_type: 'support_ops',
        resource_id: input.actionId,
        result: input.result,
        severity: input.result === 'success' ? 'info' : 'warn',
        metadata,
      });
    } catch (error) {
      // Includes an insert response lost after commit. An absent or different row still fails.
      row = await read();
      if (!row) throw error;
    }
    row ??= await read();
  }
  if (
    !row ||
    row.tenant_id !== input.tenantId ||
    row.admin_user_id !== input.actor.adminUserId ||
    row.action !== 'support_ops.action.execute' ||
    row.resource_type !== 'support_ops' ||
    row.resource_id !== input.actionId ||
    row.result !== input.result ||
    row.metadata_json !== encoded
  )
    throw new Error('support_ops_final_audit_conflict');
  if (!env.AUDIT_ARCHIVE && !env.AUTHRIM_CONFIG) return;
  await beforeEffect();
  const emitted = await emitRuntimeLogRecords({
    env: { ...env, DB_ADMIN: db, LOGGING_INDEX_DB: db },
    tenantId: input.tenantId,
    logType: 'admin_audit',
    surface: 'admin_audit',
    tenantKeyResolver: createLoggingTenantKeyResolverFromSource(env.DB, 'admin-audit-archive'),
    planes: ['archive'],
    records: [
      {
        id,
        eventAt: row.created_at,
        type: 'admin_audit.support_ops.action.execute',
        source: 'authrim/admin',
        severity: input.result === 'success' ? 'info' : 'warn',
        subject: input.actionId,
        payload: {
          action: 'support_ops.action.execute',
          resource_type: 'support_ops',
          resource_id: input.actionId,
          result: input.result,
          actor: {
            type: input.actor.metadata.admin_actor_type ?? null,
            id: input.actor.metadata.admin_actor_id ?? null,
            auth_method: input.actor.metadata.admin_auth_method ?? null,
          },
          detail_object_catalog_id: null,
          detail_storage: 'inline_admin_audit_row',
          inline_metadata_keys: Object.keys(input.actor.metadata).sort(),
        },
        indexedFields: {
          action: 'support_ops.action.execute',
          resourceType: 'support_ops',
          resourceId: input.actionId,
          result: input.result,
          severity: input.result === 'success' ? 'info' : 'warn',
        },
      },
    ],
  });
  if (emitted.targetResults.some((target) => target.error !== undefined))
    throw new Error('support_ops_final_audit_fanout_pending');
}
