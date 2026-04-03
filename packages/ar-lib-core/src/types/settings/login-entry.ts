/**
 * Login Entry Settings Category
 *
 * Settings related to login entry mode and discovery routing behavior.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/login-entry
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Login Entry Settings Interface
 */
export interface LoginEntrySettings {
  'login-entry.mode': 'tenant_only' | 'discovery_optional' | 'discovery_required';
  'login-entry.discovery_methods': string;
  'login-entry.selection_policy':
    | 'auto_if_single'
    | 'always_select'
    | 'select_if_multiple'
    | 'manual_only';
  'login-entry.allow_manual_tenant_entry': boolean;
  'login-entry.remember_last_tenant': boolean;
  'login-entry.redirect_default_login_to_discovery': boolean;
  'login-entry.host_policy': 'common_entry_only' | 'all_hosts';
}

/**
 * Login Entry Settings Metadata
 */
export const LOGIN_ENTRY_SETTINGS_META: Record<keyof LoginEntrySettings, SettingMeta> = {
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
  'login-entry.host_policy': {
    key: 'login-entry.host_policy',
    type: 'enum',
    default: 'common_entry_only',
    label: 'Discovery Host Policy',
    description:
      'Controls whether built-in discovery is available only on the common entry host or on all tenant/vanity hosts.',
    enum: ['common_entry_only', 'all_hosts'],
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
  'login-entry.mode': 'discovery_optional',
  'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug"]',
  'login-entry.selection_policy': 'select_if_multiple',
  'login-entry.allow_manual_tenant_entry': true,
  'login-entry.remember_last_tenant': true,
  'login-entry.redirect_default_login_to_discovery': true,
  'login-entry.host_policy': 'common_entry_only',
};
