import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import { joinOrganization, type OrgJoinResult } from './org-domain-resolver';
import { findTenantRole, type TenantRBACDatabases } from './tenant-rbac';

export interface TenantInvitationRecord {
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

export interface RoleAssignmentResult {
  success: boolean;
  assignment_id?: string;
  error?: string;
}

export interface InvitationAssignmentResults {
  roleAssignment?: RoleAssignmentResult;
  orgMembership?: OrgJoinResult;
}

function getAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'invitation-core');
}

export function hasRemainingInvitationUses(invitation: TenantInvitationRecord): boolean {
  return invitation.max_uses === -1 || invitation.use_count < invitation.max_uses;
}

export async function findActiveInvitationByToken(
  db: DatabaseSource,
  token: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<TenantInvitationRecord | null> {
  const adapter = getAdapter(db);

  return adapter.queryOne<TenantInvitationRecord>(
    `SELECT id, token, tenant_id, invited_email, role_id, org_id, max_uses, use_count, expires_at
     FROM tenant_invitations
     WHERE token = ? AND expires_at > ?`,
    [token, now]
  );
}

export async function consumeInvitationUse(
  db: DatabaseSource,
  invitationId: string,
  tenantId: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const adapter = getAdapter(db);
  const result = await adapter.execute(
    `UPDATE tenant_invitations
     SET use_count = use_count + 1, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND expires_at > ? AND (max_uses = -1 OR use_count < max_uses)`,
    [now, invitationId, tenantId, now]
  );

  return result.rowsAffected > 0;
}

export type InvitationEmailVerificationPolicy = 'optional' | 'required';

/** The tenant's rule for an invitation that names an email, from its `authentication-methods`. */
export function invitationEmailVerificationPolicy(
  authenticationMethods: Record<string, unknown>
): InvitationEmailVerificationPolicy {
  return authenticationMethods['authentication-methods.invitation.email_verification'] ===
    'required'
    ? 'required'
    : 'optional';
}

/** How long a sign-up holds a reserved use before it is released (seconds). */
export const INVITATION_RESERVATION_TTL_SECONDS = 60 * 60;

export type InvitationReservationResult =
  | {
      /** `reserved`: this call took a use. `held`: the holder already had one (a restart). */
      status: 'reserved' | 'held';
      reservationId: string;
    }
  | { status: 'unavailable' };

/**
 * Names the sign-up that holds a use. A sign-up that gives an email is named by it, so the same
 * person restarting (a resent code, a new start after closing the passkey prompt) keeps the one
 * use; the email is hashed so the table holds no address.
 */
export async function invitationHolderForEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(email.trim().toLowerCase())
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `email:${hex.join('')}`;
}

/**
 * Returns the uses of reservations that expired unapplied to the invitation, in one atomic batch
 * (the count and the deletion cannot part).
 */
