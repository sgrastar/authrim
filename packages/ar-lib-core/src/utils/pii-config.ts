/**
 * PII Configuration Utilities
 *
 * Provides utilities for fetching tenant PII configuration from KV store.
 * Used by operational logs and other privacy-sensitive operations.
 */

import type { TenantPIIConfig } from '../services/audit/types';
import { DEFAULT_PII_CONFIG } from '../services/audit/types';
import { settingsStorageKey } from './settings-manager';
import { AUDIT_PII_CATEGORY, AUDIT_PII_CONFIG_KEY } from '../types/settings/audit-pii';

const KV_KEY_PII_CONFIG_PREFIX = 'pii_config:';

/**
 * The tenant's own configuration as runtime reads it: the settings document projected to
 * SETTINGS (authoritative once it exists), else the legacy `pii_config:{tenantId}` value in
 * AUTHRIM_CONFIG (until the document is created from it). Null when the tenant has none.
 * Throws when a stored value cannot be read.
 */
export async function readStoredTenantPIIConfig(
  sources: { settings?: KVNamespace; legacy?: KVNamespace },
  tenantId: string
): Promise<TenantPIIConfig | null> {
  if (sources.settings) {
    let key: string | null = null;
    try {
      key = settingsStorageKey(AUDIT_PII_CATEGORY, { type: 'tenant', id: tenantId });
    } catch {
      key = null;
    }
    const raw = key ? await sources.settings.get(key) : null;
    if (raw !== null) {
      const document = JSON.parse(raw) as Record<string, unknown> | null;
      const value = document?.[AUDIT_PII_CONFIG_KEY];
      if (value === undefined || value === null) return null;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('pii_config_invalid');
      return value as TenantPIIConfig;
    }
  }
  if (sources.legacy) {
    const raw = await sources.legacy.get(`${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`);
    // Only a missing value is no config; anything stored must parse to an object.
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('pii_config_invalid');
      }
      return parsed as TenantPIIConfig;
    }
  }
  return null;
}

/**
 * Get tenant PII configuration (defaults if none is stored or it cannot be read).
 *
 * @param kvNamespace - AUTHRIM_CONFIG KV namespace (legacy location)
 * @param settingsKv - SETTINGS KV namespace (where the settings document is projected)
 */
export async function getTenantPIIConfigFromKV(
  kvNamespace: KVNamespace | undefined,
  tenantId: string,
  settingsKv?: KVNamespace
): Promise<TenantPIIConfig> {
  try {
    const stored = await readStoredTenantPIIConfig(
      { settings: settingsKv, legacy: kvNamespace },
      tenantId
    );
    if (stored) return stored;
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
  tenantId: string,
  settingsKv?: KVNamespace
): Promise<number> {
  const config = await getTenantPIIConfigFromKV(kvNamespace, tenantId, settingsKv);
  return config.operationalLogRetentionDays ?? 90;
}
