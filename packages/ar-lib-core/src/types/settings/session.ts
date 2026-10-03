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
  'session.ttl.email_code': number;
  'session.ttl.directory_password': number;
  'session.ttl.direct_auth': number;
  'session.ttl.passkey': number;
  'session.ttl.passkey_registration': number;
  'session.ttl.admin_passkey': number;
  'session.ttl.guest': number;
  'session.ttl.did': number;
  'session.refresh_default': boolean;

  // Logout Configuration
  'session.backchannel_logout_token_exp': number;
  'session.backchannel_request_timeout_ms': number;
  'session.backchannel_retry_max_attempts': number;
  'session.backchannel_retry_initial_delay_ms': number;
  'session.backchannel_retry_max_delay_ms': number;
  'session.backchannel_retry_backoff_multiplier': number;
  'session.backchannel_on_failure': 'ignore' | 'log' | 'error';
  'session.backchannel_enabled': boolean;
  'session.backchannel_include_sub': boolean;
  'session.backchannel_include_sid': boolean;
  'session.frontchannel_enabled': boolean;
  'session.session_management_enabled': boolean;
  'session.check_session_iframe_enabled': boolean;
  'session.logout_webhook_enabled': boolean;
  'session.logout_webhook_include_sub': boolean;
  'session.logout_webhook_include_sid': boolean;
}

/**
 * Session Settings Metadata
 */
