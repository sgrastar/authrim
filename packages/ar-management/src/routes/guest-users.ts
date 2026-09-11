/**
 * Browser Guest Account Admin API
 *
 * Provides admin endpoints for managing browser guest accounts.
 *
 * Guest Account Management APIs:
 * GET    /api/admin/guest-users              - List guest accounts
 * GET    /api/admin/guest-users/:id          - Get a guest account
 * GET    /api/admin/guest-users/:id/upgrades - Get upgrade history
 * DELETE /api/admin/guest-users/:id          - Delete a guest account
 * POST   /api/admin/guest-users/cleanup      - Cleanup expired guest accounts
 *
 * @see architecture-decisions.md §17 for design details
 */

import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  createPIIContextFromHono,
  CanonicalRuntimeUserStore,
  GuestLifecycleRepository,
  getTenantIdFromContext,
  getLogger,
  createAuditLogFromContext,
  transitionAccountAuthenticationState,
  type Env,
} from '@authrim/ar-lib-core';
import { findActiveAccountLegalHold } from '../account-legal-hold-guard';
import { createGuestDeletionRoute } from '../guest-lifecycle-scheduled';
import {
  createGuestDeletionAuditTaskFromContext,
  GuestDeletionAuditOutboxRepository,
  type GuestDeletionAuditOutboxRow,
} from '../guest-deletion-audit-outbox';

function createRuntimeUserStore(c: Context<{ Bindings: Env }>, tenantId: string) {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
}

function parseIntegerQuery(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum?: number
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return null;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function invalidRequest(c: Context<{ Bindings: Env }>, description: string): Response {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

interface GuestDeletionAuditLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

async function deliverGuestDeletionCompletionAudit(
  c: Context<{ Bindings: Env }>,
  input: {
    repository: GuestDeletionAuditOutboxRepository;
    task: GuestDeletionAuditOutboxRow;
    completedAt: number;
    metadata: Record<string, unknown>;
    log: GuestDeletionAuditLogger;
    logActionPrefix: 'guest_user_delete' | 'guest_cleanup_user_delete';
  }
): Promise<void> {
  let deliveryError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await createAuditLogFromContext(
        c,
        'user.deleted',
        'user',
        input.task.user_id,
        input.metadata,
        'info',
        input.task.audit_id,
        input.completedAt * 1000
      );
      try {
        await input.repository.markSucceeded(input.task.audit_id, Math.floor(Date.now() / 1000));
      } catch (outboxError) {
        // The pending task remains durable and the audit ID is idempotent, so the scheduler can
        // safely replay it and finish the acknowledgement later.
        input.log.error(
          'Guest deletion audit succeeded but outbox acknowledgement is pending',
          {
            action: `${input.logActionPrefix}_audit_ack_pending`,
            tenantId: input.task.tenant_id,
            operationId: input.task.operation_id,
          },
          outboxError as Error
        );
      }
      return;
    } catch (error) {
      deliveryError = error;
      if (attempt === 0) {
        input.log.warn('Retrying guest deletion completion audit', {
          action: `${input.logActionPrefix}_audit_retry`,
          tenantId: input.task.tenant_id,
          operationId: input.task.operation_id,
        });
      }
    }
  }

  try {
    await input.repository.markRetry(
      input.task,
      Math.floor(Date.now() / 1000),
      'audit_log_write_failed'
    );
  } catch (outboxError) {
    // The task was persisted before deletion and remains pending if this update fails.
    input.log.error(
      'Guest deletion audit retry scheduling update failed',
      {
        action: `${input.logActionPrefix}_audit_retry_schedule_failed`,
        tenantId: input.task.tenant_id,
        operationId: input.task.operation_id,
      },
      outboxError as Error
    );
  }
  input.log.error(
    'Guest account deletion committed; completion audit is queued for reconciliation',
    {
      action: `${input.logActionPrefix}_audit_pending`,
      tenantId: input.task.tenant_id,
      operationId: input.task.operation_id,
    },
    deliveryError as Error
  );
}

// ============================================================================
// Guest Account Management API
// ============================================================================

/**
 * GET /api/admin/guest-users
 * List guest accounts with pagination
 *
 * Query params:
 * - limit: number (default: 50, max: 100)
 * - offset: number (default: 0)
 * - include_expired: boolean (default: false)
 */
