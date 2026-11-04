/**
 * Another admin's step-up second factors (the administrators' side)
 *
 * An administrator sees the security keys of the tenant's other admins and can revoke one that
 * was lost or may be compromised. Revoking is not held to the minimum an admin keeps for their
 * own removals: an admin left with none registers again through the recovery waiting period.
 * It needs admin users write (route access rules), authority over the account, and L2
 * (`admin_credential.revoke`). The admin is told by email.
 *
 * Endpoints:
 * - GET    /api/admin/admins/:id/second-factors           - The admin's keys
 * - DELETE /api/admin/admins/:id/second-factors/:factorId - Revoke one
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminSecondFactorRepository,
  AdminUserRepository,
  adminAuthMiddleware,
  createErrorResponse,
  getLogger,
  getTenantIdFromContext,
  isNotificationDeliveryAvailable,
  produceNotificationDelivery,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { requireAdminStepUp } from '../../admin-step-up-gate';
import { loadAdminStanding, mayActOnAdminAccount } from './admin-role-authority';
import { presentSecondFactor } from './my-second-factors';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const adminSecondFactorsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Read and write permissions are enforced by the route access rules (admin users).
adminSecondFactorsRouter.use('*', adminAuthMiddleware({}));

function factorsLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-SECOND-FACTORS');
}

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

const notFound = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'No such admin or security key' }, 404);

/** The admin, when they belong to the selected tenant. */
async function tenantAdmin(adapter: DatabaseAdapter, tenantId: string, adminUserId: string) {
  return new AdminUserRepository(adapter).findByTenantAndId(tenantId, adminUserId);
}

/** Tell the admin a key of theirs was revoked by someone else. Best effort. */
async function noticeRevocation(
  env: Env,
  tenantId: string,
  input: { adminUserId: string; email: string; factorLabel: string | null; factorId: string }
): Promise<void> {
  if (!(await isNotificationDeliveryAvailable(env, { owner: 'tenant', tenantId }))) return;
  const key = `admin-second-factor-revoked:${input.factorId}`;
  const name = input.factorLabel ? `"${input.factorLabel}"` : 'One of your security keys';
  const text = [
    `${name} was revoked by another administrator and can no longer confirm sensitive operations.`,
    'If you did not expect this, contact the other administrators of your tenant. If it was your last key, register a new one through the recovery request in the admin console.',
  ];
  await produceNotificationDelivery(env, {
    owner: { owner: 'tenant', tenantId },
    intentId: key,
    outboxId: `notification:${key}`,
    notificationKind: 'admin.second-factor-revoked',
    idempotencyKey: key,
    expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    payload: {
      channel: 'email',
      to: input.email,
      from: env.EMAIL_FROM || 'noreply@authrim.dev',
      subject: 'A security key of your admin account was revoked',
      body: `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${text
        .map((line) => `<p>${line.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p>`)
        .join('')}</body></html>`,
      metadata: { textBody: text.join('\n\n') },
    },
  });
}

/**
 * GET /api/admin/admins/:id/second-factors
 */
adminSecondFactorsRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const adapter = adminAdapter(c);
    const adminUserId = c.req.param('id') ?? '';
    if (!(await tenantAdmin(adapter, getTenantIdFromContext(c), adminUserId))) return notFound(c);
    const factors = await new AdminSecondFactorRepository(adapter).listByUser(adminUserId);
    return c.json({ second_factors: factors.map(presentSecondFactor) });
  } catch (error) {
    factorsLog(c).error('Failed to list an admin’s second factors', {
      action: 'admin_second_factors_list',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admins/:id/second-factors/:factorId
 */
adminSecondFactorsRouter.delete('/:factorId', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const adminUserId = c.req.param('id') ?? '';
  const factorId = c.req.param('factorId');
  if (adminUserId === auth.userId) {
    return c.json(
      {
        error: 'use_own_route',
        error_description:
          'Remove your own keys from My account (DELETE /api/admin/me/second-factors/:id)',
      },
      400
    );
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const target = await tenantAdmin(adapter, tenantId, adminUserId);
    if (!target) return notFound(c);
    const standing = await loadAdminStanding(adapter, tenantId, adminUserId);
    if (!mayActOnAdminAccount(auth, standing, 'admin:admin_users:write')) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    const repository = new AdminSecondFactorRepository(adapter);
    const factor = (await repository.listByUser(adminUserId)).find(
      (item) => item.id === factorId && item.revoked_at === null
    );
    if (!factor) return notFound(c);

    // The receipt is spent here, after every check that can still refuse the request.
    const refused = await requireAdminStepUp(c, {
      operation: 'admin_credential.revoke',
      targetTenantId: tenantId,
      targetIds: [adminUserId, factor.id],
    });
    if (refused) return refused;

    if (!(await repository.revokeByAdmin(adminUserId, factor.id))) return notFound(c);

    try {
      await noticeRevocation(c.env, tenantId, {
        adminUserId,
        email: target.email,
        factorLabel: factor.label,
        factorId: factor.id,
      });
    } catch {
      factorsLog(c).warn('Second-factor revocation notice was not sent', {
        action: 'admin_second_factor_revoke_notice',
      });
    }
    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.revoked_by_admin',
      resourceType: 'admin_second_factor',
      resourceId: factor.id,
      result: 'success',
      severity: 'warn',
      metadata: { admin_user_id: adminUserId },
    });
    return c.json({ revoked: true });
  } catch (error) {
    factorsLog(c).error('Failed to revoke an admin’s second factor', {
      action: 'admin_second_factor_revoke_by_admin',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
