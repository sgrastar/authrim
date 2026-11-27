/**
 * Check API Settings Category
 *
 * Tenant settings of the Check API (`POST /api/check`).
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/check
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface CheckSettings {
  /**
   * The audience an end-user access token must carry to call the Check API (the self contract).
   * Empty: the tenant's issuer URL.
   */
  'check.audience': string;
}

export const CHECK_SETTINGS_META: Record<keyof CheckSettings, SettingMeta> = {
  'check.audience': {
    key: 'check.audience',
    type: 'string',
    default: '',
    label: 'Check API Audience',
    description:
      "The audience an end-user access token must carry to call the Check API with its own subject. Empty: the tenant's issuer URL.",
    visibility: 'admin',
  },
};

export const CHECK_CATEGORY_META: CategoryMeta = {
  category: 'check',
  label: 'Check API',
  description: 'Check API settings (the audience of end-user access tokens)',
  settings: CHECK_SETTINGS_META,
};

export const CHECK_DEFAULTS: CheckSettings = {
  'check.audience': '',
};