export async function listGuestUsers(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('GuestUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const limit = parseIntegerQuery(c.req.query('limit'), 50, 1, 100);
    const offset = parseIntegerQuery(c.req.query('offset'), 0, 0);
    const includeExpiredValue = c.req.query('include_expired');
    if (
      limit === null ||
      offset === null ||
      (includeExpiredValue !== undefined &&
        includeExpiredValue !== 'true' &&
        includeExpiredValue !== 'false')
    ) {
      return invalidRequest(c, 'Invalid pagination query');
    }
    const includeExpired = includeExpiredValue === 'true';

    const now = Date.now();

    // Build query based on include_expired flag
    const guestAccountJoin = `INNER JOIN identity_accounts uc
      ON uc.tenant_id = ad.tenant_id AND uc.legacy_user_id = ad.user_id`;
    let whereClause = `WHERE ad.tenant_id = ?
      AND uc.account_type = 'user'
      AND uc.registration_state = 'guest'
      AND uc.deleted_at IS NULL`;
    const params: unknown[] = [tenantId];

    if (!includeExpired) {
      whereClause += ' AND ad.is_active = 1 AND (ad.expires_at IS NULL OR ad.expires_at > ?)';
      params.push(now);
    }

    // Get total count
    const countResult = await authCtx.coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT ad.user_id) as count
       FROM guest_devices ad
       ${guestAccountJoin}
       ${whereClause}`,
      params
    );

    // Get one row per guest account with browser-resume credential counts.
    const users = await authCtx.coreAdapter.query<{
      user_id: string;
      credential_count: number;
      active_credential_count: number;
      next_credential_expiry: number | null;
      created_at: number;
      last_used_at: number;
    }>(
      `SELECT
        ad.user_id,
        COUNT(*) as credential_count,
        SUM(CASE WHEN ad.is_active = 1 AND (ad.expires_at IS NULL OR ad.expires_at > ?) THEN 1 ELSE 0 END) as active_credential_count,
        MIN(CASE WHEN ad.is_active = 1 THEN ad.expires_at ELSE NULL END) as next_credential_expiry,
        MIN(ad.created_at) as created_at,
        MAX(ad.last_used_at) as last_used_at
      FROM guest_devices ad
      ${guestAccountJoin}
      ${whereClause}
      GROUP BY ad.user_id
      ORDER BY last_used_at DESC
      LIMIT ? OFFSET ?`,
      [now, ...params, limit, offset]
    );

    return c.json({
      total: countResult?.count || 0,
      limit,
      offset,
      users: users.map((u) => ({
        user_id: u.user_id,
        credential_count: u.credential_count,
        active_credential_count: u.active_credential_count,
        next_credential_expiry: u.next_credential_expiry,
        has_active_resume_credential: u.active_credential_count > 0,
        created_at: u.created_at,
        last_used_at: u.last_used_at,
      })),
    });
  } catch (error) {
    log.error('Error listing users', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list guest accounts',
      },
      500
    );
  }
}

/**
 * GET /api/admin/guest-users/:id
 * Get a specific guest account
 */
export async function getGuestUser(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('GuestUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userId = c.req.param('id')!;

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    const user = await createRuntimeUserStore(c, tenantId).findById(userId, {
      includeInactive: true,
    });

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Guest account not found',
        },
        404
      );
    }

    if (user.registration_state !== 'guest') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User is not a guest account',
        },
        400
      );
    }

    // Get all browser-resume credentials for this user.
    const resumeCredentials = await authCtx.coreAdapter.query<{
      id: string;
      expires_at: number | null;
      created_at: number;
      last_used_at: number;
      is_active: number;
    }>(
      `SELECT id, expires_at, created_at, last_used_at, is_active
       FROM guest_devices
       WHERE tenant_id = ? AND user_id = ?
       ORDER BY last_used_at DESC`,
      [tenantId, userId]
    );

    // Check if user has been upgraded
    const upgrade = await authCtx.coreAdapter.queryOne<{
      id: string;
      upgraded_user_id: string;
      upgrade_method: string;
      upgraded_at: number;
      preserve_sub: number;
    }>(
      `SELECT id, upgraded_user_id, upgrade_method, upgraded_at, preserve_sub
       FROM guest_account_upgrades
       WHERE tenant_id = ? AND guest_user_id = ?
       ORDER BY upgraded_at DESC
       LIMIT 1`,
      [tenantId, userId]
    );

    const now = Date.now();

    return c.json({
      user_id: userId,
      user_type: 'end_user',
      registration_state: 'guest',
      created_at: Date.parse(user.created_at),
      last_login_at: user.last_login_at,
      resume_credentials: resumeCredentials.map((credential) => ({
        id: credential.id,
        expires_at: credential.expires_at,
        is_expired: credential.expires_at !== null && credential.expires_at < now,
        created_at: credential.created_at,
        last_used_at: credential.last_used_at,
        is_active: credential.is_active === 1,
      })),
      upgrade: upgrade
        ? {
            upgraded_user_id: upgrade.upgraded_user_id,
            method: upgrade.upgrade_method,
            upgraded_at: upgrade.upgraded_at,
            preserve_sub: upgrade.preserve_sub === 1,
          }
        : null,
    });
  } catch (error) {
    log.error('Error getting user', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get guest account',
      },
      500
    );
  }
}

/**
 * GET /api/admin/guest-users/:id/upgrades
 * Get upgrade history for a guest account (audit trail)
 */
export async function getGuestUserUpgrades(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('GuestUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userId = c.req.param('id')!;

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    // Get all upgrades related to this user (as guest source or registered target).
    const upgrades = await authCtx.coreAdapter.query<{
      id: string;
      guest_user_id: string;
      upgraded_user_id: string;
      upgrade_method: string;
      provider_id: string | null;
      preserve_sub: number;
      upgraded_at: number;
      data_migrated: number;
    }>(
      `SELECT id, guest_user_id, upgraded_user_id, upgrade_method, provider_id,
              preserve_sub, upgraded_at, data_migrated
       FROM guest_account_upgrades
       WHERE tenant_id = ? AND (guest_user_id = ? OR upgraded_user_id = ?)
       ORDER BY upgraded_at DESC`,
      [tenantId, userId, userId]
    );

    return c.json({
      user_id: userId,
      upgrades: upgrades.map((u) => ({
        id: u.id,
        guest_user_id: u.guest_user_id,
        upgraded_user_id: u.upgraded_user_id,
        method: u.upgrade_method,
        provider_id: u.provider_id,
        preserve_sub: u.preserve_sub === 1,
        upgraded_at: u.upgraded_at,
        data_migrated: u.data_migrated === 1,
      })),
    });
  } catch (error) {
    log.error('Error getting upgrades', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get upgrade history',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/guest-users/:id
 * Delete a guest account and its browser-resume records
 */
export async function deleteGuestUser(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('GuestUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userId = c.req.param('id')!;

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    // Verify the user exists and is still a guest.
    const runtimeUsers = createRuntimeUserStore(c, tenantId);
    const user = await runtimeUsers.findById(userId, { includeInactive: true });

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Guest account not found',
        },
        404
      );
    }

    if (user.registration_state !== 'guest') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User is not a guest account. Use regular user deletion.',
        },
        400
      );
    }

    const legalHold = await findActiveAccountLegalHold(authCtx.coreAdapter, tenantId, userId);
    if (legalHold) {
      return c.json(
        {
          error: 'legal_hold_active',
          error_description: 'Guest account is under legal hold and cannot be deleted',
          hold_id: legalHold.holdId,
        },
        409
      );
    }

    const deletionOperationId = crypto.randomUUID();
    const auditMetadata = {
      operationId: deletionOperationId,
      registration_state: 'guest',
      reason: 'admin_action',
      source: 'guest_admin_api',
    };
    const deletionRouteJson = JSON.stringify(
      await createGuestDeletionRoute(c.env, {
        tenantId,
        userId,
        completionAuditMode: 'outbox',
      })
    );
    const completionAuditId = `account-guest-deleted-${deletionOperationId}`;
    await createAuditLogFromContext(
      c,
      'account.guest.deletion_started',
      'user',
      userId,
      auditMetadata,
      'info',
      `account-guest-delete-started-${deletionOperationId}`
    );
    const auditOutbox = new GuestDeletionAuditOutboxRepository(authCtx.coreAdapter, tenantId);
    const auditTask = await auditOutbox.enqueue(
      createGuestDeletionAuditTaskFromContext(c, {
        auditId: completionAuditId,
        userId,
        operationId: deletionOperationId,
        metadata: auditMetadata,
      })
    );

    const deletingVersionMs = Date.now();
    const lifecycle = new GuestLifecycleRepository(authCtx.coreAdapter, tenantId);
    const deletionClaimed = await lifecycle.beginAdministrativeDeletion(
      userId,
      deletionOperationId,
      Math.floor(deletingVersionMs / 1000),
      deletionRouteJson,
      deletingVersionMs
    );
    if (!deletionClaimed) {
      await auditOutbox.remove(auditTask.audit_id);
      throw new Error('guest_administrative_deletion_conflict');
    }
    await transitionAccountAuthenticationState(c.env, {
      tenantId,
      userId,
      lifecycle: 'deleting',
      sourceVersionMs: deletingVersionMs,
      operationId: deletionOperationId,
      revokeSessions: true,
    });

    // Delete devices first (foreign key constraint)
    await authCtx.coreAdapter.execute(
      'DELETE FROM guest_devices WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    // Delete user (upgrade history preserved for audit)
    await runtimeUsers.deleteUser(userId);
    await transitionAccountAuthenticationState(c.env, {
      tenantId,
      userId,
      lifecycle: 'deleted',
      sourceVersionMs: Math.max(Date.now(), deletingVersionMs + 1),
      operationId: deletionOperationId,
      revokeSessions: true,
    });
    const completedAt = Math.floor(Date.now() / 1000);
    if (!(await lifecycle.completeDeletion(userId, deletionOperationId, completedAt))) {
      throw new Error('guest_administrative_deletion_completion_conflict');
    }

    await deliverGuestDeletionCompletionAudit(c, {
      repository: auditOutbox,
      task: auditTask,
      completedAt,
      metadata: auditMetadata,
      log,
      logActionPrefix: 'guest_user_delete',
    });
    log.info('Guest account deleted by administrator', {
      action: 'guest_user_delete',
      tenantId,
      userId,
    });

    return c.json({
      success: true,
      deleted_user_id: userId,
      note: 'Upgrade history preserved for audit purposes.',
    });
  } catch (error) {
    log.error('Error deleting user', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete guest account',
      },
      500
    );
  }
}

/**
 * POST /api/admin/guest-users/cleanup
 * Cleanup expired guest accounts
 *
 * Request body:
 * {
 *   "dry_run": boolean (default: true),
 *   "limit": number (default: 100, max: 1000)
 * }
 */
export async function cleanupExpiredGuestUsers(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('GuestUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const body = await c.req
      .json<{
        dry_run?: boolean;
        limit?: number;
      }>()
      .catch(() => ({ dry_run: true, limit: 100 }));

    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
      return invalidRequest(c, 'dry_run must be a boolean');
    }
    if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || body.limit < 1)) {
      return invalidRequest(c, 'limit must be a positive integer');
    }
    const dryRun = body.dry_run !== false; // Default to true (safe mode)
    const limit = Math.min(body.limit ?? 100, 1000);
    const now = Date.now();

    // Find expired guest browser-resume records.
    const expiredCredentials = await authCtx.coreAdapter.query<{
      user_id: string;
      credential_id: string;
      expires_at: number;
    }>(
      `SELECT ad.user_id, ad.id as credential_id, ad.expires_at
       FROM guest_devices ad
       INNER JOIN identity_accounts uc
         ON uc.tenant_id = ad.tenant_id AND uc.legacy_user_id = ad.user_id
       WHERE ad.tenant_id = ? AND ad.is_active = 1 AND ad.expires_at IS NOT NULL AND ad.expires_at < ?
         AND uc.account_type = 'user' AND uc.registration_state = 'guest' AND uc.deleted_at IS NULL
       ORDER BY ad.expires_at ASC
       LIMIT ?`,
      [tenantId, now, limit]
    );

    if (dryRun) {
      return c.json({
        dry_run: true,
        expired_count: expiredCredentials.length,
        expired_credentials: expiredCredentials.map((credential) => ({
          user_id: credential.user_id,
          credential_id: credential.credential_id,
          expired_at: credential.expires_at,
          expired_since_hours: Math.floor((now - credential.expires_at) / (1000 * 60 * 60)),
        })),
        note: 'Set dry_run=false to actually delete these users.',
      });
    }

    // Collect unique user IDs
    const userIds = [...new Set(expiredCredentials.map((credential) => credential.user_id))];

    // Delete in transaction-like manner
    let deletedCredentials = 0;
    let deactivatedCredentials = 0;
    let deletedUsers = 0;

    for (const userId of userIds) {
      // Check if the user has any active browser-resume credential.
      const activeCredential = await authCtx.coreAdapter.queryOne<{ id: string }>(
        `SELECT id FROM guest_devices
         WHERE tenant_id = ? AND user_id = ? AND is_active = 1
           AND (expires_at IS NULL OR expires_at > ?)`,
        [tenantId, userId, now]
      );

      if (!activeCredential) {
        const legalHold = await findActiveAccountLegalHold(authCtx.coreAdapter, tenantId, userId);
        if (legalHold) {
          continue;
        }
        const deletionOperationId = crypto.randomUUID();
        const auditMetadata = {
          operationId: deletionOperationId,
          registration_state: 'guest',
          reason: 'manual_cleanup',
          source: 'guest_cleanup_api',
        };
        const deletionRouteJson = JSON.stringify(
          await createGuestDeletionRoute(c.env, {
            tenantId,
            userId,
            completionAuditMode: 'outbox',
          })
        );
        const completionAuditId = `account-guest-deleted-${deletionOperationId}`;
        await createAuditLogFromContext(
          c,
          'account.guest.deletion_started',
          'user',
          userId,
          auditMetadata,
          'info',
          `account-guest-delete-started-${deletionOperationId}`
        );
        const auditOutbox = new GuestDeletionAuditOutboxRepository(authCtx.coreAdapter, tenantId);
        const auditTask = await auditOutbox.enqueue(
          createGuestDeletionAuditTaskFromContext(c, {
            auditId: completionAuditId,
            userId,
            operationId: deletionOperationId,
            metadata: auditMetadata,
          })
        );

        const deletingVersionMs = Date.now();
        const lifecycle = new GuestLifecycleRepository(authCtx.coreAdapter, tenantId);
        const deletionClaimed = await lifecycle.beginAdministrativeDeletion(
          userId,
          deletionOperationId,
          Math.floor(deletingVersionMs / 1000),
          deletionRouteJson,
          deletingVersionMs
        );
        if (!deletionClaimed) {
          await auditOutbox.remove(auditTask.audit_id);
          throw new Error('guest_administrative_deletion_conflict');
        }
        await transitionAccountAuthenticationState(c.env, {
          tenantId,
          userId,
          lifecycle: 'deleting',
          sourceVersionMs: deletingVersionMs,
          operationId: deletionOperationId,
          revokeSessions: true,
        });
        // No active credential remains, delete the guest account.
        await authCtx.coreAdapter.execute(
          'DELETE FROM guest_devices WHERE tenant_id = ? AND user_id = ?',
          [tenantId, userId]
        );
        await createRuntimeUserStore(c, tenantId).deleteUser(userId);
        await transitionAccountAuthenticationState(c.env, {
          tenantId,
          userId,
          lifecycle: 'deleted',
          sourceVersionMs: Math.max(Date.now(), deletingVersionMs + 1),
          operationId: deletionOperationId,
          revokeSessions: true,
        });
        const completedAt = Math.floor(Date.now() / 1000);
        if (!(await lifecycle.completeDeletion(userId, deletionOperationId, completedAt))) {
          throw new Error('guest_administrative_deletion_completion_conflict');
        }
        await deliverGuestDeletionCompletionAudit(c, {
          repository: auditOutbox,
          task: auditTask,
          completedAt,
          metadata: auditMetadata,
          log,
          logActionPrefix: 'guest_cleanup_user_delete',
        });
        deletedUsers++;
        deletedCredentials += expiredCredentials.filter(
          (credential) => credential.user_id === userId
        ).length;
      } else {
        // Keep the account and deactivate only expired resume credentials.
        await authCtx.coreAdapter.execute(
          `UPDATE guest_devices SET is_active = 0
           WHERE tenant_id = ? AND user_id = ? AND expires_at IS NOT NULL AND expires_at < ?`,
          [tenantId, userId, now]
        );
        await createAuditLogFromContext(c, 'guest.resume_credentials.deactivated', 'user', userId, {
          reason: 'manual_cleanup',
          source: 'guest_cleanup_api',
          expired_credential_count: expiredCredentials.filter(
            (credential) => credential.user_id === userId
          ).length,
        });
        deactivatedCredentials += expiredCredentials.filter(
          (credential) => credential.user_id === userId
        ).length;
      }
    }

    log.info('Guest account cleanup completed', {
      action: 'guest_cleanup',
      tenantId,
      deletedUsers,
      deletedCredentials,
      deactivatedCredentials,
    });

    return c.json({
      success: true,
      dry_run: false,
      deleted_users: deletedUsers,
      deleted_credentials: deletedCredentials,
      deactivated_credentials: deactivatedCredentials,
    });
  } catch (error) {
    log.error('Error during cleanup', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to cleanup expired guest accounts',
      },
      500
    );
  }
}
