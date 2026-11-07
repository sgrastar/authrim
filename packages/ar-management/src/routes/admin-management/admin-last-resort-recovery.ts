/**
 * Last-resort second-factor recovery (Cloudflare authority)
 *
 * For an admin who lost every step-up second factor when no other administrator can confirm a
 * recovery request (the only admin in the whole system), or when the environment owner decides
 * to step in. Only a machine principal holding `admin:last_resort_recovery` by its exact name can
 * call it: the setup tool writes such a principal into DB_ADMIN for the length of one command
 * (`authrim admin recover-second-factor`), so what proves the right to do this is write access to
 * the environment's Cloudflare account. No wildcard carries the permission, and handing it to any
 * other machine principal needs L2 (`machine.permission.grant`).
 *
 * In one batch it revokes every active factor of the admin (the rows stay, so a revoked factor
 * can never be registered again), ends all their sessions (and with them every step-up
 * requirement, receipt and Keyring presentation bound to one), cancels an open recovery request,
 * and opens a re-enrolment window (`security.admin_last_resort_reenroll_window_seconds`, default
 * 24 hours) in which the admin may register a first factor with a fresh passkey alone, once. It
 * is written to the audit log, emailed to the admin and every active administrator, and shown as
 * console notices.
 *
 * Endpoints:
 * - POST /api/admin/platform/last-resort-recovery/second-factors
 *   Body: { email: string, tenant_id?: string, reason?: string }
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  AdminNoticeRepository,
  AdminSecondFactorRepository,
  adminAuthMiddleware,
  createErrorResponse,
  getLogger,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  resolvePlatformSettingsWithSources,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { sendLastResortNotices } from './last-resort-recovery-notice';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/** The platform setting for how long the re-enrolment window stays open. */
export const ADMIN_LAST_RESORT_REENROLL_WINDOW_KEY =
  'security.admin_last_resort_reenroll_window_seconds';
export const ADMIN_LAST_RESORT_REENROLL_WINDOW_DEFAULT_SECONDS = 24 * 60 * 60;
const WINDOW_MIN_SECONDS = 15 * 60;
const WINDOW_MAX_SECONDS = 72 * 60 * 60;
const MAX_EMAIL_LENGTH = 320;
const MAX_REASON_LENGTH = 200;
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const adminLastResortRecoveryRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

adminLastResortRecoveryRouter.use(
  '*',
  adminAuthMiddleware({ requirePermissions: [ADMIN_PERMISSIONS.ADMIN_LAST_RESORT_RECOVERY] })
);

function log(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-SF-LAST-RESORT');
}

function refuse(
  c: AdminContext,
  status: 400 | 403 | 404 | 409,
  error: string,
  description: string,
  extra: Record<string, unknown> = {}
): Response {
  return c.json({ error, error_description: description, ...extra }, status);
}

/**
 * The re-enrolment window in seconds: the platform setting (KV, then the environment variable,
 * then the default), kept inside its bounds. A setting that cannot be read gives the default.
 */
export async function lastResortReenrollWindowSeconds(env: Env): Promise<number> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(env, 'security', { fresh: true });
    const value = values[ADMIN_LAST_RESORT_REENROLL_WINDOW_KEY];
    if (typeof value === 'number' && Number.isInteger(value)) {
      return Math.min(WINDOW_MAX_SECONDS, Math.max(WINDOW_MIN_SECONDS, value));
    }
  } catch {
    // The default below is the secure choice.
  }
  return ADMIN_LAST_RESORT_REENROLL_WINDOW_DEFAULT_SECONDS;
}

interface TargetAdmin {
  id: string;
  email: string;
  tenant_id: string;
  is_active: number | null;
  status: string;
}

async function findTargets(
  adapter: DatabaseAdapter,
  email: string,
  tenantId: string | null
): Promise<TargetAdmin[]> {
  return adapter.query<TargetAdmin>(
    `SELECT id, email, tenant_id, is_active, status FROM admin_users
      WHERE lower(email) = ? AND (? IS NULL OR tenant_id = ?)
      ORDER BY tenant_id LIMIT 20`,
    [email, tenantId, tenantId]
  );
}

/** Whether anyone other than this admin is an active administrator anywhere. */
async function hasAnotherAdmin(adapter: DatabaseAdapter, adminUserId: string): Promise<boolean> {
  const row = await adapter.queryOne<{ id: string }>(
    `SELECT id FROM admin_users
      WHERE id <> ? AND is_active = 1 AND status = 'active' LIMIT 1`,
    [adminUserId]
  );
  return row !== null;
}