export const SESSION_SETTINGS_META: Record<keyof SessionSettings, SettingMeta> = {
  // Session TTL
  'session.default_ttl': {
    key: 'session.default_ttl',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
  'session.ttl.email_code': {
    key: 'session.ttl.email_code',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
  'session.ttl.guest': {
    key: 'session.ttl.guest',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'duration',
    default: 86400000,
    envKey: 'SESSION_TTL_ANONYMOUS_MS',
    label: 'Anonymous Session TTL',
    description: 'Session lifetime after browser guest authentication in milliseconds',
    min: 60000,
    max: 2592000000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.ttl.did': {
    key: 'session.ttl.did',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'boolean',
    default: true,
    envKey: 'SESSION_REFRESH_DEFAULT',
    label: 'Refresh Session by Default',
    description: 'Extend session on activity by default',
    visibility: 'public',
  },

  // Logout Configuration
  'session.backchannel_logout_token_exp': {
    key: 'session.backchannel_logout_token_exp',
    type: 'duration',
    integer: true,
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
    integer: true,
    default: 5000,
    envKey: 'LOGOUT_BACKCHANNEL_REQUEST_TIMEOUT_MS',
    label: 'Backchannel Request Timeout',
    description: 'Timeout for backchannel logout requests in milliseconds',
    min: 1000,
    max: 30000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.backchannel_retry_max_attempts': {
    key: 'session.backchannel_retry_max_attempts',
    type: 'number',
    integer: true,
    default: 3,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_MAX_ATTEMPTS',
    label: 'Backchannel Retry Attempts',
    description:
      'Retries after a logout notification fails with a network error, a timeout or an error response other than 400 (a rejected token), with backoff (0: no retry). Retries end about 25 seconds after the logout, for all its clients together.',
    min: 0,
    max: 10,
    visibility: 'admin',
  },
  'session.backchannel_retry_initial_delay_ms': {
    key: 'session.backchannel_retry_initial_delay_ms',
    type: 'duration',
    integer: true,
    default: 1000,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_INITIAL_DELAY_MS',
    label: 'Backchannel Retry Initial Delay',
    description: 'Delay before the first retry, in milliseconds',
    min: 100,
    max: 60000,
    unit: 'ms',
    visibility: 'admin',
  },
  'session.backchannel_retry_max_delay_ms': {
    key: 'session.backchannel_retry_max_delay_ms',
    type: 'duration',
    integer: true,
    default: 30000,
    envKey: 'LOGOUT_BACKCHANNEL_RETRY_MAX_DELAY_MS',
    label: 'Backchannel Retry Max Delay',
    description: 'Longest delay between two retries, in milliseconds',
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
    description: 'Each retry waits this many times longer than the one before',
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
    description:
      "What happens when a client's logout notification still fails after its retries: 'log' and 'ignore' record the failure; 'error' also writes a warning audit log entry (backchannel_logout.failed).",
    enum: ['ignore', 'log', 'error'],
    visibility: 'admin',
  },
  'session.backchannel_enabled': {
    key: 'session.backchannel_enabled',
    type: 'boolean',
    label: 'Back-Channel Logout',
    description:
      'Send back-channel logout notifications (OIDC Back-Channel Logout) to the apps of a session that ends',
    visibility: 'admin',
    default: true,
  },
  'session.backchannel_include_sub': {
    key: 'session.backchannel_include_sub',
    type: 'boolean',
    label: 'Back-Channel Logout: sub',
    description: 'Put the user (sub) in back-channel logout tokens',
    visibility: 'admin',
    default: true,
  },
  'session.backchannel_include_sid': {
    key: 'session.backchannel_include_sid',
    type: 'boolean',
    label: 'Back-Channel Logout: sid',
    description:
      'Put the session (sid) in back-channel logout tokens (always for apps that require it)',
    visibility: 'admin',
    default: true,
  },
  'session.frontchannel_enabled': {
    key: 'session.frontchannel_enabled',
    type: 'boolean',
    label: 'Front-Channel Logout',
    description:
      'Load the front-channel logout pages of the apps of a session that ends (OIDC Front-Channel Logout)',
    visibility: 'admin',
    default: true,
  },
  'session.session_management_enabled': {
    key: 'session.session_management_enabled',
    type: 'boolean',
    label: 'Session Management',
    description:
      'OIDC Session Management: with Check Session Iframe, advertise the check_session_iframe in discovery',
    visibility: 'admin',
    default: true,
  },
  'session.check_session_iframe_enabled': {
    key: 'session.check_session_iframe_enabled',
    type: 'boolean',
    label: 'Check Session Iframe',
    description:
      'Advertise the check_session_iframe in discovery (with Session Management; the endpoint itself is always served)',
    visibility: 'admin',
    default: true,
  },
  'session.logout_webhook_enabled': {
    key: 'session.logout_webhook_enabled',
    type: 'boolean',
    label: 'Logout Webhook',
    description: 'Send a simple logout webhook to apps with a logout webhook URI',
    visibility: 'admin',
    default: false,
  },
  'session.logout_webhook_include_sub': {
    key: 'session.logout_webhook_include_sub',
    type: 'boolean',
    label: 'Logout Webhook: sub',
    description: 'Put the user (sub) in logout webhook payloads',
    visibility: 'admin',
    default: true,
  },
  'session.logout_webhook_include_sid': {
    key: 'session.logout_webhook_include_sid',
    type: 'boolean',
    label: 'Logout Webhook: sid',
    description: 'Put the session (sid) in logout webhook payloads',
    visibility: 'admin',
    default: true,
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
  'session.ttl.email_code': 86400000,
  'session.ttl.directory_password': 86400000,
  'session.ttl.direct_auth': 86400000,
  'session.ttl.passkey': 604800000,
  'session.ttl.passkey_registration': 2592000000,
  'session.ttl.admin_passkey': 604800000,
  'session.ttl.guest': 86400000,
  'session.ttl.did': 86400000,
  'session.refresh_default': true,
  'session.backchannel_logout_token_exp': 120,
  'session.backchannel_request_timeout_ms': 5000,
  'session.backchannel_retry_max_attempts': 3,
  'session.backchannel_retry_initial_delay_ms': 1000,
  'session.backchannel_retry_max_delay_ms': 30000,
  'session.backchannel_retry_backoff_multiplier': 2,
  'session.backchannel_on_failure': 'log',
  'session.backchannel_enabled': true,
  'session.backchannel_include_sub': true,
  'session.backchannel_include_sid': true,
  'session.frontchannel_enabled': true,
  'session.session_management_enabled': true,
  'session.check_session_iframe_enabled': true,
  'session.logout_webhook_enabled': false,
  'session.logout_webhook_include_sub': true,
  'session.logout_webhook_include_sid': true,
};
