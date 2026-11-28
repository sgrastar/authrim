/**
 * A tenant's custom policy rules (`policy_rules`), as the Check API and the Admin API's policy
 * simulation both read and evaluate them, so that a simulation shows what checks decide.
 */

import {
  roleAssignmentHolds,
  type DatabaseAdapter,
  type PolicyEvaluationContext,
  type PolicyEvaluationResult,
  type PolicyEvaluator,
} from '@authrim/ar-lib-core';
import {
  ATTRIBUTE_CONDITION_TYPES,
  CHECK_API_CONDITION_TYPES,
  GROUP_CONDITION_TYPES,
  PolicyEngine,
  validatePolicyConditions,
} from './engine';
import type {
  PolicyCondition,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  SubjectRole,
} from './types';

/** A custom rule, with the resource types and actions it applies to (empty: any). */
export interface TenantPolicyRule extends PolicyRule {
  resourceTypes: string[];
  actions: string[];
}

/** A `policy_rules` row, as stored. */
export interface TenantPolicyRuleRow {
  id: string;
  name: string;
  description: string | null;
  priority: number | string;
  effect: string;
  resource_types: string | null;
  actions: string | null;
  conditions: string | null;
}

/** A stored target list: null is "any" (the Admin API stores it when none is sent). */
function stringArray(raw: string | null): string[] | null {
  if (raw === null || raw === undefined) return [];
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * A stored rule as the engine uses it, or null when it cannot be evaluated as written (its
 * effect, target lists, priority or conditions are not valid).
 */
export function toTenantPolicyRule(row: TenantPolicyRuleRow): TenantPolicyRule | null {
  if (row.effect !== 'allow' && row.effect !== 'deny') return null;
  const resourceTypes = stringArray(row.resource_types);
  const actions = stringArray(row.actions);
  // The Admin API always stores an array: anything else (such as '' or null) is not a rule.
  if (typeof row.conditions !== 'string' || row.conditions === '') return null;
  const priority =
    typeof row.priority === 'number'
      ? row.priority
      : /^-?\d+$/.test(row.priority)
        ? Number(row.priority)
        : Number.NaN;
  // An invalid priority would move a deny after the allows it should come before.
  if (!Number.isSafeInteger(priority)) return null;
  let conditions: PolicyCondition[];
  try {
    const parsed = JSON.parse(row.conditions) as unknown;
    if (
      validatePolicyConditions(parsed, CHECK_API_CONDITION_TYPES, {
        expiredAttributesKnown: false,
      }) !== null
    ) {
      return null;
    }
    conditions = parsed as PolicyCondition[];
  } catch {
    return null;
  }
  if (!resourceTypes || !actions) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    priority,
    effect: row.effect,
    conditions,
    resourceTypes,
    actions,
  };
}

/**
 * The tenant's enabled rules, highest priority first, read fresh from `policy_rules`, and the ids
 * of those that cannot be evaluated as stored (toTenantPolicyRule). While any is unusable, checks
 * grant nothing from the rules: skipping one could skip a deny a later allow would get past.
 */
export async function readTenantPolicyRules(
  db: Pick<DatabaseAdapter, 'query'>,
  tenantId: string
): Promise<{ rules: TenantPolicyRule[]; unusable: string[] }> {
  const rows = await db.query<TenantPolicyRuleRow>(
    `SELECT id, name, description, priority, effect, resource_types, actions, conditions
       FROM policy_rules
      WHERE tenant_id = ? AND enabled = 1
      ORDER BY priority DESC`,
    [tenantId]
  );
  const rules: TenantPolicyRule[] = [];
  const unusable: string[] = [];
  for (const row of rows) {
    const rule = toTenantPolicyRule(row);
    if (rule) rules.push(rule);
    else unusable.push(row.id);
  }
  return { rules, unusable };
}

/** Why the rules are not evaluated when the subject's groups are unknown. */
const GROUPS_UNKNOWN_REASON =
  "A rule uses group conditions, which need the subject's groups, and they are unknown";

