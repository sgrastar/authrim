/** OpenID Connect Front-Channel Logout 1.0 endpoint for upstream OPs. */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createDiagnosticLoggerFromContext,
  getDiagnosticSessionId,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  isShardedSessionId,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';

export async function handleFrontchannelLogout(c: Context<{ Bindings: Env }>): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const providerName = c.req.param('provider');
  const issuer = c.req.query('iss');
  const sid = c.req.query('sid');
  const provider = providerName
    ? await getProviderByIdOrSlug(c.env, providerName, tenantId)
    : undefined;

  if (!provider?.issuer || issuer !== provider.issuer || !sid) {
    return new Response('Invalid front-channel logout request', {
      status: 400,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    c.env,
    `bridge-frontchannel-logout:${tenantId}`,
    { tenantId }
  );
  const sessions = await adapter.query<{ id: string }>(
    `SELECT id FROM sessions
     WHERE tenant_id = ? AND external_provider_id = ? AND external_provider_sid = ?`,
    [tenantId, provider.id, sid]
  );
  let terminated = 0;
  for (const session of sessions) {
    if (!isShardedSessionId(session.id)) continue;
    try {
      const { stub } = getSessionStoreBySessionId(c.env, session.id, tenantId);
      const response = await stub.fetch(
        new Request(`https://session-store/session/${encodeURIComponent(session.id)}`, {
          method: 'DELETE',
        })
      );
      if (response.ok) terminated++;
    } catch {
      // Continue terminating other matching sessions.
    }
  }
  await adapter.execute(
    `DELETE FROM sessions
     WHERE tenant_id = ? AND external_provider_id = ? AND external_provider_sid = ?`,
    [tenantId, provider.id, sid]
  );

  const diagnostic = await createDiagnosticLoggerFromContext(c, {
    tenantId,
    clientId: provider.clientId,
  });
  if (diagnostic) {
    await diagnostic.logAuthDecision({
      diagnosticSessionId: getDiagnosticSessionId(c),
      decision: 'allow',
      reason: 'frontchannel_logout_processed',
      flow: 'external_idp',
      context: { sessions_terminated: terminated },
    });
    await diagnostic.cleanup();
  }

  return new Response('<!doctype html><title>Logout complete</title>', {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors *",
    },
  });
}
