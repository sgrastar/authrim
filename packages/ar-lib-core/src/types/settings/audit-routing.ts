/**
 * Audit routing rules (platform). Rules that override how long matching logs are kept.
 *
 * Not part of the settings catalog: the Admin API saves it through the audit-storage routes only,
 * where a change is gated by a step-up and saved against the version that was judged. It is kept
 * as a canonical settings document (D1) and projected to KV like every settings document.
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export const AUDIT_ROUTING_CATEGORY = 'audit-routing';
export const AUDIT_ROUTING_RULES_KEY = 'audit-routing.rules';
/** Where the rules were kept before they became a settings document (AUTHRIM_CONFIG KV). */
export const LEGACY_AUDIT_ROUTING_RULES_KV_KEY = 'audit_routing_rules';

export const AUDIT_ROUTING_SETTINGS_META: Record<string, SettingMeta> = {
  [AUDIT_ROUTING_RULES_KEY]: {
    key: AUDIT_ROUTING_RULES_KEY,
    type: 'json',
    default: [],
    scopes: ['platform'],
    label: 'Audit routing rules',
    description: 'Rules that select the retention of matching logs.',
    visibility: 'page',
  },
};

export const AUDIT_ROUTING_CATEGORY_META: CategoryMeta = {
  category: AUDIT_ROUTING_CATEGORY,
  label: 'Audit Routing',
  description: 'Audit retention routing rules',
  settings: AUDIT_ROUTING_SETTINGS_META,
};
