/**
 * Sign-in limits a tenant can set: how many failed password attempts lock an account for a while
 * (`rate_limit.auth_max_failed_attempts`, platform or tenant) and how long an emailed sign-in code
 * lasts (`credentials.email_code_ttl`, tenant).
 *
 * A value outside the setting's range is not used. When the settings cannot be read, the limits
 * keep their defaults, which are the values these paths always used, so an outage of the settings
 * store neither loosens a limit nor locks people out sooner.
 */

import { CREDENTIALS_DEFAULTS, CREDENTIALS_SETTINGS_META } from '../types/settings/credentials';
import { RATE_LIMIT_DEFAULTS, RATE_LIMIT_SETTINGS_META } from '../types/settings/rate-limit';
import type { SettingMeta } from '../types/settings/common';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

function withinRange(value: unknown, meta: SettingMeta): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= (meta.min ?? 0) &&
    value <= (meta.max ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Failed password attempts (in the lockout window) after which an account is locked for a while. */
export async function resolveAuthMaxFailedAttempts(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<number> {
  const fallback = RATE_LIMIT_DEFAULTS['rate_limit.auth_max_failed_attempts'];
  try {
    const values = await resolveEffectiveSettings(env, 'rate-limit', { tenantId });
    const value = values['rate_limit.auth_max_failed_attempts'];
    return withinRange(value, RATE_LIMIT_SETTINGS_META['rate_limit.auth_max_failed_attempts'])
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}

/** How long an emailed sign-in, sign-up or re-authentication code lasts, in seconds. */
export async function resolveEmailCodeTtlSeconds(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<number> {
  const fallback = CREDENTIALS_DEFAULTS['credentials.email_code_ttl'];
  try {
    const values = await resolveEffectiveSettings(env, 'credentials', { tenantId });
    const value = values['credentials.email_code_ttl'];
    return withinRange(value, CREDENTIALS_SETTINGS_META['credentials.email_code_ttl'])
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}
