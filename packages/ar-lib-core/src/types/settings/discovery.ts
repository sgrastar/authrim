/**
 * Discovery Settings Category
 *
 * Settings related to OIDC Discovery document customization.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/discovery
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Discovery Settings Interface
 */
export interface DiscoverySettings {
  // Claims Configuration
  'discovery.claims_supported': string;
  'discovery.claims_locales_supported': string;

  // ACR Configuration
  'discovery.acr_values_supported': string;
}

/**
 * Discovery Settings Metadata
 */
export const DISCOVERY_SETTINGS_META: Record<keyof DiscoverySettings, SettingMeta> = {
  'discovery.claims_supported': {
    key: 'discovery.claims_supported',
    type: 'string',
    // Empty: discovery advertises the claims Authrim can issue.
    default: '',
    label: 'Supported Claims',
    description:
      'Comma-separated claims discovery advertises as claims_supported; empty advertises the claims Authrim can issue',
    visibility: 'admin',
  },
  'discovery.claims_locales_supported': {
    key: 'discovery.claims_locales_supported',
    type: 'string',
    default: 'en,ja',
    envKey: 'DISCOVERY_CLAIMS_LOCALES_SUPPORTED',
    label: 'Supported Claim Locales',
    description: 'Comma-separated list of supported locales for claims',
    visibility: 'admin',
  },
  'discovery.acr_values_supported': {
    key: 'discovery.acr_values_supported',
    type: 'string',
    // What discovery has always advertised; with assurance enabled, urn:authrim:aal:1..3 are added.
    default: 'urn:mace:incommon:iap:silver,urn:mace:incommon:iap:bronze',
    envKey: 'DISCOVERY_ACR_VALUES_SUPPORTED',
    label: 'Supported ACR Values',
    description: 'Comma-separated list of supported Authentication Context Class References',
    visibility: 'admin',
  },
};

/**
 * Discovery Category Metadata
 */
export const DISCOVERY_CATEGORY_META: CategoryMeta = {
  category: 'discovery',
  label: 'Discovery',
  description: 'OIDC Discovery document customization settings',
  settings: DISCOVERY_SETTINGS_META,
};

/**
 * Default Discovery settings values
 */
export const DISCOVERY_DEFAULTS: DiscoverySettings = {
  'discovery.claims_supported': '',
  'discovery.claims_locales_supported': 'en,ja',
  'discovery.acr_values_supported': 'urn:mace:incommon:iap:silver,urn:mace:incommon:iap:bronze',
};
