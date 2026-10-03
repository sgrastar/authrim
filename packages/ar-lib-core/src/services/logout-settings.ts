/**
 * Logout settings for a tenant, as the logout senders and discovery apply them. The logout and the
 * logout webhook settings are resolved apart, so a settings document that cannot be read leaves
 * the other's values in effect.
 */

import type { LogoutConfig, LogoutWebhookConfig } from '../types/logout';
import { logoutConfigFromValues, logoutWebhookConfigFromValues } from '../utils/logout-settings';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

/**
 * The tenant's back-channel, front-channel and session management settings (tenant, platform,
 * env, defaults). Throws when they cannot be read: callers keep their
 * own fallback.
 */
export async function resolveLogoutConfig(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<LogoutConfig> {
  const values = await resolveEffectiveSettings(env, 'session', {
    tenantId,
  });
  return logoutConfigFromValues(values);
}

/** The tenant's logout webhook settings. Throws when they cannot be read. */
export async function resolveLogoutWebhookConfig(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<LogoutWebhookConfig> {
  const values = await resolveEffectiveSettings(env, 'session', {
    tenantId,
  });
  return logoutWebhookConfigFromValues(values);
}
