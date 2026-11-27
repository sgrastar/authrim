/**
 * A tenant's attribute-based policy for the Check API.
 *
 * The tenant's settings decide whether attribute-based policy, and with it the tenant's custom
 * rules (`policy_rules`), applies (`feature.enable_abac`), whether the subject's verified
 * attributes are loaded (`feature.enable_verified_attributes`), whether a
 * request's relationship check is evaluated (`feature.enable_rebac`) and whether each decision is
 * logged (`feature.enable_policy_logging`).
 *
 * The rules are the tenant's own: no built-in rule takes part (the built-in roles are already
 * checked before), and a check that matches no rule is not granted by this stage.
 */

import {
  createLogger,
  readPolicyFlags,
  POLICY_FLAGS_OFF,
  TENANT_POLICY_RULES_CACHE_TTL_MS,
  serviceGroupDecidedGroups,
  type DatabaseAdapter,
  type TenantPolicySettings,
} from '@authrim/ar-lib-core';
import {
  createTenantRuleEvaluator,
  readTenantPolicyRules,
  tenantRulesUnusableReason,
  tenantRulesNeedServiceGroups,
  toTenantPolicyRule,
  type TenantPolicyRule,
} from '@authrim/ar-lib-policy';

export { createTenantRuleEvaluator, toTenantPolicyRule };
export type { TenantPolicyRule };

const log = createLogger().module('TENANT-POLICY');
// The group delegation guard (ar-lib-core role-guard) counts a rule disabled within this lifetime.
const RULES_CACHE_TTL_MS = TENANT_POLICY_RULES_CACHE_TTL_MS;
const RULES_CACHE_MAX_TENANTS = 1000;
const rulesCache = new Map<string, { rules: TenantPolicyRule[]; at: number; version: number }>();

/**
 * The tenant's rules version (`policy_rules_version`, raised in the same batch as every rule
 * change; 0 before the first). A read failure throws: the cached rules are not used on a guess.
 */
async function rulesVersionOf(db: DatabaseAdapter, tenantId: string): Promise<number> {
  const row = await db.queryOne<{ version: number | string }>(
    'SELECT version FROM policy_rules_version WHERE tenant_id = ?',
    [tenantId]
  );
  return row ? Number(row.version) : 0;
}

/**
 * The tenant's enabled custom rules, cached for a minute per isolate and used only while the
 * tenant's rules version is the one they were read under (one cheap read per check), so a rule
 * change reaches every isolate at its next check. Throws when one cannot be evaluated as written:
 * skipping it could skip a deny that a later allow would then get past, so the check grants
 * nothing from the rules until it is fixed (not cached).
 */
export async function loadTenantPolicyRules(
  db: DatabaseAdapter,
  tenantId: string
): Promise<TenantPolicyRule[]> {
  const version = await rulesVersionOf(db, tenantId);
  const cached = rulesCache.get(tenantId);
  if (cached && Date.now() - cached.at < RULES_CACHE_TTL_MS && cached.version === version)
    return cached.rules;
  const { rules, unusable } = await readTenantPolicyRules(db, tenantId);
  if (unusable.length) {
    throw new Error(`Policy rule ${unusable[0]} cannot be evaluated as stored`);
  }
  rulesCache.delete(tenantId);
  if (rulesCache.size >= RULES_CACHE_MAX_TENANTS) {
    const oldest = rulesCache.keys().next().value;
    if (oldest !== undefined) rulesCache.delete(oldest);
  }
  rulesCache.set(tenantId, { rules, at: Date.now(), version });
  return rules;
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
    // The Check API's relationship check (`feature.enable_rebac`): off when unread.
    rebac: flags.rebac,
    logDecisions: flags.policyLogging,
    ...(read ? {} : { unavailable: true }),
  };
  if (!flags.abac) return settings;
  try {
    const rules = await loadTenantPolicyRules(db, tenantId);
    // A rule relying on non-membership of a group a service group decides makes them unusable.
    const unusable = tenantRulesUnusableReason(rules, {
      ...settings,
      serviceGroupDecided: tenantRulesNeedServiceGroups(rules)
        ? await serviceGroupDecidedGroups(db, tenantId)
        : undefined,
    });
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
