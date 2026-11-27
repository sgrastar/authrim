import type { KVNamespace } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseSource, type PreparedStatement } from '../db';
import { invalidateSubjectRBACCache } from '../utils/rbac-cache';
import type { TenantRBACDatabases } from './tenant-rbac';

const MAX_GROUP_DEPTH = 16;

/** D1 supports at most 100 binds, including tenant and validity predicates. */
export function* rbacIdBatches(ids: Iterable<string>): Generator<string[]> {
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 90)
    yield unique.slice(offset, offset + 90);
}

interface GroupNode {
  id: string;
  parent_group_id: string | null;
  lifecycle_state: string;
}

async function loadGroups(metadata: DatabaseSource, tenantId: string, ids: Iterable<string>) {
  const db = ensureDatabaseAdapter(metadata);
  const found = new Map<string, GroupNode>();
  for (const batch of rbacIdBatches(ids)) {
    const rows = await db.query<GroupNode>(
      `SELECT id, parent_group_id, lifecycle_state FROM "groups"
        WHERE tenant_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
      [tenantId, ...batch]
    );
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

/** Paths start at a direct membership. An inactive or missing node ends that path. */
export async function resolveGroupAncestors(
  metadata: DatabaseSource,
  tenantId: string,
  ids: Iterable<string>
) {
  const roots = [...new Set(ids)];
  const nodes = new Map<string, GroupNode>();
  const queried = new Set<string>();
  let frontier = roots;
  for (let depth = 0; depth <= MAX_GROUP_DEPTH && frontier.length; depth++) {
    const found = await loadGroups(metadata, tenantId, frontier);
    for (const id of frontier) queried.add(id);
    const parents = new Set<string>();
    for (const node of found.values()) {
      if (node.lifecycle_state !== 'active') continue;
      nodes.set(node.id, node);
      if (node.parent_group_id && !queried.has(node.parent_group_id))
        parents.add(node.parent_group_id);
    }
    frontier = [...parents];
  }
  const paths = new Map<string, Set<string>>();
  const effective = new Set<string>();
  for (const root of roots) {
    const path = new Set<string>();
    let node = nodes.get(root);
    while (node && !path.has(node.id) && path.size <= MAX_GROUP_DEPTH) {
      path.add(node.id);
      effective.add(node.id);
      node = node.parent_group_id ? nodes.get(node.parent_group_id) : undefined;
    }
    if (path.size) paths.set(root, path);
  }
  return { directGroupIds: new Set(paths.keys()), effectiveGroupIds: effective, paths };
}

export async function resolveSubjectGroups(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  nowSeconds: number
) {
  const rows = await ensureDatabaseAdapter(dbs.account).query<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM group_memberships WHERE tenant_id = ? AND subject_id = ?
       AND lifecycle_state = 'active' AND (starts_at IS NULL OR starts_at <= ?)
       AND (expires_at IS NULL OR expires_at > ?) AND (stale_after IS NULL OR stale_after > ?)`,
    [tenantId, subjectId, nowSeconds, nowSeconds, nowSeconds]
  );
  return resolveGroupAncestors(
    dbs.metadata,
    tenantId,
    rows.map((row) => row.group_id)
  );
}

export type MembershipSource = 'manual' | 'scim' | 'rule' | 'dynamic' | 'invitation';
export interface MembershipKey {
  groupId: string;
  source: MembershipSource;
  sourceRef?: string;
}
interface MembershipTimes {
  startsAt?: number | null;
  expiresAt?: number | null;
  staleAfter?: number | null;
}

async function requireGroups(metadata: DatabaseSource, tenantId: string, groupIds: string[]) {
  if ((await loadGroups(metadata, tenantId, groupIds)).size !== new Set(groupIds).size)
    throw new Error('group_not_found');
}

function membershipStatement(
  tenantId: string,
  subjectId: string,
  input: MembershipKey & MembershipTimes
): PreparedStatement {
  const now = Math.floor(Date.now() / 1000);
  return {
    sql: `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, starts_at, expires_at, stale_after, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, group_id, subject_id, assignment_source, source_ref) DO UPDATE SET
          lifecycle_state = 'active', starts_at = excluded.starts_at, expires_at = excluded.expires_at,
          stale_after = excluded.stale_after, updated_at = excluded.updated_at`,
    params: [
      crypto.randomUUID(),
      tenantId,
      input.groupId,
      subjectId,
      input.source,
      input.sourceRef ?? '',
      input.startsAt ?? null,
      input.expiresAt ?? null,
      input.staleAfter ?? null,
      now,
      now,
    ],
  };
}

export async function upsertGroupMembership(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  input: MembershipKey & MembershipTimes,
  cache?: KVNamespace
) {
  await requireGroups(dbs.metadata, tenantId, [input.groupId]);
  const { sql, params } = membershipStatement(tenantId, subjectId, input);
  await ensureDatabaseAdapter(dbs.account).execute(sql, params);
  if (cache) await invalidateSubjectRBACCache(cache, tenantId, subjectId);
}

export async function revokeGroupMembership(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  input: MembershipKey,
  cache?: KVNamespace
) {
  await ensureDatabaseAdapter(dbs.account).execute(
    `UPDATE group_memberships SET lifecycle_state='revoked', updated_at=?
     WHERE tenant_id=? AND subject_id=? AND group_id=? AND assignment_source=? AND source_ref=?`,
    [
      Math.floor(Date.now() / 1000),
      tenantId,
      subjectId,
      input.groupId,
      input.source,
      input.sourceRef ?? '',
    ]
  );
  if (cache) await invalidateSubjectRBACCache(cache, tenantId, subjectId);
}

export async function replaceSourceMemberships(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  source: MembershipSource,
  sourceRef: string,
  groupIds: Iterable<string>,
  times: MembershipTimes = {},
  cache?: KVNamespace
) {
  const groups = [...new Set(groupIds)];
  await requireGroups(dbs.metadata, tenantId, groups);
  const account = ensureDatabaseAdapter(dbs.account);
  const sourceWhere = 'tenant_id=? AND subject_id=? AND assignment_source=? AND source_ref=?';
  const params = [tenantId, subjectId, source, sourceRef];
  // Keep stable membership IDs where the new set overlaps the old set (ownership records name them).
  await account.batch([
    ...(account.getType() === 'postgres'
      ? [
          {
            sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
            params: [JSON.stringify(params)],
          },
        ]
      : []),
    { sql: `UPDATE group_memberships SET lifecycle_state='revoked' WHERE ${sourceWhere}`, params },
    ...groups.map((groupId) =>
      membershipStatement(tenantId, subjectId, { groupId, source, sourceRef, ...times })
    ),
    {
      sql: `DELETE FROM group_memberships WHERE ${sourceWhere} AND lifecycle_state='revoked'`,
      params,
    },
  ]);
  if (cache) await invalidateSubjectRBACCache(cache, tenantId, subjectId);
}
