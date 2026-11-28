/**
 * Which service groups a change can reach, and which of them grant roles.
 *
 * A dynamic group's membership feeds every group whose rule references it (`member`), directly
 * or through others: `dependentGroups` is that closure. A group "carries roles" (carries
 * authorization) when it, or one of its canonical ancestors, has an unexpired group role grant,
 * an active, unexpired resource permission granted to the group, or an unexpired ReBAC group
 * userset tuple (`relationships.from_type = 'group'` with `from_relation = 'member'`: its members
 * hold a relation; a legacy row without it is inert), or is named by
 * a group condition
 * (`in_group`, `in_any_group`, `in_all_groups`, `not_in_any_group`) of one of the tenant's enabled
 * policy rules (a rule disabled within the policy service's rule cache lifetime still counts), or
 * any group at all while such a rule uses `same_group` (which compares with the resource's groups
 * at run time, so names none in advance): membership then decides that authorization.
 *
 * A field the person can write themselves (`Field.selfWritable`) must not decide membership of a
 * group that carries roles: `selfWritableGroups` are the groups whose result depends on such a
 * field; saving a rule that makes one of them carry roles is refused, and publication leaves them
 * out (no dynamic row, so no role).
 */
import type { DatabaseAdapter, PreparedStatement, TransactionContext } from '../../db';
import { lockGroupCatalog } from '../group-catalog';
import { TENANT_POLICY_RULES_CACHE_TTL_MS } from '../../types/check-api';

/** A database or a transaction on it (the checks run inside the caller's catalog lock). */
type GroupReader = Pick<TransactionContext, 'query' | 'queryOne'>;
import type { Field, GroupPlan } from './model';
import { answerKey, loadGroupFields, screenSavedAttributeKeys } from './inputs';

const primary = { consistencyClass: 'primary_required' as const };

/** The seeds and every group whose rule depends on one of them, transitively. */
export function dependentGroups(plan: GroupPlan, seeds: Iterable<string>): Set<string> {
  const reached = new Set<string>();
  const pending = [...seeds];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(plan.dependents[id] ?? []));
  }
  return reached;
}

/**
 * The groups whose result depends on a field the person can write themselves. `fields` are the
 * tenant's current fields (loadGroupFields): the mark is read fresh, so a plan saved before the
 * mark existed, or before the field was put on a form, is judged by today's form.
 */
export function selfWritableGroups(
  plan: GroupPlan,
  fields: Record<string, Field> = plan.fields
): Set<string> {
  const seeds = Object.entries(plan.attributes)
    .filter(([field]) => fields[field]?.selfWritable === true)
    .flatMap(([, ids]) => ids);
  return dependentGroups(plan, seeds);
}

/** The parameters that name groups, for each policy-rule condition that names groups. */
const GROUP_CONDITION_PARAMS: Record<string, 'group_id' | 'group_ids'> = {
  in_group: 'group_id',
  in_any_group: 'group_ids',
  in_all_groups: 'group_ids',
  not_in_any_group: 'group_ids',
};

