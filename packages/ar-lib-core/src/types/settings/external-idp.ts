/**
 * External IdP Settings Category
 *
 * Settings related to external identity provider federation.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/external-idp
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * External IdP Settings Interface
 */
export interface ExternalIdPSettings {
  // JIT Provisioning
  'external_idp.jit_provisioning_enabled': boolean;
  'external_idp.jit_update_on_login': boolean;

  // JWKS Settings
  'external_idp.jwks_cache_ttl': number;
  'external_idp.jwks_fetch_timeout_ms': number;

  // Request Settings
  'external_idp.request_timeout_ms': number;

  // Token Settings
  'external_idp.token_encryption_enabled': boolean;
}

/**
 * External IdP Settings Metadata
 */
export const EXTERNAL_IDP_SETTINGS_META: Record<keyof ExternalIdPSettings, SettingMeta> = {
  'external_idp.jit_provisioning_enabled': {
    key: 'external_idp.jit_provisioning_enabled',
    type: 'boolean',
    // As the bridge has always behaved without a saved configuration. Each provider must also
    // enable JIT provisioning, so this alone creates no accounts.
    default: true,
    envKey: 'ENABLE_JIT_PROVISIONING',
    label: 'JIT Provisioning',
    description:
      'Enable Just-In-Time user provisioning from external IdPs (for providers that also enable it)',
    visibility: 'public',
  },
  'external_idp.jit_update_on_login': {
    key: 'external_idp.jit_update_on_login',
    type: 'boolean',
    // Off unless set: logins have never changed the user's profile, which may be edited locally.
    default: false,
    envKey: 'JIT_UPDATE_ON_LOGIN',
    label: 'Update on Login',
    description:
      "Update the user's name, given and family name, picture and locale from the external IdP on each login",
    visibility: 'public',
    dependsOn: [{ key: 'external_idp.jit_provisioning_enabled', value: true }],
  },
  'external_idp.jwks_cache_ttl': {
    key: 'external_idp.jwks_cache_ttl',
    type: 'duration',
    default: 86400,
    envKey: 'EXTERNAL_IDP_JWKS_CACHE_TTL',
    label: 'JWKS Cache TTL',
    description: 'External IdP JWKS cache lifetime in seconds (default: 24 hours)',
    min: 300,
    max: 604800,
    unit: 'seconds',
    visibility: 'admin',
  },
  'external_idp.jwks_fetch_timeout_ms': {
    key: 'external_idp.jwks_fetch_timeout_ms',
    type: 'duration',
    default: 5000,
    envKey: 'EXTERNAL_IDP_JWKS_FETCH_TIMEOUT_MS',
    label: 'JWKS Fetch Timeout',
    description: 'Timeout for fetching external IdP JWKS in milliseconds',
    min: 1000,
    max: 30000,
    unit: 'ms',
    visibility: 'admin',
  },

  // Request Settings
  'external_idp.request_timeout_ms': {
    key: 'external_idp.request_timeout_ms',
    type: 'duration',
    default: 10000,
    envKey: 'EXTERNAL_IDP_REQUEST_TIMEOUT_MS',
    label: 'Request Timeout',
    description: 'Timeout for external IdP API requests in milliseconds',
    min: 1000,
    max: 60000,
    unit: 'ms',
    visibility: 'admin',
  },

  // Token Settings
  'external_idp.token_encryption_enabled': {
    key: 'external_idp.token_encryption_enabled',
    type: 'boolean',
    default: false,
    envKey: 'EXTERNAL_IDP_TOKEN_ENCRYPTION_ENABLED',
    label: 'Token Encryption',
    description: 'Enable encryption for tokens received from external IdPs',
    visibility: 'admin',
  },
};

/**
 * External IdP Category Metadata
 */
export const EXTERNAL_IDP_CATEGORY_META: CategoryMeta = {
  category: 'external-idp',
  label: 'External IdP',
  description: 'External identity provider federation settings',
  settings: EXTERNAL_IDP_SETTINGS_META,
};

/**
 * Default External IdP settings values
 */
export const EXTERNAL_IDP_DEFAULTS: ExternalIdPSettings = {
  'external_idp.jit_provisioning_enabled': true,
  'external_idp.jit_update_on_login': false,
  'external_idp.jwks_cache_ttl': 86400,
  'external_idp.jwks_fetch_timeout_ms': 5000,
  'external_idp.request_timeout_ms': 10000,
  'external_idp.token_encryption_enabled': false,
};
