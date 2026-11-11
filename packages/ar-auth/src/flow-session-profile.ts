/**
 * What the Flow a sign-in or sign-up runs sets for the session it makes and the methods it takes:
 * its session profile and its authentication method profile (`flow-profile-refs`).
 *
 * The interaction is the one bound to the sign-in on the server (in a challenge or an artifact),
 * never one a request merely names: a client cannot pick another Flow's longer session or wider
 * methods. With no interaction, the tenant's own settings hold (the Default profiles).
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  loadInteractionFlowProfileRefs,
  profileAllowsHandle,
  readAuthenticationProfile,
  resolveProfiledSessionTtl,
  signInAttemptInteractionFromMetadata,
  type Env,
  type FlowProfileRefs,
  type ProfiledSessionTtl,
  type SessionTtlContext,
} from '@authrim/ar-lib-core';

type AuthContext = Context<{ Bindings: Env }>;

const INTERACTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const DEFAULT_REFS: FlowProfileRefs = { methodProfileRef: 'default', sessionProfileRef: 'default' };

/**
 * The profiles of the Flow a bound interaction runs; the Default ones with no interaction, or one
 * that is not there or no longer live (as a sign-in that names none: a stale Flow's settings are
 * not used). A failed read is thrown: the sign-in is not taken under settings the Flow may not
 * allow.
 */
export async function interactionProfileRefs(
  c: AuthContext,
  tenantId: string,
  interactionId: string | null | undefined
): Promise<FlowProfileRefs> {
  if (!interactionId || !INTERACTION_ID.test(interactionId)) return { ...DEFAULT_REFS };
  const db = createAuthContextFromHono(c, tenantId).coreAdapter;
  const refs = await loadInteractionFlowProfileRefs(db, tenantId, interactionId);
  if (!refs || !refs.live) return { ...DEFAULT_REFS };
  return { methodProfileRef: refs.methodProfileRef, sessionProfileRef: refs.sessionProfileRef };
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

/** As `sessionTtlForProfile`, for the Flow a bound interaction runs. */
export async function sessionTtlForInteraction(
  c: AuthContext,
  tenantId: string,
  context: SessionTtlContext,
  interactionId: string | null | undefined
): Promise<ProfiledSessionTtl> {
  const refs = await interactionProfileRefs(c, tenantId, interactionId);
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

/**
 * Whether the Flow a bound interaction runs takes the sign-in method (`passkey`, `email_code`…,
 * or an external provider's handle). With no interaction, the tenant's settings decide (they are
 * checked where the method starts), so this allows it.
 */
export async function interactionAllowsSignInMethod(
  c: AuthContext,
  tenantId: string,
  interactionId: string | null | undefined,
  method: string,
  usage: 'login' | 'signup' = 'login'
): Promise<boolean> {
  const refs = await interactionProfileRefs(c, tenantId, interactionId);
  if (refs.methodProfileRef === 'default') return true;
  const profile = await readAuthenticationProfile(c.env, tenantId, refs.methodProfileRef);
  return profileAllowsHandle(profile, HANDLE_OF_METHOD[method] ?? method, usage);
}

/**
 * A sign-in that names its Flow through a challenge (the interaction it was started with):
 * whether the Flow takes the method, and the new session's lifetime by its session profile.
 * Throws when a profile cannot be read.
 */
export async function sessionForChallenge(
  c: AuthContext,
  tenantId: string,
  context: SessionTtlContext,
  metadata: Record<string, unknown> | null | undefined,
  method: string
): Promise<{ allowed: boolean; profiled: ProfiledSessionTtl }> {
  const interactionId = signInAttemptInteractionFromMetadata(metadata);
  const allowed = await interactionAllowsSignInMethod(c, tenantId, interactionId, method);
  const profiled = await sessionTtlForInteraction(c, tenantId, context, interactionId);
  return { allowed, profiled };
}
