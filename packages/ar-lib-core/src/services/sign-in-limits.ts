/**
 * Sign-in limits a tenant can set: how many failed password attempts lock an account for a while
 * (`rate_limit.auth_max_failed_attempts`, platform or tenant), how long an emailed sign-in code
 * lasts (`credentials.email_code_ttl`, tenant) and how often one address (or user) can be sent
 * an emailed code (`rate_limit.email_max_requests` per `rate_limit.email_window`).
 *
 * A value outside the setting's range is not used. When the settings cannot be read, the limits
 * keep their defaults, which are the values these paths always used, so an outage of the settings
 * store neither loosens a limit nor locks people out sooner.
 */

import { CREDENTIALS_DEFAULTS, CREDENTIALS_SETTINGS_META } from '../types/settings/credentials';
import { RATE_LIMIT_DEFAULTS, RATE_LIMIT_SETTINGS_META } from '../types/settings/rate-limit';
import { isWithinSettingRange as withinRange } from './setting-range';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

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

/** How many emailed codes one address (or user) can be sent, and in how long a window. */
export interface EmailSendLimit {
  maxRequests: number;
  windowSeconds: number;
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
  const fallback: EmailSendLimit = {
    maxRequests: RATE_LIMIT_DEFAULTS['rate_limit.email_max_requests'],
    windowSeconds: RATE_LIMIT_DEFAULTS['rate_limit.email_window'],
  };
  try {
    const values = await resolveEffectiveSettings(env, 'rate-limit', { tenantId });
    const maxRequests = values['rate_limit.email_max_requests'];
    const windowSeconds = values['rate_limit.email_window'];
    return {
      maxRequests: withinRange(
        maxRequests,
        RATE_LIMIT_SETTINGS_META['rate_limit.email_max_requests']
      )
        ? maxRequests
        : fallback.maxRequests,
      windowSeconds: withinRange(windowSeconds, RATE_LIMIT_SETTINGS_META['rate_limit.email_window'])
        ? windowSeconds
        : fallback.windowSeconds,
    };
  } catch {
    return fallback;
  }
}
