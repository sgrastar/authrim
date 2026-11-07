import type { Env } from '../types/env';
import { getChallengeStoreByChallengeId } from '../utils/challenge-sharding';

/**
 * The kind of an Authrim authorization challenge in this tenant (an /authorize login or a
 * re-authentication), or null when the id names no such challenge. It is read, not consumed:
 * a sign-in started for it (at an external IdP or by SAML) still completes it later.
 */
export async function readAuthorizationChallengeKind(
  env: Env,
  tenantId: string,
  challengeId: string
): Promise<'login' | 'reauth' | null> {
  try {
    const challengeStore = await getChallengeStoreByChallengeId(env, challengeId, tenantId);
    const challenge = (await challengeStore.getChallengeRpc(challengeId)) as {
      tenantId?: string;
      type?: string;
    } | null;
    if (challenge?.tenantId !== tenantId) return null;
    return challenge.type === 'login' || challenge.type === 'reauth' ? challenge.type : null;
  } catch {
    return null;
  }
}

/**
 * As `readAuthorizationChallengeKind`, but a store that could not be read is told apart from a
 * challenge that is no sign-in or re-authentication one (`unavailable`): for a caller that must
 * not take the one for the other.
 */
export async function readAuthorizationChallengeKindChecked(
  env: Env,
  tenantId: string,
  challengeId: string
): Promise<'login' | 'reauth' | null | 'unavailable'> {
  let challenge: { tenantId?: string; type?: string } | null;
  try {
    const challengeStore = (await getChallengeStoreByChallengeId(env, challengeId, tenantId)) as {
      getChallengeRpc(id: string): Promise<unknown>;
    };
    challenge = (await challengeStore.getChallengeRpc(challengeId)) as typeof challenge;
  } catch {
    return 'unavailable';
  }
  if (challenge?.tenantId !== tenantId) return null;
  return challenge.type === 'login' || challenge.type === 'reauth' ? challenge.type : null;
}

/**
 * The user a re-authentication challenge is for (the session's user when it names one), or null
 * when the challenge is not a live re-authentication challenge of `tenantId` with a user.
 */
export async function readReauthChallengeUser(
  env: Env,
  tenantId: string,
  challengeId: string | null | undefined
): Promise<string | null> {
  if (!challengeId) return null;
  try {
    const challengeStore = (await getChallengeStoreByChallengeId(env, challengeId, tenantId)) as {
      getChallengeRpc(id: string): Promise<unknown>;
    };
    const challenge = (await challengeStore.getChallengeRpc(challengeId)) as {
      tenantId?: string;
      type?: string;
      userId?: string;
      metadata?: Record<string, unknown>;
    } | null;
    if (challenge?.tenantId !== tenantId || challenge.type !== 'reauth') return null;
    const sessionUserId = challenge.metadata?.sessionUserId;
    const userId =
      typeof sessionUserId === 'string' && sessionUserId ? sessionUserId : challenge.userId;
    return userId && userId !== 'anonymous' ? userId : null;
  } catch {
    return null;
  }
}
