import type { KVNamespace } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseSource, type PreparedStatement } from '../db';
import { invalidateSubjectRBACCache } from '../utils/rbac-cache';
import type { TenantRBACDatabases } from './tenant-rbac';
import {
  markDynamicMembershipsStale,
  parseDynamicMembershipSourceRef,
} from './dynamic-groups/publication';
import { changedServiceGroups } from './dynamic-groups/plan-diff';
import type { GroupPlan } from './dynamic-groups/model';

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

const CHANGED_GROUPS_TTL_MS = 60_000;
const CHANGED_GROUPS_MAX_ENTRIES = 200;
/**
 * The groups whose rule differs between two catalog revisions, per isolate (revisions are kept,
 * so an entry never goes wrong; the TTL and the bound only limit memory).
 */
const changedGroupsCache = new Map<string, { changed: Set<string>; at: number }>();

/**
 * The service groups whose membership rule differs between the published catalog revision
 * (`service_group_revisions`) and the current catalog: changed or removed ones
 * (changedServiceGroups) and those added since. Null when either plan cannot be read (the
 * revision row is missing, or a plan is not readable JSON).
 */
async function groupsChangedSince(
  metadata: DatabaseSource,
  tenantId: string,
  published: number,
  current: { revision: number; plan_json: string }
): Promise<Set<string> | null> {
  const key = `${tenantId}\u0000${published}\u0000${current.revision}`;
  const cached = changedGroupsCache.get(key);
  if (cached && Date.now() - cached.at < CHANGED_GROUPS_TTL_MS) return cached.changed;
  const row = await ensureDatabaseAdapter(metadata).queryOne<{ plan_json: string }>(
    'SELECT plan_json FROM service_group_revisions WHERE tenant_id = ? AND revision = ?',
    [tenantId, published]
  );
  if (!row) return null;
  let before: GroupPlan;
  let after: GroupPlan;
  try {
    before = JSON.parse(row.plan_json) as GroupPlan;
    after = JSON.parse(current.plan_json) as GroupPlan;
  } catch {
    return null;
  }
  if (!Array.isArray(before?.groups) || !Array.isArray(after?.groups)) return null;
  const changed = changedServiceGroups(before, after);
  const existed = new Set(before.groups.map((group) => group.id));
  for (const group of after.groups) if (!existed.has(group.id)) changed.add(group.id);
  changedGroupsCache.delete(key);
  if (changedGroupsCache.size >= CHANGED_GROUPS_MAX_ENTRIES) {
    const oldest = changedGroupsCache.keys().next().value;
    if (oldest !== undefined) changedGroupsCache.delete(oldest);
  }
  changedGroupsCache.set(key, { changed, at: Date.now() });
  return changed;
}

/** Tests: forget the cached revision differences. */
export function clearChangedServiceGroupsCache(): void {
  changedGroupsCache.clear();
}

/** The tenant's enabled (active) canonical service groups. */
async function enabledDynamicGroupIds(
  metadata: DatabaseSource,
  tenantId: string
): Promise<string[]> {
  // The canonical groups the service-group catalog owns (canonical.ts: `dynamic:<id>`), not an
  // administrator's group that only has the dynamic kind.
  const rows = await ensureDatabaseAdapter(metadata).query<{ id: string }>(
    `SELECT id FROM "groups" WHERE tenant_id = ? AND kind = 'dynamic'
      AND group_key = 'dynamic:' || id AND lifecycle_state = 'active'`,
    [tenantId]
  );
  return rows.map((row) => row.id);
}

/** Marks the result of resolveSubjectGroups for the subject's publication record. */
const PUBLICATION_RECORD = 'publication_record';

/**
 * The subject's groups: its active memberships at `nowSeconds` and their active ancestors, and
 * the groups whose membership is not known (`unknownGroupIds`, with their ancestors: neither
 * "member" nor "not a member"; `uncertain` when there is any).
 *
 * Dynamic (service-group) memberships are judged against the subject's publication record
 * (`dynamic_membership_publications`, read in the same statement as the rows, whether or not it
 * has any row):
 * - a record of the current catalog revision: its rows are memberships;
 * - a record of an older revision: the groups whose rule changed since (changed, removed or added;
 *   changedServiceGroups) are unknown and their rows dropped; the rows of the other groups remain
 *   memberships (a rename, or a change to other groups, keeps them);
 * - no record while the tenant has enabled service groups (the subject was never evaluated), a
 *   row of another generation than the record, or a check that cannot be read (such as the
 *   published revision's plan): every enabled service group is unknown and the dynamic rows
 *   dropped.
 * Other memberships (manual, SCIM, rules, invitations) are always known.
 */
