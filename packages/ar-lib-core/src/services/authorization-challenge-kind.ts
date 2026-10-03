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
