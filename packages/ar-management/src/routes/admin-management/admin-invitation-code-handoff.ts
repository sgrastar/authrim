/**
 * The enrollment code handoff of an admin invitation: a trusted global machine principal (a
 * provisioning portal) creates the invitation for a tenant-scoped role and receives the code in
 * the API response, which nothing e-mails.
 *
 * It is available to nobody else. Every condition below must hold, and each is checked before
 * anything is written:
 * - the caller is a global machine token holding the exact permission
 *   `admin:admin_invitations:code_handoff` (no wildcard carries it, no built-in role has it);
 * - the platform switch `admin_invitations.code_handoff_enabled` is on (default off; unreadable
 *   counts as off), and it can only be turned on by a human with a step-up;
 * - the invitation is tenant-scoped, for a role that is not the super admin, not a platform role,
 *   not a wildcard role, and ranks below the super admin;
 * - no admin groups are named (their hierarchy checks stay out of the machine path);
 * - the code lives at most `HANDOFF_MAX_TTL_MINUTES`.
 *
 * The permission is the authorization for the role: the caller-outranks comparison (a machine has
 * level 0) and the `admin.role.grant` step-up are not applied in this mode, and not weakened in
 * any other.
 */
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  AdminRoleRepository,
  generateAdminInvitationCode,
  hashAdminInvitationCode,
  type DatabaseAdapter,
  ADMIN_INVITATIONS_CATEGORY,
  ADMIN_INVITATION_CODE_HANDOFF_KEY,
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  ADMIN_ROLE_DEFINITIONS,
  ADMIN_ROLE_GROUPS,
  hasGlobalMachinePermission,
  isExactMatchOnlyAdminPermission,
  resolvePlatformSettingsWithSources,
} from '@authrim/ar-lib-core';

import { ensureCrossTenantPlacement } from './cross-tenant-placement';
import { writeAdminAuditLog } from '../../admin-shared';

type HandoffContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

export type CodeDelivery = 'email' | 'response';

export const HANDOFF_DEFAULT_TTL_MINUTES = 15;
export const HANDOFF_MAX_TTL_MINUTES = 60;

const SUPER_ADMIN_LEVEL =
  ADMIN_ROLE_DEFINITIONS.find((definition) => definition.name === ADMIN_ROLES.SUPER_ADMIN)
    ?.hierarchyLevel ?? 100;

/** The delivery a request names: 'email' when absent; null for anything else (a 400). */
export function readCodeDelivery(value: unknown): CodeDelivery | null {
  if (value === undefined) return 'email';
  return value === 'email' || value === 'response' ? value : null;
}

/** Whether the caller is a global machine token holding the handoff permission. */
export function holdsCodeHandoffPermission(auth: AdminAuthContext | undefined): boolean {
  return hasGlobalMachinePermission(auth, ADMIN_PERMISSIONS.ADMIN_INVITATION_CODE_HANDOFF);
}

/**
 * Whether the platform switch is on, read without the per-isolate cache. Fails closed: a value
 * that is not exactly true, or settings that cannot be read, are off.
 */
export async function isCodeHandoffEnabled(env: Env): Promise<boolean> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(env, ADMIN_INVITATIONS_CATEGORY, {
      fresh: true,
    });
    return values[ADMIN_INVITATION_CODE_HANDOFF_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Whether a role may be handed out by handoff: tenant-level, below the super admin, and with no
 * wildcard and no exact-name-only permission (step-up exemptions, break-glass, last-resort
 * recovery, this handoff itself) among its EFFECTIVE permissions, inherited ones included, as
 * the repository resolves them for authentication. Fails closed: permissions that cannot be
 * resolved refuse.
 */
export async function roleAllowedForHandoff(
  roles: Pick<AdminRoleRepository, 'getEffectivePermissions'>,
  role: { id: string; name: string; hierarchy_level: number }
): Promise<boolean> {
  const platformRoles: readonly string[] = ADMIN_ROLE_GROUPS.platform;
  if (role.name === ADMIN_ROLES.SUPER_ADMIN || platformRoles.includes(role.name)) return false;
  if (!Number.isFinite(role.hierarchy_level)) return false;
  if (role.hierarchy_level < 0 || role.hierarchy_level >= SUPER_ADMIN_LEVEL) return false;
  let permissions: string[];
  try {
    permissions = await roles.getEffectivePermissions(role.id);
  } catch {
    return false;
  }
  if (!Array.isArray(permissions)) return false;
  return !permissions.some(
    (permission) =>
      permission === '*' || permission === 'admin:*' || isExactMatchOnlyAdminPermission(permission)
  );
}

/**
 * The lifetime of a handed-over code: `expires_in_minutes` (default 15, at most 60, whole
 * minutes). `expires_in_hours` is not accepted here. Returns milliseconds, or an error code.
 */
export function resolveHandoffTtlMs(body: {
  expires_in_minutes?: unknown;
  expires_in_hours?: unknown;
}): { ttlMs: number } | { error: 'invalid_expiry' } {
  if (body.expires_in_hours !== undefined) return { error: 'invalid_expiry' };
  const minutes =
    body.expires_in_minutes === undefined ? HANDOFF_DEFAULT_TTL_MINUTES : body.expires_in_minutes;
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > HANDOFF_MAX_TTL_MINUTES
  ) {
    return { error: 'invalid_expiry' };
  }
  return { ttlMs: minutes * 60 * 1000 };
}

