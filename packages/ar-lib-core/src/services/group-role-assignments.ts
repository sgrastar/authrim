import type { KVNamespace } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseSource, type TransactionContext } from '../db';
import { bumpTenantRBACCacheVersion } from '../utils/rbac-cache';
import { rbacIdBatches } from './group-membership';
import type { SubjectRoleAssignmentRecord } from './tenant-rbac';

export async function listGroupRoleAssignments(
  metadata: DatabaseSource,
  tenantId: string,
  groupIds: Iterable<string>,
  nowSeconds: number
) {
  const rows: (SubjectRoleAssignmentRecord & { group_id: string })[] = [];
  for (const batch of rbacIdBatches(groupIds)) {
    rows.push(
      ...(await ensureDatabaseAdapter(metadata).query<
        SubjectRoleAssignmentRecord & { group_id: string }
      >(
        `SELECT id, group_id, role_id, scope_type, scope_target, expires_at, assigned_by, created_at
       FROM group_role_assignments WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)
       AND group_id IN (${batch.map(() => '?').join(', ')})`,
        [tenantId, nowSeconds, ...batch]
      ))
    );
  }
  return rows;
}

export interface GroupRoleKey {
  groupId: string;
  roleId: string;
  scopeType?: 'global' | 'tenant' | 'group' | 'resource';
  scopeTarget?: string;
}
export interface GroupRoleGrant extends GroupRoleKey {
  expiresAt?: number | null;
  assignedBy?: string | null;
  metadataJson?: string | null;
}
/** The grant statement alone, for a caller that runs it inside its own transaction. */
export async function writeGroupRoleGrant(
  db: Pick<TransactionContext, 'execute'>,
  tenantId: string,
  input: GroupRoleGrant
) {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute(
    `INSERT INTO group_role_assignments (id, tenant_id, group_id, role_id, scope_type, scope_target,
      expires_at, assigned_by, metadata_json, created_at, updated_at)
     SELECT ?, g.tenant_id, g.id, r.id, ?, ?, ?, ?, ?, ?, ?
       FROM "groups" g JOIN roles r ON r.tenant_id=g.tenant_id
       WHERE g.tenant_id=? AND g.id=? AND r.id=?
     ON CONFLICT (tenant_id, group_id, role_id, scope_type, scope_target) DO UPDATE SET
       expires_at=excluded.expires_at, assigned_by=excluded.assigned_by,
       metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    [
      crypto.randomUUID(),
      input.scopeType ?? 'global',
      input.scopeTarget ?? '',
      input.expiresAt ?? null,
      input.assignedBy ?? null,
      input.metadataJson ?? null,
      now,
      now,
      tenantId,
      input.groupId,
      input.roleId,
    ]
  );
  if (!result.rowsAffected) throw new Error('group_or_role_not_found');
}

/** A role granted to a group reaches every member: the tenant's cached claims are all stale. */
export async function assignGroupRole(
  metadata: DatabaseSource,
  tenantId: string,
  input: GroupRoleGrant,
  cache?: KVNamespace
) {
  await writeGroupRoleGrant(ensureDatabaseAdapter(metadata), tenantId, input);
  if (cache) await bumpTenantRBACCacheVersion(cache, tenantId);
}

/**
 * Idempotent: the delete and the version bump happen whether or not a row was there, so a retry
 * after a failed bump completes the invalidation.
 */
export async function removeGroupRole(
  metadata: DatabaseSource,
  tenantId: string,
  input: GroupRoleKey,
  cache?: KVNamespace
) {
  await ensureDatabaseAdapter(metadata).execute(
    'DELETE FROM group_role_assignments WHERE tenant_id=? AND group_id=? AND role_id=? AND scope_type=? AND scope_target=?',
    [tenantId, input.groupId, input.roleId, input.scopeType ?? 'global', input.scopeTarget ?? '']
  );
  if (cache) await bumpTenantRBACCacheVersion(cache, tenantId);
}
