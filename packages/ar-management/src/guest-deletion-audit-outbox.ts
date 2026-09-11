import {
  createAuditLog,
  getAdminProxyMetadataFromContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { Context } from 'hono';

const ORPHAN_TASK_GRACE_SECONDS = 300;
const RECONCILIATION_PAGE_SIZE = 20;
const MAX_RECONCILIATION_PAGES_PER_ADAPTER = 50;
const DEFAULT_RECONCILIATION_BUDGET_MS = 5_000;

export interface GuestDeletionAuditOutboxRow {
  audit_id: string;
  tenant_id: string;
  user_id: string;
  operation_id: string;
  actor_user_id: string;
  ip_address: string;
  user_agent: string;
  metadata_json: string;
  status: 'pending' | 'retry' | 'succeeded';
  attempt_count: number | string;
  next_attempt_at: number | string;
  last_error_code: string | null;
  created_at: number | string;
  updated_at: number | string;
  succeeded_at: number | string | null;
}

export interface GuestDeletionAuditTaskInput {
  auditId: string;
  userId: string;
  operationId: string;
  actorUserId: string;
  ipAddress: string;
  userAgent: string;
  metadataJson: string;
  createdAt: number;
}

export function createGuestDeletionAuditTaskFromContext(
  c: Context<{ Bindings: Env }>,
  input: {
    auditId: string;
    userId: string;
    operationId: string;
    metadata: Record<string, unknown>;
  }
): GuestDeletionAuditTaskInput {
  const adminAuth = (c as unknown as { get(name: string): unknown }).get('adminAuth') as
    | { userId?: unknown }
    | undefined;
  if (typeof adminAuth?.userId !== 'string' || !adminAuth.userId) {
    throw new Error('guest_deletion_audit_actor_missing');
  }
  return {
    auditId: input.auditId,
    userId: input.userId,
    operationId: input.operationId,
    actorUserId: adminAuth.userId,
    ipAddress:
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown',
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadataJson: JSON.stringify({
      ...input.metadata,
      ...getAdminProxyMetadataFromContext(c),
    }),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export interface GuestDeletionAuditTarget {
  tenantId: string;
  adapters: Array<{ adapter: DatabaseAdapter; bindingRef: string }>;
}

interface GuestDeletionAuditLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

function asNonNegativeInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(3600, 30 * 2 ** Math.min(attemptCount, 7));
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(value)
    ? value
    : 'guest_deletion_audit_delivery_failed';
}

function sameTask(row: GuestDeletionAuditOutboxRow, input: GuestDeletionAuditTaskInput): boolean {
  return (
    row.audit_id === input.auditId &&
    row.user_id === input.userId &&
    row.operation_id === input.operationId &&
    row.actor_user_id === input.actorUserId &&
    row.ip_address === input.ipAddress &&
    row.user_agent === input.userAgent &&
    row.metadata_json === input.metadataJson &&
    asNonNegativeInteger(row.created_at) === input.createdAt
  );
}

/** Durable task storage is intentionally independent of the account row it outlives. */
export class GuestDeletionAuditOutboxRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly tenantId: string
  ) {}

  async enqueue(input: GuestDeletionAuditTaskInput): Promise<GuestDeletionAuditOutboxRow> {
    await this.db.execute(
      `INSERT INTO guest_deletion_audit_outbox (
         audit_id, tenant_id, user_id, operation_id, actor_user_id, ip_address, user_agent,
         metadata_json, status, attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT (audit_id) DO NOTHING`,
      [
        input.auditId,
        this.tenantId,
        input.userId,
        input.operationId,
        input.actorUserId,
        input.ipAddress,
        input.userAgent,
        input.metadataJson,
        input.createdAt,
        input.createdAt,
        input.createdAt,
      ]
    );
    const stored = await this.get(input.auditId);
    if (!stored || !sameTask(stored, input)) {
      throw new Error('guest_deletion_audit_outbox_conflict');
    }
    return stored;
  }

  get(auditId: string): Promise<GuestDeletionAuditOutboxRow | null> {
    return this.db.queryOne<GuestDeletionAuditOutboxRow>(
      'SELECT * FROM guest_deletion_audit_outbox WHERE tenant_id = ? AND audit_id = ?',
      [this.tenantId, auditId],
      { consistencyClass: 'primary_required' }
    );
  }

  listDue(now: number, limit: number): Promise<GuestDeletionAuditOutboxRow[]> {
    return this.db.query<GuestDeletionAuditOutboxRow>(
      `SELECT * FROM guest_deletion_audit_outbox
       WHERE tenant_id = ? AND status IN ('pending', 'retry') AND next_attempt_at <= ?
       ORDER BY next_attempt_at, created_at, audit_id LIMIT ?`,
      [this.tenantId, now, limit],
      { consistencyClass: 'primary_required' }
    );
  }

  async markSucceeded(auditId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM guest_deletion_audit_outbox WHERE tenant_id = ? AND audit_id = ?',
      [this.tenantId, auditId]
    );
  }

  async markRetry(task: GuestDeletionAuditOutboxRow, now: number, code: string): Promise<void> {
    const attemptCount = asNonNegativeInteger(task.attempt_count) + 1;
    await this.db.execute(
      `UPDATE guest_deletion_audit_outbox
       SET status = 'retry', attempt_count = ?, next_attempt_at = ?, last_error_code = ?,
           updated_at = ?
       WHERE tenant_id = ? AND audit_id = ? AND status <> 'succeeded'`,
      [attemptCount, now + retryDelaySeconds(attemptCount), code, now, this.tenantId, task.audit_id]
    );
  }

  async remove(auditId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM guest_deletion_audit_outbox WHERE tenant_id = ? AND audit_id = ?',
      [this.tenantId, auditId]
    );
  }
}