/** Headers that keep a response carrying a code out of every cache. */
export const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const;

/**
 * The conditions of the handoff that do not depend on the role: the permission, the platform
 * switch and the lifetime. A refusal (status and error code), or the lifetime in milliseconds.
 */
export async function handoffPreconditionRefusal(
  env: Env,
  auth: AdminAuthContext | undefined,
  body: { expires_in_minutes?: unknown; expires_in_hours?: unknown }
): Promise<{ status: 400 | 403; error: string } | { ttlMs: number }> {
  if (!holdsCodeHandoffPermission(auth))
    return { status: 403, error: 'code_handoff_not_permitted' };
  if (!(await isCodeHandoffEnabled(env))) return { status: 403, error: 'code_handoff_disabled' };
  const ttl = resolveHandoffTtlMs(body);
  if ('error' in ttl) return { status: 400, error: ttl.error };
  return { ttlMs: ttl.ttlMs };
}

/**
 * A resend of an invitation whose code was handed over (or asked to be). The code is never
 * e-mailed: an invitation handed over stays a handoff one, and one made for an e-mailed code is
 * never turned into one (that would hand its code to a machine, not to the person invited). A
 * re-issue is allowed under the conditions of the create and returns the new code as it does.
 */
export async function resendByHandoff(input: {
  c: HandoffContext;
  auth: AdminAuthContext;
  adapter: DatabaseAdapter;
  tenantId: string;
  invitation: {
    id: string;
    email: string;
    code_hash: string;
    scope_type: 'global' | 'tenant';
    admin_role_id: string;
    code_delivery?: CodeDelivery;
  };
  body: { expires_in_minutes?: unknown; expires_in_hours?: unknown };
  requested: CodeDelivery;
}): Promise<Response> {
  const { c, auth, adapter, tenantId, invitation } = input;
  let ttlMs = 0;
  if (input.requested === 'response') {
    const refusal = await handoffPreconditionRefusal(c.env, auth, input.body);
    if ('error' in refusal) return c.json({ error: refusal.error }, refusal.status);
    ttlMs = refusal.ttlMs;
  }
  if (input.requested !== (invitation.code_delivery ?? 'email')) {
    return c.json(
      {
        error: 'code_delivery_mismatch',
        error_description:
          'An invitation keeps the way its code is delivered: a handed-over code is not e-mailed, and an e-mailed one is not handed over',
      },
      409
    );
  }
  if (invitation.scope_type !== 'tenant') return c.json({ error: 'invalid_scope' }, 400);
  const placementRefusal = ensureCrossTenantPlacement(c, c.env, {
    scopeType: invitation.scope_type,
    homeTenantId: tenantId,
  });
  if (placementRefusal) return placementRefusal;

  const role = await new AdminRoleRepository(adapter).getRole(invitation.admin_role_id);
  if (!role || (role.tenant_id !== tenantId && !(role.tenant_id === 'default' && role.is_system))) {
    return c.json({ error: 'role_not_found' }, 404);
  }
  if (!(await roleAllowedForHandoff(new AdminRoleRepository(adapter), role))) {
    return c.json({ error: 'code_handoff_role_not_allowed' }, 403);
  }
  const groups = await adapter.query<{ admin_group_id: string }>(
    'SELECT admin_group_id FROM admin_invitation_groups WHERE invitation_id = ? AND tenant_id = ? LIMIT 1',
    [invitation.id, tenantId]
  );
  if (groups.length > 0) return c.json({ error: 'code_handoff_groups_not_supported' }, 400);

  const code = generateAdminInvitationCode();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  // One batch: the new code replaces the old only while the invitation is still the pending,
  // handed-over one with the code that was read; the enrolment in progress is dropped with it.
  const [updated] = await adapter.batch([
    {
      sql: `UPDATE admin_invitations
               SET code_hash = ?, expires_at = ?, last_sent_at = ?,
                   last_delivery_status = 'sent', last_delivery_error = NULL, updated_at = ?
             WHERE id = ? AND tenant_id = ? AND status = 'pending' AND code_hash = ?
               AND code_delivery = 'response'`,
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
  await writeAdminAuditLog(c, {
    action: 'admin_invitation.resend',
    resourceType: 'admin_invitation',
    resourceId: invitation.id,
    result: 'success',
    severity: 'warn',
    metadata: { email_sent: false, code_delivery: 'response' },
  });
  return c.json(
    {
      success: true,
      expires_at: expiresAt,
      email_sent: false,
      code_delivery: 'response',
      code,
    },
    200,
    NO_STORE_HEADERS
  );
}
