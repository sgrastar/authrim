import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import { joinOrganization, type OrgJoinResult } from './org-domain-resolver';

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
  now: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const adapter = getAdapter(db);
  const result = await adapter.execute(
    `UPDATE tenant_invitations
     SET use_count = use_count + 1, updated_at = ?
     WHERE id = ? AND expires_at > ? AND (max_uses = -1 OR use_count < max_uses)`,
    [now, invitationId, now]
  );

  return result.rowsAffected > 0;
}

export async function assignTenantRoleToUser(
  db: DatabaseSource,
  userId: string,
  roleId: string,
  tenantId: string
): Promise<RoleAssignmentResult> {
  const adapter = getAdapter(db);
  const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  const roleCheck = await adapter.queryOne<{ id: string }>(
    'SELECT id FROM roles WHERE id = ? AND tenant_id = ?',
    [roleId, tenantId]
  );
  if (!roleCheck) {
    return {
      success: false,
      error: 'Role not found',
    };
  }

  const existing = await adapter.queryOne<{ id: string }>(
    `SELECT id FROM role_assignments
     WHERE user_id = ? AND role_id = ? AND scope_type = 'tenant' AND scope_target = ? AND tenant_id = ?`,
    [userId, roleId, tenantId, tenantId]
  );
  if (existing) {
    return {
      success: true,
      assignment_id: existing.id,
      error: 'Already assigned',
    };
  }

  await adapter.execute(
    `INSERT INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, scope_target, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?)`,
    [assignmentId, tenantId, userId, roleId, tenantId, now, now]
  );

  return {
    success: true,
    assignment_id: assignmentId,
  };
}

export async function applyInvitationAssignments(
  db: DatabaseSource,
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
    results.roleAssignment = await assignTenantRoleToUser(db, userId, roleId, tenantId);
  }

  if (orgId) {
    results.orgMembership = await joinOrganization(db, userId, orgId, tenantId, 'member');
  }

  return results;
}
