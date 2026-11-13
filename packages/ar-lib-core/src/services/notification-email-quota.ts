/**
 * Hourly e-mail volume cap, per tenant and per deployment.
 *
 * Tenant administrators can cause e-mails to arbitrary recipients as side effects (security
 * notices, invitations, replacement notices), so every e-mail goes through `consumeEmailQuota`
 * before an intent is written. The counters are the atomic `RateLimiterCounter` Durable Object;
 * the limits are `rate_limit.email_tenant_hourly_max` and `rate_limit.email_deployment_hourly_max`
 * (platform-only settings; 0 turns a limit off).
 */

import type { Env } from '../types/env';
import { RATE_LIMIT_DEFAULTS, RATE_LIMIT_SETTINGS_META } from '../types/settings/rate-limit';
import { createLogger } from '../utils/logger';
import { buildDOKey } from '../utils/tenant-context';
import {
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';
import { isWithinSettingRange } from './setting-range';

const log = createLogger().module('EMAIL-QUOTA');

/** The quota window: fixed at one hour. */
export const EMAIL_QUOTA_WINDOW_SECONDS = 3600;

export type EmailQuotaScope = 'tenant' | 'deployment';

/** An e-mail was refused because an hourly volume cap is used up. */
export class NotificationQuotaExceededError extends Error {
  readonly code = 'notification_quota_exceeded';

  constructor(
    readonly scope: EmailQuotaScope,
    /** Seconds until the counter resets, when the limiter reported it. */
    readonly retryAfterSeconds?: number
  ) {
    super('notification_quota_exceeded');
    this.name = 'NotificationQuotaExceededError';
  }
}

export type EmailQuotaEnv = EffectiveSettingsEnv & { RATE_LIMITER?: Env['RATE_LIMITER'] };

export interface EmailQuotaLimits {
  tenantHourlyMax: number;
  deploymentHourlyMax: number;
}

const TENANT_KEY = 'rate_limit.email_tenant_hourly_max' as const;
const DEPLOYMENT_KEY = 'rate_limit.email_deployment_hourly_max' as const;

/**
 * The limits: KV, else the environment variable, else the code default (the settings reader
 * caches the documents per isolate for a short time, so this is not a KV read per e-mail). A
 * value outside the setting's range, or an unreadable store, gives the code default.
 */
export async function resolveEmailQuotaLimits(
  env: EffectiveSettingsEnv
): Promise<EmailQuotaLimits> {
  const fallback = {
    tenantHourlyMax: RATE_LIMIT_DEFAULTS[TENANT_KEY],
    deploymentHourlyMax: RATE_LIMIT_DEFAULTS[DEPLOYMENT_KEY],
  };
  try {
    const { values } = await resolvePlatformSettingsWithSources(env, 'rate-limit');
    const tenant = values[TENANT_KEY];
    const deployment = values[DEPLOYMENT_KEY];
    return {
      tenantHourlyMax: isWithinSettingRange(tenant, RATE_LIMIT_SETTINGS_META[TENANT_KEY])
        ? tenant
        : fallback.tenantHourlyMax,
      deploymentHourlyMax: isWithinSettingRange(
        deployment,
        RATE_LIMIT_SETTINGS_META[DEPLOYMENT_KEY]
      )
        ? deployment
        : fallback.deploymentHourlyMax,
    };
  } catch {
    return fallback;
  }
}

/**
 * Count one e-mail against the tenant cap (when the owner is a tenant), then the deployment cap.
 * Throws `NotificationQuotaExceededError` when a cap is used up; the deployment counter is not
 * touched when the tenant counter refuses.
 *
 * A limiter that cannot be reached FAILS OPEN (the e-mail is sent, one error line is logged): this
 * is a volume cap, not an authorization check, and blocking all sign-in mail on a limiter hiccup
 * is worse than letting a few extra mails through.
 */
export async function consumeEmailQuota(
  env: EmailQuotaEnv,
  input: { tenantId: string | null; notificationKind: string }
): Promise<void> {
  const limits = await resolveEmailQuotaLimits(env);
  const checks: Array<{
    scope: EmailQuotaScope;
    max: number;
    objectName: () => string;
    key: string;
  }> = [];
  if (input.tenantId !== null) {
    checks.push({
      scope: 'tenant',
      max: limits.tenantHourlyMax,
      objectName: () => buildDOKey('rate-limit', 'email-quota-hourly', input.tenantId as string),
      key: 'email_quota_tenant',
    });
  }
  checks.push({
    scope: 'deployment',
    max: limits.deploymentHourlyMax,
    objectName: () => 'rate-limit:email-quota-hourly:deployment',
    key: 'email_quota_deployment',
  });

  for (const check of checks) {
    if (check.max <= 0) continue;
    let result: { allowed: boolean; retryAfter: number };
    try {
      if (!env.RATE_LIMITER) throw new Error('rate_limiter_binding_missing');
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(check.objectName()));
      result = await stub.incrementRpc(check.key, {
        windowSeconds: EMAIL_QUOTA_WINDOW_SECONDS,
        maxRequests: check.max,
      });
    } catch (error) {
      log.error('E-mail quota limiter unavailable; sending without the cap', {
        action: 'email_quota_limiter_unavailable',
        scope: check.scope,
        notificationKind: input.notificationKind,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }
    if (!result.allowed) {
      log.warn('E-mail refused: hourly quota used up', {
        action: 'email_quota_exceeded',
        tenantId: input.tenantId ?? 'platform',
        scope: check.scope,
        notificationKind: input.notificationKind,
      });
      throw new NotificationQuotaExceededError(
        check.scope,
        Number.isFinite(result.retryAfter) && result.retryAfter > 0 ? result.retryAfter : undefined
      );
    }
  }
}

/** The HTTP 429 body (and Retry-After value, when known) for an explicit admin e-mail send. */
export function emailQuotaExceededResponse(error: NotificationQuotaExceededError): {
  body: { error: 'email_quota_exceeded'; scope: EmailQuotaScope };
  headers: Record<string, string>;
} {
  return {
    body: { error: 'email_quota_exceeded', scope: error.scope },
    headers:
      error.retryAfterSeconds === undefined
        ? {}
        : { 'Retry-After': String(Math.ceil(error.retryAfterSeconds)) },
  };
}
