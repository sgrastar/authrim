/**
 * Tenant-Aware Settings Accessor
 *
 * Provides a unified interface to read per-tenant settings from KV.
 * Key format: `settings:tenant:{tenantId}:{category}`
 *
 * Replaces the previously hardcoded `settings:tenant:default:{category}` reads.
 */

export type TenantSettingsCategory =
  | 'tenant'
  | 'login-ui'
  | 'authentication-methods'
  | 'feature-flags'
  | 'tokens'
  | 'step-up'
  | 'login-entry'
  | 'tenant-discovery-ui'
  | 'support-ops';

/** Tenant-scoped compatibility overlay for legacy `system_settings` consumers. */
export const TENANT_SYSTEM_SETTINGS_CATEGORY = 'certification-profile';

export function buildTenantSystemSettingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:${TENANT_SYSTEM_SETTINGS_CATEGORY}`;
}

function parseSettingsObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read effective legacy system settings for a tenant.
 *
 * The global `system_settings` value remains the deployment default. A tenant may
 * override complete top-level sections (for example `oidc` and `fapi`) without
 * changing the behavior of other tenants.
 */
export async function getTenantSystemSettings(
  kv: KVNamespace | undefined,
  tenantId: string
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;

  try {
    const [globalRaw, tenantRaw] = await Promise.all([
      kv.get('system_settings'),
      kv.get(buildTenantSystemSettingsKey(tenantId)),
    ]);
    if (!globalRaw && !tenantRaw) return null;
    return {
      ...parseSettingsObject(globalRaw),
      ...parseSettingsObject(tenantRaw),
    };
  } catch {
    return null;
  }
}

/**
 * Read a tenant settings object from KV.
 *
 * @param kv - KV namespace to read from (undefined = returns null)
 * @param tenantId - Tenant ID
 * @param category - Settings category
 * @returns Parsed settings object, or null if not found or on error
 */
export async function getTenantSettings(
  kv: KVNamespace | undefined,
  tenantId: string,
  category: TenantSettingsCategory
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;

  const key = `settings:tenant:${tenantId}:${category}`;

  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
