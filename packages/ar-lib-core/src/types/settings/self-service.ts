/**
 * Self Service Settings Category
 *
 * Tenant-scoped settings for Authrim-managed end-user self-service pages.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/self-service
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface SelfServiceSettings {
  'self-service.account_page_enabled': boolean;
  'self-service.account_page_path': string;
  'self-service.reauth_ttl_seconds': number;
}

export const SELF_SERVICE_SETTINGS_META: Record<keyof SelfServiceSettings, SettingMeta> = {
  'self-service.account_page_enabled': {
    key: 'self-service.account_page_enabled',
    type: 'boolean',
    default: true,
    label: 'Account Page Enabled',
    description: 'Enable the Authrim-managed account page for end users.',
    visibility: 'admin',
  },
  'self-service.account_page_path': {
    key: 'self-service.account_page_path',
    type: 'string',
    default: '/account',
    label: 'Account Page Path',
    description:
      'Public path prefix for Authrim-managed account pages. The prefix and all child paths are reserved by Login UI when enabled.',
    visibility: 'admin',
  },
  'self-service.reauth_ttl_seconds': {
    key: 'self-service.reauth_ttl_seconds',
    type: 'number',
    default: 300,
    envKey: 'SELF_SERVICE_REAUTH_TTL_SECONDS',
    envNumber: 'in-range',
    label: 'Re-authentication Window',
    description:
      'Seconds after signing in (or re-authenticating) during which an end user may change how they sign in from the account page: register or remove passkeys and authenticator apps, change their email, link or unlink external accounts. Shorter is safer.',
    min: 60,
    max: 1800,
    integer: true,
    unit: 's',
    visibility: 'admin',
  },
};

export const SELF_SERVICE_CATEGORY_META: CategoryMeta = {
  category: 'self-service',
  label: 'Self Service',
  description: 'Authrim-managed end-user self-service page settings',
  settings: SELF_SERVICE_SETTINGS_META,
};

export const SELF_SERVICE_DEFAULTS: SelfServiceSettings = {
  'self-service.account_page_enabled': true,
  'self-service.account_page_path': '/account',
  'self-service.reauth_ttl_seconds': 300,
};
