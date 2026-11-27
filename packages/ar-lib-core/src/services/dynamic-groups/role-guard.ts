/**
 * Which service groups a change can reach, and which of them grant roles.
 *
 * A dynamic group's membership feeds every group whose rule references it (`member`), directly
 * or through others: `dependentGroups` is that closure. A group "carries roles" when it, or one of
 * its canonical ancestors, has an unexpired group role grant: membership then grants those roles.
 *
 * A field the person can write themselves (`Field.selfWritable`) must not decide membership of a
 * group that carries roles: `selfWritableGroups` are the groups whose result depends on such a
 * field; saving a rule that makes one of them carry roles is refused, and publication leaves them
 * out (no dynamic row, so no role).
 */
import type { TransactionContext } from '../../db';

/** A database or a transaction on it (the checks run inside the caller's catalog lock). */
type GroupReader = Pick<TransactionContext, 'query' | 'queryOne'>;
import type { Field, GroupPlan } from './model';
import { loadGroupFields } from './inputs';

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

/** The ids among `ids` that carry roles (an unexpired grant on the group or an ancestor). */
export async function groupsCarryingRoles(
  db: GroupReader,
  tenantId: string,
  ids: Iterable<string>,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<Set<string>> {
  const carrying = new Set<string>();
  for (const id of new Set(ids)) {
    const row = await db.queryOne<{ id: string }>(
      `WITH RECURSIVE ancestors(id, parent_group_id) AS (
        SELECT id, parent_group_id FROM "groups" WHERE tenant_id = ? AND id = ?
        UNION SELECT g.id, g.parent_group_id FROM "groups" g JOIN ancestors a ON g.id = a.parent_group_id
        WHERE g.tenant_id = ?
      ) SELECT g.id FROM ancestors a JOIN group_role_assignments g
          ON g.group_id = a.id AND g.tenant_id = ?
        WHERE g.expires_at IS NULL OR g.expires_at > ? LIMIT 1`,
      [tenantId, id, tenantId, tenantId, nowSeconds],
      primary
    );
    if (row) carrying.add(id);
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
