/**
 * The tenant's per-provider switches for external sign-in and sign-up
 * (`authentication-methods.external_provider_usage`), enforced where a sign-in starts, completes
 * and creates an account. The login screen and the admin API only show them; this is what makes
 * them hold when the URL is called directly.
 */

import { readExternalProviderUsagePolicy, type Env } from '@authrim/ar-lib-core';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';

export type ExternalProviderUsage = 'login' | 'signup';

/** The ids an external provider's saved usage entry can carry (its stable id, else its slug). */
export function externalProviderUsageKey(provider: { id: string; slug?: string | null }): {
  providerId: string;
  ids: string[];
} {
  return { providerId: provider.id, ids: [provider.id, provider.slug ?? ''].filter(Boolean) };
}

/**
 * Throws unless the tenant lets `provider` be used for `usage`. A provider the tenant saved no
 * switch for is on (as the login screen shows it); only a switch saved as off refuses. Settings
 * that cannot be read refuse as unavailable rather than guess.
 */
export async function assertExternalProviderUsageAllowed(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string,
  provider: { id: string; slug?: string | null },
  usage: ExternalProviderUsage
): Promise<void> {
  let enabled: boolean;
  try {
    const policy = await readExternalProviderUsagePolicy(
      env,
      tenantId,
      externalProviderUsageKey(provider)
    );
    enabled = usage === 'login' ? policy.loginEnabled : policy.signupEnabled;
  } catch {
    throw new ExternalIdPError(
      ExternalIdPErrorCode.SETTINGS_UNAVAILABLE,
      'External provider settings are unavailable'
    );
  }
  if (enabled) return;
  throw new ExternalIdPError(
    usage === 'login' ? ExternalIdPErrorCode.LOGIN_DISABLED : ExternalIdPErrorCode.SIGNUP_DISABLED,
    usage === 'login'
      ? 'This provider cannot be used to sign in'
      : 'This provider cannot be used to sign up'
  );
}
