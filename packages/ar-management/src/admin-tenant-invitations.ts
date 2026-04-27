/**
 * Admin Tenant Invitations API Endpoints
 *
 * Token-based invitation flow for tenant-specific signup routing.
 *
 * - POST   /api/admin/tenants/:id/invitations          - Create invitation
 * - GET    /api/admin/tenants/:id/invitations          - List invitations
 * - DELETE /api/admin/tenants/:id/invitations/:inv_id  - Cancel invitation
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  createErrorResponse,
  AR_ERROR_CODES,
  createAuditLogFromContext,
  getLogger,
  getPluginContext,
} from '@authrim/ar-lib-core';
import { z } from 'zod';
import { ensureSupportedTenantId } from './single-tenant-guard';
import { getCanonicalTenantBaseUrl } from './request-issuer';

// =============================================================================
// Constants
// =============================================================================

/** Default invitation expiry: 72 hours */
const DEFAULT_EXPIRES_IN_HOURS = 72;
const MAX_EXPIRES_IN_HOURS = 720; // 30 days

// =============================================================================
// Types
// =============================================================================

interface TenantInvitationRow {
  id: string;
  token: string;
  tenant_id: string;
  invited_email: string | null;
  invited_by: string;
  role_id: string | null;
  org_id: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Validation
// =============================================================================

const CreateInvitationSchema = z.object({
  invited_email: z.string().email().optional().nullable(),
  role_id: z.string().min(1).max(63).optional().nullable(),
  org_id: z.string().min(1).max(63).optional().nullable(),
  max_uses: z.number().int().min(-1).max(1000).optional().default(1),
  expires_in_hours: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXPIRES_IN_HOURS)
    .optional()
    .default(DEFAULT_EXPIRES_IN_HOURS),
});

// =============================================================================
// Helpers
// =============================================================================

/** Generate a 256-bit entropy token (two UUIDs concatenated, hyphens removed) */
function generateInvitationToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function formatInvitation(row: TenantInvitationRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    invited_email: row.invited_email,
    invited_by: row.invited_by,
    role_id: row.role_id,
    org_id: row.org_id,
    max_uses: row.max_uses,
    use_count: row.use_count,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // token is intentionally omitted from list responses
  };
}

function getAdminUserId(c: Context<{ Bindings: Env }>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).get('adminAuth')?.adminId ?? 'unknown';
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/tenants/:id/invitations
 * Create a new invitation for the tenant
 */
