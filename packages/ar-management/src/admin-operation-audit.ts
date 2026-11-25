/**
 * Audit records for admin operations.
 *
 * An admin operation is recorded in the admin audit log, with its actor. When it acts on an end
 * user (a suspension, a revoked consent), that user's history in the core audit log gets an
 * entry too, linked to the user and marked as done by an administrator, without naming the
 * administrator.
 *
 * Delivery follows the action's audit class, as the core audit write does: a fail-closed action
 * (most admin actions, and every action under a tenant profile that fails all actions closed)
 * throws `AuditLogDeliveryError` when it cannot be recorded, so the request does not report
 * success. A fail-open action is logged and the operation goes on.
 */
import type { Context } from 'hono';
import {
  AuditLogDeliveryError,
  createAuditLog,
  getLogger,
  isTenantAuditActionFailClosed,
  mapLegacyAuditResult,
  resolveAuditEventFailureBehavior,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { buildAdminAuditRow, writeAdminAuditRowOrThrow } from './admin-shared';

export type AdminOperationAuditSeverity = 'info' | 'warning' | 'critical';

export interface AdminOperationAuditInput {
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata?: Record<string, unknown>;
  severity?: AdminOperationAuditSeverity;
  /** The outcome; inferred from the action and metadata when omitted. */
  result?: 'success' | 'failure';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /**
   * The end user the operation acted on. Their core audit history gets an entry; it is linked
   * to this user only, never to the administrator.
   */
  endUser?: {
    userId: string;
    /** The action name in the user's history, when it differs from the admin one. */
    action?: string;
    /** Metadata for the user's history; the admin record's metadata when omitted. */
    metadata?: Record<string, unknown>;
  };
}

type AdminContext = Context<{ Bindings: Env }>;

function contextValue(c: AdminContext, key: string): unknown {
  return (c as unknown as { get?(name: string): unknown }).get?.(key);
}

function inferResult(action: string, metadata: Record<string, unknown>): 'success' | 'failure' {
  return mapLegacyAuditResult(action, metadata) === 'success' ? 'success' : 'failure';
}

const ADMIN_SEVERITY = { info: 'info', warning: 'warn', critical: 'critical' } as const;

/** Keys that name who acted. The user's history says an administrator acted, never which. */
const ACTOR_KEYS = new Set([
  'actor',
  'actor_id',
  'actorId',
  'actor_user_id',
  'actorUserId',
  'performed_by',
  'performedBy',
  'requested_by',
  'requestedBy',
  'revoked_by',
  'revokedBy',
  'decided_by',
  'decidedBy',
  'created_by',
  'createdBy',
  'updated_by',
  'updatedBy',
  'deleted_by',
  'deletedBy',
]);

/** The metadata without any key that names who acted, at any depth. */
function withoutActor(metadata: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('admin_') && !ACTOR_KEYS.has(key))
        .map(([key, entry]) => [key, strip(entry)])
    );
  };
  return strip(metadata) as Record<string, unknown>;
}

/**
 * Records an admin operation. Answers the admin audit record's ID, or null when a fail-open
 * action could not be recorded. Throws `AuditLogDeliveryError` for a fail-closed one.
 */
export async function recordAdminOperationAudit(
  c: AdminContext,
  input: AdminOperationAuditInput
): Promise<string | null> {
  const env = c.env;
  const log = getLogger(c).module('ADMIN_AUDIT');
  const actionFailsClosed =
    resolveAuditEventFailureBehavior(input.action).behavior === 'fail_closed_or_strong_retry';

  // The tenant the request was routed to, never a header or the default tenant.
  const routedTenant = contextValue(c, 'tenantId');
  const tenantId = typeof routedTenant === 'string' ? routedTenant.trim() : '';
  if (!tenantId) {
    log.error('Admin operation not recorded: no routed tenant', { action: input.action });
    if (actionFailsClosed) {
      throw new AuditLogDeliveryError('admin_audit_tenant_required', input.action, 'unknown');
    }
    return null;
  }
  // The authenticated administrator, never a stand-in.
  const adminAuth = contextValue(c, 'adminAuth') as AdminAuthContext | undefined;
  if (!adminAuth) {
    log.error('Admin operation not recorded: no authenticated administrator', {
      action: input.action,
    });
    if (actionFailsClosed) {
      throw new AuditLogDeliveryError('admin_audit_actor_required', input.action, tenantId);
    }
    return null;
  }

  const metadata = input.metadata ?? {};
  // One outcome for both records, whatever each one's action is called.
  const result = input.result ?? inferResult(input.action, metadata);
  const failsClosed = await isTenantAuditActionFailClosed(env, tenantId, input.action);
  let recordId: string | null;
  try {
    const row = await buildAdminAuditRow(
      c,
      {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        result,
        severity: ADMIN_SEVERITY[input.severity ?? 'info'],
        metadata,
        before: input.before,
        after: input.after,
      },
      { tenantId }
    );
    recordId = await writeAdminAuditRowOrThrow(env, row);
  } catch (error) {
    log.error('Admin operation not recorded', { action: input.action }, error as Error);
    if (failsClosed) {
      throw new AuditLogDeliveryError('admin_audit_write_failed', input.action, tenantId);
    }
    recordId = null;
  }

  if (input.endUser) {
    const action = input.endUser.action ?? input.action;
    const userMetadata = withoutActor(input.endUser.metadata ?? metadata);
    // The core write classifies and throws for its own action as before.
    await createAuditLog(env, {
      tenantId,
      userId: input.endUser.userId,
      action,
      resource: input.resourceType,
      resourceId: input.resourceId ?? '',
      ipAddress:
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        'unknown',
      userAgent: c.req.header('User-Agent') || 'unknown',
      // The subject is this user. The administrator is not named in the user's history.
      metadata: JSON.stringify({
        ...userMetadata,
        userId: input.endUser.userId,
        actor_type: 'admin',
        result,
      }),
      severity: input.severity ?? 'info',
    });
  }
  return recordId;
}
