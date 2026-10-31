import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  getSessionRevocationStore,
  getSessionStoreBySessionId,
  isShardedSessionId,
  revokeUserRefreshTokenFamilies,
} from '@authrim/ar-lib-core';

const MAX_SESSION_ROWS = 1_000;

export async function revokeIdentifierReplacementCredentials(input: {
  env: Env;
  core: DatabaseAdapter;
  tenantId: string;
  accountId: string;
  initiatingSessionRef: string | null;
}): Promise<void> {
  await revokeUserRefreshTokenFamilies(input.env, input.core, {
    tenantId: input.tenantId,
    userId: input.accountId,
    reason: 'identifier_replaced',
  });

  const sessions = (
    await getSessionRevocationStore(
      input.env,
      input.tenantId,
      input.accountId
    ).listActiveSessionsRpc(
      input.tenantId,
      input.accountId,
      `account:${input.accountId}`,
      Date.now()
    )
  ).filter((session) => session.sessionId !== input.initiatingSessionRef);
  if (sessions.length > MAX_SESSION_ROWS) {
    throw new Error('identifier_replacement_session_limit_exceeded');
  }
  for (const session of sessions) {
    if (isShardedSessionId(session.sessionId)) {
      const { stub } = getSessionStoreBySessionId(input.env, session.sessionId, input.tenantId);
      await stub.invalidateSessionRpc(session.sessionId);
    }
  }
}
