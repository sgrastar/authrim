/**
 * Which sign-in Flow's profiles a sign-in runs under, held to the authorization request it
 * answers.
 *
 * A sign-in names its Flow interaction (a header or a field the browser sends), and the Flow's
 * profiles decide the methods it takes and the session it makes. The browser could otherwise name
 * the interaction of another request (another app's Flow, with wider methods or a longer
 * session), or name none and fall back to the tenant's own settings. So, when the sign-in answers
 * an authorization request (an OIDC or SAML challenge):
 *
 * - an interaction it names must have been started for that same challenge
 *   (`InteractionChallengeMismatchError` otherwise);
 * - with no usable interaction, the sign-in Flow assigned to the request's app holds (else the
 *   tenant's, as `loadAssignedLoginFlowProfileRefs` reads it), not the Default profiles.
 *
 * A sign-in that answers no request keeps what it did before: the live interaction's profiles,
 * else the Default ones.
 */
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import { getChallengeStoreByChallengeId } from '../utils/challenge-sharding';
import {
  loadAssignedLoginFlowProfileRefs,
  loadInteractionFlowProfileRefs,
  type FlowProfileRefs,
} from './flow-profile-refs';
import {
  isSAMLAuthorizationChallenge,
  readSAMLAuthorizationChallengeBinding,
} from './saml-authorization-challenge';

/** A stored authorization challenge, as far as it is read here. */
interface StoredChallenge {
  tenantId?: unknown;
  type?: unknown;
  consumed?: unknown;
  metadata?: Record<string, unknown> | null;
}

const INTERACTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const MAX_CHALLENGE_ID_LENGTH = 256;
const DEFAULT_REFS: FlowProfileRefs = { methodProfileRef: 'default', sessionProfileRef: 'default' };

/** The interaction a sign-in names was started for another authorization request (or none). */
export class InteractionChallengeMismatchError extends Error {
  constructor() {
    super('The sign-in interaction was not started for this authorization request');
    this.name = 'InteractionChallengeMismatchError';
  }
}

export function isInteractionChallengeMismatchError(
  error: unknown
): error is InteractionChallengeMismatchError {
  return error instanceof InteractionChallengeMismatchError;
}

export interface SignInFlowBinding {
  /** The Flow interaction the sign-in names. */
  interactionId?: string | null;
  /** The authorization challenge the sign-in answers, when it answers one. */
  challengeId?: string | null;
  /**
   * With no usable interaction, take the sign-in Flow assigned to the challenge's app (true, a
   * sign-in), or the Default profiles (false: a sign-up, which its registration Flow governs).
   */
  assignedFallback?: boolean;
}

export interface ResolvedSignInFlow {
  refs: FlowProfileRefs;
  /** The live interaction whose profiles hold, or null when they come from elsewhere. */
  interactionId: string | null;
}

function usableInteractionId(value: string | null | undefined): string | null {
  return typeof value === 'string' && INTERACTION_ID.test(value) ? value : null;
}

function usableChallengeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value && value.length <= MAX_CHALLENGE_ID_LENGTH
    ? value
    : null;
}

/**
 * Whether the interaction a sign-in names was started for the challenge it answers. Throws
 * `InteractionChallengeMismatchError` when it was not (for another challenge, or none). An
 * interaction that is not there is no mismatch: it lends the sign-in nothing. A failed read is
 * thrown.
 */
export async function assertInteractionAnswersChallenge(
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string | null | undefined,
  challengeId: string | null | undefined
): Promise<void> {
  const interaction = usableInteractionId(interactionId);
  const challenge = usableChallengeId(challengeId);
  if (!interaction || !challenge) return;
  const read = await loadInteractionFlowProfileRefs(db, tenantId, interaction);
  if (read && read.authorizationChallengeId !== challenge) {
    throw new InteractionChallengeMismatchError();
  }
}

/**
 * The app an authorization challenge was issued for: an OIDC client, or a SAML SP (its entity
 * id). Null when the challenge is not there (gone, used, another tenant's) or names no app. A
 * failed read is thrown.
 */