/**
 * POST /api/admin/platform/last-resort-recovery/second-factors
 */
adminLastResortRecoveryRouter.post('/second-factors', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  // A machine principal with the permission by its exact name, at the global scope (its token
  // reaches every tenant): the admin may be in any tenant, so a token for some tenants only must
  // not reach the others. Neither a wildcard nor a signed-in admin (whose way back is the
  // recovery request) can do this.
  if (
    !auth ||
    auth.authMethod !== 'machine_access_token' ||
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.ADMIN_LAST_RESORT_RECOVERY) ||
    !hasAdminPermission(
      auth.globalPermissions ?? [],
      ADMIN_PERMISSIONS.ADMIN_LAST_RESORT_RECOVERY
    ) ||
    !(auth.tenantScope ?? []).includes('*')
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await c.req.json();
    body =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const tenantId = body?.tenant_id === undefined ? null : body.tenant_id;
  const reason = body?.reason === undefined ? null : body.reason;
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    !email.includes('@') ||
    (tenantId !== null && (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId))) ||
    (reason !== null && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
    const targets = await findTargets(adapter, email, tenantId);
    const [target] = targets;
    if (!target) {
      return refuse(c, 404, 'not_found', 'No administrator has this email');
    }
    if (targets.length > 1) {
      return refuse(
        c,
        409,
        'admin_ambiguous',
        'Administrators in several tenants have this email: name the tenant',
        { tenant_ids: targets.map((target) => target.tenant_id) }
      );
    }
    // A machine principal has no second factors to recover; an ID shared with one is refused
    // rather than guessed at.
    const machine = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM admin_machine_principals WHERE id = ? LIMIT 1',
      [target.id]
    );
    if (machine) {
      return refuse(c, 400, 'target_not_human_admin', 'The target is a machine principal');
    }
    if (Number(target.is_active) !== 1 || target.status !== 'active') {
      return refuse(c, 409, 'admin_not_active', 'The administrator is not active');
    }

    const now = Date.now();
    const windowSeconds = await lastResortReenrollWindowSeconds(c.env);
    const reenrollUntil = now + windowSeconds * 1000;
    const soleAdmin = !(await hasAnotherAdmin(adapter, target.id));
    const actorId = auth.actorId ?? auth.userId;

    const result = await new AdminSecondFactorRepository(adapter).revokeAllForLastResort(
      target.id,
      { reenrollUntil, actorId, now }
    );
    if (result.cancelledRecoveryIds.length > 0) {
      try {
        await new AdminNoticeRepository(adapter).resolveBySourceRefs(result.cancelledRecoveryIds);
      } catch {
        // The requests are cancelled; their notices close on their own expiry.
      }
    }

    const auditId = await writeAdminAuditLog(c, {
      action: 'admin.second_factor.last_resort_recovery',
      resourceType: 'admin_user',
      resourceId: target.id,
      result: 'success',
      severity: 'critical',
      metadata: {
        target_tenant_id: target.tenant_id,
        revoked_second_factor_ids: result.revokedFactorIds,
        ended_sessions: result.endedSessions,
        cancelled_recovery_ids: result.cancelledRecoveryIds,
        reenroll_until: reenrollUntil,
        window_seconds: windowSeconds,
        sole_admin: soleAdmin,
        ...(reason ? { reason } : {}),
      },
    });

    const notices = await sendLastResortNotices(c.env, adapter, {
      eventId: auditId ?? crypto.randomUUID(),
      target: { id: target.id, email: target.email, tenantId: target.tenant_id },
      reenrollUntil,
      revokedFactors: result.revokedFactorIds.length,
      now,
    });
    if (!notices.emailed || !notices.consoleNotice) {
      log(c).warn('Last-resort recovery notices were not all delivered', {
        action: 'admin_second_factor_last_resort_notice',
      });
    }

    return c.json({
      admin: { id: target.id, email: target.email, tenant_id: target.tenant_id },
      revoked_second_factors: result.revokedFactorIds.length,
      ended_sessions: result.endedSessions,
      cancelled_recovery_requests: result.cancelledRecoveryIds.length,
      reenroll_until: reenrollUntil,
      sole_admin: soleAdmin,
      audit_logged: auditId !== null,
      notices: {
        emailed: notices.emailed,
        email_recipients: notices.recipients,
        console: notices.consoleNotice,
      },
    });
  } catch (error) {
    log(c).error('Last-resort second-factor recovery failed', {
      action: 'admin_second_factor_last_resort',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
