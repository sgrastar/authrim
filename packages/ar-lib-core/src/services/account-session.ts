/**
 * The end user's own session, as the self-service account surfaces read it (the account API in
 * ar-management, linked-identity management in ar-bridge), and how recently it was authenticated.
 *
 * Every sensitive self-service operation (registering or removing a passkey or TOTP, changing the
 * sign-in email, linking or unlinking an external account) needs the session to have been
 * authenticated within the last ACCOUNT_REAUTH_TTL_SECONDS; one definition keeps them aligned.
 */

import type { Env } from '../types/env';
import type { Session } from '../durable-objects/SessionStore';
import { getSessionStoreBySessionId, isShardedSessionId } from '../utils/session-helper';

/** How long an authentication (or re-authentication) allows sensitive self-service operations. */
export const ACCOUNT_REAUTH_TTL_SECONDS = 5 * 60;

export type AccountSession = {
  /** Session authentication proof, not the account's current registration_state. */
  isGuestSession?: boolean;
  sessionId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  /** When the session was last authenticated (seconds); its creation when none was recorded. */
  authTime: number;
  acr?: string;
  amr?: string[];
  userAgent?: string;
  countryCode?: string;
};

/** The error body sensitive self-service operations answer (403) when re-authentication is due. */
export const ACCOUNT_REAUTH_REQUIRED_ERROR = {
  error: 'reauth_required',
  error_description: 'Recent authentication is required for this operation',
  reauth_required: true,
} as const;

export function toAccountSession(session: Session): AccountSession {
  return {
    ...(session.data?.is_guest_session === true && { isGuestSession: true }),
    sessionId: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    authTime:
      typeof session.data?.authTime === 'number'
        ? session.data.authTime
        : Math.floor(session.createdAt / 1000),
    ...(typeof session.data?.acr === 'string' && { acr: session.data.acr }),
    ...(Array.isArray(session.data?.amr) && { amr: session.data.amr }),
    ...(typeof session.data?.userAgent === 'string' && { userAgent: session.data.userAgent }),
    ...(typeof session.data?.countryCode === 'string' && {
      countryCode: session.data.countryCode,
    }),
  };
}

/**
 * The live session `sessionId` names in `tenantId`, or null when there is none (unknown, expired,
 * another tenant's, or not a session id at all). A session store failure throws: callers answer it
 * as a server error, never as "signed out".
 */
export async function readAccountSession(
  env: Env,
  tenantId: string,
  sessionId: string | null | undefined,
  now: number = Date.now()
): Promise<AccountSession | null> {
  if (!sessionId || !isShardedSessionId(sessionId)) return null;
  const { stub } = getSessionStoreBySessionId(env, sessionId, tenantId);
  const session = (await stub.getSessionRpc(sessionId)) as Session | null;
  return isLiveAccountSession(session, tenantId, now) ? toAccountSession(session) : null;
}

/** Whether a stored session is a live one of `tenantId` with a user. */
export function isLiveAccountSession(
  session: Session | null | undefined,
  tenantId: string,
  now: number = Date.now()
): session is Session {
  return Boolean(
    session &&
    session.userId &&
    session.expiresAt > now &&
    (session.tenantId === undefined || session.tenantId === tenantId)
  );
}

/**
 * Whether an authentication at `authTime` (seconds) still allows sensitive operations at `now`
 * (seconds). authTime is only ever written by the server, so a slightly later clock elsewhere (the
 * worker that recorded it) is not a reason to refuse.
 */
export function isAccountReauthFresh(
  authTime: number,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  return now < authTime + ACCOUNT_REAUTH_TTL_SECONDS;
}
