/**
 * Public Invitation API Handlers
 *
 * Token-based invitation flow for tenant-specific signup routing.
 * These endpoints are public (no authentication required).
 *
 * - GET  /api/v1/invitations/validate?token=xxx  - Validate a token and return tenant info
 * - POST /api/v1/invitations/use                 - Mark a token as used (called after signup)
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  resolveOptionalCoreAdapterFromHono,
  getLogger,
  hasPIIDatabase,
  createPIIContextFromHono,
} from '@authrim/ar-lib-core';
import {
  applyInvitationAssignments,
  consumeInvitationUse,
  findActiveInvitationByToken,
  hasRemainingInvitationUses,
} from '@authrim/ar-lib-core/services/invitation-auth-core';

// =============================================================================
// Types
// =============================================================================

interface TenantInvitationRow {
  id: string;
  token: string;
  tenant_id: string;
  invited_email: string | null;
  role_id: string | null;
  org_id: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
}

interface TenantRow {
  id: string;
  name: string;
}

function getInvitationCoreAdapter(c: Context<{ Bindings: Env }>) {
  const adapter = resolveOptionalCoreAdapterFromHono(c, 'invitation');
  if (!adapter) {
    throw new Error('Core database is not configured');
  }
  return adapter;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/v1/invitations/validate?token=xxx
 * Validate an invitation token and return tenant/email info.
 * Called by the /invite landing page to show tenant name before signup.
 */
export async function validateInvitationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('INVITATIONS');
  const token = c.req.query('token');

  if (!token || token.length < 32) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'token' },
    });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const coreAdapter = getInvitationCoreAdapter(c);

    const invitation = await findActiveInvitationByToken(coreAdapter, token, now);

    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check uses remaining
    if (!hasRemainingInvitationUses(invitation)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const tenant = await coreAdapter.queryOne<TenantRow>(
      'SELECT id, name FROM tenants WHERE id = ?',
      [invitation.tenant_id]
    );

    if (!tenant) {
      log.warn('Invitation references non-existent tenant', {
        tenant_id: invitation.tenant_id,
        invitation_id: invitation.id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({
      valid: true,
      invitation_id: invitation.id,
      tenant_id: invitation.tenant_id,
      tenant_name: tenant.name,
      invited_email: invitation.invited_email,
      expires_at: invitation.expires_at,
    });
  } catch (error) {
    log.error('Failed to validate invitation', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/v1/invitations/use
 * Mark an invitation token as used after successful signup.
 * Also applies role/org assignments to the user.
 *
 * Body: { token: string, user_id: string }
 */
export async function useInvitationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('INVITATIONS');

  try {
    const body = await c.req.json<{ token: string; user_id: string }>();
    const { token, user_id } = body;

    if (!token || !user_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'token, user_id' },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const coreAdapter = getInvitationCoreAdapter(c);

    const invitation = await findActiveInvitationByToken(coreAdapter, token, now);

    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (!hasRemainingInvitationUses(invitation)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Verify the user_id actually exists in the correct tenant
    const userRow = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
      [user_id, invitation.tenant_id]
    );
    if (!userRow) {
      log.warn('useInvitation: user_id not found in invitation tenant', {
        user_id,
        tenant_id: invitation.tenant_id,
        invitation_id: invitation.id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // If invitation is email-restricted, verify the user's email matches (PII DB)
    if (invitation.invited_email && hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, invitation.tenant_id);
      const piiRow = await piiCtx.defaultPiiAdapter.queryOne<{ email: string }>(
        'SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?',
        [user_id, invitation.tenant_id]
      );

      // No PII record → cannot verify email; block to prevent misuse
      if (!piiRow || piiRow.email.toLowerCase() !== invitation.invited_email.toLowerCase()) {
        log.warn('useInvitation: invited_email verification failed', {
          invitation_id: invitation.id,
          user_id,
          reason: !piiRow ? 'no_pii_record' : 'email_mismatch',
        });
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }
    }

    // Atomically increment use_count only if still within limit
    const consumed = await consumeInvitationUse(
      coreAdapter,
      invitation.id,
      invitation.tenant_id,
      now
    );
    if (!consumed) {
      // Another concurrent request consumed the last use
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Apply role/org assignments
    const assignmentResults = await applyInvitationAssignments(coreAdapter, {
      userId: user_id,
      tenantId: invitation.tenant_id,
      roleId: invitation.role_id,
      orgId: invitation.org_id,
    });

    if (invitation.role_id && !assignmentResults.roleAssignment?.success) {
      log.warn('Failed to assign role from invitation', {
        invitation_id: invitation.id,
        error: assignmentResults.roleAssignment?.error,
      });
    }

    if (invitation.org_id && !assignmentResults.orgMembership?.success) {
      log.warn('Failed to assign org from invitation', {
        invitation_id: invitation.id,
        error: assignmentResults.orgMembership?.error,
      });
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to use invitation', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
