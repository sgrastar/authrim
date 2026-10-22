/**
 * Bulk Apply Settings Category
 *
 * Platform-wide limits of the bulk apply (POST /api/admin/settings/bulk-apply), which gives the
 * same settings to several tenants in one call. Platform only: a tenant cannot raise the number of
 * tenants a platform operator reaches at once.
 * API: GET/PATCH /api/admin/platform/settings/bulk-apply
 * Config Level: platform
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface BulkApplySettings {
  'bulk_apply.max_tenants_per_request': number;
  'bulk_apply.max_keys_per_request': number;
}

/** The numbers a request is held to when nothing is saved or set in the environment. */
export const BULK_APPLY_DEFAULT_MAX_TENANTS = 25;
export const BULK_APPLY_DEFAULT_MAX_KEYS = 20;
/** What a saved or environment value is held between (the Worker's subrequest budget). */
export const BULK_APPLY_LIMIT_FLOOR = 1;
export const BULK_APPLY_LIMIT_CEILING = 100;

export const BULK_APPLY_MAX_TENANTS_KEY = 'bulk_apply.max_tenants_per_request';
export const BULK_APPLY_MAX_KEYS_KEY = 'bulk_apply.max_keys_per_request';

export const BULK_APPLY_SETTINGS_META: Record<keyof BulkApplySettings, SettingMeta> = {
  'bulk_apply.max_tenants_per_request': {
    key: 'bulk_apply.max_tenants_per_request',
    type: 'number',
    default: BULK_APPLY_DEFAULT_MAX_TENANTS,
    envKey: 'BULK_APPLY_MAX_TENANTS_PER_REQUEST',
    label: 'Bulk Apply: Tenants per Request',
    description:
      'The most tenants one bulk apply request may name (duplicates count once). Each tenant costs several subrequests and some run time, so a Worker invocation can only serve so many; larger jobs are sent in several requests. Held between 1 and 100.',
    min: BULK_APPLY_LIMIT_FLOOR,
    max: BULK_APPLY_LIMIT_CEILING,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
  },
  'bulk_apply.max_keys_per_request': {
    key: 'bulk_apply.max_keys_per_request',
    type: 'number',
    default: BULK_APPLY_DEFAULT_MAX_KEYS,
    envKey: 'BULK_APPLY_MAX_KEYS_PER_REQUEST',
    label: 'Bulk Apply: Settings per Request',
    description:
      'The most settings (keys set or cleared, over all categories) one bulk apply request may carry for each tenant. Held between 1 and 100.',
    min: BULK_APPLY_LIMIT_FLOOR,
    max: BULK_APPLY_LIMIT_CEILING,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
  },
};

export const BULK_APPLY_CATEGORY_META: CategoryMeta = {
  category: 'bulk-apply',
  label: 'Bulk Apply',
  description: 'Limits of giving the same settings to several tenants in one request',
  settings: BULK_APPLY_SETTINGS_META,
};

export const BULK_APPLY_DEFAULTS: BulkApplySettings = {
  'bulk_apply.max_tenants_per_request': BULK_APPLY_DEFAULT_MAX_TENANTS,
  'bulk_apply.max_keys_per_request': BULK_APPLY_DEFAULT_MAX_KEYS,
};

/**
 * A limit as a request is held to it: a whole number between the floor and the ceiling. A value
 * that is not a number (or an environment value that does not parse) falls back to the default.
 */
export function clampBulkApplyLimit(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(BULK_APPLY_LIMIT_CEILING, Math.max(BULK_APPLY_LIMIT_FLOOR, Math.trunc(number)));
}
