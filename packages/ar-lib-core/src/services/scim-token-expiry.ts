/**
 * How long a new SCIM token lasts: the lifetime it gets when the request names none
 * (`federation.scim_token_default_expiry`) and the longest it can be given
 * (`federation.scim_token_max_expiry`), per tenant. The settings are in seconds; the SCIM token
 * API counts days, so the values are given in whole days (rounded down, at least one).
 *
 * A value outside the setting's range is not used: it falls back to a year, which is also the
 * highest a tenant can set. The default is never longer than the maximum. Tokens already issued
 * keep the lifetime they were given.
 *
 * Unlike the sign-in limits, this does not fall back when the settings cannot be read: a maximum
 * that an outage lifted would let a long-lived credential be issued, so the caller refuses.
 */

import { FEDERATION_DEFAULTS, FEDERATION_SETTINGS_META } from '../types/settings/federation';
import { isWithinSettingRange } from './setting-range';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

const SECONDS_PER_DAY = 86400;

export interface ScimTokenExpiryDays {
  /** The lifetime of a new token when the request names none. */
  defaultDays: number;
  /** The longest lifetime a new token can be given. */
  maxDays: number;
}

function toDays(seconds: number): number {
  return Math.max(1, Math.floor(seconds / SECONDS_PER_DAY));
}

/** Throws when the tenant's settings cannot be read. */
export async function resolveScimTokenExpiryDays(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<ScimTokenExpiryDays> {
  const values = await resolveEffectiveSettings(env, 'federation', { tenantId });
  const maxSeconds = values['federation.scim_token_max_expiry'];
  const defaultSeconds = values['federation.scim_token_default_expiry'];
  const maxDays = toDays(
    isWithinSettingRange(maxSeconds, FEDERATION_SETTINGS_META['federation.scim_token_max_expiry'])
      ? maxSeconds
      : FEDERATION_DEFAULTS['federation.scim_token_max_expiry']
  );
  const defaultDays = toDays(
    isWithinSettingRange(
      defaultSeconds,
      FEDERATION_SETTINGS_META['federation.scim_token_default_expiry']
    )
      ? defaultSeconds
      : FEDERATION_DEFAULTS['federation.scim_token_default_expiry']
  );
  return { defaultDays: Math.min(defaultDays, maxDays), maxDays };
}
