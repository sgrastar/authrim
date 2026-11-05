/**
 * Admin Notices Settings Category
 *
 * How long the admin console keeps notices that are no longer shown.
 * API: GET/PATCH /api/admin/platform/settings/admin-notices
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface AdminNoticesSettings {
  /** Days a resolved or expired notice is kept before it is deleted */
  'admin-notices.retention_days': number;
}

export const ADMIN_NOTICES_SETTINGS_META: Record<keyof AdminNoticesSettings, SettingMeta> = {
  'admin-notices.retention_days': {
    key: 'admin-notices.retention_days',
    type: 'number',
    default: 90,
    envKey: 'ADMIN_NOTICE_RETENTION_DAYS',
    label: 'Keep handled notices (days)',
    description:
      'Notices that were resolved or expired more than this many days ago are deleted, with who dismissed them. Open notices are never deleted.',
    visibility: 'admin',
    min: 1,
    max: 3650,
    integer: true,
    // 0 or less in the environment leaves the default.
    envNumber: 'positive',
  },
};

export const ADMIN_NOTICES_CATEGORY_META: CategoryMeta = {
  category: 'admin-notices',
  label: 'Admin Notices',
  description: 'How long handled admin console notices are kept',
  settings: ADMIN_NOTICES_SETTINGS_META,
};

export const ADMIN_NOTICES_DEFAULTS: AdminNoticesSettings = {
  'admin-notices.retention_days': 90,
};
