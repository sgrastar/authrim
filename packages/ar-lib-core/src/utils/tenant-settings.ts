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
  | 'login-methods'
  | 'feature-flags'
  | 'step-up'
  | 'login-entry'
  | 'tenant-discovery-ui';

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