/** The group ids a policy rule's conditions name (in_group / in_any_group / ...). */
export function policyConditionGroupIds(conditions: unknown): string[] {
  if (!Array.isArray(conditions)) return [];
  const ids: string[] = [];
  for (const condition of conditions as Array<{ type?: unknown; params?: unknown }>) {
    const param =
      typeof condition?.type === 'string' ? GROUP_CONDITION_PARAMS[condition.type] : undefined;
    if (!param || !condition.params || typeof condition.params !== 'object') continue;
    const value = (condition.params as Record<string, unknown>)[param];
    for (const id of Array.isArray(value) ? value : [value])
      if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

/** What the tenant's policy rules name: groups by ID, and whether any compares groups at run time. */
interface PolicyRuleGroupReferences {
  named: Set<string>;
  /** A rule uses `same_group`: any group may decide it. */
  anyGroup: boolean;
}

/**
 * The groups named by a group condition of one of the tenant's enabled policy rules, and whether
 * one of them uses `same_group`. A rule disabled less than the policy service's rule cache
 * lifetime ago (TENANT_POLICY_RULES_CACHE_TTL_MS) still counts: checks may still evaluate it.
 * (A fallback: every rule change bumps the tenant's rules version, which the policy service checks
 * before reusing its cache; this covers a failed bump or a reader without the version.) A
 * rule whose conditions are not readable JSON is not evaluated by checks (no grant from the
 * rules), so it names none.
 */
async function groupsNamedByPolicyRules(
  db: Pick<TransactionContext, 'query'>,
  tenantId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<PolicyRuleGroupReferences> {
  const rows = await db.query<{ conditions: string | null }>(
    'SELECT conditions FROM policy_rules WHERE tenant_id = ? AND (enabled = 1 OR updated_at > ?)',
    [tenantId, nowSeconds - Math.ceil(TENANT_POLICY_RULES_CACHE_TTL_MS / 1000)],
    primary
  );
  const references: PolicyRuleGroupReferences = { named: new Set(), anyGroup: false };
  for (const row of rows) {
    let conditions: unknown;
    try {
      conditions = JSON.parse(row.conditions ?? '[]');
    } catch {
      continue;
    }
    for (const id of policyConditionGroupIds(conditions)) references.named.add(id);
    if (
      Array.isArray(conditions) &&
      conditions.some((condition) => (condition as { type?: unknown })?.type === 'same_group')
    )
      references.anyGroup = true;
  }
  return references;
}

/**
 * Whether the group, or one of its ancestors (whose members it counts among), is named by a group
 * condition of an enabled policy rule, or any group may decide one (`same_group`): changing its
 * membership then changes what the rules decide.
 */
export async function groupReferencedByPolicyRules(
  db: Pick<TransactionContext, 'query'>,
  tenantId: string,
  groupId: string,
  known?: PolicyRuleGroupReferences
): Promise<boolean> {
  const { named, anyGroup } = known ?? (await groupsNamedByPolicyRules(db, tenantId));
  if (anyGroup) return true;
  if (!named.size) return false;
  const ancestors = await db.query<{ id: string }>(
    `WITH RECURSIVE ancestors(id, parent_group_id) AS (
      SELECT id, parent_group_id FROM "groups" WHERE tenant_id = ? AND id = ?
      UNION SELECT g.id, g.parent_group_id FROM "groups" g JOIN ancestors a ON g.id = a.parent_group_id
      WHERE g.tenant_id = ?
    ) SELECT id FROM ancestors`,
    [tenantId, groupId, tenantId],
    primary
  );
  return named.has(groupId) || ancestors.some((node) => named.has(node.id));
}

/**
 * Whether a service-group field (such as `custom.team`) decides, through the tenant's saved
 * service-group rules (the groups that read it and every group depending on them), a group that
 * carries authorization (groupsCarryingRoles: a role grant or resource permission on it or an
 * ancestor, or a policy rule naming it, or `same_group`). Making such a field one users write
 * themselves would let them decide that authorization.
 */
export async function fieldDecidesPolicyRuleGroup(
  db: GroupReader,
  tenantId: string,
  field: string
): Promise<boolean> {
  const [catalog] = await db.query<{ plan_json: string }>(
    'SELECT plan_json FROM service_group_catalog WHERE tenant_id = ?',
    [tenantId],
    primary
  );
  if (!catalog) return false;
  const plan = JSON.parse(catalog.plan_json) as GroupPlan;
  const seeds = plan.attributes?.[field] ?? [];
  if (!seeds.length) return false;
  return (await groupsCarryingRoles(db, tenantId, dependentGroups(plan, seeds))).size > 0;
}

/**
 * The ids among `ids` that carry authorization: an unexpired role grant, an active and unexpired
 * resource permission granted to the group (`subject_type = 'group'`), or an unexpired ReBAC group
 * userset tuple (`relationships`, `from_type = 'group'`, `from_relation = 'member'`; a legacy row
 * without it grants nothing), on the group or an ancestor; or the
 * group or an ancestor named by a group condition of an enabled policy rule.
 */
export async function groupsCarryingRoles(
  db: GroupReader,
  tenantId: string,
  ids: Iterable<string>,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<Set<string>> {
  const carrying = new Set<string>();
  let named: PolicyRuleGroupReferences | undefined;
  for (const id of new Set(ids)) {
    const row = await db.queryOne<{ id: string }>(
      `WITH RECURSIVE ancestors(id, parent_group_id) AS (
        SELECT id, parent_group_id FROM "groups" WHERE tenant_id = ? AND id = ?
        UNION SELECT g.id, g.parent_group_id FROM "groups" g JOIN ancestors a ON g.id = a.parent_group_id
        WHERE g.tenant_id = ?
      ) SELECT g.id FROM ancestors a JOIN group_role_assignments g
          ON g.group_id = a.id AND g.tenant_id = ?
        WHERE g.expires_at IS NULL OR g.expires_at > ?
        UNION ALL
        SELECT p.id FROM ancestors a JOIN resource_permissions p
          ON p.subject_type = 'group' AND p.subject_id = a.id AND p.tenant_id = ?
        WHERE p.is_active = 1 AND (p.expires_at IS NULL OR p.expires_at > ?)
        UNION ALL
        SELECT r.id FROM ancestors a JOIN relationships r
          ON r.from_type = 'group' AND r.from_relation = 'member' AND r.from_id = a.id
            AND r.tenant_id = ?
        WHERE r.expires_at IS NULL OR r.expires_at > ?
        LIMIT 1`,
      [tenantId, id, tenantId, tenantId, nowSeconds, tenantId, nowSeconds, tenantId, nowSeconds],
      primary
    );
    if (row) {
      carrying.add(id);
      continue;
    }
    named ??= await groupsNamedByPolicyRules(db, tenantId, nowSeconds);
    if (await groupReferencedByPolicyRules(db, tenantId, id, named)) carrying.add(id);
  }
  return carrying;
}

/**
 * Whether the group or one of its descendants is a service group whose result depends on a field
 * the person writes themselves (current catalog and fields): a role granted to the group, or to a
 * parent it is moved under, would then be decided by that field.
 */
export async function subtreeHasSelfWritableDynamicGroup(
  db: GroupReader,
  tenantId: string,
  groupId: string
): Promise<boolean> {
  const row = await db.queryOne<{ plan_json: string }>(
    'SELECT plan_json FROM service_group_catalog WHERE tenant_id = ?',
    [tenantId],
    primary
  );
  if (!row) return false;
  const plan = JSON.parse(row.plan_json) as GroupPlan;
  const tainted = selfWritableGroups(plan, await loadGroupFields(db, tenantId));
  if (!tainted.size) return false;
  const subtree = await db.query<{ id: string }>(
    `WITH RECURSIVE subtree(id) AS (
      SELECT id FROM "groups" WHERE tenant_id = ? AND id = ?
      UNION SELECT g.id FROM "groups" g JOIN subtree s ON g.parent_group_id = s.id
      WHERE g.tenant_id = ?
    ) SELECT id FROM subtree`,
    [tenantId, groupId, tenantId],
    primary
  );
  return subtree.some((node) => tainted.has(node.id));
}

/** A condition of a write that holds only while what its check read still holds. */
export interface GroupCatalogFence {
  sql: string;
  params: unknown[];
}

/**
 * The tenant authorization version, as a write's check reads it: the `policy_rules_version`
 * counter (null before its first write). Policy rule changes, ReBAC group userset writes and
 * service-group rule saves each raise it in the batch of their write, fenced on the value their
 * check read (authorizationVersionFence): of two such writes whose checks ran concurrently, the
 * one that commits second changes nothing (409 `group_version_conflict`). The policy service
 * reloads its cached rules when it changes (an extra raise only costs a reload).
 */
export async function readAuthorizationVersion(
  db: Pick<TransactionContext, 'queryOne'>,
  tenantId: string
): Promise<number | null> {
  const row = await db.queryOne<{ version: number | string }>(
    'SELECT version FROM policy_rules_version WHERE tenant_id = ?',
    [tenantId],
    primary
  );
  return row ? Number(row.version) : null;
}

/** The condition that the tenant authorization version is still the one read. */
export function authorizationVersionFence(
  tenantId: string,
  version: number | null
): GroupCatalogFence {
  return version === null
    ? {
        sql: 'NOT EXISTS (SELECT 1 FROM policy_rules_version WHERE tenant_id = ?)',
        params: [tenantId],
      }
    : {
        sql: 'EXISTS (SELECT 1 FROM policy_rules_version WHERE tenant_id = ? AND version = ?)',
        params: [tenantId, version],
      };
}

/**
 * The statement raising the tenant authorization version when `condition` holds (put it last in
 * the batch of the write it belongs to).
 */
export function raiseAuthorizationVersion(
  tenantId: string,
  condition: GroupCatalogFence
): PreparedStatement {
  return {
    sql: `INSERT INTO policy_rules_version (tenant_id, version) SELECT ?, 1 WHERE ${condition.sql}
      ON CONFLICT (tenant_id) DO UPDATE SET version = policy_rules_version.version + 1`,
    params: [tenantId, ...condition.params],
  };
}

/** The outcome of a guarded ReBAC group userset write (guardGroupUsersetWrite). */
export type GroupUsersetWriteOutcome<T> =
  | { kind: 'written'; result: T }
  | { kind: 'group_self_writable_attribute' }
  | { kind: 'group_version_conflict' };

/**
 * Writes (creates, refreshes or deletes) a ReBAC group userset tuple on the group.
 *
 * A create or refresh (`refuseSelfWritable`) is refused when the group or one of its
 * descendants is a service group decided by an attribute people write themselves (the userset
 * would let them decide the relation, as a role on the group would):
 * `group_self_writable_attribute`.
 *
 * `prepare` reads what it needs and returns the write's statements (none: nothing to write),
 * each with `fence.sql` in its WHERE; the first one's row count says whether it applied. The
 * fence holds while the service-group catalog revision and the tenant authorization version are
 * the ones the check read. The statements and the raise of that version run together: one batch
 * on D1, one transaction under the group catalog lock on PostgreSQL. A write whose fence no
 * longer holds is `group_version_conflict` (retry).
 */
export async function guardGroupUsersetWrite<T>(
  db: Pick<DatabaseAdapter, 'transaction' | 'getType' | 'batch' | 'queryOne' | 'query'>,
  tenantId: string,
  groupId: string,
  prepare: (
    reader: Pick<TransactionContext, 'query' | 'queryOne'>,
    fence: GroupCatalogFence
  ) => Promise<{ statements: PreparedStatement[]; result: T }>,
  options: { refuseSelfWritable?: boolean } = {}
): Promise<GroupUsersetWriteOutcome<T>> {
  const checked = async (reader: Pick<TransactionContext, 'query' | 'queryOne'>) => {
    const catalog = await reader.queryOne<{ revision: number | string }>(
      'SELECT revision FROM service_group_catalog WHERE tenant_id = ?',
      [tenantId],
      primary
    );
    const version = await readAuthorizationVersion(reader, tenantId);
    if (
      options.refuseSelfWritable !== false &&
      (await subtreeHasSelfWritableDynamicGroup(reader, tenantId, groupId))
    )
      return null;
    const catalogFence: GroupCatalogFence = catalog
      ? {
          sql: 'EXISTS (SELECT 1 FROM service_group_catalog WHERE tenant_id = ? AND revision = ?)',
          params: [tenantId, Number(catalog.revision)],
        }
      : {
          sql: 'NOT EXISTS (SELECT 1 FROM service_group_catalog WHERE tenant_id = ?)',
          params: [tenantId],
        };
    const versionFence = authorizationVersionFence(tenantId, version);
    return {
      sql: `${catalogFence.sql} AND ${versionFence.sql}`,
      params: [...catalogFence.params, ...versionFence.params],
    };
  };
  const finish = (
    prepared: { statements: PreparedStatement[]; result: T },
    rows: number | undefined
  ): GroupUsersetWriteOutcome<T> =>
    prepared.statements.length > 0 && rows === 0
      ? { kind: 'group_version_conflict' }
      : { kind: 'written', result: prepared.result };

  if (db.getType() === 'postgres') {
    return db.transaction(async (tx) => {
      await lockGroupCatalog(tx, tenantId, 'postgres');
      const fence = await checked(tx);
      if (!fence) return { kind: 'group_self_writable_attribute' as const };
      const prepared = await prepare(tx, fence);
      if (prepared.statements.length === 0) return finish(prepared, undefined);
      const results = [];
      for (const statement of [...prepared.statements, raiseAuthorizationVersion(tenantId, fence)])
        results.push(await tx.execute(statement.sql, statement.params));
      return finish(prepared, results[0]?.rowsAffected);
    });
  }
  // D1: no lock; the batch is one transaction, and the fence is what makes it conditional.
  const fence = await checked(db);
  if (!fence) return { kind: 'group_self_writable_attribute' };
  const prepared = await prepare(db, fence);
  if (prepared.statements.length === 0) return finish(prepared, undefined);
  const results = await db.batch([
    ...prepared.statements,
    raiseAuthorizationVersion(tenantId, fence),
  ]);
  return finish(prepared, results[0]?.rowsAffected);
}

/**
 * The custom attribute a screen change would newly let people write themselves while it decides,
 * through a service group, a group a policy rule names (fieldDecidesPolicyRuleGroup), or null.
 * `before` / `after` are the screen's parts as saved and as they will be, each `null` while the
 * screen is (or will be) inactive. An attribute already self-writable (registration form, another
 * screen) is not newly so.
 */
export async function screenChangeSelfWritablePolicyField(
  db: GroupReader,
  tenantId: string,
  before: unknown,
  after: unknown
): Promise<string | null> {
  const already = before === null ? new Set<string>() : screenSavedAttributeKeys(before);
  const added = [...(after === null ? [] : screenSavedAttributeKeys(after))].filter(
    (key) => !already.has(key)
  );
  if (!added.length) return null;
  const fields = await loadGroupFields(db, tenantId);
  for (const [name, field] of Object.entries(fields)) {
    if (!name.startsWith('custom.') || field.selfWritable) continue;
    if (!added.includes(answerKey(name.slice('custom.'.length)))) continue;
    if (await fieldDecidesPolicyRuleGroup(db, tenantId, name)) return name;
  }
  return null;
}

/**
 * The groups whose membership a service group decides: the catalog-owned service groups
 * (canonical.ts: kind dynamic, key `dynamic:<id>`, whatever their state) and every group above
 * one (a member of the service group counts as a member of its ancestors). `any` is whether the
 * tenant has a service group at all. A policy rule may not rely on non-membership of these groups
 * (dynamic memberships are eventually consistent: a "not a member" may be stale).
 */
export async function serviceGroupDecidedGroups(
  db: Pick<TransactionContext, 'query'>,
  tenantId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<{ affected: Set<string>; any: boolean; roles: Set<string> }> {
  // With the names of the roles granted to those groups by grants in force (as
  // group-role-assignments.ts reads them: unexpired); extending an expired grant again goes
  // through the grant-side guard (groupRoleGrantConflictsWithDenyRules).
  const rows = await db.query<{
    id: string;
    owned: number | boolean | string;
    role_name: string | null;
  }>(
    `WITH RECURSIVE up(id, parent_group_id, owned) AS (
      SELECT id, parent_group_id, 1 FROM "groups"
       WHERE tenant_id = ? AND kind = 'dynamic' AND group_key = 'dynamic:' || id
      UNION SELECT g.id, g.parent_group_id, 0 FROM "groups" g JOIN up ON g.id = up.parent_group_id
       WHERE g.tenant_id = ?
    ) SELECT up.id, up.owned, r.name AS role_name FROM up
      LEFT JOIN group_role_assignments a ON a.group_id = up.id AND a.tenant_id = ?
        AND (a.expires_at IS NULL OR a.expires_at > ?)
      LEFT JOIN roles r ON r.id = a.role_id AND r.tenant_id = a.tenant_id`,
    [tenantId, tenantId, tenantId, nowSeconds],
    primary
  );
  return {
    affected: new Set(rows.map((row) => row.id)),
    any: rows.some((row) => Number(row.owned) === 1 || row.owned === true),
    roles: new Set(rows.flatMap((row) => (row.role_name ? [row.role_name] : []))),
  };
}

/** The role names a policy rule's role conditions name (has_role / has_any_role / has_all_roles). */
export function policyConditionRoleNames(conditions: unknown): string[] {
  if (!Array.isArray(conditions)) return [];
  const names: string[] = [];
  for (const condition of conditions as Array<{ type?: unknown; params?: unknown }>) {
    const params = condition?.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object') continue;
    if (condition.type === 'has_role' && typeof params.role === 'string') names.push(params.role);
    if (
      (condition.type === 'has_any_role' || condition.type === 'has_all_roles') &&
      Array.isArray(params.roles)
    )
      for (const name of params.roles) if (typeof name === 'string') names.push(name);
  }
  return names;
}

/**
 * Whether granting the role to the group would let a deny rule rely on a role a service group
 * decides: an enabled deny rule (or one disabled within the policy service's rule cache
 * lifetime) names the role, and the group is a service group or above one (a stale "not a
 * member" would then skip the deny and let a later allow pass).
 */
export async function groupRoleGrantConflictsWithDenyRules(
  db: Pick<TransactionContext, 'query'>,
  tenantId: string,
  groupId: string,
  roleName: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const rules = await db.query<{ conditions: string | null }>(
    `SELECT conditions FROM policy_rules
      WHERE tenant_id = ? AND effect = 'deny' AND (enabled = 1 OR updated_at > ?)`,
    [tenantId, nowSeconds - Math.ceil(TENANT_POLICY_RULES_CACHE_TTL_MS / 1000)],
    primary
  );
  const named = rules.some((rule) => {
    try {
      return policyConditionRoleNames(JSON.parse(rule.conditions ?? '[]')).includes(roleName);
    } catch {
      return false;
    }
  });
  if (!named) return false;
  return (await serviceGroupDecidedGroups(db, tenantId)).affected.has(groupId);
}

/**
 * Whether any enabled service group of the current catalog depends (itself, or through a group
 * its rule references) on a field the person writes themselves: a `same_group` rule, which may
 * compare with any group, would then be decided by that field.
 */
export async function tenantHasSelfWritableDynamicGroup(
  db: GroupReader,
  tenantId: string
): Promise<boolean> {
  const row = await db.queryOne<{ plan_json: string }>(
    'SELECT plan_json FROM service_group_catalog WHERE tenant_id = ?',
    [tenantId],
    primary
  );
  if (!row) return false;
  const plan = JSON.parse(row.plan_json) as GroupPlan;
  if (!Array.isArray(plan.groups) || !plan.groups.length) return false;
  const tainted = selfWritableGroups(plan, await loadGroupFields(db, tenantId));
  return plan.groups.some((group) => group.enabled && tainted.has(group.id));
}

/** Groups whose result depends on a self-writable field and that carry roles. */
export async function selfWritableRoleGroups(
  db: GroupReader,
  tenantId: string,
  plan: GroupPlan,
  fields: Record<string, Field> = plan.fields
): Promise<Set<string>> {
  const tainted = selfWritableGroups(plan, fields);
  return tainted.size ? groupsCarryingRoles(db, tenantId, tainted) : new Set();
}
