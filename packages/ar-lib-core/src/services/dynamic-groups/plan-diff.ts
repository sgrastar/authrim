/**
 * Which service groups' membership rules differ between two saved plans (catalog revisions).
 *
 * Only what decides membership is compared: whether the group is enabled, its condition, its SCIM
 * role, and the definition of every field its condition reads. Presentation (display name,
 * description, key) is not. A group whose rule references a changed group (`member`), directly or
 * through others, is changed too; a group of the older plan that the newer one no longer has is
 * changed.
 */
import type { Expression, GroupPlan, ServiceGroup } from './model';
import { stableStringify } from '../../utils/stable-json';

function fieldsOf(expression: Expression | null, into = new Set<string>()): Set<string> {
  if (!expression) return into;
  switch (expression.op) {
    case 'attribute':
      into.add(expression.field);
      break;
    case 'all':
    case 'any':
      for (const arg of expression.args) fieldsOf(arg, into);
      break;
    case 'not':
      fieldsOf(expression.arg, into);
      break;
    case 'member':
      break;
  }
  return into;
}

function membersOf(expression: Expression | null, into = new Set<string>()): Set<string> {
  if (!expression) return into;
  switch (expression.op) {
    case 'member':
      into.add(expression.groupId);
      break;
    case 'all':
    case 'any':
      for (const arg of expression.args) membersOf(arg, into);
      break;
    case 'not':
      membersOf(expression.arg, into);
      break;
    case 'attribute':
      break;
  }
  return into;
}

/**
 * A stable text of what decides the group's membership under the plan: key order does not count
 * (stableStringify, as the service-groups API decides a rule change), so a reordered condition
 * keeps the published memberships.
 */
function ruleSignature(plan: GroupPlan, group: ServiceGroup): string {
  const fields = [...fieldsOf(group.condition)].sort();
  return stableStringify({
    enabled: group.enabled,
    condition: group.condition,
    scimRoleId: group.scimRoleId ?? null,
    fields: fields.map((field) => [field, plan.fields?.[field] ?? null]),
  });
}

/** The ids of the groups of `before` whose membership rule is not the same under `after`. */
export function changedServiceGroups(before: GroupPlan, after: GroupPlan): Set<string> {
  const current = new Map((after.groups ?? []).map((group) => [group.id, group]));
  const changed = new Set<string>();
  for (const group of before.groups ?? []) {
    const next = current.get(group.id);
    if (!next || ruleSignature(before, group) !== ruleSignature(after, next)) changed.add(group.id);
  }
  // A group whose rule references a changed group (as published) is changed too.
  const dependents = new Map<string, string[]>();
  for (const group of before.groups ?? [])
    for (const member of membersOf(group.condition))
      dependents.set(member, [...(dependents.get(member) ?? []), group.id]);
  const pending = [...changed];
  for (let id = pending.pop(); id !== undefined; id = pending.pop())
    for (const dependent of dependents.get(id) ?? [])
      if (!changed.has(dependent)) {
        changed.add(dependent);
        pending.push(dependent);
      }
  return changed;
}