export async function resolveSubjectGroups(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  nowSeconds: number
) {
  const account = ensureDatabaseAdapter(dbs.account);
  // Dynamic rows are read past their stale_after too: one gone stale (not republished since) makes
  // its group unknown rather than disappear. Other sources keep stale_after as a validity bound.
  const rows = await account.query<{
    group_id: string | null;
    assignment_source?: string;
    source_ref?: string | null;
    stale_after?: number | string | null;
    unknown_groups_json?: string | null;
  }>(
    `SELECT m.group_id, m.assignment_source, m.source_ref, m.stale_after,
        NULL AS unknown_groups_json
       FROM group_memberships m
      WHERE m.tenant_id = ? AND m.subject_id = ?
       AND m.lifecycle_state = 'active' AND (m.starts_at IS NULL OR m.starts_at <= ?)
       AND (m.expires_at IS NULL OR m.expires_at > ?)
       AND (m.stale_after IS NULL OR m.stale_after > ? OR m.assignment_source = 'dynamic')
     UNION ALL
     SELECT NULL, '${PUBLICATION_RECORD}', p.generation, NULL, p.unknown_groups_json
       FROM dynamic_membership_publications p
      WHERE p.tenant_id = ? AND p.subject_id = ?`,
    [tenantId, subjectId, nowSeconds, nowSeconds, nowSeconds, tenantId, subjectId]
  );
  const record = rows.find((row) => row.assignment_source === PUBLICATION_RECORD);
  const memberships = rows.filter(
    (row): row is typeof row & { group_id: string } =>
      row.assignment_source !== PUBLICATION_RECORD && typeof row.group_id === 'string'
  );
  const dynamic = memberships.filter((row) => row.assignment_source === 'dynamic');
  let unknown = new Set<string>();
  // Every enabled service group (and every dynamic row's group). When not even those can be
  // read, the read fails: the caller treats the memberships as unreadable.
  const allDynamicUnknown = async () => {
    unknown = new Set([
      ...(await enabledDynamicGroupIds(dbs.metadata, tenantId)),
      ...dynamic.map((row) => row.group_id),
    ]);
  };
  const recorded = record?.source_ref ? String(record.source_ref) : null;
  const parsed = recorded ? parseDynamicMembershipSourceRef(recorded) : null;
  // The groups the publication recorded as undecided for the subject (unknown evaluation, or left
  // out on purpose); null when the record cannot be read.
  let undecided: string[] | null = [];
  try {
    // A record written before unknown_groups_json existed (NULL) says nothing of what it left
    // undecided: every service group is unknown until it is republished.
    const raw: unknown =
      record && record.unknown_groups_json === null
        ? null
        : record?.unknown_groups_json
          ? JSON.parse(record.unknown_groups_json)
          : [];
    undecided = Array.isArray(raw) && raw.every((id) => typeof id === 'string') ? raw : null;
  } catch {
    undecided = null;
  }
  if (!recorded || undecided === null) {
    await allDynamicUnknown();
  } else if (!parsed || dynamic.some((row) => row.source_ref !== recorded)) {
    await allDynamicUnknown();
  } else {
    try {
      const metadata = ensureDatabaseAdapter(dbs.metadata);
      const catalog = await metadata.queryOne<{ revision: number | string; plan_json: string }>(
        'SELECT revision, plan_json FROM service_group_catalog WHERE tenant_id = ?',
        [tenantId]
      );
      if (!catalog) {
        await allDynamicUnknown();
      } else if (Number(catalog.revision) !== parsed.ruleVersion) {
        const changed = await groupsChangedSince(dbs.metadata, tenantId, parsed.ruleVersion, {
          revision: Number(catalog.revision),
          plan_json: catalog.plan_json,
        });
        // A copy: the cached difference is shared by every subject of these revisions.
        if (changed) unknown = new Set(changed);
        else await allDynamicUnknown();
      }
    } catch {
      await allDynamicUnknown();
    }
  }
  for (const id of undecided ?? []) unknown.add(id);
  // A dynamic row past its stale_after: not republished since, so its group is unknown.
  for (const row of dynamic)
    if (
      row.stale_after !== null &&
      row.stale_after !== undefined &&
      Number(row.stale_after) <= nowSeconds
    )
      unknown.add(row.group_id);
  const groupIds = memberships
    .filter((row) => row.assignment_source !== 'dynamic' || !unknown.has(row.group_id))
    .map((row) => row.group_id);
  const resolved = await resolveGroupAncestors(dbs.metadata, tenantId, groupIds);
  // An unknown group's ancestors are unknown too, except those known through another membership
  // (in effectiveGroupIds): the unknown set holds only what is neither known member nor known not.
  const unknownGroupIds = new Set(unknown);
  if (unknown.size) {
    for (const id of (await resolveGroupAncestors(dbs.metadata, tenantId, unknown))
      .effectiveGroupIds)
      unknownGroupIds.add(id);
  }
  for (const id of resolved.effectiveGroupIds) unknownGroupIds.delete(id);
  return {
    ...resolved,
    unknownGroupIds,
    uncertain: unknownGroupIds.size > 0,
  };
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
  input: MembershipKey & MembershipTimes,
  now: number = Math.floor(Date.now() / 1000)
): PreparedStatement {
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

/**
 * Writes the membership and says, from the write itself, what it did: the row's id, its
 * updated_at, and whether this request changed it (`changed`: made it, or made it active again,
 * stamping `updatedAt`), so the caller can take back exactly this write
 * (`... WHERE id = ? AND updated_at = ?`). Two conditional statements, each RETURNING the row:
 * an INSERT that does nothing on the unique key, then an UPDATE of a row that is not active. A
 * row already active is left as it is (`changed: false`, read without writing). The RBAC cache
 * is left to the caller.
 */
export async function writeGroupMembership(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  input: MembershipKey & MembershipTimes
): Promise<{ id: string; updatedAt: number; changed: boolean }> {
  await requireGroups(dbs.metadata, tenantId, [input.groupId]);
  const account = ensureDatabaseAdapter(dbs.account);
  const now = Math.floor(Date.now() / 1000);
  const sourceRef = input.sourceRef ?? '';
  const key = [tenantId, input.groupId, subjectId, input.source, sourceRef];
  const keyWhere =
    'tenant_id=? AND group_id=? AND subject_id=? AND assignment_source=? AND source_ref=?';
  const returned = (rows: { id: string; updated_at: number | string }[]) =>
    rows[0] ? { id: rows[0].id, updatedAt: Number(rows[0].updated_at) } : null;
  const inserted = returned(
    await account.query<{ id: string; updated_at: number | string }>(
      `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, starts_at, expires_at, stale_after, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, group_id, subject_id, assignment_source, source_ref) DO NOTHING
        RETURNING id, updated_at`,
      [
        crypto.randomUUID(),
        ...key,
        input.startsAt ?? null,
        input.expiresAt ?? null,
        input.staleAfter ?? null,
        now,
        now,
      ]
    )
  );
  if (inserted) return { ...inserted, changed: true };
  const reactivated = returned(
    await account.query<{ id: string; updated_at: number | string }>(
      `UPDATE group_memberships SET lifecycle_state='active', starts_at=?, expires_at=?,
          stale_after=?, updated_at=?
        WHERE ${keyWhere} AND lifecycle_state<>'active'
        RETURNING id, updated_at`,
      [input.startsAt ?? null, input.expiresAt ?? null, input.staleAfter ?? null, now, ...key]
    )
  );
  if (reactivated) return { ...reactivated, changed: true };
  const existing = await account.queryOne<{ id: string; updated_at: number | string }>(
    `SELECT id, updated_at FROM group_memberships WHERE ${keyWhere}`,
    key
  );
  if (!existing) throw new Error('group_membership_write_lost');
  return { id: existing.id, updatedAt: Number(existing.updated_at), changed: false };
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
  if (input.source === 'manual') {
    await expireDerivedDynamicMemberships(dbs, tenantId, subjectId, cache);
    return;
  }
  if (cache) await invalidateSubjectRBACCache(cache, tenantId, subjectId);
}

/**
 * After a manual membership is taken away: the subject's published dynamic memberships may derive
 * from it (member(<group>)), so they stop granting now (stale_after = now) and the cached claims
 * are dropped; the next evaluation publishes them again from the changed input.
 */
async function expireDerivedDynamicMemberships(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  cache?: KVNamespace
) {
  await markDynamicMembershipsStale(ensureDatabaseAdapter(dbs.account), tenantId, subjectId, cache);
}

/**
 * Revokes every `manual` row of the subject in the group with one statement (whatever its
 * `source_ref`), then drops the subject's cached claims once.
 */
export async function revokeManualGroupMemberships(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  groupId: string,
  cache?: KVNamespace
) {
  await ensureDatabaseAdapter(dbs.account).execute(
    `UPDATE group_memberships SET lifecycle_state='revoked', updated_at=?
     WHERE tenant_id=? AND subject_id=? AND group_id=? AND assignment_source='manual'`,
    [Math.floor(Date.now() / 1000), tenantId, subjectId, groupId]
  );
  await expireDerivedDynamicMemberships(dbs, tenantId, subjectId, cache);
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
