import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  isShardedSessionId,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';

type SessionRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
};

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function toSessionItem(row: SessionRow, currentSessionId: string) {
  return {
    id: row.id,
    current: row.id === currentSessionId,
    created_at: row.created_at * 1000,
    expires_at: row.expires_at * 1000,
  };
}

function currentSessionRow(accountSession: {
  sessionId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}): SessionRow {
  return {
    id: accountSession.sessionId,
    tenant_id: '',
    user_id: accountSession.userId,
    created_at: Math.floor(accountSession.createdAt / 1000),
    expires_at: Math.floor(accountSession.expiresAt / 1000),
  };
}

export async function listAccountSessionsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows = await authCtx.coreAdapter.query<SessionRow>(
    `SELECT id, tenant_id, user_id, expires_at, created_at
       FROM sessions
      WHERE tenant_id = ? AND user_id = ? AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 100`,
    [tenantId, accountSession.userId, nowSeconds]
  );
  const sessions = rows.map((row) => toSessionItem(row, accountSession.sessionId));
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
  const authCtx = createAuthContextFromHono(c, tenantId);
  let row = await authCtx.coreAdapter.queryOne<SessionRow>(
    `SELECT id, tenant_id, user_id, expires_at, created_at
       FROM sessions
      WHERE id = ? AND tenant_id = ? AND user_id = ?`,
    [sessionId, tenantId, accountSession.userId]
  );

  if (!row && sessionId === accountSession.sessionId) {
    row = currentSessionRow(accountSession);
  }

  if (!row) {
    return c.json({ error: 'not_found', error_description: 'Session was not found' }, 404);
  }

  let storeStatus: 'revoked' | 'not_found' | 'not_applicable' = 'not_applicable';
  if (isShardedSessionId(sessionId)) {
    try {
      const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
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
  }

  await authCtx.coreAdapter.execute('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [
    sessionId,
    tenantId,
  ]);

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