export async function createTenantInvitationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-TENANT-INVITATIONS');
  const tenantId = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, tenantId);
  if (blocked) {
    return blocked;
  }

  try {
    const body = await c.req.json();
    const parsed = CreateInvitationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const { invited_email, role_id, org_id, max_uses, expires_in_hours } = parsed.data;

    // Verify tenant exists
    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const tenant = await adapter.queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE id = ?',
      [tenantId]
    );
    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + expires_in_hours * 3600;
    const invitationId = crypto.randomUUID();
    const token = generateInvitationToken();
    const adminId = getAdminUserId(c);

    await adapter.execute(
      `INSERT INTO tenant_invitations
        (id, token, tenant_id, invited_email, invited_by, role_id, org_id, max_uses, use_count, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        invitationId,
        token,
        tenantId,
        invited_email ?? null,
        adminId,
        role_id ?? null,
        org_id ?? null,
        max_uses,
        expiresAt,
        now,
        now,
      ]
    );

    const inviteUrl = `${getCanonicalTenantBaseUrl(c.env, tenantId)}/discover?invite_token=${token}`;

    // Conditionally send email if invited_email is specified and email plugin is available
    let emailSent = false;
    if (invited_email) {
      const pluginCtx = getPluginContext(c);
      const emailNotifier = pluginCtx.registry.getNotifier('email');

      if (emailNotifier) {
        const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';
        const emailResult = await emailNotifier.send({
          channel: 'email',
          to: invited_email,
          from: fromEmail,
          subject: `You've been invited to ${tenant.name}`,
          body: getInvitationEmailHtml({
            tenantName: tenant.name,
            inviteUrl,
            expiresInHours: expires_in_hours,
          }),
          metadata: {
            textBody: getInvitationEmailText({
              tenantName: tenant.name,
              inviteUrl,
              expiresInHours: expires_in_hours,
            }),
          },
        });

        if (emailResult.success) {
          emailSent = true;
        } else {
          log.warn('Failed to send invitation email', { error: emailResult.error });
        }
      } else {
        log.warn('Email notifier not configured, invitation URL returned without sending email', {
          tenant_id: tenantId,
          invited_email,
        });
      }
    }

    await createAuditLogFromContext(
      c,
      'tenant_invitation.create',
      'tenant_invitation',
      invitationId,
      { tenant_id: tenantId, invited_email, role_id, org_id, email_sent: emailSent }
    );

    return c.json(
      {
        id: invitationId,
        invite_url: inviteUrl,
        token,
        expires_at: expiresAt,
        email_sent: emailSent,
      },
      201
    );
  } catch (error) {
    log.error('Failed to create tenant invitation', { tenant_id: tenantId, error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/tenants/:id/invitations
 * List invitations for the tenant
 */
export async function listTenantInvitationsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-TENANT-INVITATIONS');
  const tenantId = c.req.param('id')!;
  const blocked = await ensureSupportedTenantId(c, tenantId);
  if (blocked) {
    return blocked;
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const includeExpired = c.req.query('include_expired') === 'true';

  try {
    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;

    // Verify tenant exists
    const tenant = await adapter.queryOne<{ id: string }>('SELECT id FROM tenants WHERE id = ?', [
      tenantId,
    ]);
    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiryFilter = includeExpired ? '' : ` AND expires_at > ${now}`;

    const total = await adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM tenant_invitations WHERE tenant_id = ?${expiryFilter}`,
      [tenantId]
    );

    const rows = await adapter.query<TenantInvitationRow>(
      `SELECT * FROM tenant_invitations WHERE tenant_id = ?${expiryFilter}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [tenantId, limit, offset]
    );

    return c.json({
      items: rows.map(formatInvitation),
      total: total?.count ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    log.error('Failed to list tenant invitations', { tenant_id: tenantId, error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/tenants/:id/invitations/:inv_id
 * Cancel (delete) an invitation
 */
export async function cancelTenantInvitationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-TENANT-INVITATIONS');
  const tenantId = c.req.param('id')!;
  const invId = c.req.param('inv_id')!;
  const blocked = await ensureSupportedTenantId(c, tenantId);
  if (blocked) {
    return blocked;
  }

  try {
    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;

    const invitation = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM tenant_invitations WHERE id = ? AND tenant_id = ?',
      [invId, tenantId]
    );
    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await adapter.execute('DELETE FROM tenant_invitations WHERE id = ?', [invId]);

    await createAuditLogFromContext(c, 'tenant_invitation.cancel', 'tenant_invitation', invId, {
      tenant_id: tenantId,
    });

    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to cancel tenant invitation', {
      tenant_id: tenantId,
      inv_id: invId,
      error: String(error),
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Email Templates
// =============================================================================

interface InvitationEmailParams {
  tenantName: string;
  inviteUrl: string;
  expiresInHours: number;
}

function getInvitationEmailHtml(params: InvitationEmailParams): string {
  const { tenantName, inviteUrl, expiresInHours } = params;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>You've been invited to ${tenantName}</h2>
  <p>Click the link below to accept your invitation and create your account:</p>
  <p><a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">Accept Invitation</a></p>
  <p style="color:#666;font-size:14px;">This invitation link expires in ${expiresInHours} hours.</p>
  <p style="color:#999;font-size:12px;">If you did not expect this invitation, you can safely ignore this email.</p>
</body>
</html>`;
}

function getInvitationEmailText(params: InvitationEmailParams): string {
  const { tenantName, inviteUrl, expiresInHours } = params;
  return `You've been invited to ${tenantName}

Accept your invitation and create your account:
${inviteUrl}

This invitation link expires in ${expiresInHours} hours.

If you did not expect this invitation, you can safely ignore this email.`;
}