export async function releaseExpiredInvitationReservations(
  db: DatabaseSource,
  invitationId: string,
  tenantId: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> {
  const adapter = getAdapter(db);
  const expired = `FROM tenant_invitation_redemptions
     WHERE tenant_id = ? AND invitation_id = ? AND status = 'reserved' AND expires_at <= ?`;
  await adapter.batch([
    {
      sql: `UPDATE tenant_invitations
       SET use_count = MAX(0, use_count - (SELECT COUNT(*) ${expired})), updated_at = ?
       WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 ${expired})`,
      params: [
        tenantId,
        invitationId,
        now,
        now,
        invitationId,
        tenantId,
        tenantId,
        invitationId,
        now,
      ],
    },
    { sql: `DELETE ${expired}`, params: [tenantId, invitationId, now] },
  ]);
}

/**
 * Reserves one use of an invitation for a sign-up when it starts. The reservation and the count
 * are written in one atomic batch, and only while the invitation is active with a use left, so
 * concurrent sign-ups cannot take more uses than it has. The use is counted only while the new
 * row is still 'pending' inside that batch, so a batch the adapter replays after it committed
 * counts nothing again. A holder that already has a use keeps it (and its expiry moves on)
 * instead of taking another.
 */
export async function reserveInvitationUse(
  db: DatabaseSource,
  input: {
    invitationId: string;
    tenantId: string;
    holder: string;
    now?: number;
    ttlSeconds?: number;
  }
): Promise<InvitationReservationResult> {
  const adapter = getAdapter(db);
  const { invitationId, tenantId, holder } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + (input.ttlSeconds ?? INVITATION_RESERVATION_TTL_SECONDS);
  await releaseExpiredInvitationReservations(adapter, invitationId, tenantId, now);

  const reservationId = `inr_${crypto.randomUUID().replace(/-/g, '')}`;
  const [inserted] = await adapter.batch([
    {
      sql: `INSERT INTO tenant_invitation_redemptions
         (id, tenant_id, invitation_id, holder, status, user_id, expires_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'pending', NULL, ?, ?, ?
       WHERE NOT EXISTS (
           SELECT 1 FROM tenant_invitation_redemptions
           WHERE tenant_id = ? AND invitation_id = ? AND holder = ?)
         AND EXISTS (
           SELECT 1 FROM tenant_invitations
           WHERE id = ? AND tenant_id = ? AND expires_at > ? AND (max_uses = -1 OR use_count < max_uses))`,
      params: [
        reservationId,
        tenantId,
        invitationId,
        holder,
        expiresAt,
        now,
        now,
        tenantId,
        invitationId,
        holder,
        invitationId,
        tenantId,
        now,
      ],
    },
    {
      sql: `UPDATE tenant_invitations SET use_count = use_count + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND EXISTS (
         SELECT 1 FROM tenant_invitation_redemptions
         WHERE id = ? AND tenant_id = ? AND status = 'pending')`,
      params: [now, invitationId, tenantId, reservationId, tenantId],
    },
    {
      sql: `UPDATE tenant_invitation_redemptions SET status = 'reserved'
       WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      params: [reservationId, tenantId],
    },
  ]);
  if ((inserted?.rowsAffected ?? 0) > 0) {
    return { status: 'reserved', reservationId };
  }

  const held = await adapter.queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM tenant_invitation_redemptions
     WHERE tenant_id = ? AND invitation_id = ? AND holder = ?`,
    [tenantId, invitationId, holder]
  );
  if (!held) return { status: 'unavailable' };
  if (held.status === 'reserved') {
    await adapter.execute(
      `UPDATE tenant_invitation_redemptions SET expires_at = MAX(expires_at, ?), updated_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'reserved'`,
      [expiresAt, now, held.id, tenantId]
    );
  }
  return { status: 'held', reservationId: held.id };
}

export interface InvitationReservationRecord {
  id: string;
  status: 'pending' | 'reserved' | 'applied';
  user_id: string | null;
  expires_at: number;
}

/** The use a sign-up holds of an invitation, if it holds one (read only: reserves nothing). */
export async function findInvitationReservation(
  db: DatabaseSource,
  input: { invitationId: string; tenantId: string; holder: string }
): Promise<InvitationReservationRecord | null> {
  const adapter = getAdapter(db);
  return adapter.queryOne<InvitationReservationRecord>(
    `SELECT id, status, user_id, expires_at FROM tenant_invitation_redemptions
     WHERE tenant_id = ? AND invitation_id = ? AND holder = ?`,
    [input.tenantId, input.invitationId, input.holder]
  );
}

/**
 * Binds a reserved use to the account its sign-up has just created, so it can only ever be
 * applied to that account. True when it is now bound to `userId` (also when it already was).
 */
export async function bindInvitationReservation(
  db: DatabaseSource,
  input: { reservationId: string; invitationId: string; tenantId: string; userId: string }
): Promise<boolean> {
  const adapter = getAdapter(db);
  const result = await adapter.execute(
    `UPDATE tenant_invitation_redemptions SET user_id = ?
     WHERE id = ? AND tenant_id = ? AND invitation_id = ? AND status = 'reserved'
       AND (user_id IS NULL OR user_id = ?)`,
    [input.userId, input.reservationId, input.tenantId, input.invitationId, input.userId]
  );
  return result.rowsAffected > 0;
}

/**
 * Whether the invitation has a use left once reservations that expired unapplied are counted as
 * returned (read only, for public reads such as validation and discovery: the uses themselves
 * are returned by the next reservation).
 */
export async function invitationHasUsesLeft(
  db: DatabaseSource,
  invitation: TenantInvitationRecord,
  now: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (hasRemainingInvitationUses(invitation)) return true;
  const adapter = getAdapter(db);
  const expired = await adapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM tenant_invitation_redemptions
     WHERE tenant_id = ? AND invitation_id = ? AND status = 'reserved' AND expires_at <= ?`,
    [invitation.tenant_id, invitation.id, now]
  );
  return invitation.use_count - Number(expired?.count ?? 0) < invitation.max_uses;
}

/**
 * Marks a reserved use as applied to the account its sign-up created. True when the reservation
 * is now applied to `userId` (also when it already was); false when it is gone (released after
 * expiring, or its invitation was deleted), or is bound or applied to another account.
 */
export async function claimInvitationReservation(
  db: DatabaseSource,
  input: {
    reservationId: string;
    invitationId: string;
    tenantId: string;
    userId: string;
    now?: number;
  }
): Promise<boolean> {
  const adapter = getAdapter(db);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const result = await adapter.execute(
    `UPDATE tenant_invitation_redemptions SET status = 'applied', user_id = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND invitation_id = ?
       AND ((status = 'reserved' AND (user_id IS NULL OR user_id = ?))
         OR (status = 'applied' AND user_id = ?))`,
    [
      input.userId,
      now,
      input.reservationId,
      input.tenantId,
      input.invitationId,
      input.userId,
      input.userId,
    ]
  );
  return result.rowsAffected > 0;
}

/**
 * Gives a reserved use back to the invitation (a sign-up that ended up signing in an existing
 * account instead). Atomic like the reservation; an applied use is never given back.
 */
export async function releaseInvitationReservation(
  db: DatabaseSource,
  input: { reservationId: string; invitationId: string; tenantId: string; now?: number }
): Promise<void> {
  const adapter = getAdapter(db);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const { reservationId, invitationId, tenantId } = input;
  await adapter.batch([
    {
      sql: `UPDATE tenant_invitations SET use_count = MAX(0, use_count - 1), updated_at = ?
       WHERE id = ? AND tenant_id = ? AND EXISTS (
         SELECT 1 FROM tenant_invitation_redemptions
         WHERE id = ? AND tenant_id = ? AND invitation_id = ? AND status = 'reserved')`,
      params: [now, invitationId, tenantId, reservationId, tenantId, invitationId],
    },
    {
      sql: `DELETE FROM tenant_invitation_redemptions
       WHERE id = ? AND tenant_id = ? AND invitation_id = ? AND status = 'reserved'`,
      params: [reservationId, tenantId, invitationId],
    },
  ]);
}

/** Looks an invitation up by id, active or not (a reserved use outlives the invitation's expiry). */
export async function findInvitationById(
  db: DatabaseSource,
  invitationId: string,
  tenantId: string
): Promise<TenantInvitationRecord | null> {
  const adapter = getAdapter(db);
  return adapter.queryOne<TenantInvitationRecord>(
    `SELECT id, token, tenant_id, invited_email, role_id, org_id, max_uses, use_count, expires_at
     FROM tenant_invitations
     WHERE id = ? AND tenant_id = ?`,
    [invitationId, tenantId]
  );
}

/**
 * Gives the user a tenant-wide role of its tenant. The role is a tenant setting (metadata
 * database); the assignment is the user's account data (account database).
 */
export async function assignTenantRoleToUser(
  dbs: TenantRBACDatabases,
  userId: string,
  roleId: string,
  tenantId: string
): Promise<RoleAssignmentResult> {
  const adapter = getAdapter(dbs.account);
  const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  const roleCheck = await findTenantRole(dbs.metadata, tenantId, { id: roleId });
  if (!roleCheck) {
    return {
      success: false,
      error: 'Role not found',
    };
  }

  const existing = await adapter.queryOne<{ id: string }>(
    `SELECT id FROM role_assignments
     WHERE tenant_id = ? AND subject_id = ? AND role_id = ? AND scope_type = 'global' AND scope_target = ''`,
    [tenantId, userId, roleId]
  );
  if (existing) {
    return {
      success: true,
      assignment_id: existing.id,
      error: 'Already assigned',
    };
  }

  await adapter.execute(
    `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope_type, scope_target, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'global', '', ?, ?)`,
    [assignmentId, tenantId, userId, roleId, now, now]
  );

  return {
    success: true,
    assignment_id: assignmentId,
  };
}

/** Gives the user the role and organisation an invitation names (either may be absent). */
export async function applyInvitationAssignments(
  dbs: TenantRBACDatabases,
  params: {
    userId: string;
    tenantId: string;
    roleId?: string | null;
    orgId?: string | null;
  }
): Promise<InvitationAssignmentResults> {
  const { userId, tenantId, roleId, orgId } = params;
  const results: InvitationAssignmentResults = {};

  if (roleId) {
    results.roleAssignment = await assignTenantRoleToUser(dbs, userId, roleId, tenantId);
  }

  if (orgId) {
    results.orgMembership = await joinOrganization(dbs, userId, orgId, tenantId, 'member');
  }

  return results;
}
