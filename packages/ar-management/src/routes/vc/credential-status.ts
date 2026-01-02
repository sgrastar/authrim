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
import type { Env, DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  IssuedCredentialRepository,
  D1StatusListRepository,
  StatusListManager,
  StatusValue,
  getTenantIdFromContext,
  createErrorResponse,
  AR_ERROR_CODES,
} from '@authrim/ar-lib-core';

/**
 * POST /api/admin/vc/credentials/:id/revoke
 *
 * Revoke a credential by setting its status to invalid in the status list.
 * This is permanent and cannot be undone.
 */
export async function revokeCredentialHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const credentialId = c.req.param('id');

  if (!credentialId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // SECURITY: Get tenant ID from authenticated context, not from request
    const tenantId = getTenantIdFromContext(c);

    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);

    // Get credential by ID
    const credential = await issuedCredentialRepo.findById(credentialId);

    if (!credential) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // SECURITY: Verify credential belongs to the authenticated tenant
    if (credential.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (credential.status === 'revoked') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (!credential.status_list_id || credential.status_list_index === null) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Update status in the status list
    await statusListManager.revoke(credential.status_list_id, credential.status_list_index);

    // Update credential status in database
    await issuedCredentialRepo.updateStatus(credentialId, 'revoked');

    return c.json({
      id: credentialId,
      status: 'revoked',
      status_list_id: credential.status_list_id,
      status_list_index: credential.status_list_index,
      revoked_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/vc] Revoke credential error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/vc/credentials/:id/suspend
 *
 * Suspend a credential temporarily. Can be reactivated later.
 * Suspension uses a separate status list from revocation.
 */
export async function suspendCredentialHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const credentialId = c.req.param('id');

  if (!credentialId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // SECURITY: Get tenant ID from authenticated context, not from request
    const tenantId = getTenantIdFromContext(c);

    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);

    // Get credential by ID
    const credential = await issuedCredentialRepo.findById(credentialId);

    if (!credential) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // SECURITY: Verify credential belongs to the authenticated tenant
    if (credential.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (credential.status === 'revoked') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (credential.status === 'suspended') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (!credential.status_list_id || credential.status_list_index === null) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Update status in the status list
    await statusListManager.suspend(credential.status_list_id, credential.status_list_index);

    // Update credential status in database
    await issuedCredentialRepo.updateStatus(credentialId, 'suspended');

    return c.json({
      id: credentialId,
      status: 'suspended',
      status_list_id: credential.status_list_id,
      status_list_index: credential.status_list_index,
      suspended_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/vc] Suspend credential error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/vc/credentials/:id/activate
 *
 * Reactivate a suspended credential.
 * Note: Revoked credentials cannot be reactivated.
 */
export async function activateCredentialHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const credentialId = c.req.param('id');

  if (!credentialId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // SECURITY: Get tenant ID from authenticated context, not from request
    const tenantId = getTenantIdFromContext(c);

    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const issuedCredentialRepo = new IssuedCredentialRepository(adapter);
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);

    // Get credential by ID
    const credential = await issuedCredentialRepo.findById(credentialId);

    if (!credential) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // SECURITY: Verify credential belongs to the authenticated tenant
    if (credential.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (credential.status === 'revoked') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (credential.status === 'active') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (!credential.status_list_id || credential.status_list_index === null) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Update status in the status list
    await statusListManager.activate(credential.status_list_id, credential.status_list_index);

    // Update credential status in database
    await issuedCredentialRepo.updateStatus(credentialId, 'active');

    return c.json({
      id: credentialId,
      status: 'active',
      status_list_id: credential.status_list_id,
      status_list_index: credential.status_list_index,
      activated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[admin/vc] Activate credential error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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
  // SECURITY: Get tenant ID from authenticated context, not from query parameters
  const tenantId = getTenantIdFromContext(c);
  const purpose = c.req.query('purpose') as 'revocation' | 'suspension' | undefined;
  const state = c.req.query('state') as 'active' | 'sealed' | 'archived' | undefined;

  try {
    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
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
    console.error('[admin/vc] List status lists error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/vc/status-lists/:id
 *
 * Get status list details including stats.
 */
export async function getStatusListHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const listId = c.req.param('id');

  if (!listId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // SECURITY: Get tenant ID from authenticated context
    const tenantId = getTenantIdFromContext(c);

    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const statusListRepo = new D1StatusListRepository(adapter);
    const statusListManager = new StatusListManager(statusListRepo);

    const list = await statusListManager.getStatusList(listId);

    if (!list) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // SECURITY: Verify status list belongs to the authenticated tenant
    if (list.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Calculate ETag for the list
    const etag = await statusListManager.calculateETag(listId);

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
    console.error('[admin/vc] Get status list error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/vc/status-lists/stats
 *
 * Get aggregate statistics for status lists.
 */
export async function getStatusListStatsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  // SECURITY: Get tenant ID from authenticated context, not from query parameters
  const tenantId = getTenantIdFromContext(c);

  try {
    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
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
    console.error('[admin/vc] Get status list stats error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
