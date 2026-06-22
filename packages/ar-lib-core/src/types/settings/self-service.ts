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
}

export const SELF_SERVICE_SETTINGS_META: Record<keyof SelfServiceSettings, SettingMeta> = {
  'self-service.account_page_enabled': {
    key: 'self-service.account_page_enabled',
    type: 'boolean',
    default: false,
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
};

export const SELF_SERVICE_CATEGORY_META: CategoryMeta = {
  category: 'self-service',
  label: 'Self Service',
  description: 'Authrim-managed end-user self-service page settings',
  settings: SELF_SERVICE_SETTINGS_META,
};

export const SELF_SERVICE_DEFAULTS: SelfServiceSettings = {
  'self-service.account_page_enabled': false,
  'self-service.account_page_path': '/account',
};