/**
 * Whether the rule names a group whose membership is unknown, or compares with the resource's
 * groups (`same_group`) while one of them is unknown: it cannot be evaluated as written then.
 */
function ruleReadsUnknownGroups(rule: TenantPolicyRule, context: PolicyContext): boolean {
  const unknown = new Set(context.subject.unknownGroupIds ?? []);
  if (!unknown.size) return false;
  return rule.conditions.some((condition) => {
    if (condition.type === 'same_group')
      return (context.resource.groupIds ?? []).some((id) => unknown.has(id));
    if (!GROUP_CONDITION_TYPES.has(condition.type)) return false;
    const named =
      condition.type === 'in_group'
        ? [condition.params.group_id]
        : ((condition.params.group_ids as unknown[] | undefined) ?? []);
    return named.some((id) => typeof id === 'string' && unknown.has(id));
  });
}

/** The groups service groups decide (serviceGroupDecidedGroups in ar-lib-core). */
export interface ServiceGroupDecided {
  affected: ReadonlySet<string>;
  /** The tenant has a service group at all. */
  any: boolean;
  /** The names of the roles granted to those groups (a member of the service group gets them). */
  roles?: ReadonlySet<string>;
}

const ROLE_CONDITION_NAMES: ReadonlySet<string> = new Set([
  'has_role',
  'has_any_role',
  'has_all_roles',
]);

/**
 * Why a rule relies on non-membership of a group a service group decides, or null. Dynamic
 * memberships are eventually consistent, so a "not a member" may be stale: a rule may use them
 * only where a wrong "not a member" merely loses access. Refused: `not_in_any_group` naming such a
 * group, and a deny rule's `in_group` / `in_any_group` / `in_all_groups` naming one, or its
 * `same_group` while the tenant has any service group.
 */
export function dynamicGroupConditionProblem(
  rule: { effect: string; conditions: readonly PolicyCondition[] },
  decided: ServiceGroupDecided
): string | null {
  for (const condition of rule.conditions) {
    const named =
      condition.type === 'in_group'
        ? [condition.params.group_id]
        : GROUP_CONDITION_TYPES.has(condition.type)
          ? ((condition.params.group_ids as unknown[] | undefined) ?? [])
          : [];
    const dynamic = named.find(
      (id): id is string => typeof id === 'string' && decided.affected.has(id)
    );
    if (condition.type === 'not_in_any_group' && dynamic !== undefined)
      return `not_in_any_group names ${dynamic}, whose membership a service group decides`;
    if (rule.effect !== 'deny') continue;
    if (ROLE_CONDITION_NAMES.has(condition.type)) {
      const roles =
        condition.type === 'has_role'
          ? [condition.params.role]
          : ((condition.params.roles as unknown[] | undefined) ?? []);
      const decidedRole = roles.find(
        (name): name is string => typeof name === 'string' && (decided.roles?.has(name) ?? false)
      );
      if (decidedRole !== undefined)
        return `A deny rule's ${condition.type} names ${decidedRole}, a role granted through a service group`;
    }
    if (condition.type === 'same_group' && decided.any)
      return 'A deny rule compares with the resource groups (same_group) while service groups decide memberships';
    if (dynamic !== undefined)
      return `A deny rule's ${condition.type} names ${dynamic}, whose membership a service group decides`;
  }
  return null;
}

/**
 * Whether checking the rules needs what service groups decide: a group condition, or a deny
 * rule's role condition (the role may be granted through a service group).
 */
export function tenantRulesNeedServiceGroups(rules: readonly TenantPolicyRule[]): boolean {
  return (
    tenantRulesUseGroups(rules) ||
    rules.some(
      (rule) =>
        rule.effect === 'deny' &&
        rule.conditions.some((condition) => ROLE_CONDITION_NAMES.has(condition.type))
    )
  );
}

