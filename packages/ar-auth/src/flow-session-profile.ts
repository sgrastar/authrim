/**
 * What the Flow a sign-in or sign-up runs sets for the session it makes and the methods it takes:
 * its session profile and its authentication method profile (`flow-profile-refs`).
 *
 * The interaction is the one bound to the sign-in on the server (in a challenge or an artifact),
 * never one a request merely names: a client cannot pick another Flow's longer session or wider
 * methods. A sign-in that answers an authorization request is held to it (`sign-in-flow-binding`):
 * its interaction must have been started for that request, and with none the app's own sign-in
 * Flow holds. Otherwise, with no interaction, the tenant's own settings hold (the Default
 * profiles).
 */
import type { Context } from 'hono';
import {
  assertInteractionAnswersChallenge,
  createAuthContextFromHono,
  isInteractionChallengeMismatchError,
  SIGN_IN_ATTEMPT_INTERACTION_HEADER,
  profileAllowsHandle,
  readAuthenticationProfile,
  resolveProfiledSessionTtl,
  resolveSignInFlowProfileRefs,
  signInAttemptInteractionFromMetadata,
  type Env,
  type FlowProfileRefs,
  type ProfiledSessionTtl,
  type SessionTtlContext,
  type SignInFlowBinding,
} from '@authrim/ar-lib-core';

type AuthContext = Context<{ Bindings: Env }>;

/** The interaction alone (a sign-in that answers no request), or the full binding. */
export type SignInFlowSource = string | null | undefined | SignInFlowBinding;

function bindingOf(source: SignInFlowSource): SignInFlowBinding {
  return source !== null && typeof source === 'object' ? source : { interactionId: source };
}

/**
 * The profiles a sign-in runs under (`resolveSignInFlowProfileRefs`): a live interaction's, the
 * assigned sign-in Flow's for a request with no usable interaction, else the Default ones. Throws
 * `InteractionChallengeMismatchError` for an interaction of another request, and a failed read:
 * the sign-in is not taken under settings the Flow may not allow.
 */
export async function interactionProfileRefs(
  c: AuthContext,
  tenantId: string,
  source: SignInFlowSource
): Promise<FlowProfileRefs> {
  const db = createAuthContextFromHono(c, tenantId).coreAdapter;
  const resolved = await resolveSignInFlowProfileRefs(c.env, db, tenantId, bindingOf(source));
  return resolved.refs;
}

/**
 * A new session's lifetime and what it keeps of its profile (spread `snapshot` into the
 * session's data), as the session profile names it. Throws `SessionProfileUnavailableError`
 * when the profile is not there.
 */
export async function sessionTtlForProfile(
  c: AuthContext,
  tenantId: string,
  context: SessionTtlContext,
  sessionProfileRef: string | null | undefined
): Promise<ProfiledSessionTtl> {
  return resolveProfiledSessionTtl(c.env, tenantId, context, sessionProfileRef);
}

/** As `sessionTtlForProfile`, for the Flow the sign-in runs under. */
export async function sessionTtlForInteraction(
  c: AuthContext,
  tenantId: string,
  context: SessionTtlContext,
  source: SignInFlowSource
): Promise<ProfiledSessionTtl> {
  const refs = await interactionProfileRefs(c, tenantId, source);
  return sessionTtlForProfile(c, tenantId, context, refs.sessionProfileRef);
}

/** The Flow step handle a sign-in method stands for (as `authentication-profile` reads it). */
const HANDLE_OF_METHOD: Record<string, string> = {
  passkey: 'passkey',
  email_code: 'mail_otp',
  email_otp: 'mail_otp',
  email_verification_protocol: 'mail_otp',
  totp: 'totp',
  directory_password: 'directory_password',
  guest: 'guest',
};

/** Whether a method profile takes the sign-in method (`passkey`, `email_code`…, or a handle). */
export async function profileTakesMethod(
  c: AuthContext,
  tenantId: string,
  methodProfileRef: string,
  method: string | null,
  usage: 'login' | 'signup'
): Promise<boolean> {
  if (methodProfileRef === 'default') return true;
  // A Flow that narrows its methods takes no sign-in whose method is not known.
  if (!method) return false;
  const profile = await readAuthenticationProfile(c.env, tenantId, methodProfileRef);
  return profileAllowsHandle(profile, HANDLE_OF_METHOD[method] ?? method, usage);
}

/**
 * Whether the Flow the sign-in runs under takes the sign-in method (`passkey`, `email_code`…,
 * or an external provider's handle). Under the Default profile, the tenant's settings decide
 * (they are checked where the method starts), so this allows it.
 */
export async function interactionAllowsSignInMethod(
  c: AuthContext,
  tenantId: string,
  source: SignInFlowSource,
  method: string | null,
  usage: 'login' | 'signup' = 'login'
): Promise<boolean> {
  const refs = await interactionProfileRefs(c, tenantId, source);
  return profileTakesMethod(c, tenantId, refs.methodProfileRef, method, usage);
}

/**
 * A sign-in that names its Flow through a challenge (the interaction it was started with), and
 * answers `authorizationChallengeId` when it answers a request: whether the Flow takes the
 * method, and the new session's lifetime by its session profile. Throws when a profile cannot be
 * read, and `InteractionChallengeMismatchError` for an interaction of another request.
 */
export async function sessionForChallenge(
  c: AuthContext,
  tenantId: string,
  context: SessionTtlContext,
  metadata: Record<string, unknown> | null | undefined,
  method: string,
  authorizationChallengeId?: string | null
): Promise<{ allowed: boolean; profiled: ProfiledSessionTtl; interactionId: string | null }> {
  const db = createAuthContextFromHono(c, tenantId).coreAdapter;
  const resolved = await resolveSignInFlowProfileRefs(c.env, db, tenantId, {
    interactionId: signInAttemptInteractionFromMetadata(metadata),
    challengeId: authorizationChallengeId,
  });
  const allowed = await profileTakesMethod(
    c,
    tenantId,
    resolved.refs.methodProfileRef,
    method,
    'login'
  );
  const profiled = await sessionTtlForProfile(
    c,
    tenantId,
    context,
    resolved.refs.sessionProfileRef
  );
  return { allowed, profiled, interactionId: resolved.interactionId };
}

/**
 * The answer to a sign-in whose interaction was started for another authorization request (or
 * for none) than the one it answers.
 */
export function interactionChallengeMismatchResponse(c: AuthContext): Response {
  return c.json(
    {
      error: 'authorization_challenge_mismatch',
      error_description: 'The sign-in was not started for this authorization request.',
    },
    403
  );
}

/**
 * At the start of a sign-in or sign-up that answers an authorization request: refused (403) when
 * the interaction it names (`interactionId`, else the interaction header) was started for another
 * request, or for none; 503 when that cannot be read. Null when it may go on.
 */
export async function namedInteractionChallengeRefusal(
  c: AuthContext,
  tenantId: string,
  interactionId: string | null | undefined,
  challengeId: string | null | undefined
): Promise<Response | null> {
  if (!challengeId) return null;
  const named = interactionId ?? c.req.header(SIGN_IN_ATTEMPT_INTERACTION_HEADER) ?? null;
  if (!named) return null;
  try {
    await assertInteractionAnswersChallenge(
      createAuthContextFromHono(c, tenantId).coreAdapter,
      tenantId,
      named,
      challengeId
    );
    return null;
  } catch (error) {
    if (isInteractionChallengeMismatchError(error)) return interactionChallengeMismatchResponse(c);
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The sign-in flow is unavailable.',
      },
      503
    );
  }
}
