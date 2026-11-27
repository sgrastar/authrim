/**
 * Service (dynamic) groups are canonical groups. Every group of the service-group catalog has a
 * `groups` row in the same tenant metadata database with the same id, `kind = 'dynamic'`,
 * `group_key = 'dynamic:<id>'` (derived from the id, so renaming the group or changing its key
 * never changes it), the catalog's display name and description, `lifecycle_state` `active` while
 * the group is enabled (`inactive` otherwise) and `rule_revision` = the catalog revision that last
 * saved it. Role assignments and the published `dynamic` memberships name that row.
 *
 * The rows are written in the catalog save's own batch (`DynamicGroupStore.save`, fenced by the
 * save's write token, so a conflicting save writes neither). A group removed from the catalog is
 * made inactive there (its grants stop at once); `removeDynamicGroup` then removes its
 * memberships on every account database, its grants and the row. `syncDynamicGroupCatalog`
 * repairs both from the reconcile path: catalogs saved before this existed, and a removal that
 * stopped part way.
 */
import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseAdapter, PreparedStatement } from '../../db';
import { bumpTenantRBACCacheVersion, invalidateSubjectRBACCache } from '../../utils/rbac-cache';
import type { Catalog } from './store';
import type { ServiceGroup } from './model';

const primary = { consistencyClass: 'primary_required' as const };
/**
 * A row the catalog owns: kind `dynamic` with the derived key. A `dynamic` group an administrator
 * created through the groups API has another key and is never changed or removed here.
 */
const OWNED = "kind = 'dynamic' AND group_key = 'dynamic:' || id";

export function dynamicGroupKey(id: string): string {
  return `dynamic:${id}`;
}

/** A condition (and its parameters) every canonical write must also satisfy. */
export interface CanonicalWriteGuard {
  sql: string;
  params: unknown[];
}

function lifecycleOf(group: ServiceGroup): 'active' | 'inactive' {
  return group.enabled ? 'active' : 'inactive';
}

/** Creates or updates the canonical row of each group; never takes over a row of another kind. */
export function canonicalDynamicGroupStatements(
  tenantId: string,
  groups: ServiceGroup[],
  removedIds: string[],
  revision: number,
  guard: CanonicalWriteGuard,
  now = Date.now()
): PreparedStatement[] {
  return [
    ...groups.map((group) => ({
      sql: `INSERT INTO "groups" (id, tenant_id, group_key, display_name, description,
          parent_group_id, lifecycle_state, kind, external_id, rule_revision, metadata_json,
          created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, NULL, ?, 'dynamic', NULL, CAST(? AS INTEGER), NULL,
          CAST(? AS BIGINT), CAST(? AS BIGINT) WHERE ${guard.sql}
        ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name,
          description = excluded.description, lifecycle_state = excluded.lifecycle_state,
          rule_revision = excluded.rule_revision, updated_at = excluded.updated_at
        WHERE "groups".tenant_id = excluded.tenant_id AND "groups".kind = 'dynamic'
          AND "groups".group_key = excluded.group_key`,
      params: [
        group.id,
        tenantId,
        dynamicGroupKey(group.id),
        group.displayName,
        group.description,
        lifecycleOf(group),
        revision,
        now,
        now,
        ...guard.params,
      ],
    })),
    ...removedIds.map((id) => ({
      sql: `UPDATE "groups" SET lifecycle_state = 'inactive', updated_at = ?
        WHERE tenant_id = ? AND id = ? AND ${OWNED} AND ${guard.sql}`,
      params: [now, tenantId, id, ...guard.params],
    })),
  ];
}

interface CanonicalRow {
  id: string;
  display_name: string;
  description: string | null;
  lifecycle_state: string;
  rule_revision: number | string | null;
}

/**
 * Makes the canonical rows match the catalog (only rows that differ are written, fenced by the
 * catalog revision) and answers the ids of canonical dynamic rows the catalog no longer has: the
 * caller finishes their removal with `removeDynamicGroup`.
 *
 * A tenant with no catalog at all is left as it is: its canonical dynamic groups await their
 * catalog (`awaitingCatalog`; a restore brings the catalog as settings, and a reconcile running
 * before it arrives must not remove the groups and their memberships).
 */