/** Whether any of the rules reads the subject's groups (a group condition). */
export function tenantRulesUseGroups(rules: readonly TenantPolicyRule[]): boolean {
  return rules.some((rule) =>
    rule.conditions.some((condition) => GROUP_CONDITION_TYPES.has(condition.type))
  );
}

/**
 * Why a tenant's rules cannot be used for checks under its settings, or null when they can.
 * Without the subject's verified attributes, a deny on one of them could never apply and a
 * later allow would get past it. Likewise, rules with group conditions need the subject's
 * groups: when those are unknown (`subjectGroupsUnknown`), the rules are not used.
 */
export function tenantRulesUnusableReason(
  rules: readonly TenantPolicyRule[],
  settings: {
    verifiedAttributes: boolean;
    subjectGroupsUnknown?: boolean;
    /**
     * The groups service groups decide. Required (fail closed) when the rules use group
     * conditions: a rule relying on their non-membership makes the rules unusable.
     */
    serviceGroupDecided?: ServiceGroupDecided;
  }
): string | null {
  if (settings.subjectGroupsUnknown && tenantRulesUseGroups(rules)) return GROUPS_UNKNOWN_REASON;
  if (
    !settings.verifiedAttributes &&
    rules.some(
      (rule) =>
        rule.effect === 'deny' &&
        rule.conditions.some((condition) => ATTRIBUTE_CONDITION_TYPES.has(condition.type))
    )
  ) {
    return 'A deny rule uses verified attributes, which the settings keep out of the checks';
  }
  if (tenantRulesNeedServiceGroups(rules)) {
    if (!settings.serviceGroupDecided)
      return 'The rules use group or deny role conditions and the service groups could not be read';
    for (const rule of rules) {
      const problem = dynamicGroupConditionProblem(rule, settings.serviceGroupDecided);
      if (problem) return `Rule ${rule.id}: ${problem}`;
    }
  }
  return null;
}

const ROLE_CONDITION_TYPES = new Set(['has_role', 'has_any_role', 'has_all_roles']);

/**
 * The subject's role assignments that hold for the request's target: global ones, one for the
 * resource's groups (`group:<id>`), and one for the resource itself (`resource:<type>:<id>`
 * or `resource:<id>`). An assignment for another group or resource does not count.
 */
function rolesForTarget(roles: readonly SubjectRole[], context: PolicyContext): SubjectRole[] {
  const { groupIds, id, type } = context.resource;
  // The same matching as the role check of the Check API (roleAssignmentHolds).
  return roles.filter((role) =>
    roleAssignmentHolds(
      { scope: role.scope, scopeTarget: role.scopeTarget },
      { groupIds, resourceType: type, resourceId: id }
    )
  );
}

function hasOwnAttribute(attributes: Record<string, unknown> | undefined, name: unknown): boolean {
  return (
    attributes !== undefined &&
    typeof name === 'string' &&
    Object.prototype.hasOwnProperty.call(attributes, name)
  );
}

/** Whether a deny needs a target the request does not give (so it could never apply). */
function denyNeedsMissingTarget(rule: TenantPolicyRule, context: PolicyContext): string | null {
  if (rule.effect !== 'deny') return null;
  for (const condition of rule.conditions) {
    if (condition.type === 'is_resource_owner' && !context.resource.ownerId) {
      return 'the resource owner';
    }
    if (GROUP_CONDITION_TYPES.has(condition.type) && context.subject.groupIds === undefined) {
      return "the subject's groups";
    }
    if (condition.type === 'same_group' && !context.resource.groupIds?.length) {
      return "the resource's groups";
    }
    // A deny on a resource attribute the resource does not carry could never apply (the
    // attributes may not have been registered, or could not be read): fail closed.
    if (
      (condition.type === 'resource_attribute_equals' ||
        condition.type === 'resource_attribute_in') &&
      !hasOwnAttribute(context.resource.attributes, condition.params.attribute)
    ) {
      return `the resource attribute ${String(condition.params.attribute)}`;
    }
    if (ROLE_CONDITION_TYPES.has(condition.type)) {
      const scope = condition.params.scope;
      if (scope === 'group' && !context.resource.groupIds?.length) return "the resource's groups";
      if (scope === 'resource' && !context.resource.id) return 'the resource';
    }
  }
  return null;
}

