/**
 * Rate Limit Settings Category
 *
 * Settings related to API rate limiting.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/rate-limit
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Rate Limit Settings Interface
 */
export interface RateLimitSettings {
  // Rate Limit Tiers
  'rate_limit.strict': number;
  'rate_limit.moderate': number;
  'rate_limit.lenient': number;

  // Window Settings
  'rate_limit.window_ms': number;

  // Email Rate Limits
  'rate_limit.email_max_requests': number;
  'rate_limit.email_window': number;

  // Auth Rate Limits
  'rate_limit.auth_max_failed_attempts': number;
}

/**
 * Rate Limit Settings Metadata
 */
export const RATE_LIMIT_SETTINGS_META: Record<keyof RateLimitSettings, SettingMeta> = {
  'rate_limit.strict': {
    key: 'rate_limit.strict',
    type: 'number',
    default: 10,
    envKey: 'RATE_LIMIT_STRICT',
    envNumber: 'positive',
    label: 'Strict Rate Limit',
    description:
      'Requests per window for sensitive endpoints (token, register, and others), for the whole platform. Unset: 10, or the value saved through the older rate-limit API.',
    min: 1,
    max: 1000000,
    integer: true,
    // Rate limit counters are shared across tenants: platform only.
    scopes: ['platform'],
    visibility: 'admin',
  },
  'rate_limit.moderate': {
    key: 'rate_limit.moderate',
    type: 'number',
    default: 60,
    envKey: 'RATE_LIMIT_MODERATE',
    envNumber: 'positive',
    label: 'Moderate Rate Limit',
    description:
      'Requests per window for standard API endpoints, for the whole platform. Unset: 60, or the value saved through the older rate-limit API.',
    min: 1,
    max: 1000000,
    integer: true,
    // Rate limit counters are shared across tenants: platform only.
    scopes: ['platform'],
    visibility: 'admin',
  },
  'rate_limit.lenient': {
    key: 'rate_limit.lenient',
    type: 'number',
    default: 300,
    envKey: 'RATE_LIMIT_LENIENT',
    envNumber: 'positive',
    label: 'Lenient Rate Limit',
    description:
      'Requests per window for public endpoints (discovery, JWKS), for the whole platform. Unset: 300, or the value saved through the older rate-limit API.',
    min: 1,
    max: 1000000,
    integer: true,
    // Rate limit counters are shared across tenants: platform only.
    scopes: ['platform'],
    visibility: 'admin',
  },
  'rate_limit.window_ms': {
    key: 'rate_limit.window_ms',
    type: 'duration',
    default: 60000,
    envKey: 'RATE_LIMIT_WINDOW_MS',
    envNumber: 'positive',
    label: 'Rate Limit Window',
    description:
      'Window of the strict, moderate and lenient limits in milliseconds (whole seconds), for the whole platform. Unset: each keeps its own window (60 seconds, or the value saved through the older rate-limit API).',
    min: 1000,
    max: 86400000,
    unit: 'ms',
    integer: true,
    step: 1000,
    scopes: ['platform'],
    visibility: 'admin',
  },
  'rate_limit.email_max_requests': {
    key: 'rate_limit.email_max_requests',
    type: 'number',
    default: 3,
    envKey: 'EMAIL_RATE_LIMIT_MAX_REQUESTS',
    label: 'Email Max Requests',
    description: 'Maximum email sends per window (spam protection)',
    min: 1,
    max: 10,
    visibility: 'admin',
  },
  'rate_limit.email_window': {
    key: 'rate_limit.email_window',
    type: 'duration',
    default: 900,
    envKey: 'EMAIL_RATE_LIMIT_WINDOW',
    label: 'Email Rate Window',
    description: 'Email rate limit window in seconds (default: 15 minutes)',
    min: 300,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'rate_limit.auth_max_failed_attempts': {
    key: 'rate_limit.auth_max_failed_attempts',
    type: 'number',
    default: 5,
    envKey: 'AUTH_MAX_FAILED_ATTEMPTS',
    label: 'Max Failed Auth Attempts',
    description: 'Maximum failed authentication attempts before lockout',
    min: 3,
    max: 20,
    visibility: 'admin',
  },
};

/**
 * Rate Limit Category Metadata
 */
export const RATE_LIMIT_CATEGORY_META: CategoryMeta = {
  category: 'rate-limit',
  label: 'Rate Limiting',
  description: 'API rate limiting configuration',
  settings: RATE_LIMIT_SETTINGS_META,
};

/**
 * Default Rate Limit settings values
 */
export const RATE_LIMIT_DEFAULTS: RateLimitSettings = {
  'rate_limit.strict': 10,
  'rate_limit.moderate': 60,
  'rate_limit.lenient': 300,
  'rate_limit.window_ms': 60000,
  'rate_limit.email_max_requests': 3,
  'rate_limit.email_window': 900,
  'rate_limit.auth_max_failed_attempts': 5,
};
