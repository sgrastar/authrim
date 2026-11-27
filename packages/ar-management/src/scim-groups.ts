/**
 * SCIM Groups on the canonical group tables (`groups`, `group_memberships`).
 *
 * How a SCIM Group maps onto them:
 * - A SCIM Group is a `groups` row of kind `scim` in the tenant metadata database. Its SCIM `id`
 *   is `groups.id`, `displayName` is `display_name` (unique among the tenant's SCIM groups) and
 *   `externalId` is `external_id`. Its `group_key` is `scim:<id>`: derived from the id, so a rename
 *   or a new externalId never changes it and two SCIM groups never share one. Groups of other
 *   kinds are not SCIM resources: SCIM neither lists nor changes them.
 * - A member is a `group_memberships` row in the member's own account database with
 *   `assignment_source = 'scim'` and `source_ref = 'scim'`: the tenant's one SCIM provisioning
 *   domain. The SCIM authentication names a token only by its hash, which a token rotation
 *   replaces, so the token cannot own rows without orphaning them; every token of the tenant
 *   therefore shares the domain. (A tenant with several SCIM connections feeding the same group
 *   sees one shared member list; separate domains per connection need a stable connection id the
 *   SCIM authentication does not have yet.) SCIM reads and writes only the rows of its domain:
 *   rows another source wrote (manual, rules, dynamic, invitations) and memberships reached
 *   through a descendant group are never shown as its members, so a GET followed by a PUT of
 *   what it returned leaves them as they are.
 * - Every membership change makes the subject's cached RBAC claims stale; deleting or renaming a
 *   group makes the tenant's stale.
 *
 * Delegation: SCIM writes memberships only into `kind = 'scim'` groups, which it created. A SCIM
 * group carries no role until an administrator attaches one to it (or to a parent it is moved
 * under), and attaching or reparenting passes the grant_tier guard of that administrator at that
 * moment. Attaching a role to a SCIM group, or reparenting one, is therefore the act of
 * delegating that role to the tenant's SCIM provisioning domain: from then on the SCIM client
 * decides who holds it, without a guard of its own. (A per-domain ceiling on what SCIM may be
 * delegated is a recorded follow-up.)
 */
import type { KVNamespace } from '@cloudflare/workers-types';
import {
  bumpTenantRBACCacheVersion,
  createGroup,
  invalidateSubjectRBACCache,
  lockGroupCatalog,
  rbacIdBatches,
  resolveGroupAncestors,
  revokeGroupMembership,
  updateGroup,
  upsertGroupMembership,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import type { InternalGroup, ScimPatchOp, ScimUser } from '@authrim/ar-lib-scim';

export const SCIM_MEMBERSHIP_SOURCE = 'scim' as const;
/** The tenant's SCIM provisioning domain (see above): the `source_ref` of every SCIM row. */
export const SCIM_SOURCE_REF = 'scim';

/** The databases a SCIM group operation reads and writes. */
export interface ScimGroupStores {
  /** The tenant metadata database: group definitions and group role assignments. */
  metadata: DatabaseAdapter;
  /** Every database the tenant's accounts (and so their memberships) are in, each once. */
  accounts: DatabaseAdapter[];
  /** The RBAC claims cache (REBAC_CACHE), when bound. */
  cache?: KVNamespace;
}

/** A member and the account database its membership rows are in. */
export interface ScimGroupMember {
  subjectId: string;
  account: DatabaseAdapter;
}

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: number | string;
  updated_at: number | string;
}

const GROUP_COLUMNS = 'id, display_name, external_id, created_at, updated_at';
const OWNED_ROWS = "assignment_source = 'scim' AND source_ref = ? AND lifecycle_state = 'active'";

export function scimGroupKey(id: string): string {
  return `scim:${id}`;
}

function iso(value: number | string): string {
  return new Date(Number(value)).toISOString();
}

