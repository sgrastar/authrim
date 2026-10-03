/**
 * Federation Settings Category
 *
 * Settings related to identity federation (SAML, SCIM, etc.).
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/federation
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Federation Settings Interface
 */
export interface FederationSettings {
  // SAML Settings
  'federation.saml_enabled': boolean;
  'federation.saml_assertion_ttl': number;
  'federation.saml_request_ttl': number;
  'federation.saml_artifact_ttl': number;
  'federation.saml_artifact_resolution_timeout': number;
  'federation.saml_sso_binding': 'HTTP-POST' | 'HTTP-Redirect';
  'federation.saml_slo_binding': 'HTTP-POST' | 'HTTP-Redirect';
  'federation.saml_nameid_format': 'emailAddress' | 'persistent' | 'transient' | 'unspecified';

  'federation.scim_token_max_expiry': number;
  'federation.scim_token_default_expiry': number;
}

/**
 * Federation Settings Metadata
 */
export const FEDERATION_SETTINGS_META: Record<keyof FederationSettings, SettingMeta> = {
  'federation.saml_enabled': {
    key: 'federation.saml_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_SAML',
    label: 'SAML Enabled',
    description: 'Enable SAML 2.0 federation',
    visibility: 'public',
  },
  'federation.saml_assertion_ttl': {
    key: 'federation.saml_assertion_ttl',
    type: 'duration',
    default: 300,
    envKey: 'SAML_ASSERTION_TTL',
    label: 'SAML Assertion TTL',
    description: 'SAML assertion lifetime in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'federation.saml_request_ttl': {
    key: 'federation.saml_request_ttl',
    type: 'duration',
    default: 300,
    envKey: 'SAML_REQUEST_TTL',
    label: 'SAML Request TTL',
    description: 'SAML authentication request lifetime in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'federation.saml_artifact_ttl': {
    key: 'federation.saml_artifact_ttl',
    type: 'duration',
    default: 120,
    envKey: 'SAML_ARTIFACT_TTL',
    label: 'SAML Artifact TTL',
    description: 'SAML artifact lifetime in seconds',
    min: 30,
    max: 300,
    unit: 'seconds',
    visibility: 'admin',
  },
  'federation.saml_artifact_resolution_timeout': {
    key: 'federation.saml_artifact_resolution_timeout',
    type: 'duration',
    default: 5000,
    envKey: 'SAML_ARTIFACT_RESOLUTION_TIMEOUT',
    label: 'SAML Artifact Resolution Timeout',
    description: 'Timeout for SAML artifact resolution request in milliseconds',
    min: 1000,
    max: 30000,
    unit: 'ms',
    visibility: 'admin',
  },
  'federation.saml_sso_binding': {
    key: 'federation.saml_sso_binding',
    type: 'enum',
    default: 'HTTP-POST',
    envKey: 'SAML_SSO_BINDING',
    label: 'SAML SSO Binding',
    description: 'SAML Single Sign-On request binding (HTTP-POST recommended)',
    enum: ['HTTP-POST', 'HTTP-Redirect'],
    visibility: 'admin',
  },
  'federation.saml_slo_binding': {
    key: 'federation.saml_slo_binding',
    type: 'enum',
    default: 'HTTP-POST',
    envKey: 'SAML_SLO_BINDING',
    label: 'SAML SLO Binding',
    description: 'SAML Single Logout request binding',
    enum: ['HTTP-POST', 'HTTP-Redirect'],
    visibility: 'admin',
  },
  'federation.saml_nameid_format': {
    key: 'federation.saml_nameid_format',
    type: 'enum',
    default: 'emailAddress',
    envKey: 'SAML_NAMEID_FORMAT',
    label: 'SAML NameID Format',
    description: 'SAML NameID format (persistent provides privacy protection)',
    enum: ['emailAddress', 'persistent', 'transient', 'unspecified'],
    visibility: 'admin',
  },

  'federation.scim_token_max_expiry': {
    key: 'federation.scim_token_max_expiry',
    type: 'duration',
    default: 31536000,
    envKey: 'SCIM_TOKEN_MAX_EXPIRY',
    label: 'SCIM Token Max Expiry',
    description: 'Maximum SCIM token lifetime in seconds (1 year)',
    min: 86400,
    max: 31536000,
    unit: 'seconds',
    visibility: 'admin',
  },
  'federation.scim_token_default_expiry': {
    key: 'federation.scim_token_default_expiry',
    type: 'duration',
    default: 7776000,
    envKey: 'SCIM_TOKEN_DEFAULT_EXPIRY',
    label: 'SCIM Token Default Expiry',
    description: 'Default SCIM token lifetime in seconds (90 days)',
    min: 3600,
    max: 31536000,
    unit: 'seconds',
    visibility: 'admin',
  },
};

/**
 * Federation Category Metadata
 */
export const FEDERATION_CATEGORY_META: CategoryMeta = {
  category: 'federation',
  label: 'Federation',
  description: 'Identity federation settings (SAML, account linking)',
  settings: FEDERATION_SETTINGS_META,
};

/**
 * Default Federation settings values
 */
export const FEDERATION_DEFAULTS: FederationSettings = {
  // SAML
  'federation.saml_enabled': false,
  'federation.saml_assertion_ttl': 300,
  'federation.saml_request_ttl': 300,
  'federation.saml_artifact_ttl': 120,
  'federation.saml_artifact_resolution_timeout': 5000,
  'federation.saml_sso_binding': 'HTTP-POST',
  'federation.saml_slo_binding': 'HTTP-POST',
  'federation.saml_nameid_format': 'emailAddress',
  'federation.scim_token_max_expiry': 31536000,
  'federation.scim_token_default_expiry': 7776000,
};
