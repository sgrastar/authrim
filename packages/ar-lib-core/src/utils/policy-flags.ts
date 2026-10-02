/**
 * Policy feature flags for a tenant, as the Settings API resolves them.
 *
 * Each flag is `feature.enable_*`: the tenant's value, else the platform's, else the value saved
 * through the older APIs (`policy:flags:*`), else its environment variable, else its default.
 */

import {
  resolveEffectiveSettingsWithSources,
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from '../services/effective-settings';

export interface PolicyFlags {
  /** Attribute-based evaluation in permission checks (`feature.enable_abac`). */
  abac: boolean;
  /** The policy service's relationship check endpoints (`feature.enable_rebac`). */
  rebac: boolean;
  /** A log entry for each permission check decision (`feature.enable_policy_logging`). */
  policyLogging: boolean;
  /** Users' verified attributes in attribute-based rules (`feature.enable_verified_attributes`). */
  verifiedAttributes: boolean;
  /** The tenant's custom policy rules in attribute-based checks (`feature.enable_custom_rules`). */
  customRules: boolean;
  /** SD-JWT ID tokens for clients that request them (`feature.enable_sd_jwt`). */
  sdJwt: boolean;
  /** Permissions embedded in access tokens (`feature.enable_policy_embedding`). */
  policyEmbedding: boolean;
}

const FLAG_KEYS: Record<keyof PolicyFlags, string> = {
  abac: 'feature.enable_abac',
  rebac: 'feature.enable_rebac',
  policyLogging: 'feature.enable_policy_logging',
  verifiedAttributes: 'feature.enable_verified_attributes',
  customRules: 'feature.enable_custom_rules',
  sdJwt: 'feature.enable_sd_jwt',
  policyEmbedding: 'feature.enable_policy_embedding',
};

/** Every flag off: what applies when the flags cannot be read (each only adds access or output). */
export const POLICY_FLAGS_OFF: PolicyFlags = Object.freeze({
  abac: false,
  rebac: false,
  policyLogging: false,
  verifiedAttributes: false,
  customRules: false,
  sdJwt: false,
  policyEmbedding: false,
});

/**
 * The policy flags for a tenant (without one, the platform's). All off when they cannot be read:
 * each flag enables access, output or logging, so none turns on from a fallback.
 */
export async function resolvePolicyFlags(
  env: EffectiveSettingsEnv,
  tenantId?: string
): Promise<PolicyFlags> {
  return (await readPolicyFlags(env, tenantId)) ?? { ...POLICY_FLAGS_OFF };
}

/**
 * Like resolvePolicyFlags, but null when the flags cannot be read. `fresh` reads without the
 * per-isolate caches (for admin views that must match what was just saved).
 */
export async function readPolicyFlags(
  env: EffectiveSettingsEnv,
  tenantId?: string,
  options: { fresh?: boolean } = {}
): Promise<PolicyFlags | null> {
  try {
    const { values } = tenantId
      ? await resolveEffectiveSettingsWithSources(env, 'feature-flags', {
          tenantId,
          fresh: options.fresh,
        })
      : await resolvePlatformSettingsWithSources(env, 'feature-flags', {
          fresh: options.fresh,
        });
    const flags = { ...POLICY_FLAGS_OFF };
    for (const [name, key] of Object.entries(FLAG_KEYS) as Array<[keyof PolicyFlags, string]>) {
      flags[name] = values[key] === true;
    }
    return flags;
  } catch {
    return null;
  }
}
