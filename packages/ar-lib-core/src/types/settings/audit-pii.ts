/**
 * Audit PII configuration (tenant): which fields are PII and how long logs are kept.
 *
 * Not part of the settings catalog (see audit-routing.ts): saved through the audit PII routes
 * only, against the version that was judged.
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export const AUDIT_PII_CATEGORY = 'audit-pii';
export const AUDIT_PII_CONFIG_KEY = 'audit-pii.config';
/** Prefix of the key the configuration was kept under (AUTHRIM_CONFIG KV) before this. */
export const LEGACY_PII_CONFIG_KV_PREFIX = 'pii_config:';

export const AUDIT_PII_SETTINGS_META: Record<string, SettingMeta> = {
  [AUDIT_PII_CONFIG_KEY]: {
    key: AUDIT_PII_CONFIG_KEY,
    type: 'json',
    default: null,
    scopes: ['tenant'],
    label: 'Audit PII configuration',
    description: "The tenant's PII fields, detail level and retention days.",
    visibility: 'page',
  },
};

export const AUDIT_PII_CATEGORY_META: CategoryMeta = {
  category: AUDIT_PII_CATEGORY,
  label: 'Audit PII',
  description: 'Audit PII configuration',
  settings: AUDIT_PII_SETTINGS_META,
};
