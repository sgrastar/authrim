/**
 * Tenant Settings Category
 *
 * Tenant-level configuration and branding settings.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/tenant
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';
import type { UserIdFormat } from '../../utils/id';

/**
 * Tenant Settings Interface
 */
export interface TenantSettings {
  // Core Settings
  'tenant.base_domain': string;
  'tenant.default_id': string;
  'tenant.isolation_enabled': boolean;
  'tenant.user_id_format': UserIdFormat;

  // CORS Settings
  'tenant.allowed_origins': string;
  'tenant.allowed_domains': string;
  'tenant.allowed_identifiers': string;

  // Runtime Profile Overrides
  'tenant.storage_profile_id': string;
  'tenant.audit_profile_id': string;
  'tenant.residency_profile_id': string;

  // Branding
  'tenant.name': string;
  'tenant.logo_uri': string;
  'tenant.tos_uri': string;
  'tenant.policy_uri': string;

  // UI Paths
  'tenant.ui_base_url': string;
  'tenant.ui_login_path': string;
  'tenant.ui_consent_path': string;
  'tenant.ui_reauth_path': string;
  'tenant.ui_error_path': string;
}

/**
 * Tenant Settings Metadata
 */
export const TENANT_SETTINGS_META: Record<keyof TenantSettings, SettingMeta> = {
  // Core Settings
  'tenant.base_domain': {
    key: 'tenant.base_domain',
    type: 'string',
    default: '',
    envKey: 'BASE_DOMAIN',
    label: 'Base Domain',
    description: 'Base domain for this tenant',
    visibility: 'admin',
  },
  'tenant.default_id': {
    key: 'tenant.default_id',
    type: 'string',
    default: 'default',
    envKey: 'DEFAULT_TENANT_ID',
    label: 'Default Tenant ID',
    description: 'Default tenant identifier',
    visibility: 'internal',
  },
  'tenant.isolation_enabled': {
    key: 'tenant.isolation_enabled',
    type: 'boolean',
    default: false,
    envKey: 'TENANT_ISOLATION_ENABLED',
    label: 'Tenant Isolation',
    description: 'Enable strict tenant isolation',
    visibility: 'admin',
  },
  'tenant.user_id_format': {
    key: 'tenant.user_id_format',
    type: 'enum',
    default: 'nanoid',
    envKey: 'USER_ID_FORMAT',
    label: 'User ID Format',
    description:
      'Format for generating user IDs. "nanoid" (default) generates URL-safe 21-character IDs. "uuid" generates standard UUID v4 format. This setting is configured during setup and cannot be changed after users are created.',
    enum: ['nanoid', 'uuid'],
    visibility: 'internal',
  },

  // CORS Settings
  'tenant.allowed_origins': {
    key: 'tenant.allowed_origins',
    type: 'string',
    default: '',
    envKey: 'ALLOWED_ORIGINS',
    label: 'Allowed Origins (CORS)',
    description:
      'Comma-separated list of allowed origins for Direct Auth API. Supports wildcards (e.g., https://*.pages.dev). If not set, all origins are allowed without credentials.',
    visibility: 'admin',
  },
  'tenant.allowed_domains': {
    key: 'tenant.allowed_domains',
    type: 'string',
    default: '',
    label: 'Allowed Domains',
    description:
      'Comma-separated list of exact request hosts allowed for this tenant. Empty keeps the canonical issuer host only.',
    visibility: 'admin',
  },
  'tenant.allowed_identifiers': {
    key: 'tenant.allowed_identifiers',
    type: 'string',
    default: '',
    label: 'Allowed Identifiers',
    description:
      'Comma-separated list of exact issuer/verifier identifiers allowed for this tenant. Empty disables additional identifier restrictions.',
    visibility: 'admin',
  },
  'tenant.storage_profile_id': {
    key: 'tenant.storage_profile_id',
    type: 'string',
    default: '',
    label: 'Storage Profile Override',
    description:
      'Optional storage profile ID override for this tenant. Empty means inherit the environment default.',
    visibility: 'admin',
  },
  'tenant.audit_profile_id': {
    key: 'tenant.audit_profile_id',
    type: 'string',
    default: '',
    label: 'Audit Profile Override',
    description:
      'Optional audit profile ID override for this tenant. Empty means inherit the environment default.',
    visibility: 'admin',
  },
  'tenant.residency_profile_id': {
    key: 'tenant.residency_profile_id',
    type: 'string',
    default: '',
    label: 'Residency Profile Override',
    description:
      'Optional residency profile ID override for this tenant. Empty means inherit the environment default.',
    visibility: 'admin',
  },

  // Branding
  'tenant.name': {
    key: 'tenant.name',
    type: 'string',
    default: '',
    envKey: 'TENANT_NAME',
    label: 'Tenant Name',
    description: 'Display name for this tenant',
    visibility: 'public',
  },
  'tenant.logo_uri': {
    key: 'tenant.logo_uri',
    type: 'string',
    default: '',
    envKey: 'TENANT_LOGO_URI',
    label: 'Logo URI',
    description: 'URL to tenant logo image',
    visibility: 'public',
  },
  'tenant.tos_uri': {
    key: 'tenant.tos_uri',
    type: 'string',
    default: '',
    envKey: 'TENANT_TOS_URI',
    label: 'Terms of Service URI',
    description: 'URL to tenant terms of service',
    visibility: 'public',
  },
  'tenant.policy_uri': {
    key: 'tenant.policy_uri',
    type: 'string',
    default: '',
    envKey: 'TENANT_POLICY_URI',
    label: 'Privacy Policy URI',
    description: 'URL to tenant privacy policy',
    visibility: 'public',
  },

  // UI Paths
  'tenant.ui_base_url': {
    key: 'tenant.ui_base_url',
    type: 'string',
    default: '',
    envKey: 'UI_BASE_URL',
    label: 'UI Base URL',
    description: 'Base URL for authentication UI (if different from issuer)',
    visibility: 'page',
  },
  'tenant.ui_login_path': {
    key: 'tenant.ui_login_path',
    type: 'string',
    default: '/login',
    envKey: 'UI_LOGIN_PATH',
    label: 'Login Path',
    description: 'Path for user login page',
    visibility: 'page',
  },
  'tenant.ui_consent_path': {
    key: 'tenant.ui_consent_path',
    type: 'string',
    default: '/consent',
    envKey: 'UI_CONSENT_PATH',
    label: 'Consent Path',
    description: 'Path for OAuth consent page',
    visibility: 'page',
  },
  'tenant.ui_reauth_path': {
    key: 'tenant.ui_reauth_path',
    type: 'string',
    default: '/reauth',
    envKey: 'UI_REAUTH_PATH',
    label: 'Reauth Path',
    description: 'Path for re-authentication page',
    visibility: 'page',
  },
  'tenant.ui_error_path': {
    key: 'tenant.ui_error_path',
    type: 'string',
    default: '/error',
    envKey: 'UI_ERROR_PATH',
    label: 'Error Path',
    description: 'Path for error display page',
    visibility: 'page',
  },
};

/**
 * Tenant Category Metadata
 */
export const TENANT_CATEGORY_META: CategoryMeta = {
  category: 'tenant',
  label: 'Tenant',
  description: 'Tenant configuration and branding settings',
  settings: TENANT_SETTINGS_META,
};

/**
 * Default Tenant settings values
 */
export const TENANT_DEFAULTS: TenantSettings = {
  'tenant.base_domain': '',
  'tenant.default_id': 'default',
  'tenant.isolation_enabled': false,
  'tenant.user_id_format': 'nanoid',
  // CORS Settings
  'tenant.allowed_origins': '',
  'tenant.allowed_domains': '',
  'tenant.allowed_identifiers': '',
  'tenant.storage_profile_id': '',
  'tenant.audit_profile_id': '',
  'tenant.residency_profile_id': '',
  // Branding
  'tenant.name': '',
  'tenant.logo_uri': '',
  'tenant.tos_uri': '',
  'tenant.policy_uri': '',
  // UI Paths
  'tenant.ui_base_url': '',
  'tenant.ui_login_path': '/login',
  'tenant.ui_consent_path': '/consent',
  'tenant.ui_reauth_path': '/reauth',
  'tenant.ui_error_path': '/error',
};
