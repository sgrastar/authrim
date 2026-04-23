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
  D1Adapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  hasPIIDatabase,
  createPIIContextFromHono,
} from '@authrim/ar-lib-core';

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
    const adapter = new D1Adapter({ db: c.env.DB });

    const invitation = await adapter.queryOne<TenantInvitationRow>(
      `SELECT id, token, tenant_id, invited_email, role_id, org_id, max_uses, use_count, expires_at
       FROM tenant_invitations
       WHERE token = ? AND expires_at > ?`,
      [token, now]
    );

    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check uses remaining
    if (invitation.max_uses !== -1 && invitation.use_count >= invitation.max_uses) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const tenant = await adapter.queryOne<TenantRow>('SELECT id, name FROM tenants WHERE id = ?', [
      invitation.tenant_id,
    ]);

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
    const adapter = new D1Adapter({ db: c.env.DB });

    const invitation = await adapter.queryOne<TenantInvitationRow>(
      `SELECT id, tenant_id, invited_email, role_id, org_id, max_uses, use_count, expires_at
       FROM tenant_invitations
       WHERE token = ? AND expires_at > ?`,
      [token, now]
    );

    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (invitation.max_uses !== -1 && invitation.use_count >= invitation.max_uses) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Verify the user_id actually exists in the correct tenant
    const userRow = await adapter.queryOne<{ id: string }>(
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
    const result = await c.env.DB.prepare(
      `UPDATE tenant_invitations
       SET use_count = use_count + 1, updated_at = ?
       WHERE id = ? AND (max_uses = -1 OR use_count < max_uses)`
    )
      .bind(now, invitation.id)
      .run();

    if (result.meta.changes === 0) {
      // Another concurrent request consumed the last use
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Apply role/org assignments
    if (invitation.role_id) {
      try {
        await adapter.execute(
          `INSERT OR IGNORE INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, scope_target, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?)`,
          [
            crypto.randomUUID(),
            invitation.tenant_id,
            user_id,
            invitation.role_id,
            invitation.tenant_id,
            now,
            now,
          ]
        );
      } catch (assignErr) {
        log.warn('Failed to assign role from invitation', { error: String(assignErr) });
      }
    }

    if (invitation.org_id) {
      try {
        await adapter.execute(
          `INSERT OR IGNORE INTO org_memberships (id, tenant_id, user_id, org_id, membership_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', ?, ?)`,
          [crypto.randomUUID(), invitation.tenant_id, user_id, invitation.org_id, now, now]
        );
      } catch (assignErr) {
        log.warn('Failed to assign org from invitation', { error: String(assignErr) });
      }
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to use invitation', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
