import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserStore,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  isShardedSessionId,
} from '@authrim/ar-lib-core';

const REAUTH_TTL_SECONDS = 5 * 60;

export type AccountSession = {
  sessionId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  authTime: number;
  acr?: string;
  amr?: string[];
};

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function unauthorized(c: Context<{ Bindings: Env }>, description: string): Response {
  setNoStore(c);
  return c.json(
    {
      error: 'unauthorized',
      error_description: description,
    },
    401
  );
}

function normalizeSession(session: Session): AccountSession {
  return {
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
  };
}

export async function requireAccountSession(
  c: Context<{ Bindings: Env }>
): Promise<AccountSession | Response> {
  const sessionId = getCookie(c, 'authrim_session');
  if (!sessionId) {
    return unauthorized(c, 'Authentication required');
  }

  if (!isShardedSessionId(sessionId)) {
    return unauthorized(c, 'Session has expired or is invalid');
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (
      !session ||
      !session.userId ||
      session.expiresAt <= Date.now() ||
      (session.tenantId !== undefined && session.tenantId !== tenantId)
    ) {
      return unauthorized(c, 'Session has expired or is invalid');
    }

    return normalizeSession(session);
  } catch (error) {
    const log = getLogger(c).module('ACCOUNT-PAGE');
    log.error('Account session validation failed', { action: 'session_validate' }, error as Error);
    setNoStore(c);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to validate account session',
      },
      500
    );
  }
}

export async function getAccountProfileHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let user:
    | Awaited<ReturnType<CanonicalRuntimeUserStore['findById']>>
    | null = null;
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: piiCtx.defaultPiiAdapter,
      tenantId,
    });
    user = await runtimeUsers.findById(accountSession.userId);
  } catch (error) {
    const log = getLogger(c).module('ACCOUNT-PAGE');
    log.error('Account profile lookup failed', { action: 'profile_lookup' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load account profile',
      },
      500
    );
  }

  if (!user) {
    return unauthorized(c, 'Session user was not found');
  }

  return c.json({
    profile: {
      user_id: accountSession.userId,
      email: user.email,
      email_verified: user.email_verified === 1,
      name: user.name,
      given_name: user.given_name,
      family_name: user.family_name,
      locale: user.locale,
      picture: user.picture,
    },
    session: {
      id: accountSession.sessionId,
      created_at: accountSession.createdAt,
      expires_at: accountSession.expiresAt,
      auth_time: accountSession.authTime,
      ...(accountSession.acr && { acr: accountSession.acr }),
      ...(accountSession.amr && { amr: accountSession.amr }),
    },
  });
}

export async function getAccountReauthStatusHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = accountSession.authTime + REAUTH_TTL_SECONDS;

  return c.json({
    reauth: {
      required: nowSeconds >= expiresAt,
      authenticated_at: accountSession.authTime,
      expires_at: expiresAt,
      ttl_seconds: REAUTH_TTL_SECONDS,
      methods: accountSession.amr ?? [],
    },
  });
}
