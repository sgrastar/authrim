/**
 * The device flow settings the runtime reads, for a tenant and, once the client is known, for the
 * client (the `device-flow` category; scopes tenant and client):
 *
 * - code lifetime: `device_flow.expires_in` kept between `device_flow.min_expires_in` and
 *   `device_flow.max_expires_in`.
 * - polling interval: `device_flow.poll_interval` kept between `device_flow.min_interval` and
 *   `device_flow.max_interval`. RFC 8628 gives the client no parameter for the lifetime or the
 *   interval, so these are server-side values; `max_interval` is also what `slow_down` can raise a
 *   code to.
 * - `device_flow.slow_down_increment` (at least 5 seconds, RFC 8628 section 3.5) and
 *   `device_flow.max_poll_count` (a floor: the poll governor raises the cap to what a device that
 *   follows the interval needs). /device_authorization keeps both, and the maximum interval, on
 *   the code, so the polls that follow need no settings read.
 *
 * The user code format (`user_code_charset`, `user_code_length`) is not read here: it is still
 * fixed in code.
 *
 * Environment variables stay the deployment default (the setting's `envKey`), a stored value
 * overrides them (the client's over the tenant's), and the built-in default (today's constants) is
 * last.
 *
 * A value outside what the setting allows is not used: that one value falls back to its default.
 * A pair whose minimum is above its maximum falls back to the defaults of both. The bounds are the
 * tenant's guard-rails: a client's own `expires_in` and `poll_interval` are held between them, and
 * a client that sets bounds of its own can only narrow the tenant's. The limits that protect the
 * endpoint are asserted here whatever is stored. When the settings cannot be read this THROWS, and
 * the caller refuses the request instead of guessing.
 */

import { DEVICE_FLOW_DEFAULTS, DEVICE_FLOW_SETTINGS_META } from '../types/settings/device-flow';
import { isWithinSettingRange } from './setting-range';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

export interface DeviceFlowPolicy {
  /** Lifetime of the device code (seconds); also the `expires_in` of the response. */
  expiresIn: number;
  /** Shortest code lifetime (seconds). */
  minExpiresIn: number;
  /** Longest code lifetime (seconds). */
  maxExpiresIn: number;
  /** Polling interval returned to the device (seconds). */
  pollInterval: number;
  /** Lowest polling interval (seconds). */
  minInterval: number;
  /** Highest polling interval, also the ceiling for slow_down (seconds). */
  maxInterval: number;
  /** Seconds one slow_down adds to the polling interval (at least 5). */
  slowDownIncrement: number;
  /** The configured poll count; a floor, the governor raises the cap for a long lifetime. */
  maxPollCount: number;
}

/** Limits held in code, whatever is stored. */
export const DEVICE_FLOW_HARD_LIMITS = {
  /** No device code lives longer than an hour. */
  maxExpiresIn: 3600,
  maxInterval: 300,
  minInterval: 1,
  /** RFC 8628 section 3.5: the interval is increased by 5 seconds. */
  minSlowDownIncrement: 5,
  maxSlowDownIncrement: 30,
  maxPollCount: 500,
} as const;

type NumericKey =
  | 'device_flow.expires_in'
  | 'device_flow.min_expires_in'
  | 'device_flow.max_expires_in'
  | 'device_flow.poll_interval'
  | 'device_flow.min_interval'
  | 'device_flow.max_interval'
  | 'device_flow.slow_down_increment'
  | 'device_flow.max_poll_count';

