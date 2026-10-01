/**
 * A tenant's custom policy rules (`policy_rules`), as the Check API and the Admin API's policy
 * simulation both read and evaluate them, so that a simulation shows what checks decide.
 */

import {
  ATTRIBUTE_CONDITION_TYPES,
  CHECK_API_CONDITION_TYPES,
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
 * Why a tenant's rules cannot be used for checks under its settings, or null when they can.
 * Without the subject's verified attributes, a deny on one of them could never apply and a
 * later allow would get past it.
 */
export function tenantRulesUnusableReason(
  rules: readonly TenantPolicyRule[],
  settings: { verifiedAttributes: boolean }
): string | null {
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
  return null;
}

const ROLE_CONDITION_TYPES = new Set(['has_role', 'has_any_role', 'has_all_roles']);

/**
 * The subject's role assignments that hold for the request's target: global ones, one for the
 * resource's organization (`org:<id>`), and one for the resource itself (`resource:<type>:<id>`
 * or `resource:<id>`). An assignment for another organization or resource does not count.
 */
function rolesForTarget(roles: readonly SubjectRole[], context: PolicyContext): SubjectRole[] {
  const { orgId, id, type } = context.resource;
  return roles.filter((role) => {
    if (role.scope === 'global') return true;
    if (role.scope === 'org') return Boolean(orgId) && role.scopeTarget === `org:${orgId}`;
    if (role.scope === 'resource') {
      return (
        Boolean(id) &&
        (role.scopeTarget === `resource:${type}:${id}` || role.scopeTarget === `resource:${id}`)
      );
    }
    return false;
  });
}

/** Whether a deny needs a target the request does not give (so it could never apply). */
function denyNeedsMissingTarget(rule: TenantPolicyRule, context: PolicyContext): string | null {
  if (rule.effect !== 'deny') return null;
  for (const condition of rule.conditions) {
    if (condition.type === 'is_resource_owner' && !context.resource.ownerId) {
      return 'the resource owner';
    }
    if (ROLE_CONDITION_TYPES.has(condition.type)) {
      const scope = condition.params.scope;
      if (scope === 'org' && !context.resource.orgId) return "the resource's organization";
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
