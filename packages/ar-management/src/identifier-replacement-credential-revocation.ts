import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  getRefreshTokenRotatorStubByJti,
  getSessionStoreBySessionId,
  isShardedSessionId,
  listRefreshTokenFamiliesByUser,
  revokeRefreshTokenFamiliesByUser,
} from '@authrim/ar-lib-core';

const MAX_SESSION_ROWS = 1_000;

interface SessionRow {
  id: string;
}

export async function revokeIdentifierReplacementCredentials(input: {
  env: Env;
  core: DatabaseAdapter;
  tenantId: string;
  accountId: string;
  initiatingSessionRef: string | null;
}): Promise<void> {
  const families = await listRefreshTokenFamiliesByUser(input.core, {
    tenantId: input.tenantId,
    userId: input.accountId,
    activeOnly: true,
    nowMs: Date.now(),
  });
  const revokedInstances = new Set<string>();
  for (const family of families) {
    const resolution = getRefreshTokenRotatorStubByJti(
      input.env,
      family.client_id,
      family.jti,
      input.tenantId
    );
    if (revokedInstances.has(resolution.resolution.instanceName)) continue;
    await resolution.stub.revokeFamilyRpc(input.accountId, 'identifier_replaced');
    revokedInstances.add(resolution.resolution.instanceName);
  }
  await revokeRefreshTokenFamiliesByUser(input.core, {
    tenantId: input.tenantId,
    userId: input.accountId,
  });

  const sessions = await input.core.query<SessionRow>(
    `SELECT id FROM sessions
      WHERE tenant_id = ? AND user_id = ? AND id <> ?
      ORDER BY id
      LIMIT ?`,
    [input.tenantId, input.accountId, input.initiatingSessionRef ?? '', MAX_SESSION_ROWS + 1],
    { consistencyClass: 'primary_required' }
  );
  if (sessions.length > MAX_SESSION_ROWS) {
    throw new Error('identifier_replacement_session_limit_exceeded');
  }
  for (const session of sessions) {
    if (isShardedSessionId(session.id)) {
      const { stub } = getSessionStoreBySessionId(input.env, session.id, input.tenantId);
      await stub.invalidateSessionRpc(session.id);
    }
  }
  if (sessions.length > 0) {
    const placeholders = sessions.map(() => '?').join(', ');
    await input.core.execute(
      `DELETE FROM sessions
        WHERE tenant_id = ? AND user_id = ? AND id IN (${placeholders})`,
      [input.tenantId, input.accountId, ...sessions.map((session) => session.id)]
    );
  }
}
