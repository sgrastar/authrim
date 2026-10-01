/**
 * Limits Settings Category
 *
 * Settings for various system limits and caps.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/limits
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Limits Settings Interface
 */
export interface LimitsSettings {
  // Query Limits
  'limits.max_query_limit': number;
  'limits.default_batch_size': number;

  // Permission Limits
  'limits.max_embedded_permissions': number;
  'limits.max_resource_permissions': number;
  'limits.max_custom_claims': number;

  // Token Exchange Limits
  'limits.token_exchange_max_resource_params': number;
  'limits.token_exchange_max_audience_params': number;
}

/**
 * Limits Settings Metadata
 */
export const LIMITS_SETTINGS_META: Record<keyof LimitsSettings, SettingMeta> = {
  // Query Limits
  'limits.max_query_limit': {
    key: 'limits.max_query_limit',
    type: 'number',
    default: 1000,
    envKey: 'MAX_QUERY_LIMIT',
    label: 'Max Query Limit',
    description: 'Maximum items per query (pagination limit)',
    min: 10,
    max: 10000,
    visibility: 'admin',
  },
  'limits.default_batch_size': {
    key: 'limits.default_batch_size',
    type: 'number',
    default: 100,
    envKey: 'DEFAULT_BATCH_SIZE_LIMIT',
    label: 'Default Batch Size',
    description: 'Default batch size for bulk operations',
    min: 10,
    max: 1000,
    visibility: 'admin',
  },

  // Permission Limits
  'limits.max_embedded_permissions': {
    key: 'limits.max_embedded_permissions',
    type: 'number',
    default: 50,
    envKey: 'MAX_EMBEDDED_PERMISSIONS',
    envNumber: 'positive',
    integer: true,
    label: 'Max Embedded Permissions',
    description:
      'Maximum permissions embedded in access tokens by policy embedding (tenant-wide first, then scoped)',
    min: 1,
    max: 500,
    visibility: 'admin',
  },
  'limits.max_resource_permissions': {
    key: 'limits.max_resource_permissions',
    type: 'number',
    default: 100,
    envKey: 'MAX_RESOURCE_PERMISSIONS',
    envNumber: 'positive',
    integer: true,
    label: 'Max Resource Permissions',
    description: 'Maximum resource-level permissions per user',
    min: 1,
    max: 1000,
    visibility: 'admin',
  },
  'limits.max_custom_claims': {
    key: 'limits.max_custom_claims',
    type: 'number',
    default: 20,
    envKey: 'MAX_CUSTOM_CLAIMS',
    envNumber: 'positive',
    integer: true,
    label: 'Max Custom Claims',
    description: 'Maximum custom claims in ID tokens',
    min: 1,
    max: 100,
    visibility: 'admin',
  },

  // Token Exchange Limits
  'limits.token_exchange_max_resource_params': {
    key: 'limits.token_exchange_max_resource_params',
    type: 'number',
    default: 10,
    envKey: 'TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS',
    label: 'Token Exchange Max Resource Params',
    description: 'Maximum resource parameters in token exchange request',
    min: 1,
    max: 50,
    visibility: 'admin',
  },
  'limits.token_exchange_max_audience_params': {
    key: 'limits.token_exchange_max_audience_params',
    type: 'number',
    default: 10,
    envKey: 'TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS',
    label: 'Token Exchange Max Audience Params',
    description: 'Maximum audience parameters in token exchange request',
    min: 1,
    max: 50,
    visibility: 'admin',
  },
};

/**
 * Limits Category Metadata
 */
export const LIMITS_CATEGORY_META: CategoryMeta = {
  category: 'limits',
  label: 'Limits',
  description: 'System limits for queries, permissions, and operations',
  settings: LIMITS_SETTINGS_META,
};

/**
 * Default Limits settings values
 */
export const LIMITS_DEFAULTS: LimitsSettings = {
  'limits.max_query_limit': 1000,
  'limits.default_batch_size': 100,
  'limits.max_embedded_permissions': 50,
  'limits.max_resource_permissions': 100,
  'limits.max_custom_claims': 20,
  'limits.token_exchange_max_resource_params': 10,
  'limits.token_exchange_max_audience_params': 10,
};
