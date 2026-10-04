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

  // Email Rate Limits
  'rate_limit.email_max_requests': number;
  'rate_limit.email_window': number;

  // Auth Rate Limits
  'rate_limit.auth_max_failed_attempts': number;
  'rate_limit.public_read': number;
  'rate_limit.login_start': number;
  'rate_limit.send_challenge': number;
  'rate_limit.loadtest': number;
  'rate_limit.strict_window_seconds': number;
  'rate_limit.moderate_window_seconds': number;
  'rate_limit.lenient_window_seconds': number;
  'rate_limit.public_read_window_seconds': number;
  'rate_limit.login_start_window_seconds': number;
  'rate_limit.send_challenge_window_seconds': number;
  'rate_limit.loadtest_window_seconds': number;
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
      'Requests per window for sensitive endpoints (token, register, and others), for the whole platform. Unset: 10, or the value saved through the older rate-limit API, or env.',
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
      'Requests per window for standard API endpoints, for the whole platform. Unset: 60, or the value saved through the older rate-limit API, or env.',
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
      'Requests per window for public endpoints (discovery, JWKS), for the whole platform. Unset: 300, or the value saved through the older rate-limit API, or env.',
    min: 1,
    max: 1000000,
    integer: true,
    // Rate limit counters are shared across tenants: platform only.
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
    integer: true,
    type: 'number',
    default: 5,
    envKey: 'AUTH_MAX_FAILED_ATTEMPTS',
    label: 'Max Failed Auth Attempts',
    description:
      'Failed password attempts (directory passwords, within 15 minutes) after which the account is locked for the rest of that time',
    min: 3,
    max: 20,
    visibility: 'admin',
  },
  'rate_limit.public_read': {
    key: 'rate_limit.public_read',
    type: 'number',
    label: 'Public Read Rate Limit',
    description:
      'Requests per window for public read-only bootstrap endpoints, for the whole platform',
    min: 1,
    max: 1000000,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 600,
  },
  'rate_limit.login_start': {
    key: 'rate_limit.login_start',
    type: 'number',
    label: 'Login Start Rate Limit',
    description: 'Requests per window for starting a login interaction, for the whole platform',
    min: 1,
    max: 1000000,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 300,
  },
  'rate_limit.send_challenge': {
    key: 'rate_limit.send_challenge',
    type: 'number',
    label: 'Send Challenge Rate Limit',
    description:
      'Requests per window for endpoints that send a challenge (such as an email code), for the whole platform',
    min: 1,
    max: 1000000,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 30,
  },
  'rate_limit.loadtest': {
    key: 'rate_limit.loadtest',
    type: 'number',
    label: 'Load Test Rate Limit',
    description: 'Requests per window under the load-test profile, for the whole platform',
    min: 1,
    max: 1000000,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 10000,
  },
  'rate_limit.strict_window_seconds': {
    key: 'rate_limit.strict_window_seconds',
    type: 'number',
    label: 'Strict Window',
    description: 'Window of the strict limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
  },
  'rate_limit.moderate_window_seconds': {
    key: 'rate_limit.moderate_window_seconds',
    type: 'number',
    label: 'Moderate Window',
    description: 'Window of the moderate limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
  },
  'rate_limit.lenient_window_seconds': {
    key: 'rate_limit.lenient_window_seconds',
    type: 'number',
    label: 'Lenient Window',
    description: 'Window of the lenient limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
  },
  'rate_limit.public_read_window_seconds': {
    key: 'rate_limit.public_read_window_seconds',
    type: 'number',
    label: 'Public Read Window',
    description: 'Window of the public read limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
  },
  'rate_limit.login_start_window_seconds': {
    key: 'rate_limit.login_start_window_seconds',
    type: 'number',
    label: 'Login Start Window',
    description: 'Window of the login start limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
  },
  'rate_limit.send_challenge_window_seconds': {
    key: 'rate_limit.send_challenge_window_seconds',
    type: 'number',
    label: 'Send Challenge Window',
    description: 'Window of the send challenge limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
  },
  'rate_limit.loadtest_window_seconds': {
    key: 'rate_limit.loadtest_window_seconds',
    type: 'number',
    label: 'Load Test Window',
    description: 'Window of the load test limit, for the whole platform',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    scopes: ['platform'],
    visibility: 'admin',
    default: 60,
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
  'rate_limit.email_max_requests': 3,
  'rate_limit.email_window': 900,
  'rate_limit.auth_max_failed_attempts': 5,
  'rate_limit.public_read': 600,
  'rate_limit.login_start': 300,
  'rate_limit.send_challenge': 30,
  'rate_limit.loadtest': 10000,
  'rate_limit.strict_window_seconds': 60,
  'rate_limit.moderate_window_seconds': 60,
  'rate_limit.lenient_window_seconds': 60,
  'rate_limit.public_read_window_seconds': 60,
  'rate_limit.login_start_window_seconds': 60,
  'rate_limit.send_challenge_window_seconds': 60,
  'rate_limit.loadtest_window_seconds': 60,
};

/** The rate limiter's profiles, by the name of their Settings API keys. */
export const RATE_LIMIT_PROFILE_SETTING_NAMES = {
  strict: 'strict',
  moderate: 'moderate',
  lenient: 'lenient',
  publicRead: 'public_read',
  loginStart: 'login_start',
  sendChallenge: 'send_challenge',
  loadTest: 'loadtest',
} as const;

export type RateLimitProfileName = keyof typeof RATE_LIMIT_PROFILE_SETTING_NAMES;

/**
 * A profile's Settings API keys (`rate_limit.<name>`, `rate_limit.<name>_window_seconds`) and the
 * AUTHRIM_CONFIG keys the older rate-limit API saved them under.
 */
export function rateLimitProfileKeys(profile: RateLimitProfileName): {
  maxRequests: string;
  windowSeconds: string;
  legacyMaxRequests: string;
  legacyWindowSeconds: string;
} {
  const name = RATE_LIMIT_PROFILE_SETTING_NAMES[profile];
  return {
    maxRequests: `rate_limit.${name}`,
    windowSeconds: `rate_limit.${name}_window_seconds`,
    legacyMaxRequests: `rate_limit_${name}_max_requests`,
    legacyWindowSeconds: `rate_limit_${name}_window_seconds`,
  };
}
