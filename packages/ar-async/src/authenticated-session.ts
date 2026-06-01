import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserStore,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getSessionStoreBySessionId,
  isShardedSessionId,
} from '@authrim/ar-lib-core';

export interface AuthenticatedAsyncUser {
  userId: string;
  sub: string;
  email: string | null;
}

function getSessionIdFromRequest(c: Context<{ Bindings: Env }>): string | null {
  const cookieSession = getCookie(c, 'authrim_session');
  if (cookieSession) {
    return cookieSession;
  }

  const headerSession = c.req.header('X-Session-Id');
  if (headerSession) {
    return headerSession;
  }

  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

export async function getAuthenticatedAsyncUser(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<AuthenticatedAsyncUser | null> {
  try {
    const sessionId = getSessionIdFromRequest(c);
    if (!sessionId || !isShardedSessionId(sessionId)) {
      return null;
    }

    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
    if (!session || session.expiresAt <= Date.now()) {
      return null;
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: piiCtx.defaultPiiAdapter,
      tenantId,
    });
    const user = await runtimeUsers.findById(session.userId, { includeInactive: true });
    if (!user || user.active !== 1) {
      return null;
    }

    return {
      userId: session.userId,
      sub: session.userId,
      email: user.email ?? null,
    };
  } catch {
    return null;
  }
}

export function cibaLoginHintMatchesAuthenticatedUser(
  loginHint: string | undefined,
  user: AuthenticatedAsyncUser
): boolean {
  if (!loginHint) {
    return true;
  }

  const normalized = loginHint.trim().toLowerCase();
  if (normalized.startsWith('sub:')) {
    return normalized.slice(4) === user.sub.toLowerCase();
  }

  if (normalized.includes('@')) {
    return user.email?.toLowerCase() === normalized;
  }

  return normalized === user.sub.toLowerCase() || normalized === user.userId.toLowerCase();
}
