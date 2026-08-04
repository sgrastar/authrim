import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  getLogger,
  getSessionRevocationStore,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  isShardedSessionId,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function toSessionItem(
  session: Pick<Session, 'id' | 'createdAt' | 'expiresAt'>,
  currentSessionId: string
) {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    created_at: session.createdAt,
    expires_at: session.expiresAt,
  };
}

function currentSessionRow(accountSession: {
  sessionId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}): Pick<Session, 'id' | 'createdAt' | 'expiresAt'> {
  return {
    id: accountSession.sessionId,
    createdAt: accountSession.createdAt,
    expiresAt: accountSession.expiresAt,
  };
}

export async function listAccountSessionsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const indexed = await getSessionRevocationStore(
    c.env,
    tenantId,
    accountSession.userId
  ).listActiveSessionsRpc(
    tenantId,
    accountSession.userId,
    `account:${accountSession.userId}`,
    Date.now()
  );
  const sessions: ReturnType<typeof toSessionItem>[] = [];
  for (const entry of indexed.slice(0, 100)) {
    if (!isShardedSessionId(entry.sessionId)) continue;
    const { stub } = getSessionStoreBySessionId(c.env, entry.sessionId, tenantId);
    const session = (await stub.getSessionRpc(entry.sessionId)) as Session | null;
    if (session?.tenantId === tenantId && session.userId === accountSession.userId) {
      sessions.push(toSessionItem(session, accountSession.sessionId));
    }
  }
  if (!sessions.some((session) => session.id === accountSession.sessionId)) {
    sessions.push(toSessionItem(currentSessionRow(accountSession), accountSession.sessionId));
    sessions.sort((a, b) => b.created_at - a.created_at);
  }

  return c.json({
    sessions,
  });
}

export async function deleteAccountSessionHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const sessionId = c.req.param('id');
  if (!sessionId) {
    return c.json({ error: 'not_found', error_description: 'Session was not found' }, 404);
  }

  const tenantId = getTenantIdFromContext(c);
  if (!isShardedSessionId(sessionId)) {
    return c.json({ error: 'not_found', error_description: 'Session was not found' }, 404);
  }

  let storeStatus: 'revoked' | 'not_found' = 'not_found';
  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
    if (!session || session.tenantId !== tenantId || session.userId !== accountSession.userId) {
      return c.json({ error: 'not_found', error_description: 'Session was not found' }, 404);
    }
    storeStatus = (await sessionStore.invalidateSessionRpc(sessionId)) ? 'revoked' : 'not_found';
  } catch (error) {
    const log = getLogger(c).module('ACCOUNT-SESSIONS');
    log.error('SessionStore invalidation failed', { action: 'session_revoke' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke session',
      },
      503
    );
  }

  const current = sessionId === accountSession.sessionId;
  if (current) {
    setCookie(c, 'authrim_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 0,
    });
  }

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.session.revoked',
    resourceType: 'session',
    resourceId: sessionId,
    metadata: {
      current,
      store_status: storeStatus,
    },
  });

  return c.json({
    ok: true,
    session: {
      id: sessionId,
      current,
      store_status: storeStatus,
    },
  });
}
