/**
 * Groups Settings Category
 *
 * Tenant-scoped settings of end-user groups.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/groups
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface GroupsSettings {
  'groups.dynamic_freshness_seconds': number;
}

export const GROUPS_SETTINGS_CATEGORY = 'groups';
export const GROUPS_DYNAMIC_FRESHNESS_KEY = 'groups.dynamic_freshness_seconds';
export const GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS = 86_400;
export const GROUPS_DYNAMIC_FRESHNESS_MIN_SECONDS = 3_600;
export const GROUPS_DYNAMIC_FRESHNESS_MAX_SECONDS = 30 * 86_400;

export const GROUPS_SETTINGS_META: Record<keyof GroupsSettings, SettingMeta> = {
  'groups.dynamic_freshness_seconds': {
    key: GROUPS_DYNAMIC_FRESHNESS_KEY,
    type: 'number',
    default: GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS,
    scopes: ['tenant'],
    label: 'Dynamic group membership freshness window',
    description:
      'Seconds a published dynamic group membership keeps granting without being checked again. The scheduler checks it again and renews it when less than half is left; when the check finds the result out of date or failing, the membership stops at once. Shorter means a membership no longer backed by a checked result stops sooner, at the cost of more scheduled work.',
    min: GROUPS_DYNAMIC_FRESHNESS_MIN_SECONDS,
    max: GROUPS_DYNAMIC_FRESHNESS_MAX_SECONDS,
    integer: true,
    unit: 's',
    visibility: 'admin',
  },
};

export const GROUPS_CATEGORY_META: CategoryMeta = {
  category: GROUPS_SETTINGS_CATEGORY,
  label: 'Groups',
  description: 'End-user group settings',
  settings: GROUPS_SETTINGS_META,
};

export const GROUPS_DEFAULTS: GroupsSettings = {
  'groups.dynamic_freshness_seconds': GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS,
};