async function writeGuestDeletionAudit(
  env: Env,
  task: GuestDeletionAuditOutboxRow,
  completedAt: number
): Promise<void> {
  await createAuditLog(env, {
    id: task.audit_id,
    createdAt: completedAt,
    tenantId: task.tenant_id,
    userId: task.actor_user_id,
    action: 'user.deleted',
    resource: 'user',
    resourceId: task.user_id,
    ipAddress: task.ip_address,
    userAgent: task.user_agent,
    metadata: task.metadata_json,
    severity: 'info',
  });
}

export async function processGuestDeletionAuditOutbox(
  env: Env,
  targets: GuestDeletionAuditTarget[],
  log: GuestDeletionAuditLogger,
  options: {
    now?: () => number;
    nowMs?: () => number;
    deadlineMs?: number;
    writeAudit?: (
      task: GuestDeletionAuditOutboxRow,
      adapter: DatabaseAdapter,
      completedAt: number
    ) => Promise<void>;
  } = {}
): Promise<{ processed: number; succeeded: number; retrying: number }> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = options.nowMs ?? Date.now;
  const writeAudit =
    options.writeAudit ??
    ((task, _adapter, completedAt) => writeGuestDeletionAudit(env, task, completedAt));
  let processed = 0;
  let succeeded = 0;
  let retrying = 0;

  for (const target of targets) {
    for (const { adapter, bindingRef } of target.adapters) {
      const repository = new GuestDeletionAuditOutboxRepository(adapter, target.tenantId);
      const deadlineMs = options.deadlineMs ?? nowMs() + DEFAULT_RECONCILIATION_BUDGET_MS;
      pageLoop: for (
        let page = 0;
        page < MAX_RECONCILIATION_PAGES_PER_ADAPTER && nowMs() < deadlineMs;
        page += 1
      ) {
        const tasks = await repository.listDue(now(), RECONCILIATION_PAGE_SIZE);
        if (tasks.length === 0) break;
        for (const task of tasks) {
          if (nowMs() >= deadlineMs) break pageLoop;
          processed += 1;
          const attemptAt = now();
          try {
            const lifecycle = await adapter.queryOne<{
              phase: string;
              deletion_operation_id: string | null;
              deleted_at: number | string | null;
            }>(
              `SELECT phase, deletion_operation_id, deleted_at FROM guest_account_lifecycle
               WHERE tenant_id = ? AND user_id = ?`,
              [target.tenantId, task.user_id],
              { consistencyClass: 'primary_required' }
            );
            if (!lifecycle || lifecycle.deletion_operation_id !== task.operation_id) {
              const taskCreatedAt = asNonNegativeInteger(task.created_at);
              if (taskCreatedAt > 0 && attemptAt - taskCreatedAt < ORPHAN_TASK_GRACE_SECONDS) {
                await repository.markRetry(task, attemptAt, 'guest_deletion_claim_pending');
                retrying += 1;
              } else {
                await repository.remove(task.audit_id);
              }
              continue;
            }
            if (lifecycle.phase !== 'deleted') {
              await repository.markRetry(task, attemptAt, 'guest_deletion_not_committed');
              retrying += 1;
              continue;
            }
            const completedAt = asNonNegativeInteger(lifecycle.deleted_at ?? -1);
            if (completedAt === 0) {
              await repository.markRetry(task, attemptAt, 'guest_deletion_completion_time_missing');
              retrying += 1;
              continue;
            }
            await writeAudit(task, adapter, completedAt * 1000);
            await repository.markSucceeded(task.audit_id);
            succeeded += 1;
          } catch (error) {
            await repository.markRetry(task, attemptAt, errorCode(error));
            retrying += 1;
            log.warn('Guest deletion audit reconciliation deferred', {
              tenantId: target.tenantId,
              bindingRef,
              operationId: task.operation_id,
              errorCode: errorCode(error),
            });
          }
        }
        if (tasks.length < RECONCILIATION_PAGE_SIZE) break;
      }
    }
  }

  if (processed > 0) {
    log.info('Guest deletion audit reconciliation completed', { processed, succeeded, retrying });
  }
  return { processed, succeeded, retrying };
}
