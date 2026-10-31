/**
 * CIBA Settings Category
 *
 * Settings related to Client Initiated Backchannel Authentication.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/ciba
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * CIBA Settings Interface
 */
export interface CIBASettings {
  // Expiry Settings
  'ciba.expires_in': number;
  'ciba.poll_interval': number;
  'ciba.max_poll_count': number;
  'ciba.slow_down_increment': number;

  // Expiry Limits (for client configuration)
  'ciba.min_expires_in': number;
  'ciba.max_expires_in': number;
  'ciba.min_interval': number;
  'ciba.max_interval': number;

  // Message Settings
  'ciba.max_binding_message_length': number;
  'ciba.binding_message_required': boolean;

  // Feature Settings
  'ciba.user_code_enabled': boolean;

  // Notification Timeout Settings
  'ciba.ping_notification_timeout_ms': number;
  'ciba.push_notification_timeout_ms': number;
}

/**
 * CIBA Settings Metadata
 */
export const CIBA_SETTINGS_META: Record<keyof CIBASettings, SettingMeta> = {
  'ciba.expires_in': {
    key: 'ciba.expires_in',
    type: 'duration',
    default: 300,
    envKey: 'CIBA_DEFAULT_EXPIRES_IN',
    label: 'Request Expiry',
    description:
      'Lifetime of a backchannel authentication request when the client does not ask for one (requested_expiry), in seconds. Kept between the minimum and maximum expiry. Applies to requests made after the change.',
    min: 60,
    max: 600,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'public',
  },
  'ciba.poll_interval': {
    key: 'ciba.poll_interval',
    type: 'duration',
    default: 5,
    envKey: 'CIBA_DEFAULT_INTERVAL',
    label: 'Poll Interval',
    description:
      'Polling interval returned to poll-mode clients, in seconds. Kept between the minimum and maximum poll interval. Applies to requests made after the change.',
    min: 2,
    max: 60,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'public',
  },
  'ciba.max_poll_count': {
    key: 'ciba.max_poll_count',
    type: 'number',
    default: 120,
    envKey: 'CIBA_MAX_POLL_COUNT',
    label: 'Max Poll Count',
    description:
      'Polls a poll-mode client may make before its request is dropped (expired_token). A floor, not a fixed limit: the count a client needs when it waits the whole polling interval for the whole request lifetime, plus a margin, is allowed if that is higher, so a client that follows the interval is never cut off. Applies to requests made after the change.',
    min: 10,
    max: 500,
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.slow_down_increment': {
    key: 'ciba.slow_down_increment',
    type: 'duration',
    default: 5,
    envKey: 'CIBA_SLOW_DOWN_INCREMENT',
    label: 'Slow Down Increment',
    description:
      "Seconds added to the polling interval each time a client polls too early (slow_down), up to the maximum poll interval. CIBA Core requires at least 5 seconds. Applies to requests made after the change. Standard clients raise their own wait by exactly 5 s after slow_down; a larger value keeps the server's interval ahead of them until they catch up, so they can be told slow_down repeatedly. Keep 5 unless your clients follow the server's interval.",
    min: 5,
    max: 30,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },

  // Expiry Limits
  'ciba.min_expires_in': {
    key: 'ciba.min_expires_in',
    type: 'duration',
    default: 60,
    envKey: 'CIBA_MIN_EXPIRES_IN',
    label: 'Min Expiry',
    description:
      'Shortest request lifetime, in seconds: a shorter requested_expiry is raised to it. Must not exceed the maximum expiry.',
    min: 30,
    max: 600,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.max_expires_in': {
    key: 'ciba.max_expires_in',
    type: 'duration',
    default: 600,
    envKey: 'CIBA_MAX_EXPIRES_IN',
    label: 'Max Expiry',
    description:
      'Longest request lifetime, in seconds: a longer requested_expiry is lowered to it. Must not be below the minimum expiry.',
    min: 60,
    max: 3600,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.min_interval': {
    key: 'ciba.min_interval',
    type: 'duration',
    default: 2,
    envKey: 'CIBA_MIN_INTERVAL',
    label: 'Min Poll Interval',
    description:
      'Server-side lower bound for the polling interval, in seconds. The poll interval is never set below it. Must not exceed the maximum poll interval.',
    min: 1,
    max: 60,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.max_interval': {
    key: 'ciba.max_interval',
    type: 'duration',
    default: 60,
    envKey: 'CIBA_MAX_INTERVAL',
    label: 'Max Poll Interval',
    description:
      'Server-side upper bound for the polling interval, in seconds: the poll interval is never set above it, and slow_down never raises a request past it. Must not be below the minimum poll interval. Applies to requests made after the change.',
    min: 5,
    max: 300,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.max_binding_message_length': {
    key: 'ciba.max_binding_message_length',
    type: 'number',
    default: 140,
    envKey: 'CIBA_MAX_BINDING_MESSAGE_LENGTH',
    label: 'Max Binding Message Length',
    description:
      'Longest binding_message accepted, counted in UTF-16 code units (an emoji counts as two).',
    min: 50,
    max: 500,
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.binding_message_required': {
    key: 'ciba.binding_message_required',
    type: 'boolean',
    default: false,
    envKey: 'CIBA_BINDING_MESSAGE_REQUIRED',
    label: 'Binding Message Required',
    description:
      'Refuse a backchannel authentication request that has no binding_message, or only blank text (invalid_binding_message). Off by default: CIBA Core makes the parameter optional.',
    visibility: 'public',
  },
  'ciba.user_code_enabled': {
    key: 'ciba.user_code_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CIBA_USER_CODE',
    label: 'User Code Support',
    description:
      'Accept the user_code parameter on backchannel authentication requests and advertise backchannel_user_code_parameter_supported. Off by default: a request with a user_code is then refused (invalid_request). The code is shown to the person approving the request; Authrim does not verify it.',
    visibility: 'public',
  },

  // Notification Timeout Settings
  'ciba.ping_notification_timeout_ms': {
    key: 'ciba.ping_notification_timeout_ms',
    type: 'duration',
    default: 5000,
    envKey: 'PING_NOTIFICATION_TIMEOUT_MS',
    label: 'Ping Notification Timeout',
    description:
      'How long to wait for a ping-mode client to answer the notification that its request was decided, in milliseconds. The notification is sent while the approving person waits for their approval to complete, so a long timeout holds that request open. A notification that fails is not retried: the client can still poll.',
    min: 1000,
    max: 30000,
    unit: 'ms',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'ciba.push_notification_timeout_ms': {
    key: 'ciba.push_notification_timeout_ms',
    type: 'duration',
    default: 5000,
    envKey: 'PUSH_NOTIFICATION_TIMEOUT_MS',
    label: 'Push Notification Timeout',
    description: 'Timeout for CIBA push mode notifications in milliseconds',
    min: 1000,
    max: 30000,
    unit: 'ms',
    visibility: 'admin',
    status: 'in_development',
  },
};

/**
 * CIBA Category Metadata
 */
export const CIBA_CATEGORY_META: CategoryMeta = {
  category: 'ciba',
  label: 'CIBA',
  description: 'Client Initiated Backchannel Authentication settings',
  settings: CIBA_SETTINGS_META,
};

/**
 * Default CIBA settings values
 */
export const CIBA_DEFAULTS: CIBASettings = {
  'ciba.expires_in': 300,
  'ciba.poll_interval': 5,
  'ciba.max_poll_count': 120,
  'ciba.slow_down_increment': 5,
  // Expiry Limits
  'ciba.min_expires_in': 60,
  'ciba.max_expires_in': 600,
  'ciba.min_interval': 2,
  'ciba.max_interval': 60,
  // Message Settings
  'ciba.max_binding_message_length': 140,
  'ciba.binding_message_required': false,
  'ciba.user_code_enabled': false,
  // Notification Timeouts
  'ciba.ping_notification_timeout_ms': 5000,
  'ciba.push_notification_timeout_ms': 5000,
};
