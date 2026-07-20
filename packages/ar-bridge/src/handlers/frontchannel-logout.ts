/** OpenID Connect Front-Channel Logout 1.0 endpoint for upstream OPs. */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createDiagnosticLoggerFromContext,
  DIAGNOSTIC_FLOW_ID_HEADER,
  getDiagnosticSessionId,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  isShardedSessionId,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';

export async function handleFrontchannelLogout(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('FRONTCHANNEL-LOGOUT');
  const tenantId = getTenantIdFromContext(c);
  const flowId = crypto.randomUUID();
  c.header(DIAGNOSTIC_FLOW_ID_HEADER, flowId);
  const providerName = c.req.param('provider');
  const issuer = c.req.query('iss');
  const sid = c.req.query('sid');
  const provider = providerName
    ? await getProviderByIdOrSlug(c.env, providerName, tenantId)
    : undefined;
  let diagnostic: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>> = null;

  if (provider) {
    diagnostic = await createDiagnosticLoggerFromContext(c, {
      tenantId,
      clientId: provider.clientId,
    }).catch(() => null);
  }

  try {
    if (!provider?.issuer || issuer !== provider.issuer || !sid) {
      await diagnostic
        ?.logAuthDecision({
          diagnosticSessionId: getDiagnosticSessionId(c),
          flowId,
          decision: 'deny',
          reason: 'frontchannel_logout_rejected',
          flow: 'frontchannel_logout',
          context: {
            validation_error: !provider?.issuer
              ? 'unknown_provider'
              : !sid
                ? 'missing_sid'
                : 'issuer_mismatch',
          },
        })
        .catch(() => undefined);
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
    let terminationFailures = 0;
    for (const session of sessions) {
      try {
        if (isShardedSessionId(session.id)) {
          const { stub } = getSessionStoreBySessionId(c.env, session.id, tenantId);
          const response = await stub.fetch(
            new Request(`https://session-store/session/${encodeURIComponent(session.id)}`, {
              method: 'DELETE',
            })
          );
          if (!response.ok) {
            terminationFailures++;
            continue;
          }
        }
        await adapter.execute('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [
          session.id,
          tenantId,
        ]);
        terminated++;
      } catch {
        terminationFailures++;
      }
    }
    if (terminationFailures > 0) throw new Error('session_invalidation_failed');

    await diagnostic
      ?.logAuthDecision({
        diagnosticSessionId: getDiagnosticSessionId(c),
        flowId,
        decision: 'allow',
        reason: 'frontchannel_logout_processed',
        flow: 'frontchannel_logout',
        context: {
          issuer_valid: true,
          sid_present: true,
          sessions_terminated: terminated,
        },
      })
      .catch(() => undefined);

    return new Response('<!doctype html><title>Logout complete</title>', {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors *",
      },
    });
  } catch (error) {
    await diagnostic
      ?.logAuthDecision({
        diagnosticSessionId: getDiagnosticSessionId(c),
        flowId,
        decision: 'deny',
        reason: 'frontchannel_logout_rejected',
        flow: 'frontchannel_logout',
        context: { validation_error: 'session_invalidation_failed' },
      })
      .catch(() => undefined);
    log.warn('Front-channel logout session invalidation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('Front-channel logout failed', {
      status: 500,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  } finally {
    await diagnostic?.cleanup().catch(() => undefined);
  }
}
