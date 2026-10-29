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
  compareGuestCleanupKey,
  decodeGuestCleanupCursor,
  encodeGuestCleanupCursor,
  guestCleanupInventoryDigest,
} from '../guest-cleanup-cursor';
import { createGuestPiiErasurePort } from '@authrim/ar-lib-core/services/guest-pii-erasure';
import {
  guestStoresFromContext,
  guestMapStores,
  findGuestCoreOwner,
  resolveGuestOwnerStorage,
  type GuestCoreOwner,
  type GuestCoreStore,
} from '../guest-account-storage';
import {
  parseGuestDeletionRoute,
  verifyGuestDeletionPins,
  guestErasureBoundaryId,
} from '../guest-deletion-route';
import {
  createAuthContextFromHono,
  createPIIContextFromHono,
  CanonicalRuntimeUserStore,
  GuestLifecycleRepository,
  getTenantIdFromContext,
  getLogger,
  getSessionRevocationStore,
  createAuditLogFromContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { findActiveAccountLegalHold } from '../account-legal-hold-guard';
import { createGuestDeletionRoute, deleteOneGuestAccount } from '../guest-lifecycle-scheduled';
import {
  createGuestDeletionAuditTaskFromContext,
  GuestDeletionAuditOutboxRepository,
  requireGuestDeletionAuditTask,
  writeGuestDeletionAudit,
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
    const userId = c.req.param('id');

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
    const userId = c.req.param('id');

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
function guestFailure(c: Context<{ Bindings: Env }>, error: unknown): Response {
  const code =
    error instanceof Error && /^guest_[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : 'server_error';
  return c.json(
    { error: code, error_description: 'Guest operation could not be verified or completed' },
    code === 'server_error' ? 500 : 503
  );
}

async function guestTerminalProof(
  c: Context<{ Bindings: Env }>,
  core: DatabaseAdapter,
  route: import('../guest-deletion-route').GuestDeletionRouteV2
): Promise<boolean> {
  const row = await new GuestLifecycleRepository(core, route.tenantId).get(route.userId);
  if (
    !row ||
    row.phase !== 'deleted' ||
    row.deletion_operation_id !== route.operationId ||
    !row.deleted_at ||
    row.deletion_route_json !== JSON.stringify(route) ||
    route.execution.phase !== 'erasure_started' ||
    route.execution.boundaryId !== (await guestErasureBoundaryId(route.operationId)) ||
    route.execution.erasureStartedAtMs === null
  )
    return false;
  const account = await core.queryOne<{ id: string }>(
    `SELECT account.id FROM identity_accounts account JOIN account_legal_hold_states authority ON authority.tenant_id=account.tenant_id AND authority.account_id=account.id
    WHERE account.tenant_id=? AND account.id=? AND account.legacy_user_id=? AND account.account_route_generation=? AND account.lifecycle_state='deleted'
      AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=account.tenant_id AND hold.subject_id=account.id AND hold.subject_type='account' AND hold.state='active')`,
    [route.tenantId, route.accountId, route.userId, route.accountRouteGeneration],
    { consistencyClass: 'primary_required' }
  );
  if (!account) return false;
  const authentication = await getSessionRevocationStore(
    c.env,
    route.tenantId,
    route.userId
  ).getAccountStateRpc(route.tenantId, route.userId, `account:${route.userId}`);
  if (
    authentication.lifecycle !== 'deleted' ||
    authentication.lifecycleOperationId !== `${route.operationId}:complete` ||
    authentication.lifecycleVersionMs !== route.execution.erasureStartedAtMs + 1
  )
    throw new Error('guest_deletion_authentication_unverified');
  const verified = await verifyGuestDeletionPins(c.env, route);
  const marker = await createGuestPiiErasurePort(verified.pii, route.piiPin).get({
    tenantId: route.tenantId,
    userId: route.userId,
    accountId: route.accountId,
    accountRouteGeneration: route.accountRouteGeneration,
    operationId: route.operationId,
    boundaryId: route.execution.boundaryId,
    sourceStartedAtMs: route.execution.erasureStartedAtMs,
    piiPin: route.piiPin,
  });
  return marker?.state === 'deleted';
}

/** One request resumes only the original immutable operation/actor, never replaces its task. */
async function performGuestDeletion(
  c: Context<{ Bindings: Env }>,
  owner: GuestCoreOwner,
  reason: 'admin_action' | 'manual_cleanup'
): Promise<'deleted' | 'pending' | 'held'> {
  const tenantId = getTenantIdFromContext(c);
  if (!owner.pin || owner.adapter.getType() !== 'd1')
    throw new Error('guest_deletion_backend_unsupported');
  let lifecycle = new GuestLifecycleRepository(owner.adapter, tenantId),
    row = await lifecycle.get(owner.userId);
  if (!row) throw new Error('guest_deletion_source_unverified');
  if (await findActiveAccountLegalHold(owner.adapter, tenantId, owner.userId)) return 'held';
  if (row.phase === 'active') {
    if (
      !owner.account ||
      owner.account.account_type !== 'user' ||
      owner.account.registration_state !== 'guest'
    )
      throw new Error('guest_deletion_conflict');
    const operationId = crypto.randomUUID(),
      auditId = `account-guest-deleted-${operationId}`;
    const route = await createGuestDeletionRoute(c.env, {
      tenantId,
      userId: owner.userId,
      operationId,
      completionAuditId: auditId,
      origin: 'admin',
      owner,
    });
    const metadata = {
      guestDeletionVersion: 2,
      operationId,
      registration_state: 'guest',
      reason,
      source: reason === 'admin_action' ? 'guest_admin_api' : 'guest_cleanup_api',
    };
    const task = createGuestDeletionAuditTaskFromContext(c, {
      auditId,
      userId: owner.userId,
      operationId,
      metadata,
    });
    await createAuditLogFromContext(
      c,
      'account.guest.deletion_started',
      'user',
      owner.userId,
      metadata,
      'info',
      `account-guest-delete-started-${operationId}`
    );
    const at = Date.now();
    task.createdAt = Math.floor(at / 1000);
    row = await lifecycle.admitDeletion({
      userId: owner.userId,
      accountId: route.accountId,
      operationId,
      routeJson: JSON.stringify(route),
      expectedRevision: row.revision,
      accountRouteGeneration: route.accountRouteGeneration,
      now: task.createdAt,
      startedAtMs: at,
      origin: 'admin',
      task,
    });
    if (!row) {
      if (await findActiveAccountLegalHold(owner.adapter, tenantId, owner.userId)) return 'held';
      throw new Error('guest_deletion_conflict');
    }
  }
  if (!row.deletion_operation_id || !['deleting', 'deleted'].includes(row.phase))
    throw new Error('guest_deletion_conflict');
  const route = parseGuestDeletionRoute(row.deletion_route_json, {
    tenantId,
    userId: owner.userId,
    operationId: row.deletion_operation_id,
  });
  const verified = await verifyGuestDeletionPins(c.env, route);
  lifecycle = new GuestLifecycleRepository(verified.core, tenantId);
  const outbox = new GuestDeletionAuditOutboxRepository(verified.core, tenantId);
  const existing = await outbox.get(route.completionAuditId);
  if (!existing) {
    if (await guestTerminalProof(c, verified.core, route)) return 'deleted';
    throw new Error('guest_deletion_source_unverified');
  }
  const result = await deleteOneGuestAccount(c.env, {
    tenantId,
    core: verified.core,
    coreBindingRef: route.corePin.bindingRef,
    candidate: row,
    now: Math.floor(Date.now() / 1000),
  });
  if (result === 'held') return 'held';
  if (result !== 'deleted') return 'pending';
  if (!(await guestTerminalProof(c, verified.core, route)))
    throw new Error('guest_deletion_completion_unknown');
  const terminal = await lifecycle.get(owner.userId);
  if (!terminal?.deleted_at) throw new Error('guest_deletion_completion_unknown');
  const task = await requireGuestDeletionAuditTask(verified.core, route);
  try {
    await writeGuestDeletionAudit(c.env, task, terminal.deleted_at * 1000);
    await outbox.acknowledgeV2(task);
  } catch {
    await outbox.markRetry(task, Math.floor(Date.now() / 1000), 'guest_deletion_audit_pending');
  }
  return 'deleted';
}

export async function deleteGuestUser(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const tenantId = getTenantIdFromContext(c),
      requested = c.req.param('id');
    if (!requested) return invalidRequest(c, 'User ID is required');
    const owner = await findGuestCoreOwner(
      await guestStoresFromContext(c, tenantId),
      tenantId,
      requested
    );
    if (!owner)
      return c.json({ error: 'not_found', error_description: 'Guest account not found' }, 404);
    if (
      owner.account &&
      (owner.account.account_type !== 'user' || owner.account.registration_state !== 'guest')
    )
      return invalidRequest(c, 'User is not a guest account. Use regular user deletion.');
    const result = await performGuestDeletion(c, owner, 'admin_action');
    if (result === 'held')
      return c.json(
        {
          error: 'legal_hold_active',
          error_description:
            'Guest deletion is paused by an active legal hold; the original request is retained',
        },
        409
      );
    if (result === 'pending') {
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'guest_deletion_pending',
          error_description: 'Guest deletion is in progress; retry resumes the same request',
        },
        503
      );
    }
    return c.json({
      success: true,
      deleted_user_id: owner.userId,
      note: 'Upgrade history preserved for audit purposes.',
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'guest_deletion_conflict')
      return c.json({ error: 'conflict', error_description: 'Guest lifecycle changed' }, 409);
    return guestFailure(c, error);
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
export async function cleanupExpiredGuestUsers(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req
      .json<{ dry_run?: unknown; limit?: unknown; cursor?: unknown }>()
      .catch(() => ({ dry_run: true, limit: 100, cursor: undefined }));
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') ||
      (body.limit !== undefined &&
        (typeof body.limit !== 'number' || !Number.isSafeInteger(body.limit) || body.limit < 1))
    )
      return invalidRequest(c, 'Invalid cleanup request');
    const limit = Math.min(typeof body.limit === 'number' ? body.limit : 100, 1000),
      now = Date.now();
    const stores = (await guestStoresFromContext(c, tenantId)).sort((a, b) =>
      compareGuestCleanupKey(a.pin?.databaseId ?? a.bindingRef, b.pin?.databaseId ?? b.bindingRef)
    );
    const inventoryDigest = await guestCleanupInventoryDigest(stores);
    let cursor: ReturnType<typeof decodeGuestCleanupCursor>;
    try {
      cursor = decodeGuestCleanupCursor(body.cursor, tenantId, inventoryDigest);
    } catch {
      return invalidRequest(c, 'Invalid or stale cleanup cursor');
    }
    if (cursor && cursor.source >= stores.length)
      return invalidRequest(c, 'Invalid cleanup cursor');
    type Candidate = {
      user_id: string;
      credential_id: string | null;
      expires_at: number;
      store: GuestCoreStore;
    };
    const pageSize = Math.min(limit, 16);
    // Accepted/started/terminal-but-unacknowledged jobs survive deletion of the last credential.
    const pendingSql = `SELECT guest.user_id,NULL AS credential_id,guest.updated_at AS expires_at
      FROM guest_account_lifecycle guest WHERE guest.tenant_id=? AND
        (guest.phase='deleting' OR (guest.phase='deleted' AND EXISTS (
          SELECT 1 FROM guest_deletion_audit_outbox task WHERE task.tenant_id=guest.tenant_id AND task.user_id=guest.user_id
          AND task.operation_id=guest.deletion_operation_id AND task.status IN ('pending','retry'))))
      ORDER BY guest.updated_at,guest.user_id LIMIT ?`;
    const expiredSql = `SELECT device.user_id,device.id AS credential_id,device.expires_at FROM guest_devices device
      JOIN identity_accounts account ON account.tenant_id=device.tenant_id AND account.legacy_user_id=device.user_id
      WHERE device.tenant_id=? AND device.is_active=1 AND device.expires_at IS NOT NULL AND device.expires_at<?
        AND account.account_type='user' AND account.registration_state='guest' AND account.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM guest_account_lifecycle guest WHERE guest.tenant_id=device.tenant_id
          AND guest.user_id=device.user_id AND guest.phase IN ('deleting','deleted'))
      ORDER BY device.expires_at,device.id LIMIT ?`;
    const pendingPages =
      cursor?.phase === 'expired'
        ? []
        : await guestMapStores(stores, async (store) =>
            (
              await store.adapter.query<Omit<Candidate, 'store'>>(
                cursor?.phase === 'pending'
                  ? pendingSql.replace(
                      'ORDER BY',
                      `AND (guest.updated_at>? OR (guest.updated_at=? AND (guest.user_id>? OR (guest.user_id=? AND ?>?)))) ORDER BY`
                    )
                  : pendingSql,
                cursor?.phase === 'pending'
                  ? [
                      tenantId,
                      cursor.at,
                      cursor.at,
                      cursor.id,
                      cursor.id,
                      stores.indexOf(store),
                      cursor.source,
                      pageSize + 1,
                    ]
                  : [tenantId, pageSize + 1],
                {
                  consistencyClass: 'primary_required',
                }
              )
            ).map((row) => ({ ...row, store }))
          );
    const expiredPages = await guestMapStores(stores, async (store) =>
      (
        await store.adapter.query<Omit<Candidate, 'store'>>(
          cursor?.phase === 'expired'
            ? expiredSql.replace(
                'ORDER BY',
                `AND (device.expires_at>? OR (device.expires_at=? AND (device.id>? OR (device.id=? AND ?>?)))) ORDER BY`
              )
            : expiredSql,
          cursor?.phase === 'expired'
            ? [
                tenantId,
                now,
                cursor.at,
                cursor.at,
                cursor.id,
                cursor.id,
                stores.indexOf(store),
                cursor.source,
                pageSize + 1,
              ]
            : [tenantId, now, pageSize + 1],
          { consistencyClass: 'primary_required' }
        )
      ).map((row) => ({ ...row, store }))
    );
    const pendingCandidates = pendingPages
      .flat()
      .sort(
        (a, b) =>
          a.expires_at - b.expires_at ||
          compareGuestCleanupKey(a.user_id, b.user_id) ||
          stores.indexOf(a.store) - stores.indexOf(b.store)
      );
    const expiredCandidates = expiredPages
      .flat()
      .sort(
        (a, b) =>
          a.expires_at - b.expires_at ||
          compareGuestCleanupKey(a.credential_id ?? '', b.credential_id ?? '') ||
          stores.indexOf(a.store) - stores.indexOf(b.store)
      );
    const selected = [...pendingCandidates, ...expiredCandidates].slice(0, pageSize);
    let hasMore = pendingCandidates.length + expiredCandidates.length > selected.length;
    const cursorFor = (candidate: Candidate | null) =>
      candidate
        ? encodeGuestCleanupCursor({
            version: 1,
            tenantId,
            inventoryDigest,
            phase: candidate.credential_id === null ? 'pending' : 'expired',
            at: candidate.expires_at,
            id: candidate.credential_id ?? candidate.user_id,
            source: stores.indexOf(candidate.store),
          })
        : null;
    if (body.dry_run !== false)
      return c.json({
        dry_run: true,
        expired_count: selected.filter((row) => row.credential_id !== null).length,
        pending_users: selected.filter((row) => row.credential_id === null).length,
        expired_credentials: selected
          .filter((row) => row.credential_id !== null)
          .map((row) => ({
            user_id: row.user_id,
            credential_id: row.credential_id,
            expired_at: row.expires_at,
            expired_since_hours: Math.floor((now - row.expires_at) / 3600000),
          })),
        has_more: hasMore,
        next_cursor: hasMore ? cursorFor(selected.at(-1) ?? null) : null,
        note: 'Set dry_run=false to resume deletions and clean expired credentials.',
      });
    let deletedUsers = 0,
      deletedCredentials = 0,
      deactivated = 0,
      pending = 0,
      held = 0;
    const deadline = Date.now() + 5000,
      seen = new Set<string>();
    const resume = async (owner: GuestCoreOwner, credentialCount: number) => {
      const result = await performGuestDeletion(c, owner, 'manual_cleanup');
      if (result === 'deleted') {
        deletedUsers++;
        deletedCredentials += credentialCount;
      } else if (result === 'held') held++;
      else pending++;
    };
    let lastVisited: Candidate | null = null;
    for (const candidate of selected) {
      if (seen.has(candidate.user_id)) {
        lastVisited = candidate;
        continue;
      }
      if (Date.now() >= deadline) {
        hasMore = true;
        break;
      }
      lastVisited = candidate;
      seen.add(candidate.user_id);
      const owner = await findGuestCoreOwner(stores, tenantId, candidate.user_id);
      if (!owner || !owner.pin || owner.pin.databaseId !== candidate.store.pin?.databaseId)
        throw new Error('guest_account_owner_unverified');
      const lifecycle = new GuestLifecycleRepository(owner.adapter, tenantId);
      const current = await lifecycle.get(owner.userId);
      const credentials = selected.filter(
        (entry) => entry.user_id === owner.userId && entry.credential_id !== null
      );
      // A previously accepted intent always resumes; active credentials cannot divert it.
      if (current && ['deleting', 'deleted'].includes(current.phase)) {
        await resume(owner, credentials.length);
        continue;
      }
      if (!current || current.phase !== 'active') throw new Error('guest_deletion_conflict');
      const active = await owner.adapter.queryOne<{ id: string }>(
        `SELECT id FROM guest_devices WHERE tenant_id=? AND user_id=? AND is_active=1 AND (expires_at IS NULL OR expires_at>?) LIMIT 1`,
        [tenantId, owner.userId, now],
        { consistencyClass: 'primary_required' }
      );
      if (!active) {
        await resume(owner, credentials.length);
        continue;
      }
      if (await findActiveAccountLegalHold(owner.adapter, tenantId, owner.userId)) {
        held++;
        continue;
      }
      const verified = await resolveGuestOwnerStorage(c.env, owner, tenantId);
      const ids = credentials.flatMap((entry) =>
        entry.credential_id === null ? [] : [entry.credential_id]
      );
      if (!ids.length) {
        pending++;
        continue;
      }
      const updated = await owner.adapter.execute(
        `UPDATE guest_devices SET is_active=0 WHERE tenant_id=? AND user_id=? AND id IN (${ids.map(() => '?').join(',')})
          AND is_active=1 AND expires_at IS NOT NULL AND expires_at<?
          AND EXISTS (SELECT 1 FROM identity_accounts account JOIN account_legal_hold_states authority
            ON authority.tenant_id=account.tenant_id AND authority.account_id=account.id
            JOIN guest_account_lifecycle guest ON guest.tenant_id=account.tenant_id AND guest.user_id=account.legacy_user_id
            WHERE account.tenant_id=guest_devices.tenant_id AND account.legacy_user_id=guest_devices.user_id
              AND account.id=? AND account.account_route_generation=? AND account.account_type='user'
              AND account.registration_state='guest' AND account.lifecycle_state='active' AND account.deleted_at IS NULL
              AND guest.phase='active' AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=account.tenant_id
                AND hold.subject_type='account' AND hold.subject_id=account.id AND hold.state='active'))`,
        [
          tenantId,
          owner.userId,
          ...ids,
          now,
          verified.account.id,
          verified.account.account_route_generation,
        ]
      );
      if (!updated.success) throw new Error('guest_cleanup_deactivation_unknown');
      const reflected = await owner.adapter.query<{ id: string; is_active: number }>(
        `SELECT id,is_active FROM guest_devices WHERE tenant_id=? AND user_id=? AND id IN (${ids.map(() => '?').join(',')})`,
        [tenantId, owner.userId, ...ids],
        { consistencyClass: 'primary_required' }
      );
      if (reflected.length !== ids.length || reflected.some((entry) => entry.is_active !== 0)) {
        if (await findActiveAccountLegalHold(owner.adapter, tenantId, owner.userId)) {
          held++;
          continue;
        }
        const raced = await lifecycle.get(owner.userId);
        if (raced && ['deleting', 'deleted'].includes(raced.phase)) {
          await resume(owner, credentials.length);
          continue;
        }
        throw new Error('guest_cleanup_deactivation_unknown');
      }
      await createAuditLogFromContext(
        c,
        'guest.resume_credentials.deactivated',
        'user',
        owner.userId,
        {
          reason: 'manual_cleanup',
          source: 'guest_cleanup_api',
          expired_credential_count: ids.length,
        }
      );
      deactivated += ids.length;
    }
    const remaining = await guestMapStores(
      stores,
      async (store) =>
        (
          await store.adapter.query(pendingSql, [tenantId, 1], {
            consistencyClass: 'primary_required',
          })
        ).length > 0 ||
        (
          await store.adapter.query(expiredSql, [tenantId, now, 1], {
            consistencyClass: 'primary_required',
          })
        ).length > 0
    );
    hasMore ||=
      remaining.some(Boolean) ||
      pending > 0 ||
      held > 0 ||
      seen.size < new Set(selected.map((entry) => entry.user_id)).size;
    return c.json({
      success: true,
      dry_run: false,
      complete: !hasMore,
      has_more: hasMore,
      next_cursor: hasMore ? cursorFor(lastVisited) : null,
      deleted_users: deletedUsers,
      deleted_credentials: deletedCredentials,
      deactivated_credentials: deactivated,
      pending_users: pending,
      held_users: held,
    });
  } catch (error) {
    return guestFailure(c, error);
  }
}
