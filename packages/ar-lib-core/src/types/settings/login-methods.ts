/**
 * Login Methods Settings Category
 *
 * Settings for public Login UI method discovery.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/login-methods
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface LoginMethodsSettings {
  'login-methods.cache_ttl': number;
  'login-methods.external_providers': string;
  'login-methods.directory_password.enabled': boolean;
  'login-methods.directory_password.connector_id': string;
  'login-methods.directory_password.label': string;
  'login-methods.directory_password.auto_provision': boolean;
}

export const LOGIN_METHODS_SETTINGS_META: Record<keyof LoginMethodsSettings, SettingMeta> = {
  'login-methods.cache_ttl': {
    key: 'login-methods.cache_ttl',
    type: 'duration',
    default: 300,
    envKey: 'LOGIN_METHODS_CACHE_TTL',
    label: 'Cache TTL',
    description: 'Cache lifetime for the public login methods response',
    min: 0,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'login-methods.external_providers': {
    key: 'login-methods.external_providers',
    type: 'string',
    default: '[]',
    label: 'External Providers',
    description: 'JSON array of custom external login providers displayed by Login UI',
    visibility: 'page',
  },
  'login-methods.directory_password.enabled': {
    key: 'login-methods.directory_password.enabled',
    type: 'boolean',
    default: false,
    label: 'Directory Password',
    description: 'Enable organization directory password login via Authrim Wordwarden',
    visibility: 'admin',
  },
  'login-methods.directory_password.connector_id': {
    key: 'login-methods.directory_password.connector_id',
    type: 'string',
    default: 'default',
    label: 'Directory Connector ID',
    description: 'Tenant-scoped Wordwarden connector ID used for directory password login',
    visibility: 'admin',
  },
  'login-methods.directory_password.label': {
    key: 'login-methods.directory_password.label',
    type: 'string',
    default: 'Organization ID',
    label: 'Directory Password Label',
    description: 'Public label shown for directory password login',
    visibility: 'page',
  },
  'login-methods.directory_password.auto_provision': {
    key: 'login-methods.directory_password.auto_provision',
    type: 'boolean',
    default: false,
    label: 'Directory Password Auto Provision',
    description:
      'Create an Authrim user automatically after successful directory verification when no mapped user exists',
    visibility: 'admin',
  },
};

export const LOGIN_METHODS_CATEGORY_META: CategoryMeta = {
  category: 'login-methods',
  label: 'Login Methods',
  description: 'Login method discovery and custom external provider settings',
  settings: LOGIN_METHODS_SETTINGS_META,
};

export const LOGIN_METHODS_DEFAULTS: LoginMethodsSettings = {
  'login-methods.cache_ttl': 300,
  'login-methods.external_providers': '[]',
  'login-methods.directory_password.enabled': false,
  'login-methods.directory_password.connector_id': 'default',
  'login-methods.directory_password.label': 'Organization ID',
  'login-methods.directory_password.auto_provision': false,
};
