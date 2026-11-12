/**
 * Sign-in limits a tenant can set: how many failed password attempts lock an account for a while
 * (`rate_limit.auth_max_failed_attempts`, platform or tenant), how long an emailed sign-in code
 * lasts (`credentials.email_code_ttl`, tenant) and how often one address (or user) can be sent
 * an emailed code (`rate_limit.email_max_requests` per `rate_limit.email_window`), and how many
 * authenticator-app sign-in starts and sign-up code checks are allowed
 * (`rate_limit.totp_max_requests` per `rate_limit.totp_window`).
 *
 * A value outside the setting's range is not used. When the settings cannot be read, the limits
 * keep their defaults, which are the values these paths always used, so an outage of the settings
 * store neither loosens a limit nor locks people out sooner. A key the platform has locked keeps
 * the platform's value when the tenant's layer cannot be read (a lock must not be loosened).
 */

import { CREDENTIALS_DEFAULTS, CREDENTIALS_SETTINGS_META } from '../types/settings/credentials';
import { RATE_LIMIT_DEFAULTS, RATE_LIMIT_SETTINGS_META } from '../types/settings/rate-limit';
import { isWithinSettingRange as withinRange } from './setting-range';
import {
  resolveEffectiveSettings,
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';

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

/** How many requests a limit allows, and in how long a window. */
export interface RequestLimit {
  maxRequests: number;
  windowSeconds: number;
}

/** How many emailed codes one address (or user) can be sent, and in how long a window. */
export type EmailSendLimit = RequestLimit;

/**
 * A limit stored as a pair of rate-limit settings. Each value that is out of range, or unreadable,
 * keeps its default.
 */
async function resolveRequestLimit(
  env: EffectiveSettingsEnv,
  tenantId: string,
  maxRequestsKey: keyof typeof RATE_LIMIT_DEFAULTS,
  windowKey: keyof typeof RATE_LIMIT_DEFAULTS
): Promise<RequestLimit> {
  const fallback: RequestLimit = {
    maxRequests: RATE_LIMIT_DEFAULTS[maxRequestsKey],
    windowSeconds: RATE_LIMIT_DEFAULTS[windowKey],
  };
  const limitFrom = (values: Record<string, unknown>, only?: ReadonlySet<string>): RequestLimit => {
    const maxRequests = values[maxRequestsKey];
    const windowSeconds = values[windowKey];
    return {
      maxRequests:
        (!only || only.has(maxRequestsKey)) &&
        withinRange(maxRequests, RATE_LIMIT_SETTINGS_META[maxRequestsKey])
          ? maxRequests
          : fallback.maxRequests,
      windowSeconds:
        (!only || only.has(windowKey)) &&
        withinRange(windowSeconds, RATE_LIMIT_SETTINGS_META[windowKey])
          ? windowSeconds
          : fallback.windowSeconds,
    };
  };
  try {
    return limitFrom(await resolveEffectiveSettings(env, 'rate-limit', { tenantId }));
  } catch {
    // The tenant's layer could not be read. A setting the platform has locked still holds (its
    // value does not come from the tenant); everything else keeps its default, as before. Each
    // key is decided on its own (one locked and one not gives a mixed pair): taking the platform
    // pair only when both are locked would loosen a locked count back to the default.
    try {
      const platform = await resolvePlatformSettingsWithSources(env, 'rate-limit');
      return limitFrom(platform.values, new Set(platform.locked));
    } catch {
      return fallback;
    }
  }
}

/**
 * The email send limit of emailed sign-in, sign-up, re-authentication and directory migration
 * codes (`rate_limit.email_max_requests` per `rate_limit.email_window`). Each value that is out
 * of range, or unreadable, keeps its default (3 sends per 15 minutes). The limit on codes for
 * account discovery is separate.
 */
export async function resolveEmailSendLimit(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<EmailSendLimit> {
  return resolveRequestLimit(
    env,
    tenantId,
    'rate_limit.email_max_requests',
    'rate_limit.email_window'
  );
}

/**
 * The authenticator-app (TOTP) attempt limit (`rate_limit.totp_max_requests` per
 * `rate_limit.totp_window`): sign-in and re-authentication starts per identifier and IP address,
 * and sign-up code checks per sign-up and IP address. Each value that is out of range, or
 * unreadable, keeps its default (10 per 15 minutes).
 */
export async function resolveTotpAttemptLimit(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<RequestLimit> {
  return resolveRequestLimit(
    env,
    tenantId,
    'rate_limit.totp_max_requests',
    'rate_limit.totp_window'
  );
}
