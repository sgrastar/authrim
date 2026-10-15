/**
 * The CIBA settings the runtime reads, per tenant (the `ciba` category):
 *
 * - request lifetime: `ciba.expires_in` (when the client sends no `requested_expiry`) kept between
 *   `ciba.min_expires_in` and `ciba.max_expires_in`, which also bound a `requested_expiry`.
 * - polling interval: `ciba.poll_interval` kept between `ciba.min_interval` and
 *   `ciba.max_interval`. CIBA has no client parameter for the interval, so these are server-side
 *   bounds; `max_interval` is also what `slow_down` can raise a request to.
 * - `ciba.max_binding_message_length` and `ciba.binding_message_required`.
 *
 * Environment variables stay the deployment default (the setting's `envKey`), the tenant's stored
 * value overrides them, and the built-in default (today's constants) is last.
 *
 * A value outside what the setting allows is not used: that one value falls back to its default.
 * A pair whose minimum is above its maximum falls back to the defaults of both. The limits that
 * protect the endpoint are asserted here whatever is stored. When the settings cannot be read this
 * THROWS: `binding_message_required` is a restriction, and a silent fallback to the defaults would
 * loosen it, so the caller refuses the request instead.
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
}

/** Limits held in code, whatever is stored. */
export const CIBA_HARD_LIMITS = {
  maxExpiresIn: 3600,
  maxInterval: 300,
  /** Every poll costs a Durable Object write, so the interval never goes below this. */
  minInterval: 2,
  maxBindingMessageLength: 500,
} as const;

type NumericKey =
  | 'ciba.expires_in'
  | 'ciba.min_expires_in'
  | 'ciba.max_expires_in'
  | 'ciba.poll_interval'
  | 'ciba.min_interval'
  | 'ciba.max_interval'
  | 'ciba.max_binding_message_length';

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
  };
}