/**
 * Evaluate a tenant's rules for one request: only the rules for its resource type and action,
 * with the subject's roles that hold for the request's target, and no grant when one of their
 * denies needs a target the request does not give (it could not apply, and a later allow would
 * get past it). No matching rule: not granted.
 */
export function evaluateTenantRules(
  rules: readonly TenantPolicyRule[],
  context: PolicyContext
): PolicyDecision {
  const applicable = rules.filter(
    (rule) =>
      (rule.resourceTypes.length === 0 || rule.resourceTypes.includes(context.resource.type)) &&
      (rule.actions.length === 0 || rule.actions.includes(context.action.name))
  );
  // A rule naming a group whose membership is unknown: neither its allow nor its deny can be
  // decided, so nothing is granted from the rules (a later allow would get past its deny).
  for (const rule of applicable) {
    if (ruleReadsUnknownGroups(rule, context)) {
      return { allowed: false, reason: GROUPS_UNKNOWN_REASON, decidedBy: rule.id };
    }
  }
  for (const rule of applicable) {
    const missing = denyNeedsMissingTarget(rule, context);
    if (missing) {
      return {
        allowed: false,
        reason: `A deny rule needs ${missing}, which the check did not give`,
        decidedBy: rule.id,
      };
    }
  }
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRules(applicable);
  return engine.evaluate({
    ...context,
    subject: {
      ...context.subject,
      roles: rolesForTarget(context.subject.roles ?? [], context),
    },
  });
}

/**
 * A permission check's context (as the Check API and the admin access check give it) as the
 * tenant's rules see it. `subjectGroupIds` undefined stays undefined: memberships unknown.
 */
export function toTenantPolicyContext(context: PolicyEvaluationContext): PolicyContext {
  return {
    subject: {
      id: context.subjectId,
      roles: (context.subjectRoles ?? []).map((role) => ({
        name: role.name,
        scope: role.scope,
        scopeTarget: role.scopeTarget,
        expiresAt: role.expiresAt,
      })),
      groupIds: context.subjectGroupIds,
      unknownGroupIds: context.subjectUnknownGroupIds,
      verifiedAttributes: context.verifiedAttributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
        source: attribute.source,
      })),
    } as PolicyContext['subject'],
    resource: {
      type: context.resourceType,
      id: context.resourceId ?? '',
      ownerId: context.resourceOwnerId,
      groupIds: context.resourceGroupIds,
      attributes: context.resourceAttributes,
    },
    action: { name: context.action },
    timestamp: context.timestamp,
    environment: context.environment,
  };
}

/**
 * Evaluates a tenant's rules for a check (no match: not granted). When the rules use group
 * conditions and the check does not know the subject's groups at all, nothing is granted from
 * them, whatever else the rules say (a caller without its own guard cannot pass on unknown
 * memberships); when only some groups are unknown, the rules for the request that name one stop
 * the evaluation (evaluateTenantRules).
 */
export function createTenantRuleEvaluator(rules: TenantPolicyRule[]): PolicyEvaluator {
  const usesSubjectGroups = tenantRulesUseGroups(rules);
  return {
    usesSubjectGroups,
    evaluate(context: PolicyEvaluationContext): PolicyEvaluationResult {
      if (usesSubjectGroups && context.subjectGroupIds === undefined)
        return { allowed: false, reason: GROUPS_UNKNOWN_REASON };
      const decision = evaluateTenantRules(rules, toTenantPolicyContext(context));
      return { allowed: decision.allowed, reason: decision.reason, decidedBy: decision.decidedBy };
    },
  };
}