export function toInternalGroup(row: GroupRow): InternalGroup {
  return {
    id: row.id,
    name: row.display_name,
    external_id: row.external_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function findScimGroup(
  metadata: DatabaseAdapter,
  tenantId: string,
  groupId: string
): Promise<InternalGroup | null> {
  const row = await metadata.queryOne<GroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM "groups" WHERE tenant_id = ? AND id = ? AND kind = 'scim'`,
    [tenantId, groupId]
  );
  return row ? toInternalGroup(row) : null;
}

/**
 * Whether another SCIM group of the tenant has the name. Checked before the write: two requests
 * creating or renaming to the same name at once can both pass (accepted; the table has no unique
 * index on display names).
 */
export async function scimGroupNameTaken(
  metadata: DatabaseAdapter,
  tenantId: string,
  displayName: string,
  exceptGroupId?: string
): Promise<boolean> {
  const row = await metadata.queryOne<{ id: string }>(
    `SELECT id FROM "groups" WHERE tenant_id = ? AND kind = 'scim' AND display_name = ?${
      exceptGroupId ? ' AND id <> ?' : ''
    } LIMIT 1`,
    exceptGroupId ? [tenantId, displayName, exceptGroupId] : [tenantId, displayName]
  );
  return Boolean(row);
}

/** The list query of the tenant's SCIM groups; `where` is an extra condition on its columns. */
export function scimGroupListSql(where?: string): { list: string; count: string } {
  const from = `FROM "groups" WHERE tenant_id = ? AND kind = 'scim'${where ? ` AND ${where}` : ''}`;
  return {
    list: `SELECT ${GROUP_COLUMNS} ${from}`,
    count: `SELECT COUNT(*) AS total ${from}`,
  };
}

export async function listScimGroupRows(
  metadata: DatabaseAdapter,
  sql: string,
  params: (string | number | boolean | null)[]
): Promise<InternalGroup[]> {
  return (await metadata.query<GroupRow>(sql, params)).map(toInternalGroup);
}

async function forEachConcurrent<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  const pending = [...items];
  const worker = async () => {
    for (let item = pending.shift(); item !== undefined; item = pending.shift()) await run(item);
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
}

const bySubject = (a: ScimGroupMember, b: ScimGroupMember) =>
  a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;

/**
 * The members SCIM rows give each of the groups, by group id: one query per account database
 * for each 90 groups.
 */
export async function listScimMembersOfGroups(
  stores: ScimGroupStores,
  tenantId: string,
  groupIds: Iterable<string>
): Promise<Map<string, ScimGroupMember[]>> {
  const found = new Map<string, Map<string, ScimGroupMember>>();
  for (const batch of rbacIdBatches(groupIds)) {
    for (const account of new Set(stores.accounts)) {
      const rows = await account.query<{ group_id: string; subject_id: string }>(
        `SELECT DISTINCT group_id, subject_id FROM group_memberships
          WHERE tenant_id = ? AND ${OWNED_ROWS}
            AND group_id IN (${batch.map(() => '?').join(', ')})`,
        [tenantId, SCIM_SOURCE_REF, ...batch]
      );
      for (const row of rows) {
        const members = found.get(row.group_id) ?? new Map<string, ScimGroupMember>();
        if (!members.has(row.subject_id))
          members.set(row.subject_id, { subjectId: row.subject_id, account });
        found.set(row.group_id, members);
      }
    }
  }
  return new Map([...found].map(([id, members]) => [id, [...members.values()].sort(bySubject)]));
}

/** The members SCIM rows give the group, by subject id. */
export async function listOwnedScimMembers(
  stores: ScimGroupStores,
  tenantId: string,
  groupId: string
): Promise<ScimGroupMember[]> {
  return (await listScimMembersOfGroups(stores, tenantId, [groupId])).get(groupId) ?? [];
}

/**
 * Makes the SCIM rows of the group exactly `next`: adds a row for each new member and revokes
 * the row of each member left out. Rows of other sources are not touched.
 */
export async function setOwnedScimMembers(
  stores: ScimGroupStores,
  tenantId: string,
  groupId: string,
  current: ScimGroupMember[],
  next: ScimGroupMember[]
): Promise<void> {
  const key = { groupId, source: SCIM_MEMBERSHIP_SOURCE, sourceRef: SCIM_SOURCE_REF };
  const currentIds = new Set(current.map((member) => member.subjectId));
  const nextIds = new Set(next.map((member) => member.subjectId));
  const added = [...new Map(next.map((member) => [member.subjectId, member])).values()].filter(
    (member) => !currentIds.has(member.subjectId)
  );
  const removed = current.filter((member) => !nextIds.has(member.subjectId));
  await forEachConcurrent(added, (member) =>
    upsertGroupMembership(
      { metadata: stores.metadata, account: member.account },
      tenantId,
      member.subjectId,
      key,
      stores.cache
    )
  );
  await forEachConcurrent(removed, (member) =>
    revokeGroupMembership(
      { metadata: stores.metadata, account: member.account },
      tenantId,
      member.subjectId,
      key,
      stores.cache
    )
  );
}

type PatchOperation = ScimPatchOp['Operations'][number];

/** A PATCH of a group's members that cannot be applied; nothing is written. */
export interface ScimGroupPatchFailure {
  ok: false;
  scimType: 'invalidPath' | 'invalidValue' | 'noTarget';
  detail: string;
}

export interface ScimGroupPatchPlan {
  ok: true;
  /** The members after the patch, as sent (bulkId references unresolved). */
  memberIds: string[];
  changed: boolean;
  /** Values a `remove` named that are not current members (to be checked as User ids). */
  removedValues: string[];
  otherOperations: PatchOperation[];
}

const MEMBER_ATTRIBUTES = new Set(['value', '$ref', 'display', 'type']);

/** The member values of a `members` value: every element an object with a string `value`. */
function memberValues(value: unknown): string[] | null {
  const items = Array.isArray(value) ? value : [value];
  const values: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const member = item as Record<string, unknown>;
    if (typeof member.value !== 'string' || member.value.length === 0) return null;
    for (const [key, field] of Object.entries(member))
      if (!MEMBER_ATTRIBUTES.has(key) || typeof field !== 'string') return null;
    values.push(member.value);
  }
  return values;
}

const GROUP_SCHEMA_PREFIX = 'urn:ietf:params:scim:schemas:core:2.0:group:';
const MEMBER_FILTER =
  /^members\[\s*value\s+eq\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\](?:\.([A-Za-z$]+))?$/i;

type MemberPath =
  | { kind: 'members' }
  | { kind: 'filter'; value: string; subAttribute?: string }
  | { kind: 'invalid' }
  | null;

/** Which members a PATCH path names: null for a path of another attribute. */
function parseMemberPath(path: string): MemberPath {
  let rest = path.trim();
  if (rest.toLowerCase().startsWith(GROUP_SCHEMA_PREFIX))
    rest = rest.slice(GROUP_SCHEMA_PREFIX.length);
  if (!/^members(?![A-Za-z0-9_])/i.test(rest)) return null;
  if (rest.toLowerCase() === 'members') return { kind: 'members' };
  const filter = rest.match(MEMBER_FILTER);
  if (!filter) return { kind: 'invalid' };
  const value = (filter[1] ?? filter[2]).replace(/\\(.)/g, '$1');
  return { kind: 'filter', value, subAttribute: filter[3]?.toLowerCase() };
}

const failure = (
  scimType: ScimGroupPatchFailure['scimType'],
  detail: string
): ScimGroupPatchFailure => ({ ok: false, scimType, detail });

/**
 * Plans a PATCH of a group: its effect on the members and the operations left for the other
 * attributes. On the members, `add` is the union, `replace` the replacement (or, with a
 * `members[value eq …]` filter, the replacement of that member's value) and `remove` the
 * difference (all members with no value); the path may carry the Group schema URN, a filter may
 * quote its value with double or single quotes, and no path with a value carrying `members`
 * works as the path `members`. A member path, operator or value that cannot be applied fails the
 * whole patch before anything is written.
 */
export function splitScimGroupPatch(
  currentMemberIds: string[],
  operations: PatchOperation[]
): ScimGroupPatchPlan | ScimGroupPatchFailure {
  const members = new Set(currentMemberIds);
  const removedValues = new Set<string>();
  let changed = false;
  const otherOperations: PatchOperation[] = [];
  const invalidMembers = failure('invalidValue', 'members must be objects with a string value');
  for (const operation of operations) {
    const op = String(operation.op).toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op))
      return failure('invalidValue', `Unsupported patch operation: ${String(operation.op)}`);
    let target: MemberPath = { kind: 'members' };
    let value: unknown = operation.value;
    if (!operation.path?.trim()) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('members' in value)) {
        otherOperations.push(operation);
        continue;
      }
      const rest: Record<string, unknown> = { ...value };
      value = rest.members;
      delete rest.members;
      if (Object.keys(rest).length > 0) otherOperations.push({ ...operation, value: rest });
      if (op === 'remove') return failure('invalidPath', 'remove requires a path');
    } else {
      target = parseMemberPath(operation.path);
      if (target === null) {
        otherOperations.push(operation);
        continue;
      }
    }
    if (target.kind === 'invalid')
      return failure('invalidPath', `Unsupported members path: ${operation.path}`);

    if (target.kind === 'filter') {
      if (op === 'add') return failure('invalidPath', 'add cannot target a filtered member');
      if (op === 'remove') {
        if (target.subAttribute)
          return failure('invalidPath', 'A member attribute cannot be removed');
        if (!members.has(target.value)) removedValues.add(target.value);
        members.delete(target.value);
        changed = true;
        continue;
      }
      // replace: the matching member's value.
      if (!members.has(target.value)) return failure('noTarget', 'No member matches the filter');
      let next: string | null = null;
      if (target.subAttribute === 'value') {
        next = typeof value === 'string' && value.length > 0 ? value : null;
      } else if (target.subAttribute === undefined) {
        const values = memberValues(value);
        next = values && values.length === 1 ? values[0] : null;
      } else {
        return failure('invalidPath', 'Only the value of a member can be replaced');
      }
      if (next === null) return invalidMembers;
      members.delete(target.value);
      members.add(next);
      changed = true;
      continue;
    }

    // The whole members attribute.
    if (op === 'remove' && value === undefined) {
      members.clear();
      changed = true;
      continue;
    }
    const values = memberValues(value);
    if (values === null) return invalidMembers;
    changed = true;
    if (op === 'add') for (const id of values) members.add(id);
    else if (op === 'replace') {
      members.clear();
      for (const id of values) members.add(id);
    } else {
      for (const id of values) {
        if (!members.has(id)) removedValues.add(id);
        members.delete(id);
      }
    }
  }
  return {
    ok: true,
    memberIds: [...members],
    changed,
    removedValues: [...removedValues],
    otherOperations,
  };
}

export async function createScimGroup(
  stores: ScimGroupStores,
  tenantId: string,
  input: { displayName: string; externalId: string | null }
): Promise<string> {
  const id = crypto.randomUUID();
  return createGroup(stores.metadata, tenantId, {
    id,
    groupKey: scimGroupKey(id),
    displayName: input.displayName,
    externalId: input.externalId,
    kind: 'scim',
  });
}

/** Writes the group's SCIM attributes (also when unchanged: its version moves with every write). */
export async function updateScimGroup(
  stores: ScimGroupStores,
  tenantId: string,
  existing: InternalGroup,
  input: { displayName: string; externalId: string | null }
): Promise<void> {
  await updateGroup(stores.metadata, tenantId, existing.id, {
    displayName: input.displayName,
    externalId: input.externalId,
  });
  // Group names reach the claims of every member (and of members of its descendants).
  if (stores.cache && input.displayName !== existing.name)
    await bumpTenantRBACCacheVersion(stores.cache, tenantId);
}

export type ScimGroupDeletion = 'deleted' | 'has_children' | 'not_found';

const NO_CHILD_GROUP =
  'NOT EXISTS (SELECT 1 FROM "groups" c WHERE c.tenant_id = ? AND c.parent_group_id = ?)';

/**
 * Deletes the group's definition, unless it has a child group, and then its role assignments.
 *
 * D1 has no interactive transaction (its `transaction` runs the statements one by one), so there
 * the check and both deletes are one `batch`, which D1 runs atomically: the definition is deleted
 * only while no child group exists, and the role assignments only once the definition is gone.
 * PostgreSQL runs them in a real transaction under the group catalog lock, which a concurrent
 * reparenting takes too.
 */
async function deleteScimGroupDefinition(
  metadata: DatabaseAdapter,
  tenantId: string,
  groupId: string
): Promise<ScimGroupDeletion> {
  const deleteDefinition = {
    sql: `DELETE FROM "groups" WHERE tenant_id = ? AND id = ? AND kind = 'scim' AND ${NO_CHILD_GROUP}`,
    params: [tenantId, groupId, tenantId, groupId],
  };
  const deleteRoles = {
    sql: `DELETE FROM group_role_assignments WHERE tenant_id = ? AND group_id = ?
           AND NOT EXISTS (SELECT 1 FROM "groups" g WHERE g.tenant_id = ? AND g.id = ?)`,
    params: [tenantId, groupId, tenantId, groupId],
  };
  // Resource permissions granted to the group go once the definition is gone; a retry (the group
  // already gone) deletes what an interrupted deletion left.
  const deletePermissions = {
    sql: `DELETE FROM resource_permissions WHERE tenant_id = ? AND subject_type = 'group'
           AND subject_id = ? AND NOT EXISTS (SELECT 1 FROM "groups" g WHERE g.tenant_id = ? AND g.id = ?)`,
    params: [tenantId, groupId, tenantId, groupId],
  };
  const hasChild = async (reader: Pick<DatabaseAdapter, 'queryOne'>) =>
    Boolean(
      await reader.queryOne<{ id: string }>(
        `SELECT id FROM "groups" WHERE tenant_id = ? AND parent_group_id = ? LIMIT 1`,
        [tenantId, groupId]
      )
    );
  if (metadata.getType() !== 'postgres') {
    const [deleted] = await metadata.batch([deleteDefinition, deleteRoles, deletePermissions]);
    if (deleted?.rowsAffected) return 'deleted';
    return (await hasChild(metadata)) ? 'has_children' : 'not_found';
  }
  return metadata.transaction<ScimGroupDeletion>(async (tx) => {
    await lockGroupCatalog(tx, tenantId, 'postgres');
    if (await hasChild(tx)) return 'has_children';
    const deleted = await tx.execute(deleteDefinition.sql, deleteDefinition.params);
    if (!deleted.rowsAffected) {
      if (await hasChild(tx)) return 'has_children';
      // Gone already (a retry): what an interrupted deletion left is deleted.
      await tx.execute(deleteRoles.sql, deleteRoles.params);
      await tx.execute(deletePermissions.sql, deletePermissions.params);
      return 'not_found';
    }
    await tx.execute(deleteRoles.sql, deleteRoles.params);
    await tx.execute(deletePermissions.sql, deletePermissions.params);
    return 'deleted';
  });
}

/**
 * Deletes a SCIM group, its role assignments and every membership of it in every account
 * database. A group with child groups is not deleted. The definition and its role assignments go
 * first, atomically (deleteScimGroupDefinition), and the tenant's cached claims are made stale at
 * once: a membership left by a failure part way names no group and grants nothing.
 */
export async function deleteScimGroup(
  stores: ScimGroupStores,
  tenantId: string,
  groupId: string
): Promise<ScimGroupDeletion> {
  const outcome = await deleteScimGroupDefinition(stores.metadata, tenantId, groupId);
  if (outcome !== 'deleted') return outcome;
  if (stores.cache) await bumpTenantRBACCacheVersion(stores.cache, tenantId);
  for (const account of new Set(stores.accounts)) {
    const rows = await account.query<{ subject_id: string }>(
      'SELECT DISTINCT subject_id FROM group_memberships WHERE tenant_id = ? AND group_id = ?',
      [tenantId, groupId]
    );
    await account.execute('DELETE FROM group_memberships WHERE tenant_id = ? AND group_id = ?', [
      tenantId,
      groupId,
    ]);
    if (stores.cache) {
      const cache = stores.cache;
      await forEachConcurrent(
        rows.map((row) => row.subject_id),
        (subjectId) => invalidateSubjectRBACCache(cache, tenantId, subjectId)
      );
    }
  }
  return 'deleted';
}

/**
 * The user's groups for `User.groups`: `direct` for a group the user is in by any membership row
 * in force (whatever its source), `indirect` for each active ancestor of one. Only SCIM groups
 * carry a `$ref` (the others are not SCIM resources).
 */
export async function fetchScimUserGroups(
  metadata: DatabaseAdapter,
  account: DatabaseAdapter,
  tenantId: string,
  userId: string,
  baseUrl: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<NonNullable<ScimUser['groups']>> {
  const rows = await account.query<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM group_memberships
      WHERE tenant_id = ? AND subject_id = ?
        AND lifecycle_state = 'active' AND (starts_at IS NULL OR starts_at <= ?)
        AND (expires_at IS NULL OR expires_at > ?) AND (stale_after IS NULL OR stale_after > ?)`,
    [tenantId, userId, nowSeconds, nowSeconds, nowSeconds]
  );
  if (rows.length === 0) return [];
  const { directGroupIds, effectiveGroupIds } = await resolveGroupAncestors(
    metadata,
    tenantId,
    rows.map((row) => row.group_id)
  );
  const groups: Array<{ id: string; display_name: string; kind: string }> = [];
  for (const batch of rbacIdBatches(effectiveGroupIds)) {
    groups.push(
      ...(await metadata.query<{ id: string; display_name: string; kind: string }>(
        `SELECT id, display_name, kind FROM "groups"
          WHERE tenant_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
        [tenantId, ...batch]
      ))
    );
  }
  return groups
    .sort((a, b) =>
      a.display_name === b.display_name
        ? a.id < b.id
          ? -1
          : 1
        : a.display_name < b.display_name
          ? -1
          : 1
    )
    .map((group) => ({
      value: group.id,
      ...(group.kind === 'scim'
        ? { $ref: `${baseUrl}/scim/v2/Groups/${encodeURIComponent(group.id)}` }
        : {}),
      display: group.display_name,
      type: directGroupIds.has(group.id) ? 'direct' : 'indirect',
    }));
}
