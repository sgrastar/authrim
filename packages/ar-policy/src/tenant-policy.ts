/**
 * A tenant's attribute-based policy for the Check API.
 *
 * The tenant's settings decide whether attribute-based policy applies (`feature.enable_abac`),
 * whether its custom rules (`policy_rules`) take part (`feature.enable_custom_rules`), whether the
 * subject's verified attributes are loaded (`feature.enable_verified_attributes`) and whether
 * each decision is logged (`feature.enable_policy_logging`).
 *
 * The rules are the tenant's own: no built-in rule takes part (the built-in roles are already
 * checked before), and a check that matches no rule is not granted by this stage.
 */

import {
  createLogger,
  readPolicyFlags,
  POLICY_FLAGS_OFF,
  type DatabaseAdapter,
  type PolicyEvaluationContext,
  type PolicyEvaluationResult,
  type PolicyEvaluator,
  type TenantPolicySettings,
} from '@authrim/ar-lib-core';
import {
  evaluateTenantRules,
  tenantRulesUnusableReason,
  toTenantPolicyRule,
  type PolicyContext,
  type TenantPolicyRule,
  type TenantPolicyRuleRow,
} from '@authrim/ar-lib-policy';

export { toTenantPolicyRule };
export type { TenantPolicyRule };

const log = createLogger().module('TENANT-POLICY');
const RULES_CACHE_TTL_MS = 60_000;
const RULES_CACHE_MAX_TENANTS = 1000;
const rulesCache = new Map<string, { rules: TenantPolicyRule[]; at: number }>();

/**
 * The tenant's enabled custom rules, cached for a minute per isolate. Throws when one cannot be
 * evaluated as written: skipping it could skip a deny that a later allow would then get past,
 * so the check grants nothing from the rules until it is fixed (not cached).
 */
export async function loadTenantPolicyRules(
  db: DatabaseAdapter,
  tenantId: string
): Promise<TenantPolicyRule[]> {
  const cached = rulesCache.get(tenantId);
  if (cached && Date.now() - cached.at < RULES_CACHE_TTL_MS) return cached.rules;
  const rows = await db.query<TenantPolicyRuleRow>(
    `SELECT id, name, description, priority, effect, resource_types, actions, conditions
       FROM policy_rules
      WHERE tenant_id = ? AND enabled = 1
      ORDER BY priority DESC`,
    [tenantId]
  );
  const rules: TenantPolicyRule[] = [];
  for (const row of rows) {
    const rule = toTenantPolicyRule(row);
    if (!rule) {
      throw new Error(`Policy rule ${row.id} cannot be evaluated as stored`);
    }
    rules.push(rule);
  }
  rulesCache.delete(tenantId);
  if (rulesCache.size >= RULES_CACHE_MAX_TENANTS) {
    const oldest = rulesCache.keys().next().value;
    if (oldest !== undefined) rulesCache.delete(oldest);
  }
  rulesCache.set(tenantId, { rules, at: Date.now() });
  return rules;
}

/** Evaluates a tenant's rules for a check (no match: not granted). */
export function createTenantRuleEvaluator(rules: TenantPolicyRule[]): PolicyEvaluator {
  return {
    evaluate(context: PolicyEvaluationContext): PolicyEvaluationResult {
      const policyContext: PolicyContext = {
        subject: {
          id: context.subjectId,
          roles: (context.subjectRoles ?? []).map((role) => ({
            name: role.name,
            scope: role.scope,
            scopeTarget: role.scopeTarget,
            expiresAt: role.expiresAt,
          })),
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
          orgId: context.resourceOrgId,
          attributes: context.resourceAttributes,
        },
        action: { name: context.action },
        timestamp: context.timestamp,
        environment: context.environment,
      };
      const decision = evaluateTenantRules(rules, policyContext);
      return { allowed: decision.allowed, reason: decision.reason, decidedBy: decision.decidedBy };
    },
  };
}

/**
 * The attribute-based policy settings of a tenant. Never throws: settings or rules that cannot
 * be read turn attribute-based policy off for the check (it only grants access), marked
 * `unavailable` so that the result is not cached.
 */
export async function resolveTenantPolicy(
  env: Parameters<typeof readPolicyFlags>[0],
  db: DatabaseAdapter,
  tenantId: string
): Promise<TenantPolicySettings> {
  const read = await readPolicyFlags(env, tenantId);
  const flags = read ?? POLICY_FLAGS_OFF;
  const settings: TenantPolicySettings = {
    abac: flags.abac,
    verifiedAttributes: flags.abac && flags.verifiedAttributes,
    logDecisions: flags.policyLogging,
    ...(read ? {} : { unavailable: true }),
  };
  if (!flags.abac || !flags.customRules) return settings;
  try {
    const rules = await loadTenantPolicyRules(db, tenantId);
    const unusable = tenantRulesUnusableReason(rules, settings);
    if (unusable) throw new Error(unusable);
    settings.evaluator = createTenantRuleEvaluator(rules);
  } catch (error) {
    log.warn('Tenant policy rules could not be used; no grants from them', {
      tenantId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { ...settings, abac: false, verifiedAttributes: false, unavailable: true };
  }
  return settings;
}

/** Tests: forget the cached rules. */
export function clearTenantPolicyRulesCache(): void {
  rulesCache.clear();
}
