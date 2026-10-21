/**
 * Log Storage Settings Category
 *
 * Where audit and security log rows live over time.
 * API: GET/PATCH /api/admin/platform/settings/log-storage
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface LogStorageSettings {
  /** Days log rows stay in D1 before they move to R2; 0 keeps them in D1 */
  'log-storage.d1_retention_days': number;
}

export const LOG_STORAGE_SETTINGS_META: Record<keyof LogStorageSettings, SettingMeta> = {
  'log-storage.d1_retention_days': {
    key: 'log-storage.d1_retention_days',
    type: 'number',
    // Off by default; setup turns it on (7) for new environments only.
    default: 0,
    label: 'Days in D1',
    description:
      'Audit and security log rows older than this many days move from D1 to R2 as whole rows and stay readable there until they expire. 0 keeps every row in D1.',
    visibility: 'admin',
    min: 0,
    max: 3650,
    integer: true,
  },
};

export const LOG_STORAGE_CATEGORY_META: CategoryMeta = {
  category: 'log-storage',
  label: 'Log Storage',
  description: 'How long log rows stay in D1 before they move to R2',
  settings: LOG_STORAGE_SETTINGS_META,
};

export const LOG_STORAGE_DEFAULTS: LogStorageSettings = {
  'log-storage.d1_retention_days': 0,
};
