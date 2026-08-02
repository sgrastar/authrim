import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AdminRoleRepository,
  AdminUserRepository,
  generateAdminInvitationCode,
  generateId,
  produceNotificationDelivery,
  getTenantIdFromContext,
  hashAdminInvitationCode,
  hasAdminPermission,
  normalizeAdminInvitationIpRanges,
  requireDedicatedAdminDatabaseAdapter,
  adminAuthMiddleware,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EMAIL_LENGTH = 320;
const MAX_ADMIN_NAME_LENGTH = 200;
const MAX_IDENTIFIER_LENGTH = 256;

interface AdminInvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  code_hash: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  admin_role_id: string;
  role_name: string;
  role_display_name: string | null;
  scope_type: 'global' | 'tenant';
  scope_id: string | null;
  role_expires_at: number | null;
  ip_restriction_enabled: number;
  allowed_ip_ranges_json: string;
  expires_at: number;
  last_sent_at: number;
  last_delivery_status: 'pending' | 'sent' | 'failed';
  accepted_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export const adminInvitationsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

type AdminInvitationContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

adminInvitationsRouter.use(
  '*',
  adminAuthMiddleware({ requirePermissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ] })
);

function getAdapter(c: AdminInvitationContext) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-invitations');
}

function hasInvitationWritePermission(auth: AdminAuthContext): boolean {
  const permissions = auth.permissions ?? [];
  return (
    hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_USERS_WRITE) &&
    hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE)
  );
}

function formatInvitation(row: AdminInvitationRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    email: row.email,
    name: row.name,
    status: row.status,
    role: {
      id: row.admin_role_id,
      name: row.role_name,
      display_name: row.role_display_name,
    },
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    role_expires_at: row.role_expires_at,
    ip_restriction_enabled: Boolean(row.ip_restriction_enabled),
    allowed_ip_ranges: parseRanges(row.allowed_ip_ranges_json),
    expires_at: row.expires_at,
    last_sent_at: row.last_sent_at,
    last_delivery_status: row.last_delivery_status,
    accepted_at: row.accepted_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseRanges(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

function resolveJoinUrl(env: Env): string | null {
  if (!env.ADMIN_UI_URL) return null;
  try {
    const url = new URL(env.ADMIN_UI_URL);
    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
      return null;
    }
    return new URL('/admin/join', url.origin).href;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return replacements[character];
  });
}

