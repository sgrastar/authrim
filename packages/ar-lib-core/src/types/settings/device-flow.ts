/**
 * Device Flow Settings Category
 *
 * Settings related to OAuth 2.0 Device Authorization Grant (RFC 8628).
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/device-flow
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Device Flow Settings Interface
 */
export interface DeviceFlowSettings {
  // Expiry Settings
  'device_flow.expires_in': number;
  'device_flow.poll_interval': number;
  'device_flow.max_poll_count': number;
  'device_flow.slow_down_increment': number;

  // Expiry Limits (for client configuration)
  'device_flow.min_expires_in': number;
  'device_flow.max_expires_in': number;
  'device_flow.min_interval': number;
  'device_flow.max_interval': number;

  // User Code Settings
  'device_flow.user_code_charset': 'BASE20' | 'NUMERIC';
  'device_flow.user_code_length': number;
}

/**
 * Device Flow Settings Metadata
 */
export const DEVICE_FLOW_SETTINGS_META: Record<keyof DeviceFlowSettings, SettingMeta> = {
  'device_flow.expires_in': {
    key: 'device_flow.expires_in',
    type: 'duration',
    default: 600,
    envKey: 'DEVICE_FLOW_DEFAULT_EXPIRES_IN',
    label: 'Device Code Expiry',
    description:
      'Lifetime of a device code in seconds (RFC 8628 recommends 5 to 10 minutes). Kept between the minimum and maximum expiry. Applies to codes issued after the change.',
    min: 300,
    max: 1800,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'public',
  },
  'device_flow.poll_interval': {
    key: 'device_flow.poll_interval',
    type: 'duration',
    default: 5,
    envKey: 'DEVICE_FLOW_DEFAULT_INTERVAL',
    label: 'Poll Interval',
    description:
      'Polling interval returned to the device in seconds (RFC 8628 default: 5). Kept between the minimum and maximum poll interval. Applies to codes issued after the change.',
    min: 1,
    max: 60,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'public',
  },
  'device_flow.max_poll_count': {
    key: 'device_flow.max_poll_count',
    type: 'number',
    default: 120,
    envKey: 'DEVICE_FLOW_MAX_POLL_COUNT',
    label: 'Max Poll Count',
    description:
      'Polls a device may make before its code is dropped (expired_token). A floor, not a fixed limit: the count a device needs when it waits the whole polling interval for the whole code lifetime, plus a margin, is allowed if that is higher, so a device that follows the interval is never cut off. Applies to codes issued after the change.',
    min: 10,
    max: 500,
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'device_flow.slow_down_increment': {
    key: 'device_flow.slow_down_increment',
    type: 'duration',
    default: 5,
    envKey: 'DEVICE_FLOW_SLOW_DOWN_INCREMENT',
    label: 'Slow Down Increment',
    description:
      "Seconds added to the polling interval each time a device polls too early (slow_down), up to the maximum poll interval. RFC 8628 section 3.5 requires at least 5 seconds. Applies to codes issued after the change. Standard clients raise their own wait by exactly 5 s after slow_down; a larger value keeps the server's interval ahead of them until they catch up, so they can be told slow_down repeatedly. Keep 5 unless your clients follow the server's interval.",
    min: 5,
    max: 30,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },

  // Expiry Limits (for client configuration)
  'device_flow.min_expires_in': {
    key: 'device_flow.min_expires_in',
    type: 'duration',
    default: 300,
    envKey: 'DEVICE_FLOW_MIN_EXPIRES_IN',
    label: 'Min Expiry',
    description:
      'Shortest device code lifetime, in seconds. The code lifetime is never set below it, which also holds a client-level expiry to it. Must not exceed the maximum expiry.',
    min: 60,
    max: 1800,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'device_flow.max_expires_in': {
    key: 'device_flow.max_expires_in',
    type: 'duration',
    default: 1800,
    envKey: 'DEVICE_FLOW_MAX_EXPIRES_IN',
    label: 'Max Expiry',
    description:
      'Longest device code lifetime, in seconds. The code lifetime is never set above it (and never above one hour, whatever is stored), which also holds a client-level expiry to it. Must not be below the minimum expiry.',
    min: 300,
    max: 3600,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'device_flow.min_interval': {
    key: 'device_flow.min_interval',
    type: 'duration',
    default: 5,
    envKey: 'DEVICE_FLOW_MIN_INTERVAL',
    label: 'Min Poll Interval',
    description:
      'Server-side lower bound for the polling interval, in seconds. The poll interval is never set below it, which also holds a client-level interval to it. Must not exceed the maximum poll interval.',
    min: 1,
    max: 60,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'device_flow.max_interval': {
    key: 'device_flow.max_interval',
    type: 'duration',
    default: 60,
    envKey: 'DEVICE_FLOW_MAX_INTERVAL',
    label: 'Max Poll Interval',
    description:
      'Server-side upper bound for the polling interval, in seconds: the poll interval is never set above it, and slow_down never raises a code past it. Must not be below the minimum poll interval. Applies to codes issued after the change.',
    min: 5,
    max: 300,
    unit: 'seconds',
    integer: true,
    envNumber: 'strict-in-range',
    visibility: 'admin',
  },
  'device_flow.user_code_charset': {
    key: 'device_flow.user_code_charset',
    type: 'enum',
    default: 'BASE20',
    envKey: 'DEVICE_FLOW_USER_CODE_CHARSET',
    label: 'User Code Charset',
    description: 'Character set for user codes (BASE20: BCDFGHJKLMNPQRSTVWXZ, NUMERIC: 0-9)',
    enum: ['BASE20', 'NUMERIC'],
    visibility: 'public',
    status: 'in_development',
  },
  'device_flow.user_code_length': {
    key: 'device_flow.user_code_length',
    type: 'number',
    default: 8,
    envKey: 'DEVICE_FLOW_USER_CODE_LENGTH',
    label: 'User Code Length',
    description: 'Number of characters in user code',
    min: 4,
    max: 16,
    visibility: 'public',
    status: 'in_development',
  },
};

/**
 * Device Flow Category Metadata
 */
export const DEVICE_FLOW_CATEGORY_META: CategoryMeta = {
  category: 'device-flow',
  label: 'Device Flow',
  description: 'OAuth 2.0 Device Authorization Grant settings',
  settings: DEVICE_FLOW_SETTINGS_META,
};

/**
 * Default Device Flow settings values
 */
export const DEVICE_FLOW_DEFAULTS: DeviceFlowSettings = {
  'device_flow.expires_in': 600,
  'device_flow.poll_interval': 5,
  'device_flow.max_poll_count': 120,
  'device_flow.slow_down_increment': 5,
  'device_flow.min_expires_in': 300,
  'device_flow.max_expires_in': 1800,
  'device_flow.min_interval': 5,
  'device_flow.max_interval': 60,
  'device_flow.user_code_charset': 'BASE20',
  'device_flow.user_code_length': 8,
};
