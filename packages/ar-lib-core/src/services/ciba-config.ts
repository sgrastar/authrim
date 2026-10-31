/**
 * The CIBA settings the runtime reads, per tenant (the `ciba` category):
 *
 * - request lifetime: `ciba.expires_in` (when the client sends no `requested_expiry`) kept between
 *   `ciba.min_expires_in` and `ciba.max_expires_in`, which also bound a `requested_expiry`.
 * - polling interval: `ciba.poll_interval` kept between `ciba.min_interval` and
 *   `ciba.max_interval`. CIBA has no client parameter for the interval, so these are server-side
 *   bounds; `max_interval` is also what `slow_down` can raise a request to.
 * - `ciba.slow_down_increment` (at least 5 seconds, CIBA Core section 11) and `ciba.max_poll_count`
 *   (a floor: the poll governor raises the cap to what a client that follows the interval needs).
 *   /bc-authorize keeps both on the request, so the polls that follow need no settings read.
 * - `ciba.max_binding_message_length` and `ciba.binding_message_required`.
 * - `ciba.user_code_enabled`: whether a request may carry a `user_code`, and what discovery
 *   advertises. Authrim does not verify user codes; see the comment on the field.
 * - `ciba.ping_notification_timeout_ms`: how long the ping notification waits for the client.
 *
 * Environment variables stay the deployment default (the setting's `envKey`), the tenant's stored
 * value overrides them, and the built-in default (today's constants) is last.
 *
 * A value outside what the setting allows is not used: that one value falls back to its default.
 * A pair whose minimum is above its maximum falls back to the defaults of both. The limits that
 * protect the endpoint are asserted here whatever is stored. When the settings cannot be read this
 * THROWS: `binding_message_required` and `user_code_enabled` are restrictions, and a silent
 * fallback to the defaults would loosen the first, so the caller refuses the request instead. (A
 * caller that only needs a timeout, which restricts nothing, may use the default instead.)
 */

import { CIBA_DEFAULTS, CIBA_SETTINGS_META } from '../types/settings/ciba';
import { isWithinSettingRange } from './setting-range';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

export interface CibaConfig {
  /** Request lifetime when the client sends no requested_expiry (seconds). */
  expiresIn: number;
  /** Shortest request lifetime (seconds). */
  minExpiresIn: number;
  /** Longest request lifetime (seconds). */
  maxExpiresIn: number;
  /** Polling interval returned to poll-mode clients (seconds). */
  pollInterval: number;
  /** Lowest polling interval (seconds). */
  minInterval: number;
  /** Highest polling interval, also the ceiling for slow_down (seconds). */
  maxInterval: number;
  /** Longest binding_message, in UTF-16 code units. */
  maxBindingMessageLength: number;
  /** A request without a binding_message is refused. */
  bindingMessageRequired: boolean;
  /** Seconds one slow_down adds to the polling interval (at least 5). */
  slowDownIncrement: number;
  /** The configured poll count; a floor, the governor raises the cap for a long lifetime. */
  maxPollCount: number;
  /**
   * A backchannel authentication request may carry a `user_code`, and discovery advertises
   * `backchannel_user_code_parameter_supported`. This is only the acceptance switch: the OP does
   * not verify a user code (no `invalid_user_code` / `missing_user_code`), it stores it and shows it
   * to the person approving the request. Real verification needs a secret the user holds.
   */
  userCodeEnabled: boolean;
  /** How long the ping notification waits for the client's endpoint (milliseconds). */
  pingNotificationTimeoutMs: number;
}

/** Limits held in code, whatever is stored. */
export const CIBA_HARD_LIMITS = {
  maxExpiresIn: 3600,
  maxInterval: 300,
  /** Every poll costs a Durable Object write, so the interval never goes below this. */
  minInterval: 2,
  maxBindingMessageLength: 500,
  /** CIBA Core section 11: the interval is increased by at least 5 seconds. */
  minSlowDownIncrement: 5,
  maxSlowDownIncrement: 30,
  maxPollCount: 500,
  maxPingNotificationTimeoutMs: 30000,
} as const;

type NumericKey =
  | 'ciba.expires_in'
  | 'ciba.min_expires_in'
  | 'ciba.max_expires_in'
  | 'ciba.poll_interval'
  | 'ciba.min_interval'
  | 'ciba.max_interval'
  | 'ciba.max_binding_message_length'
  | 'ciba.slow_down_increment'
  | 'ciba.max_poll_count'
  | 'ciba.ping_notification_timeout_ms';

function numberOrDefault(values: Record<string, unknown>, key: NumericKey): number {
  const value = values[key];
  return isWithinSettingRange(value, CIBA_SETTINGS_META[key]) ? value : CIBA_DEFAULTS[key];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The CIBA settings of a tenant. Throws when they cannot be read. */
export async function resolveCibaConfig(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<CibaConfig> {
  const values = await resolveEffectiveSettings(env, 'ciba', { tenantId });

  let minExpiresIn = numberOrDefault(values, 'ciba.min_expires_in');
  let maxExpiresIn = Math.min(
    numberOrDefault(values, 'ciba.max_expires_in'),
    CIBA_HARD_LIMITS.maxExpiresIn
  );
  if (minExpiresIn > maxExpiresIn) {
    minExpiresIn = CIBA_DEFAULTS['ciba.min_expires_in'];
    maxExpiresIn = CIBA_DEFAULTS['ciba.max_expires_in'];
  }

  let minInterval = Math.max(
    numberOrDefault(values, 'ciba.min_interval'),
    CIBA_HARD_LIMITS.minInterval
  );
  let maxInterval = Math.min(
    numberOrDefault(values, 'ciba.max_interval'),
    CIBA_HARD_LIMITS.maxInterval
  );
  if (minInterval > maxInterval) {
    minInterval = CIBA_DEFAULTS['ciba.min_interval'];
    maxInterval = CIBA_DEFAULTS['ciba.max_interval'];
  }

  const bindingMessageRequired = values['ciba.binding_message_required'];
  const userCodeEnabled = values['ciba.user_code_enabled'];

  return {
    expiresIn: clamp(numberOrDefault(values, 'ciba.expires_in'), minExpiresIn, maxExpiresIn),
    minExpiresIn,
    maxExpiresIn,
    pollInterval: clamp(numberOrDefault(values, 'ciba.poll_interval'), minInterval, maxInterval),
    minInterval,
    maxInterval,
    maxBindingMessageLength: Math.min(
      numberOrDefault(values, 'ciba.max_binding_message_length'),
      CIBA_HARD_LIMITS.maxBindingMessageLength
    ),
    bindingMessageRequired:
      typeof bindingMessageRequired === 'boolean'
        ? bindingMessageRequired
        : CIBA_DEFAULTS['ciba.binding_message_required'],
    slowDownIncrement: clamp(
      numberOrDefault(values, 'ciba.slow_down_increment'),
      CIBA_HARD_LIMITS.minSlowDownIncrement,
      CIBA_HARD_LIMITS.maxSlowDownIncrement
    ),
    maxPollCount: Math.min(
      numberOrDefault(values, 'ciba.max_poll_count'),
      CIBA_HARD_LIMITS.maxPollCount
    ),
    userCodeEnabled:
      typeof userCodeEnabled === 'boolean'
        ? userCodeEnabled
        : CIBA_DEFAULTS['ciba.user_code_enabled'],
    pingNotificationTimeoutMs: Math.min(
      numberOrDefault(values, 'ciba.ping_notification_timeout_ms'),
      CIBA_HARD_LIMITS.maxPingNotificationTimeoutMs
    ),
  };
}