function numberOrDefault(values: Record<string, unknown>, key: NumericKey): number {
  const value = values[key];
  return isWithinSettingRange(value, DEVICE_FLOW_SETTINGS_META[key])
    ? value
    : (DEVICE_FLOW_DEFAULTS[key] as number);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface Bounds {
  minExpiresIn: number;
  maxExpiresIn: number;
  minInterval: number;
  maxInterval: number;
}

/** The lifetime and interval bounds a document holds: each pair usable, else both defaults. */
function boundsOf(values: Record<string, unknown>): Bounds {
  let minExpiresIn = numberOrDefault(values, 'device_flow.min_expires_in');
  let maxExpiresIn = Math.min(
    numberOrDefault(values, 'device_flow.max_expires_in'),
    DEVICE_FLOW_HARD_LIMITS.maxExpiresIn
  );
  if (minExpiresIn > maxExpiresIn) {
    minExpiresIn = DEVICE_FLOW_DEFAULTS['device_flow.min_expires_in'];
    maxExpiresIn = DEVICE_FLOW_DEFAULTS['device_flow.max_expires_in'];
  }

  let minInterval = Math.max(
    numberOrDefault(values, 'device_flow.min_interval'),
    DEVICE_FLOW_HARD_LIMITS.minInterval
  );
  let maxInterval = Math.min(
    numberOrDefault(values, 'device_flow.max_interval'),
    DEVICE_FLOW_HARD_LIMITS.maxInterval
  );
  if (minInterval > maxInterval) {
    minInterval = DEVICE_FLOW_DEFAULTS['device_flow.min_interval'];
    maxInterval = DEVICE_FLOW_DEFAULTS['device_flow.max_interval'];
  }
  return { minExpiresIn, maxExpiresIn, minInterval, maxInterval };
}

/** A client's bounds can only narrow the tenant's; a pair that cannot be combined stays the tenant's. */
function narrow(tenant: Bounds, client: Bounds): Bounds {
  const minExpiresIn = Math.max(tenant.minExpiresIn, client.minExpiresIn);
  const maxExpiresIn = Math.min(tenant.maxExpiresIn, client.maxExpiresIn);
  const minInterval = Math.max(tenant.minInterval, client.minInterval);
  const maxInterval = Math.min(tenant.maxInterval, client.maxInterval);
  const lifetime = minExpiresIn <= maxExpiresIn;
  const interval = minInterval <= maxInterval;
  return {
    minExpiresIn: lifetime ? minExpiresIn : tenant.minExpiresIn,
    maxExpiresIn: lifetime ? maxExpiresIn : tenant.maxExpiresIn,
    minInterval: interval ? minInterval : tenant.minInterval,
    maxInterval: interval ? maxInterval : tenant.maxInterval,
  };
}

/**
 * The device flow policy for a tenant, and for one of its clients when `clientId` is given.
 * Throws when the settings cannot be read.
 */
export async function resolveDeviceFlowPolicy(
  env: EffectiveSettingsEnv,
  tenantId: string,
  clientId?: string
): Promise<DeviceFlowPolicy> {
  const tenantValues = await resolveEffectiveSettings(env, 'device-flow', { tenantId });
  let values = tenantValues;
  let bounds = boundsOf(tenantValues);
  if (clientId) {
    // The client's document falls back to the tenant's for every key it does not set
    values = await resolveEffectiveSettings(env, 'device-flow', { tenantId, clientId });
    bounds = narrow(bounds, boundsOf(values));
  }

  return {
    expiresIn: clamp(
      numberOrDefault(values, 'device_flow.expires_in'),
      bounds.minExpiresIn,
      bounds.maxExpiresIn
    ),
    minExpiresIn: bounds.minExpiresIn,
    maxExpiresIn: bounds.maxExpiresIn,
    pollInterval: clamp(
      numberOrDefault(values, 'device_flow.poll_interval'),
      bounds.minInterval,
      bounds.maxInterval
    ),
    minInterval: bounds.minInterval,
    maxInterval: bounds.maxInterval,
    slowDownIncrement: clamp(
      numberOrDefault(values, 'device_flow.slow_down_increment'),
      DEVICE_FLOW_HARD_LIMITS.minSlowDownIncrement,
      DEVICE_FLOW_HARD_LIMITS.maxSlowDownIncrement
    ),
    maxPollCount: Math.min(
      numberOrDefault(values, 'device_flow.max_poll_count'),
      DEVICE_FLOW_HARD_LIMITS.maxPollCount
    ),
  };
}
