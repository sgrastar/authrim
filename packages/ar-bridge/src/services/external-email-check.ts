import {
  loadInteractionRegistrationPolicy,
  resolveSignInFlowProfileRefs,
  profileAllowsHandle,
  readAuthenticationProfile,
  resolveProfiledSessionTtl,
  type ProfiledSessionTtl,
  normalizeMethodHandle,
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
): Promise<{ policy: RegistrationPolicy; profileRef: string; sessionProfileRef: string } | null> {
  const core = await resolveAuthCorePersistenceAdapterFromEnv(env, 'bridge-external-sign-up', {
    tenantId,
  });
  const named = interactionId
    ? await loadInteractionRegistrationPolicy(core, tenantId, interactionId)
    : null;
  if (named && named.live) {
    return {
      policy: named.policy,
      profileRef: named.profileRef,
      sessionProfileRef: named.sessionProfileRef,
    };
  }
  return loadTenantRegistrationPolicy(core, tenantId);
}

/** The handle an external provider has in a Flow step (as the runtime names it). */
export function providerHandle(provider: { slug?: string | null; id: string }): string {
  return normalizeMethodHandle(provider.slug || provider.id);
}

/**
 * What the Flow an external sign-in runs sets for it: whether its authentication method profile
 * takes the provider (a sign-in; a sign-up was held to its registration Flow before the account
 * was made), and the session's lifetime by its session profile. A sign-up's session follows the
 * registration Flow it was held to; a sign-in's, the Flow of the interaction the start checked.
 * A read that fails is thrown: no session is made under settings the Flow may not allow.
 */
export async function externalSessionProfile(
  env: Env,
  input: {
    tenantId: string;
    interactionId: string | undefined;
    /** The authorization request the sign-in answers (kept from the start). */
    challengeId?: string | undefined;
    provider: { slug?: string | null; id: string };
    isNewUser: boolean;
  }
): Promise<{ allowed: boolean; profiled: ProfiledSessionTtl; interactionId: string | null }> {
  if (input.isNewUser) {
    const signUp = await loadExternalSignUpPolicy(env, input.tenantId, input.interactionId);
    return {
      allowed: true,
      // The interaction it ran in, as the start checked it (live then).
      interactionId: input.interactionId ?? null,
      profiled: await resolveProfiledSessionTtl(
        env,
        input.tenantId,
        'default',
        signUp?.sessionProfileRef ?? 'default'
      ),
    };
  }
  const core = await resolveAuthCorePersistenceAdapterFromEnv(env, 'bridge-external-sign-in', {
    tenantId: input.tenantId,
  });
  // The live interaction's Flow (checked at the start to answer the same request); one gone or
  // no longer live since is as none named (its stale settings are not used). With none, a
  // sign-in that answers a request runs under its app's sign-in Flow, else the Default profiles.
  const { refs, interactionId } = await resolveSignInFlowProfileRefs(env, core, input.tenantId, {
    interactionId: input.interactionId,
    challengeId: input.challengeId,
  });
  const methodRef = refs.methodProfileRef;
  const allowed =
    methodRef === 'default' ||
    profileAllowsHandle(
      await readAuthenticationProfile(env, input.tenantId, methodRef),
      providerHandle(input.provider),
      'login'
    );
  return {
    allowed,
    interactionId,
    profiled: await resolveProfiledSessionTtl(
      env,
      input.tenantId,
      'default',
      refs.sessionProfileRef
    ),
  };
}
