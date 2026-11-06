/**
 * Credential Status Admin API
 *
 * Admin endpoints for managing credential revocation and suspension.
 *
 * Endpoints:
 * - POST /api/admin/vc/credentials/:id/revoke - Revoke a credential
 * - POST /api/admin/vc/credentials/:id/suspend - Suspend a credential
 * - POST /api/admin/vc/credentials/:id/activate - Activate a suspended credential
 * - GET  /api/admin/vc/status-lists - List status lists
 * - GET  /api/admin/vc/status-lists/:id - Get status list details
 */

import type { Context } from 'hono';
import type { Env, CredentialStatus, CredentialStatusTransitionTarget } from '@authrim/ar-lib-core';
import {
  D1StatusListRepository,
  StatusListManager,
  transitionCredentialStatus,
  createAuthContextFromHono,
  getTenantIdFromContext,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';
import { ADMIN_CREDENTIAL_TYPE } from '../admin-management/admin-wallet-credential-store';

type TransitionSpec = {
  from: CredentialStatus[];
  to: CredentialStatusTransitionTarget;
  timestampField: 'revoked_at' | 'suspended_at' | 'activated_at';
  label: string;
};

const REVOKE: TransitionSpec = {
  from: ['pending', 'active', 'suspended'],
  to: 'revoked',
  timestampField: 'revoked_at',
  label: 'Revoke',
};
const SUSPEND: TransitionSpec = {
  from: ['active'],
  to: 'suspended',
  timestampField: 'suspended_at',
  label: 'Suspend',
};
const ACTIVATE: TransitionSpec = {
  from: ['suspended'],
  to: 'active',
  timestampField: 'activated_at',
  label: 'Activate',
};

/**
 * Every status change goes through the one ar-lib-core transition, which updates the credential
 * row and the status-list bit atomically. Outcomes: changed/unchanged -> 200 with the resulting
 * status (idempotent), not_found -> 404, not_allowed -> 409, conflict -> 503 (retry).
 */
async function applyTransition(
  c: Context<{ Bindings: Env }>,
  spec: TransitionSpec
): Promise<Response> {
  const log = getLogger(c).module('CredentialStatusAPI');
  const credentialId = c.req.param('id')!;

  if (!credentialId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // SECURITY: Get tenant ID from authenticated context, not from request
    const tenantId = getTenantIdFromContext(c);
    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const now = Date.now();

    // Admin credentials have their own routes, which check authority over the admin and ask for
    // an L2 step-up. This generic route must not be a way around them. The type never changes.
    const type = await adapter.queryOne<{ credential_type: string }>(
      'SELECT credential_type FROM issued_credentials WHERE tenant_id = ? AND public_id = ?',
      [tenantId, credentialId]
    );
    if (type?.credential_type === ADMIN_CREDENTIAL_TYPE) {
      return c.json(
        {
          error: 'admin_credential_not_managed_here',
          error_description:
            'Admin credentials are revoked through the admin wallet credential routes',
        },
        409
      );
    }

    const result = await transitionCredentialStatus(adapter, {
      tenantId,
      credentialId,
      from: spec.from,
      to: spec.to,
      now,
    });

    switch (result.outcome) {
      case 'changed':
      case 'unchanged':
        return c.json({
          id: credentialId,
          status: spec.to,
          [spec.timestampField]: new Date(now).toISOString(),
        });
      case 'not_found':
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      case 'not_allowed':
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
      case 'conflict':
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'The credential changed concurrently. Retry shortly.',
          },
          503,
          { 'Retry-After': '1' }
        );
      default:
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  } catch (error) {
    log.error(`${spec.label} credential error`, {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/vc/credentials/:id/revoke
 *
 * Revoke a credential (pending, active or suspended). Permanent; repeating it is a no-op.
 */
export async function revokeCredentialHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  return applyTransition(c, REVOKE);
}

/**
 * POST /api/admin/vc/credentials/:id/suspend
 *
 * Suspend an active credential temporarily. Can be reactivated later.
 */
export async function suspendCredentialHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  return applyTransition(c, SUSPEND);
}

/**
 * POST /api/admin/vc/credentials/:id/activate
 *
 * Reactivate a suspended credential. A revoked credential never comes back.
 */
export async function activateCredentialHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  return applyTransition(c, ACTIVATE);
}

/**
 * GET /api/admin/vc/status-lists
 *
 * List all status lists with optional filtering.
 *
 * Query parameters:
 * - tenant_id: Filter by tenant ID
 * - purpose: Filter by purpose (revocation | suspension)
 * - state: Filter by state (active | sealed | archived)
 */
export async function listStatusListsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('CredentialStatusAPI');
  // SECURITY: Get tenant ID from authenticated context, not from query parameters
  const tenantId = getTenantIdFromContext(c);
  const purpose = c.req.query('purpose') as 'revocation' | 'suspension' | undefined;
  const state = c.req.query('state') as 'active' | 'sealed' | 'archived' | undefined;

  try {
    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);

    const lists = await statusListManager.listStatusLists(tenantId, { purpose, state });

    return c.json({
      status_lists: lists.map((list) => ({
        id: list.id,
        tenant_id: list.tenant_id,
        purpose: list.purpose,
        capacity: list.capacity,
        used_count: list.used_count,
        state: list.state,
        created_at: list.created_at,
        updated_at: list.updated_at,
        sealed_at: list.sealed_at,
      })),
      total: lists.length,
    });
  } catch (error) {
    log.error('List status lists error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/vc/status-lists/:id
 *
 * Get status list details including stats.
 */
export async function getStatusListHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('CredentialStatusAPI');
  const listId = c.req.param('id')!;

  if (!listId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // SECURITY: Get tenant ID from authenticated context
    const tenantId = getTenantIdFromContext(c);

    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);

    const list = await statusListManager.getStatusList(tenantId, listId);

    if (!list) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Calculate ETag for the list
    const etag = await statusListManager.calculateETag(tenantId, listId);

    return c.json({
      id: list.id,
      tenant_id: list.tenant_id,
      purpose: list.purpose,
      capacity: list.capacity,
      used_count: list.used_count,
      available_count: list.capacity - list.used_count,
      utilization_percentage: Math.round((list.used_count / list.capacity) * 100 * 100) / 100,
      state: list.state,
      created_at: list.created_at,
      updated_at: list.updated_at,
      sealed_at: list.sealed_at,
      etag,
    });
  } catch (error) {
    log.error('Get status list error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/vc/status-lists/stats
 *
 * Get aggregate statistics for status lists.
 */
export async function getStatusListStatsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('CredentialStatusAPI');
  // SECURITY: Get tenant ID from authenticated context, not from query parameters
  const tenantId = getTenantIdFromContext(c);

  try {
    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const statusListRepo = new D1StatusListRepository(adapter);

    const stats = await statusListRepo.getStats(tenantId);

    return c.json({
      tenant_id: tenantId,
      lists: {
        total: stats.total,
        active: stats.active,
        sealed: stats.sealed,
        archived: stats.archived,
      },
      capacity: {
        total: stats.totalCapacity,
        used: stats.totalUsed,
        available: stats.totalCapacity - stats.totalUsed,
        utilization_percentage:
          stats.totalCapacity > 0
            ? Math.round((stats.totalUsed / stats.totalCapacity) * 100 * 100) / 100
            : 0,
      },
    });
  } catch (error) {
    log.error('Get status list stats error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
