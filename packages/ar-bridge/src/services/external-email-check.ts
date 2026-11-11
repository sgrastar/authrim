import {
  loadInteractionRegistrationPolicy,
  loadTenantRegistrationPolicy,
  resolveAuthCorePersistenceAdapterFromEnv,
  type Env,
  type RegistrationExternalEmailCheck,
  type RegistrationPolicy,
} from '@authrim/ar-lib-core';

/**
 * Whether a sign-up through an external provider needs its email address checked by email code
 * before the account is made, under the `external_email_check` of the registration Flow it runs.
 *
 * Returns the first check that matches, or null (nothing extra to check). A null or empty policy
 * (no Flow policy, or one that lists nothing) never matches: the tenant's behaviour is unchanged.
 */
export function externalEmailCheckNeeded(
  checks: readonly RegistrationExternalEmailCheck[] | null | undefined,
  input: { email?: string | null; emailVerified?: boolean | null; trustEmail?: boolean | null }
): RegistrationExternalEmailCheck | null {
  if (!checks || checks.length === 0) return null;
  const hasEmail = typeof input.email === 'string' && input.email.trim() !== '';
  if (checks.includes('no_email') && !hasEmail) return 'no_email';
  if (checks.includes('unverified') && hasEmail && input.emailVerified !== true) {
    return 'unverified';
  }
  if (checks.includes('low_trust') && input.trustEmail !== true) return 'low_trust';
  return null;
}

/**
 * The sign-up policy an external sign-up is held to: the registration Flow the start named (a
 * live interaction of it), else the tenant's own registration Flow, so naming another interaction
 * or none does not skip it. Null when neither exists (the tenant's behaviour then holds). A read
 * that fails is thrown: the sign-up is not taken.
 */
export async function loadExternalSignUpPolicy(
  env: Env,
  tenantId: string,
  interactionId: string | undefined
): Promise<{ policy: RegistrationPolicy; profileRef: string } | null> {
  const core = await resolveAuthCorePersistenceAdapterFromEnv(env, 'bridge-external-sign-up', {
    tenantId,
  });
  const named = interactionId
    ? await loadInteractionRegistrationPolicy(core, tenantId, interactionId)
    : null;
  if (named && named.live) return { policy: named.policy, profileRef: named.profileRef };
  return loadTenantRegistrationPolicy(core, tenantId);
}

/** The handle an external provider has in a Flow step (as the runtime names it). */
export function providerHandle(provider: { slug?: string | null; id: string }): string {
  const value = provider.slug || provider.id;
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'method'
  );
}
