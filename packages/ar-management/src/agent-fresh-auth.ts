import type { AdminAuthContext } from '@authrim/ar-lib-core';

export const ADMIN_FRESH_AUTH_WINDOW_MS = 5 * 60 * 1000;

/** Shared high-risk Admin confirmation contract for Agent Access control-plane actions. */
export function isFreshAdminHuman(auth: AdminAuthContext, now: number): boolean {
  const authenticationTimeMs = (auth as AdminAuthContext & { authenticationTimeMs?: number })
    .authenticationTimeMs;
  return (
    (!auth.actorType || auth.actorType === 'human') &&
    auth.authMethod === 'session' &&
    auth.mfaVerified === true &&
    typeof authenticationTimeMs === 'number' &&
    now - authenticationTimeMs >= 0 &&
    now - authenticationTimeMs <= ADMIN_FRESH_AUTH_WINDOW_MS
  );
}