function invitationEmail(input: {
  code: string;
  joinUrl: string;
  roleName: string;
  expiresAt: number;
}) {
  const expiresAt = new Date(input.expiresAt).toISOString();
  const text = `You have been invited to administer Authrim.

Open the official Authrim Admin site yourself and enter this one-time enrollment code:
${input.joinUrl}

Enrollment code: ${input.code}
Role: ${input.roleName}
Expires: ${expiresAt}

This code can only bootstrap Passkey registration. Authrim will ask you to authenticate with the newly registered Passkey before activating the administrator account. Do not share this code.`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2>Authrim administrator invitation</h2>
  <p>Open the official Authrim Admin site yourself and enter this one-time enrollment code.</p>
  <p><strong>Official address:</strong><br><code>${escapeHtml(input.joinUrl)}</code></p>
  <p style="font-size:24px;letter-spacing:0.12em"><strong>${escapeHtml(input.code)}</strong></p>
  <p><strong>Role:</strong> ${escapeHtml(input.roleName)}<br><strong>Expires:</strong> ${escapeHtml(expiresAt)}</p>
  <p>This code can only bootstrap Passkey registration. Authrim will ask you to authenticate with the newly registered Passkey before activating the administrator account.</p>
  <p style="color:#666">Do not share this code. If you did not expect this invitation, ignore this email.</p>
</body></html>`;

  return { text, html };
}

async function sendInvitationEmail(
  c: AdminInvitationContext,
  input: {
    deliveryId: string;
    email: string;
    code: string;
    roleName: string;
    expiresAt: number;
  }
): Promise<{ success: boolean; error?: string }> {
  const joinUrl = resolveJoinUrl(c.env);
  if (!joinUrl) return { success: false, error: 'ADMIN_UI_URL is not configured as a safe origin' };

  try {
    const content = invitationEmail({
      code: input.code,
      joinUrl,
      roleName: input.roleName,
      expiresAt: input.expiresAt,
    });
    const delivery = await produceNotificationDelivery(c.env, {
      owner: { owner: 'tenant', tenantId: getTenantIdFromContext(c) },
      intentId: `admin-invitation:${input.deliveryId}`,
      outboxId: `notification:${input.deliveryId}`,
      notificationKind: 'admin.admin-invitation',
      idempotencyKey: `admin-invitation:${input.deliveryId}`,
      expiresAt: Math.floor(input.expiresAt / 1000),
      payload: {
        channel: 'email',
        to: input.email,
        from: c.env.EMAIL_FROM || 'noreply@authrim.dev',
        subject: 'Authrim administrator invitation',
        body: content.html,
        metadata: { textBody: content.text },
      },
    });
    return delivery.delivery !== 'permanent_failure'
      ? { success: true }
      : { success: false, error: 'Email delivery provider rejected the message' };
  } catch {
    return { success: false, error: 'Email delivery provider failed' };
  }
}

adminInvitationsRouter.get('/', async (c) => {
  const adapter = getAdapter(c);
  const tenantId = getTenantIdFromContext(c);
  const includeCompleted = c.req.query('include_completed') === 'true';
  const now = Date.now();
  const rows = await adapter.query<AdminInvitationRow>(
    `SELECT i.*,
            CASE WHEN i.status = 'pending' AND i.expires_at <= ?
                 THEN 'expired' ELSE i.status END AS status,
            i.admin_role_name AS role_name,
            i.admin_role_display_name AS role_display_name
       FROM admin_invitations i
      WHERE i.tenant_id = ? ${includeCompleted ? '' : "AND i.status = 'pending' AND i.expires_at > ?"}
      ORDER BY i.created_at DESC
      LIMIT 100`,
    includeCompleted ? [now, tenantId] : [now, tenantId, now]
  );
  return c.json({ items: rows.map(formatInvitation), total: rows.length });
});

adminInvitationsRouter.post('/', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  if (!hasInvitationWritePermission(auth)) {
    return c.json({ error: 'insufficient_permissions' }, 403);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const roleId = typeof body.role_id === 'string' ? body.role_id.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : null;
  const requestedScopeType = body.scope_type;
  const requestedScopeId = typeof body.scope_id === 'string' ? body.scope_id.trim() : null;
  const roleExpiresAt = body.role_expires_at;
  const expiresInHours = body.expires_in_hours;
  const restrictionRequested = body.ip_restriction_enabled;
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    !/^\S+@\S+\.\S+$/.test(email) ||
    !roleId ||
    roleId.length > MAX_IDENTIFIER_LENGTH ||
    (body.name !== undefined && body.name !== null && typeof body.name !== 'string') ||
    (name !== null && name.length > MAX_ADMIN_NAME_LENGTH) ||
    (requestedScopeType !== undefined &&
      requestedScopeType !== 'global' &&
      requestedScopeType !== 'tenant') ||
    (body.scope_id !== undefined && body.scope_id !== null && typeof body.scope_id !== 'string') ||
    (requestedScopeId !== null && requestedScopeId.length > MAX_IDENTIFIER_LENGTH) ||
    (roleExpiresAt !== undefined && typeof roleExpiresAt !== 'number') ||
    (expiresInHours !== undefined && typeof expiresInHours !== 'number') ||
    (restrictionRequested !== undefined && typeof restrictionRequested !== 'boolean')
  ) {
    return c.json(
      { error: 'invalid_request', error_description: 'email and role_id are required' },
      400
    );
  }

  const adapter = getAdapter(c);
  const tenantId = getTenantIdFromContext(c);
  const now = Date.now();
  const userRepo = new AdminUserRepository(adapter);
  if (await userRepo.findByEmail(tenantId, email)) {
    return c.json(
      { error: 'admin_exists', error_description: 'An Admin already uses this email' },
      409
    );
  }
  const role = await new AdminRoleRepository(adapter).getRole(roleId);
  if (!role || (role.tenant_id !== tenantId && !(role.tenant_id === 'default' && role.is_system))) {
    return c.json({ error: 'role_not_found' }, 404);
  }
  const wildcardAuthority = hasAdminPermission(auth.permissions ?? [], '*');
  const invitingPeerSuperAdmin = role.name === 'super_admin' && wildcardAuthority;
  if (
    auth.hierarchyLevel !== undefined &&
    role.hierarchy_level >= auth.hierarchyLevel &&
    !invitingPeerSuperAdmin
  ) {
    return c.json({ error: 'insufficient_permissions' }, 403);
  }

  const scopeType = requestedScopeType ?? (role.name === 'super_admin' ? 'global' : 'tenant');
  const scopeId = scopeType === 'tenant' ? requestedScopeId || tenantId : null;
  if (
    (role.name === 'super_admin' && scopeType !== 'global') ||
    (scopeType === 'global' && !wildcardAuthority) ||
    (scopeType === 'tenant' && scopeId !== tenantId)
  ) {
    return c.json({ error: 'invalid_scope' }, 400);
  }
  if (roleExpiresAt !== undefined && (!Number.isFinite(roleExpiresAt) || roleExpiresAt <= now)) {
    return c.json({ error: 'invalid_role_expiry' }, 400);
  }

  const restrictionEnabled = restrictionRequested === true;
  const rangeValidation = normalizeAdminInvitationIpRanges(body.allowed_ip_ranges ?? []);
  if (!rangeValidation.valid || (restrictionEnabled && rangeValidation.ranges.length === 0)) {
    return c.json(
      {
        error: 'invalid_ip_ranges',
        error_description: rangeValidation.error ?? 'At least one IP range is required',
      },
      400
    );
  }
  const allowedIpRanges = restrictionEnabled ? rangeValidation.ranges : [];

  const requestedTtl = (expiresInHours ?? 24) * 60 * 60 * 1000;
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0 || requestedTtl > MAX_INVITATION_TTL_MS) {
    return c.json({ error: 'invalid_expiry' }, 400);
  }

  await adapter.execute(
    `UPDATE admin_invitations
        SET status = 'expired', pending_email_key = NULL, updated_at = ?
      WHERE tenant_id = ? AND email = ? AND status = 'pending' AND expires_at <= ?`,
    [now, tenantId, email, now]
  );
  const pending = await adapter.queryOne<{ id: string }>(
    "SELECT id FROM admin_invitations WHERE tenant_id = ? AND email = ? AND status = 'pending' LIMIT 1",
    [tenantId, email]
  );
  if (pending) {
    return c.json(
      { error: 'invitation_exists', error_description: 'A pending invitation already exists' },
      409
    );
  }

  const code = generateAdminInvitationCode();
  const codeHash = await hashAdminInvitationCode(code);
  const expiresAt = now + (requestedTtl || DEFAULT_INVITATION_TTL_MS);
  const invitationId = generateId();
  const adminUserId = generateId();

  try {
    await adapter.execute(
      `INSERT INTO admin_invitations (
         id, tenant_id, admin_user_id, email, name, code_hash, status, admin_role_id,
         scope_type, scope_id, role_expires_at, ip_restriction_enabled,
         allowed_ip_ranges_json, expires_at, last_sent_at,
         last_delivery_status, created_by, created_at, updated_at, pending_email_key,
         admin_role_name, admin_role_display_name
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        invitationId,
        tenantId,
        adminUserId,
        email,
        name || null,
        codeHash,
        role.id,
        scopeType,
        scopeId,
        roleExpiresAt ?? null,
        restrictionEnabled ? 1 : 0,
        JSON.stringify(allowedIpRanges),
        expiresAt,
        now,
        auth.userId,
        now,
        now,
        email,
        role.name,
        role.display_name,
      ]
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json(
        { error: 'invitation_exists', error_description: 'A pending invitation already exists' },
        409
      );
    }
    throw error;
  }

  const delivery = await sendInvitationEmail(c, {
    deliveryId: invitationId,
    email,
    code,
    roleName: role.display_name || role.name,
    expiresAt,
  });
  await adapter.execute(
    "UPDATE admin_invitations SET last_delivery_status = ?, last_delivery_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    [
      delivery.success ? 'sent' : 'failed',
      delivery.error?.slice(0, 500) ?? null,
      Date.now(),
      invitationId,
    ]
  );
  await writeAdminAuditLog(c, {
    action: 'admin_invitation.create',
    resourceType: 'admin_invitation',
    resourceId: invitationId,
    result: delivery.success ? 'success' : 'failure',
    severity: 'critical',
    metadata: {
      invited_email: email,
      role_id: role.id,
      scope_type: scopeType,
      ip_restriction_enabled: restrictionEnabled,
      allowed_ip_ranges: allowedIpRanges,
      email_sent: delivery.success,
    },
  });

  if (!delivery.success) {
    return c.json(
      {
        error: 'email_delivery_failed',
        error_description: delivery.error,
        invitation_id: invitationId,
      },
      502
    );
  }
  return c.json({ id: invitationId, email, expires_at: expiresAt, email_sent: true }, 201);
});

