/**
 * Authentication Methods Settings Category
 *
 * Settings for public Login UI method discovery.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/authentication-methods
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface AuthenticationMethodsSettings {
  'authentication-methods.cache_ttl': number;
  'authentication-methods.external_providers': string;
  'authentication-methods.directory_password.enabled': boolean;
  'authentication-methods.directory_password.connector_id': string;
  'authentication-methods.directory_password.label': string;
  'authentication-methods.directory_password.auto_provision': boolean;
}

export const AUTHENTICATION_METHODS_SETTINGS_META: Record<
  keyof AuthenticationMethodsSettings,
  SettingMeta
> = {
  'authentication-methods.cache_ttl': {
    key: 'authentication-methods.cache_ttl',
    type: 'duration',
    default: 300,
    envKey: 'AUTHENTICATION_METHODS_CACHE_TTL',
    label: 'Cache TTL',
    description: 'Cache lifetime for the public authentication methods response',
    min: 0,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'authentication-methods.external_providers': {
    key: 'authentication-methods.external_providers',
    type: 'string',
    default: '[]',
    label: 'External Providers',
    description: 'JSON array of custom external login providers displayed by Login UI',
    visibility: 'page',
  },
  'authentication-methods.directory_password.enabled': {
    key: 'authentication-methods.directory_password.enabled',
    type: 'boolean',
    default: false,
    label: 'Directory Password',
    description: 'Enable organization directory password login via Authrim Wordwarden',
    visibility: 'admin',
  },
  'authentication-methods.directory_password.connector_id': {
    key: 'authentication-methods.directory_password.connector_id',
    type: 'string',
    default: 'default',
    label: 'Directory Connector ID',
    description: 'Tenant-scoped Wordwarden connector ID used for directory password login',
    visibility: 'admin',
  },
  'authentication-methods.directory_password.label': {
    key: 'authentication-methods.directory_password.label',
    type: 'string',
    default: 'Organization ID',
    label: 'Directory Password Label',
    description: 'Public label shown for directory password login',
    visibility: 'page',
  },
  'authentication-methods.directory_password.auto_provision': {
    key: 'authentication-methods.directory_password.auto_provision',
    type: 'boolean',
    default: false,
    label: 'Directory Password Auto Provision',
    description:
      'Create an Authrim user automatically after successful directory verification when no mapped user exists',
    visibility: 'admin',
  },
};

export const AUTHENTICATION_METHODS_CATEGORY_META: CategoryMeta = {
  category: 'authentication-methods',
  label: 'Authentication Methods',
  description: 'Login method discovery and custom external provider settings',
  settings: AUTHENTICATION_METHODS_SETTINGS_META,
};

export const AUTHENTICATION_METHODS_DEFAULTS: AuthenticationMethodsSettings = {
  'authentication-methods.cache_ttl': 300,
  'authentication-methods.external_providers': '[]',
  'authentication-methods.directory_password.enabled': false,
  'authentication-methods.directory_password.connector_id': 'default',
  'authentication-methods.directory_password.label': 'Organization ID',
  'authentication-methods.directory_password.auto_provision': false,
};