export async function readChallengeFlowTarget(
  env: Env,
  tenantId: string,
  challengeId: string
): Promise<{
  clientId: string | null;
  samlSpId: string | null;
  kind: 'login' | 'reauth';
} | null> {
  const store = (await getChallengeStoreByChallengeId(env, challengeId, tenantId)) as {
    getChallengeRpc(id: string): Promise<StoredChallenge | null>;
  };
  const challenge = await store.getChallengeRpc(challengeId);
  if (!challenge || challenge.tenantId !== tenantId || challenge.consumed) return null;
  if (challenge.type !== 'login' && challenge.type !== 'reauth') return null;
  if (isSAMLAuthorizationChallenge(challenge.metadata)) {
    const binding = readSAMLAuthorizationChallengeBinding(challenge);
    return binding ? { clientId: null, samlSpId: binding.spEntityId, kind: challenge.type } : null;
  }
  const clientId = challenge.metadata?.client_id;
  return typeof clientId === 'string' && clientId
    ? { clientId, samlSpId: null, kind: challenge.type }
    : null;
}

/**
 * The profiles a sign-in runs under (see the file comment). Throws
 * `InteractionChallengeMismatchError` for an interaction of another request, and any failed read.
 */
export async function resolveSignInFlowProfileRefs(
  env: Env,
  db: DatabaseAdapter,
  tenantId: string,
  binding: SignInFlowBinding
): Promise<ResolvedSignInFlow> {
  const interactionId = usableInteractionId(binding.interactionId);
  const challengeId = usableChallengeId(binding.challengeId);
  if (interactionId) {
    const read = await loadInteractionFlowProfileRefs(db, tenantId, interactionId);
    if (read && challengeId && read.authorizationChallengeId !== challengeId) {
      throw new InteractionChallengeMismatchError();
    }
    if (read?.live) {
      return {
        refs: {
          methodProfileRef: read.methodProfileRef,
          sessionProfileRef: read.sessionProfileRef,
        },
        interactionId,
      };
    }
  }
  if (challengeId && binding.assignedFallback !== false) {
    const target = await readChallengeFlowTarget(env, tenantId, challengeId);
    // A re-authentication is held to the tenant's re-authentication methods, not a sign-in Flow.
    if (target && target.kind === 'login') {
      const assigned = await loadAssignedLoginFlowProfileRefs(db, tenantId, target);
      if (assigned) return { refs: assigned, interactionId: null };
    }
  }
  return { refs: { ...DEFAULT_REFS }, interactionId: null };
}

/**
 * Whether the session may answer a SAML request the IdP sent the person to sign in for
 * (`sentToSignInAt`). A session from before that is single sign-on, which the request judges. One
 * made since must have been made in an interaction started for that request: one made in another
 * (another app's Flow) or by a route that records none would answer it under settings its Flow
 * does not allow. A route that records no interaction is taken only while the SP's sign-in Flow
 * sets nothing of its own (both profiles Default). A failed read is thrown.
 */
export async function sessionAnswersSAMLRequest(
  db: DatabaseAdapter,
  tenantId: string,
  input: {
    sessionCreatedAt: number | undefined;
    sessionData: Record<string, unknown> | undefined;
    sentToSignInAt: number | undefined;
    requestId: string;
    spEntityId: string;
  }
): Promise<boolean> {
  if (
    input.sentToSignInAt === undefined ||
    (input.sessionCreatedAt !== undefined && input.sessionCreatedAt < input.sentToSignInAt)
  ) {
    return true;
  }
  const recorded = usableInteractionId(
    typeof input.sessionData?.runtime_interaction_id === 'string'
      ? input.sessionData.runtime_interaction_id
      : null
  );
  if (recorded) {
    const read = await loadInteractionFlowProfileRefs(db, tenantId, recorded);
    // The request id is what the browser said when the interaction started: it counts only for an
    // interaction started for this SP alone (so it ran the SP's own Flow), not another app's.
    return (
      read !== null &&
      read.samlRequestId === input.requestId &&
      read.samlSpId === input.spEntityId &&
      !read.clientId
    );
  }
  const assigned = await loadAssignedLoginFlowProfileRefs(db, tenantId, {
    samlSpId: input.spEntityId,
  });
  return (
    !assigned ||
    (assigned.methodProfileRef === 'default' && assigned.sessionProfileRef === 'default')
  );
}
