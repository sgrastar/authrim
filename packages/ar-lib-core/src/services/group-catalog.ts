import type { KVNamespace } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter, type DatabaseSource, type TransactionContext } from '../db';
import { bumpTenantRBACCacheVersion } from '../utils/rbac-cache';

/** Evaluate the parent check in the mutation statement. UNION terminates even for corrupt loops. */
export function groupParentCondition(
  tenantId: string,
  parentId: string | null,
  child: { id: string } | { key: string }
) {
  if (parentId === null) return { sql: '1=1', params: [] };
  const column = 'id' in child ? 'id' : 'group_key';
  const value = 'id' in child ? child.id : child.key;
  return {
    sql: `EXISTS (WITH RECURSIVE ancestors(id, parent_group_id) AS (
      SELECT id, parent_group_id FROM "groups" WHERE tenant_id=? AND id=? AND ${column}<>?
      UNION
      SELECT g.id, g.parent_group_id FROM "groups" g JOIN ancestors a ON a.parent_group_id=g.id
       WHERE g.tenant_id=? AND g.${column}<>?
    ) SELECT 1 FROM ancestors WHERE parent_group_id IS NULL)`,
    params: [tenantId, parentId, value, tenantId, value],
  };
}

/** PostgreSQL concurrent reparenting transactions must see each other's committed graph. */
export async function lockGroupCatalog(
  tx: Pick<TransactionContext, 'queryOne'>,
  tenantId: string,
  backend: string
) {
  if (backend === 'postgres')
    await tx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [tenantId]);
}

interface GroupFields {
  displayName: string;
  description: string | null;
  parentGroupId: string | null;
  lifecycleState: string;
  kind: 'static' | 'dynamic' | 'scim' | 'provisioned';
  externalId: string | null;
  ruleRevision: number | null;
  metadataJson: string | null;
}

export async function createGroup(
  metadata: DatabaseSource,
  tenantId: string,
  input: Partial<GroupFields> & { groupKey: string; displayName: string; id?: string }
) {
  const db = ensureDatabaseAdapter(metadata);
  // A caller may choose the id, so a key derived from it (SCIM: `scim:<id>`) can be written at once.
  const id = input.id ?? crypto.randomUUID();
  const parent = groupParentCondition(tenantId, input.parentGroupId ?? null, { id });
  const now = Date.now();
  await db.transaction(async (tx) => {
    await lockGroupCatalog(tx, tenantId, db.getType());
    const result = await tx.execute(
      `INSERT INTO "groups" (id, tenant_id, group_key, display_name, description, parent_group_id,
        lifecycle_state, kind, external_id, rule_revision, metadata_json, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${parent.sql}`,
      [
        id,
        tenantId,
        input.groupKey,
        input.displayName,
        input.description ?? null,
        input.parentGroupId ?? null,
        input.lifecycleState ?? 'active',
        input.kind ?? 'static',
        input.externalId ?? null,
        input.ruleRevision ?? null,
        input.metadataJson ?? null,
        now,
        now,
        ...parent.params,
      ]
    );
    if (!result.rowsAffected) throw new Error('invalid_group_parent');
  });
  return id;
}

/** Moving or deactivating a group changes the effective roles of every member below it. */
export async function updateGroup(
  metadata: DatabaseSource,
  tenantId: string,
  id: string,
  input: Partial<GroupFields>,
  cache?: KVNamespace
) {
  const columns: Record<keyof GroupFields, string> = {
    displayName: 'display_name',
    description: 'description',
    parentGroupId: 'parent_group_id',
    lifecycleState: 'lifecycle_state',
    kind: 'kind',
    externalId: 'external_id',
    ruleRevision: 'rule_revision',
    metadataJson: 'metadata_json',
  };
  const keys = (Object.keys(columns) as (keyof GroupFields)[]).filter(
    (key) => input[key] !== undefined
  );
  const parent = groupParentCondition(tenantId, input.parentGroupId ?? null, { id });
  const db = ensureDatabaseAdapter(metadata);
  await db.transaction(async (tx) => {
    await lockGroupCatalog(tx, tenantId, db.getType());
    const result = await tx.execute(
      `UPDATE "groups" SET ${[...keys.map((key) => columns[key] + '=?'), 'updated_at=?'].join(', ')}
       WHERE tenant_id=? AND id=? AND ${parent.sql}`,
      [...keys.map((key) => input[key]), Date.now(), tenantId, id, ...parent.params]
    );
    if (!result.rowsAffected) throw new Error('group_not_found_or_invalid_parent');
  });
  // authrim_groups carries the name and kind, so any update changes cached claims.
  if (cache) await bumpTenantRBACCacheVersion(cache, tenantId);
}
