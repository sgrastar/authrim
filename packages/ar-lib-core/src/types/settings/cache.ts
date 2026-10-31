/**
 * Cache Settings Category
 *
 * Settings for various cache TTLs and caching behavior.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/cache
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Cache Settings Interface
 */
export interface CacheSettings {}

/**
 * Cache Settings Metadata
 */
export const CACHE_SETTINGS_META: Record<keyof CacheSettings, SettingMeta> = {};

/**
 * Cache Category Metadata
 */
export const CACHE_CATEGORY_META: CategoryMeta = {
  category: 'cache',
  label: 'Cache Settings',
  description:
    'Holds no settings: cache lifetimes are internal tuning values fixed in code (they are not meant to be changed at run time). Nothing is planned here.',
  settings: CACHE_SETTINGS_META,
};

/**
 * Default Cache settings values
 */
export const CACHE_DEFAULTS: CacheSettings = {};
