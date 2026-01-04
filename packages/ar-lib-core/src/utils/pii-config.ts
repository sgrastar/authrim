/**
 * PII Configuration Utilities
 *
 * Provides utilities for fetching tenant PII configuration from KV store.
 * Used by operational logs and other privacy-sensitive operations.
 */

import type { TenantPIIConfig } from '../services/audit/types';
import { DEFAULT_PII_CONFIG } from '../services/audit/types';

const KV_KEY_PII_CONFIG_PREFIX = 'pii_config:';

/**
 * Get tenant PII configuration from KV store
 *
 * @param kvNamespace - AUTHRIM_CONFIG KV namespace
 * @param tenantId - Tenant identifier
 * @returns TenantPIIConfig (defaults if not found)
 */
export async function getTenantPIIConfigFromKV(
  kvNamespace: KVNamespace | undefined,
  tenantId: string
): Promise<TenantPIIConfig> {
  if (!kvNamespace) {
    return { ...DEFAULT_PII_CONFIG };
  }

  try {
    const kvValue = await kvNamespace.get(`${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`);
    if (kvValue) {
      return JSON.parse(kvValue) as TenantPIIConfig;
    }
  } catch {
    // KV read error or parse error - use default
  }

  return { ...DEFAULT_PII_CONFIG };
}

/**
 * Get operational log retention days for a tenant
 *
 * @param kvNamespace - AUTHRIM_CONFIG KV namespace
 * @param tenantId - Tenant identifier
 * @returns Retention days (default: 90)
 */
export async function getOperationalLogRetentionDays(
  kvNamespace: KVNamespace | undefined,
  tenantId: string
): Promise<number> {
  const config = await getTenantPIIConfigFromKV(kvNamespace, tenantId);
  return config.operationalLogRetentionDays ?? 90;
}
