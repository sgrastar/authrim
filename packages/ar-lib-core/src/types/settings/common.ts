/**
 * Common Types for Settings API v2
 *
 * This file defines the base types used across all setting categories.
 */

import type { SettingMeta, CategoryMeta } from '../../utils/settings-manager';

export type { SettingMeta, CategoryMeta };

/**
 * Setting scope level for hierarchical settings
 * - platform: Global settings, managed by system admins
 * - tenant: Tenant-specific settings, inherited from platform
 * - client: Client-specific settings, inherited from tenant
 */
export type SettingScopeLevel = 'platform' | 'tenant' | 'client';

/**
 * Role-based permissions for settings
 */
export interface ScopePermission {
  /** Roles that can view settings at this scope */
  viewRoles: string[];
  /** Roles that can edit settings at this scope */
  editRoles: string[];
}

/**
 * Extended category metadata with scope information
 */
export interface ScopedCategoryMeta extends CategoryMeta {
  /** Scopes where this category is available */
  allowedScopes: SettingScopeLevel[];
  /** Permission mapping per scope level */
  scopePermissions: Record<SettingScopeLevel, ScopePermission>;
}

/**
 * Default scope permissions for common role patterns
 */
export const DEFAULT_SCOPE_PERMISSIONS: Record<SettingScopeLevel, ScopePermission> = {
  platform: {
    viewRoles: ['system_admin', 'viewer'],
    editRoles: ['system_admin'],
  },
  tenant: {
    viewRoles: ['system_admin', 'distributor_admin', 'org_admin', 'viewer'],
    editRoles: ['system_admin', 'distributor_admin'],
  },
  client: {
    viewRoles: ['system_admin', 'distributor_admin', 'org_admin', 'viewer'],
    editRoles: ['system_admin', 'distributor_admin', 'org_admin'],
  },
};

/**
 * Create a scoped category metadata object
 */
export function defineScopedCategory(
  category: string,
  config: Omit<ScopedCategoryMeta, 'category'>
): ScopedCategoryMeta {
  return { category, ...config };
}

/**
 * Helper type to extract the value type from a SettingMeta
 */
export type SettingValue<T extends SettingMeta> = T['type'] extends 'number' | 'duration'
  ? number
  : T['type'] extends 'boolean'
    ? boolean
    : T['type'] extends 'string' | 'enum'
      ? string
      : unknown;

/**
 * Base visibility levels for settings
 */
export type SettingVisibility = 'public' | 'admin' | 'internal';

/**
 * Duration units
 */
export type DurationUnit = 'seconds' | 'ms' | 'minutes' | 'hours' | 'days';

/**
 * Create a setting metadata object with type safety
 */
export function defineSetting(key: string, config: Omit<SettingMeta, 'key'>): SettingMeta {
  return { key, ...config };
}

/**
 * Create a category metadata object
 */
export function defineCategory(
  category: string,
  config: Omit<CategoryMeta, 'category'>
): CategoryMeta {
  return { category, ...config };
}