export async function syncDynamicGroupCatalog(
  db: DatabaseAdapter,
  tenantId: string,
  catalog: Catalog | null,
  cache?: KVNamespace
): Promise<{ changed: number; orphanIds: string[]; awaitingCatalog: string[] }> {
  const rows = await db.query<CanonicalRow>(
    `SELECT id, display_name, description, lifecycle_state, rule_revision FROM "groups"
      WHERE tenant_id = ? AND ${OWNED}`,
    [tenantId],
    primary
  );
  if (!catalog) return { changed: 0, orphanIds: [], awaitingCatalog: rows.map((row) => row.id) };
  const existing = new Map(rows.map((row) => [row.id, row]));
  const groups = catalog.plan.groups;
  const inCatalog = new Set(groups.map((group) => group.id));
  const stale = groups.filter((group) => {
    const row = existing.get(group.id);
    return (
      !row ||
      row.display_name !== group.displayName ||
      (row.description ?? '') !== group.description ||
      row.lifecycle_state !== lifecycleOf(group) ||
      Number(row.rule_revision) !== catalog.revision
    );
  });
  const orphans = rows.filter((row) => !inCatalog.has(row.id));
  const deactivate = orphans.filter((row) => row.lifecycle_state === 'active').map((row) => row.id);
  if (stale.length || deactivate.length) {
    await db.batch(
      canonicalDynamicGroupStatements(tenantId, stale, deactivate, catalog.revision, {
        sql: 'EXISTS (SELECT 1 FROM service_group_catalog WHERE tenant_id = ? AND revision = ?)',
        params: [tenantId, catalog.revision],
      })
    );
  }
  const changed = stale.length + deactivate.length;
  if (changed && cache) await bumpTenantRBACCacheVersion(cache, tenantId);
  return { changed, orphanIds: orphans.map((row) => row.id), awaitingCatalog: [] };
}

/**
 * Finishes removing a dynamic group the catalog no longer has: the row goes inactive (when not
 * yet), the tenant's cached claims are made stale, then its memberships (all sources) are deleted
 * on every account database, then its grants, then the row; last the former members' cached
 * claims are dropped. Re-runnable: each step is idempotent, and a failure part way leaves an
 * inactive group with fewer members, never members of a missing group. `bumpTenant: false` when
 * the caller has just bumped the tenant version itself (the deletion request, after its save).
 */
export async function removeDynamicGroup(
  metadata: DatabaseAdapter,
  accounts: DatabaseAdapter[],
  tenantId: string,
  groupId: string,
  cache?: KVNamespace,
  options: { bumpTenant?: boolean } = {}
): Promise<void> {
  const catalog = await metadata.queryOne<{ plan_json: string }>(
    'SELECT plan_json FROM service_group_catalog WHERE tenant_id = ?',
    [tenantId],
    primary
  );
  // Without a catalog the group awaits it (see syncDynamicGroupCatalog): never removed then.
  if (!catalog) throw new Error('group_catalog_missing');
  const plan = JSON.parse(catalog.plan_json) as { groups?: Array<{ id: string }> };
  if (plan.groups?.some((group) => group.id === groupId)) throw new Error('group_still_in_catalog');
  await metadata.execute(
    `UPDATE "groups" SET lifecycle_state = 'inactive', updated_at = ?
      WHERE tenant_id = ? AND id = ? AND ${OWNED} AND lifecycle_state <> 'inactive'`,
    [Date.now(), tenantId, groupId]
  );
  if (cache && options.bumpTenant !== false) await bumpTenantRBACCacheVersion(cache, tenantId);
  const subjects = new Set<string>();
  for (const account of new Set(accounts)) {
    for (const row of await account.query<{ subject_id: string }>(
      'SELECT DISTINCT subject_id FROM group_memberships WHERE tenant_id = ? AND group_id = ?',
      [tenantId, groupId],
      primary
    ))
      subjects.add(row.subject_id);
    await account.execute('DELETE FROM group_memberships WHERE tenant_id = ? AND group_id = ?', [
      tenantId,
      groupId,
    ]);
  }
  await metadata.execute(
    'DELETE FROM group_role_assignments WHERE tenant_id = ? AND group_id = ?',
    [tenantId, groupId]
  );
  await metadata.execute(`DELETE FROM "groups" WHERE tenant_id = ? AND id = ? AND ${OWNED}`, [
    tenantId,
    groupId,
  ]);
  if (cache)
    for (const subjectId of subjects) await invalidateSubjectRBACCache(cache, tenantId, subjectId);
}
