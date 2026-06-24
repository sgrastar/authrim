/**
 * Session Settings Category
 *
 * Settings related to user sessions and logout.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/session
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Session Settings Interface
 */
export interface SessionSettings {
  // Session TTL
  'session.default_ttl': number;
  'session.max_ttl': number;
  'session.min_ttl': number;
  'session.ttl.email_code': number;
  'session.ttl.directory_password': number;
  'session.ttl.direct_auth': number;
  'session.ttl.passkey': number;
  'session.ttl.passkey_registration': number;
  'session.ttl.admin_passkey': number;
  'session.ttl.anonymous': number;
  'session.ttl.did': number;
  'session.refresh_default': boolean;
  'session.token_ttl': number;
  'session.tombstone_ttl': number;

  // Logout Configuration
  'session.backchannel_logout_token_exp': number;
  'session.backchannel_request_timeout_ms': number;
  'session.backchannel_retry_max_attempts': number;
  'session.backchannel_retry_initial_delay_ms': number;
  'session.backchannel_retry_max_delay_ms': number;
  'session.backchannel_retry_backoff_multiplier': number;
  'session.backchannel_on_failure': 'ignore' | 'log' | 'error';
}

/**
 * Session Settings Metadata
 */
export const SESSION_SETTINGS_META: Record<keyof SessionSettings, SettingMeta> = {
  // Session TTL
  'session.default_ttl': {
    key: 'session.default_ttl',
    type: 'duration',
    default: 86400000,
    envKey: 'DEFAULT_SESSION_TTL',
    label: 'Default Session TTL',
    description: 'Default session lifetime in milliseconds (24 hours)',
    min: 60000,
    max: 604800000,
    unit: 'ms',
    visibility: 'public',
  },
  'session.max_ttl': {
    key: 'session.max_ttl',
    type: 'duration',
    default: 604800000,
    envKey: 'MAX_SESSION_TTL_MS',
    label: 'Max Session TTL',
    description: 'Maximum allowed session lifetime in milliseconds (7 days)',
    min: 86400000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.min_ttl': {
    key: 'session.min_ttl',
    type: 'duration',
    default: 60000,
    envKey: 'MIN_SESSION_TTL_MS',
    label: 'Min Session TTL',
    description: 'Minimum allowed session lifetime in milliseconds (1 minute)',
    min: 30000,
    max: 86400000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.email_code': {
    key: 'session.ttl.email_code',
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TTL_EMAIL_CODE_MS',
    label: 'Email Code Session TTL',
    description: 'Session lifetime after email code authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.directory_password': {
    key: 'session.ttl.directory_password',
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TTL_DIRECTORY_PASSWORD_MS',
    label: 'Directory Password Session TTL',
    description:
      'Session lifetime after Directory Connector password authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.direct_auth': {
    key: 'session.ttl.direct_auth',
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TTL_DIRECT_AUTH_MS',
    label: 'Direct Auth Session TTL',
    description: 'Session lifetime after Direct Auth artifact completion in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.passkey': {
    key: 'session.ttl.passkey',
    type: 'duration',
    default: 604800000,
    envKey: 'SESSION_TTL_PASSKEY_MS',
    label: 'Passkey Session TTL',
    description: 'Session lifetime after end-user passkey authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.passkey_registration': {
    key: 'session.ttl.passkey_registration',
    type: 'duration',
    default: 2592000000,
    envKey: 'SESSION_TTL_PASSKEY_REGISTRATION_MS',
    label: 'Passkey Registration Session TTL',
    description: 'Session lifetime created immediately after passkey registration in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.admin_passkey': {
    key: 'session.ttl.admin_passkey',
    type: 'duration',
    default: 604800000,
    envKey: 'SESSION_TTL_ADMIN_PASSKEY_MS',
    label: 'Admin Passkey Session TTL',
    description: 'Admin UI session lifetime after passkey authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.anonymous': {
    key: 'session.ttl.anonymous',
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TTL_ANONYMOUS_MS',
    label: 'Anonymous Session TTL',
    description: 'Session lifetime after anonymous device authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.did': {
    key: 'session.ttl.did',
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TTL_DID_MS',
    label: 'DID Session TTL',
    description: 'Session lifetime after DID authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.refresh_default': {
    key: 'session.refresh_default',
    type: 'boolean',
    default: true,
    envKey: 'SESSION_REFRESH_DEFAULT',
    label: 'Refresh Session by Default',
    description: 'Extend session on activity by default',
    visibility: 'public',
  },
  'session.token_ttl': {
    key: 'session.token_ttl',
    type: 'duration',
    default: 300,
    envKey: 'SESSION_TOKEN_TTL',
    label: 'Session Token TTL',
    description: 'Session token lifetime in seconds (for session management)',
    min: 60,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'session.tombstone_ttl': {
    key: 'session.tombstone_ttl',
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TOMBSTONE_TTL',
    label: 'Tombstone TTL',
    description: 'How long to keep deleted session markers in milliseconds (24 hours)',
    min: 3600000,
    max: 604800000,
    unit: 'ms',
    visibility: 'admin',
  },

  // Logout Configuration
  'session.backchannel_logout_token_exp': {
    key: 'session.backchannel_logout_token_exp',
    type: 'duration',
    default: 120,
    envKey: 'LOGOUT_BACKCHANNEL_TOKEN_EXP',
    label: 'Backchannel Logout Token Expiry',
    description: 'Logout token expiry time in seconds',
    min: 30,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'session.backchannel_request_timeout_ms': {
    key: 'session.backchannel_request_timeout_ms',
    type: 'duration',
    default: 10000,
    envKey: 'LOGOUT_BACKCHANNEL_REQUEST_TIMEOUT_MS',
    label: 'Backchannel Request Timeout',
    description: 'Timeout for backchannel logout requests in milliseconds',
    min: 1000,
    max: 60000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.backchannel_retry_max_attempts': {
    key: 'session.backchannel_retry_max_attempts',
    type: 'number',
    default: 3,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_MAX_ATTEMPTS',
    label: 'Backchannel Retry Attempts',
    description: 'Maximum retry attempts for failed logout requests',
    min: 0,
    max: 10,
    visibility: 'admin',
  },
  'session.backchannel_retry_initial_delay_ms': {
    key: 'session.backchannel_retry_initial_delay_ms',
    type: 'duration',
    default: 1000,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_INITIAL_DELAY_MS',
    label: 'Backchannel Retry Initial Delay',
    description: 'Initial delay before first retry in milliseconds',
    min: 100,
    max: 10000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.backchannel_retry_max_delay_ms': {
    key: 'session.backchannel_retry_max_delay_ms',
    type: 'duration',
    default: 30000,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_MAX_DELAY_MS',
    label: 'Backchannel Retry Max Delay',
    description: 'Maximum delay between retries in milliseconds',
    min: 1000,
    max: 300000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.backchannel_retry_backoff_multiplier': {
    key: 'session.backchannel_retry_backoff_multiplier',
    type: 'number',
    default: 2,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_BACKOFF_MULTIPLIER',
    label: 'Backchannel Retry Backoff',
    description: 'Backoff multiplier for retry delays',
    min: 1,
    max: 5,
    visibility: 'admin',
  },
  'session.backchannel_on_failure': {
    key: 'session.backchannel_on_failure',
    type: 'enum',
    default: 'log',
    envKey: 'LOGOUT_BACKCHANNEL_ON_FAILURE',
    label: 'Backchannel Failure Behavior',
    description: 'Action when backchannel logout fails after all retries',
    enum: ['ignore', 'log', 'error'],
    visibility: 'admin',
  },
};

/**
 * Session Category Metadata
 */
export const SESSION_CATEGORY_META: CategoryMeta = {
  category: 'session',
  label: 'Session & Logout',
  description: 'Session management and logout configuration',
  settings: SESSION_SETTINGS_META,
};

/**
 * Default Session settings values
 */
export const SESSION_DEFAULTS: SessionSettings = {
  'session.default_ttl': 86400000,
  'session.max_ttl': 604800000,
  'session.min_ttl': 60000,
  'session.ttl.email_code': 86400000,
  'session.ttl.directory_password': 86400000,
  'session.ttl.direct_auth': 86400000,
  'session.ttl.passkey': 604800000,
  'session.ttl.passkey_registration': 2592000000,
  'session.ttl.admin_passkey': 604800000,
  'session.ttl.anonymous': 86400000,
  'session.ttl.did': 86400000,
  'session.refresh_default': true,
  'session.token_ttl': 300,
  'session.tombstone_ttl': 86400000,
  'session.backchannel_logout_token_exp': 120,
  'session.backchannel_request_timeout_ms': 10000,
  'session.backchannel_retry_max_attempts': 3,
  'session.backchannel_retry_initial_delay_ms': 1000,
  'session.backchannel_retry_max_delay_ms': 30000,
  'session.backchannel_retry_backoff_multiplier': 2,
  'session.backchannel_on_failure': 'log',
};
