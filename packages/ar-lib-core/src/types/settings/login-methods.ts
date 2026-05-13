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
};
