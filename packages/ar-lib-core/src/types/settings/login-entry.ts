/**
 * Login Entry Settings Category
 *
 * Settings related to login entry mode and discovery routing behavior.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/login-entry
 * Config Level: platform, tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Login Entry Settings Interface
 */
export interface LoginEntrySettings {
  'login-entry.override_enabled': boolean;
  'login-entry.mode': 'tenant_only' | 'discovery_optional' | 'discovery_required';
  'login-entry.discovery_methods': string;
  'login-entry.email_resolution_policy':
    | 'exact_email_then_domain'
    | 'exact_email_only'
    | 'disabled';
  'login-entry.selection_policy':
    | 'auto_if_single'
    | 'always_select'
    | 'select_if_multiple'
    | 'manual_only';
  'login-entry.allow_manual_tenant_entry': boolean;
  'login-entry.remember_last_tenant': boolean;
  'login-entry.redirect_default_login_to_discovery': boolean;
  'login-entry.require_common_discovery_before_login': boolean;
  'login-entry.skip_discovery_if_only_one_tenant': boolean;
  'login-entry.redirect_tenant_discover_to_common_entry': boolean;
}

/**
 * Login Entry Settings Metadata
 */
export const LOGIN_ENTRY_SETTINGS_META: Record<keyof LoginEntrySettings, SettingMeta> = {
  'login-entry.override_enabled': {
    key: 'login-entry.override_enabled',
    type: 'boolean',
    default: false,
    label: 'Tenant Override Enabled',
    description:
      'Enables tenant-scoped login entry behavior overrides. When disabled, tenant hosts use common entry behavior.',
    visibility: 'admin',
  },
  'login-entry.mode': {
    key: 'login-entry.mode',
    type: 'enum',
    default: 'discovery_optional',
    label: 'Login Entry Mode',
    description: 'Controls whether tenant discovery can be used before tenant login.',
    enum: ['tenant_only', 'discovery_optional', 'discovery_required'],
    visibility: 'admin',
  },
  'login-entry.discovery_methods': {
    key: 'login-entry.discovery_methods',
    type: 'string',
    default: '["email_domain","tenant_code","tenant_slug"]',
    label: 'Discovery Methods',
    description:
      'JSON array of enabled discovery methods. Example: ["email_domain","tenant_code","tenant_slug"]',
    visibility: 'admin',
  },
  'login-entry.email_resolution_policy': {
    key: 'login-entry.email_resolution_policy',
    type: 'enum',
    default: 'exact_email_then_domain',
    label: 'Email Resolution Policy',
    description:
      'Controls whether email discovery uses exact address matching only, exact match with domain fallback, or is disabled.',
    enum: ['exact_email_then_domain', 'exact_email_only', 'disabled'],
    visibility: 'admin',
  },
  'login-entry.selection_policy': {
    key: 'login-entry.selection_policy',
    type: 'enum',
    default: 'select_if_multiple',
    label: 'Selection Policy',
    description: 'Controls when tenant selection is automatic and when chooser input is shown.',
    enum: ['auto_if_single', 'always_select', 'select_if_multiple', 'manual_only'],
    visibility: 'admin',
  },
  'login-entry.allow_manual_tenant_entry': {
    key: 'login-entry.allow_manual_tenant_entry',
    type: 'boolean',
    default: true,
    label: 'Allow Manual Tenant Entry',
    description: 'Allow tenant code or slug entry as a discovery fallback.',
    visibility: 'admin',
  },
  'login-entry.remember_last_tenant': {
    key: 'login-entry.remember_last_tenant',
    type: 'boolean',
    default: true,
    label: 'Remember Last Tenant',
    description: 'Remember the last resolved tenant for future discovery attempts.',
    visibility: 'admin',
  },
  'login-entry.redirect_default_login_to_discovery': {
    key: 'login-entry.redirect_default_login_to_discovery',
    type: 'boolean',
    default: true,
    label: 'Redirect Default Login To Discovery',
    description:
      'Redirect the common-entry /login page to /discover while keeping tenant-specific /login unchanged.',
    visibility: 'admin',
  },
  'login-entry.require_common_discovery_before_login': {
    key: 'login-entry.require_common_discovery_before_login',
    type: 'boolean',
    default: true,
    label: 'Require Common Discovery Before Login',
    description:
      'When enabled, direct tenant-host /login visits must pass through the shared /discover screen first. Challenge-based OIDC login remains unchanged.',
    visibility: 'admin',
  },
  'login-entry.skip_discovery_if_only_one_tenant': {
    key: 'login-entry.skip_discovery_if_only_one_tenant',
    type: 'boolean',
    default: false,
    label: 'Skip Discovery If Only One Tenant',
    description:
      'When enabled on the shared entry host, automatically continue to the tenant login page when exactly one active tenant exists.',
    visibility: 'admin',
  },
  'login-entry.redirect_tenant_discover_to_common_entry': {
    key: 'login-entry.redirect_tenant_discover_to_common_entry',
    type: 'boolean',
    default: true,
    label: 'Redirect Tenant Discover To Common Entry',
    description:
      'Redirect tenant-host /discover requests to the shared common-entry /discover page.',
    visibility: 'admin',
  },
};

/**
 * Login Entry Category Metadata
 */
export const LOGIN_ENTRY_CATEGORY_META: CategoryMeta = {
  category: 'login-entry',
  label: 'Login Entry',
  description: 'Tenant login entry and discovery behavior settings',
  settings: LOGIN_ENTRY_SETTINGS_META,
};

/**
 * Default Login Entry settings values
 */
export const LOGIN_ENTRY_DEFAULTS: LoginEntrySettings = {
  'login-entry.override_enabled': false,
  'login-entry.mode': 'discovery_optional',
  'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug"]',
  'login-entry.email_resolution_policy': 'exact_email_then_domain',
  'login-entry.selection_policy': 'select_if_multiple',
  'login-entry.allow_manual_tenant_entry': true,
  'login-entry.remember_last_tenant': true,
  'login-entry.redirect_default_login_to_discovery': true,
  'login-entry.require_common_discovery_before_login': true,
  'login-entry.skip_discovery_if_only_one_tenant': false,
  'login-entry.redirect_tenant_discover_to_common_entry': true,
};