adminInvitationsRouter.post('/:id/resend', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  if (!hasInvitationWritePermission(auth))
    return c.json({ error: 'insufficient_permissions' }, 403);

  const adapter = getAdapter(c);
  const tenantId = getTenantIdFromContext(c);
  const invitation = await adapter.queryOne<AdminInvitationRow>(
    `SELECT i.*, i.admin_role_name AS role_name,
            i.admin_role_display_name AS role_display_name
       FROM admin_invitations i
      WHERE i.id = ? AND i.tenant_id = ? AND i.status = 'pending'`,
    [c.req.param('id'), tenantId]
  );
  if (!invitation) return c.json({ error: 'invitation_not_found' }, 404);

  const code = generateAdminInvitationCode();
  const now = Date.now();
  const expiresAt = now + DEFAULT_INVITATION_TTL_MS;
  const [updated] = await adapter.batch([
    {
      sql: `UPDATE admin_invitations
               SET code_hash = ?, expires_at = ?, last_sent_at = ?,
                   last_delivery_status = 'pending', last_delivery_error = NULL, updated_at = ?
             WHERE id = ? AND tenant_id = ? AND status = 'pending' AND code_hash = ?`,
      params: [
        await hashAdminInvitationCode(code),
        expiresAt,
        now,
        now,
        invitation.id,
        tenantId,
        invitation.code_hash,
      ],
    },
    {
      sql: 'DELETE FROM admin_invitation_enrollments WHERE invitation_id = ?',
      params: [invitation.id],
    },
  ]);
  if (!updated || updated.rowsAffected !== 1) {
    return c.json({ error: 'invitation_resend_conflict' }, 409);
  }
  const delivery = await sendInvitationEmail(c, {
    deliveryId: `${invitation.id}:${now}`,
    email: invitation.email,
    code,
    roleName: invitation.role_display_name || invitation.role_name,
    expiresAt,
  });
  await adapter.execute(
    "UPDATE admin_invitations SET last_delivery_status = ?, last_delivery_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    [
      delivery.success ? 'sent' : 'failed',
      delivery.error?.slice(0, 500) ?? null,
      Date.now(),
      invitation.id,
    ]
  );
  await writeAdminAuditLog(c, {
    action: 'admin_invitation.resend',
    resourceType: 'admin_invitation',
    resourceId: invitation.id,
    result: delivery.success ? 'success' : 'failure',
    severity: 'warn',
    metadata: { email_sent: delivery.success },
  });
  if (!delivery.success) {
    return c.json({ error: 'email_delivery_failed', error_description: delivery.error }, 502);
  }
  return c.json({ success: true, expires_at: expiresAt });
});

adminInvitationsRouter.delete('/:id', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  if (!hasInvitationWritePermission(auth))
    return c.json({ error: 'insufficient_permissions' }, 403);

  const adapter = getAdapter(c);
  const tenantId = getTenantIdFromContext(c);
  const result = await adapter.execute(
    "UPDATE admin_invitations SET status = 'revoked', pending_email_key = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
    [Date.now(), c.req.param('id'), tenantId]
  );
  if (result.rowsAffected === 0) return c.json({ error: 'invitation_not_found' }, 404);
  await writeAdminAuditLog(c, {
    action: 'admin_invitation.revoke',
    resourceType: 'admin_invitation',
    resourceId: c.req.param('id'),
    result: 'success',
    severity: 'critical',
  });
  return c.json({ success: true });
});
