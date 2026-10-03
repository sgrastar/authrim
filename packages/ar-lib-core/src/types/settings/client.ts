/**
 * Client Settings Category
 *
 * Per-client OAuth settings.
 * API: GET/PATCH /api/admin/clients/:clientId/settings
 * Config Level: client
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Client Settings Interface
 */
export interface ClientSettings {
  // App Login Settings (first-party authority lives in Client Trust Policy)
  'client.app_login_enabled': boolean;

  // SSO Override
  'client.sso_enabled': boolean;

  'client.default_audience': string;
  'client.default_resource': string;
}

/**
 * Client Settings Metadata
 */
export const CLIENT_SETTINGS_META: Record<keyof ClientSettings, SettingMeta> = {
  'client.app_login_enabled': {
    key: 'client.app_login_enabled',
    type: 'boolean',
    default: false,
    label: 'App Login Enabled',
    description:
      'Allow Login UI direct sign-in to start this first-party OIDC client after authentication.',
    visibility: 'admin',
  },
  'client.sso_enabled': {
    key: 'client.sso_enabled',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_SSO_ENABLED',
    label: 'SSO Enabled',
    description:
      'Enable Single Sign-On for this client. When disabled, users must authenticate even with an existing session.',
    visibility: 'public',
  },

  'client.default_audience': {
    key: 'client.default_audience',
    type: 'string',
    default: '',
    envKey: 'CLIENT_DEFAULT_AUDIENCE',
    label: 'Default Audience',
    description: 'Default audience for tokens',
    visibility: 'admin',
  },
  'client.default_resource': {
    key: 'client.default_resource',
    type: 'string',
    default: '',
    envKey: 'CLIENT_DEFAULT_RESOURCE',
    label: 'Default Resource',
    description:
      'Default resource target for access tokens when the token request omits resource/audience.',
    visibility: 'admin',
  },
};

/**
 * Client Category Metadata
 */
export const CLIENT_CATEGORY_META: CategoryMeta = {
  category: 'client',
  label: 'Client Settings',
  description: 'Per-client OAuth configuration',
  settings: CLIENT_SETTINGS_META,
};

/**
 * Default Client settings values
 */
export const CLIENT_DEFAULTS: ClientSettings = {
  'client.app_login_enabled': false,
  'client.sso_enabled': false,
  'client.default_audience': '',
  'client.default_resource': '',
};
