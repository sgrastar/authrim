/** OpenID Connect Front-Channel Logout 1.0 endpoint for upstream OPs. */

import type { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  createDiagnosticLoggerFromContext,
  DIAGNOSTIC_FLOW_ID_HEADER,
  getDiagnosticSessionId,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  isShardedSessionId,
  listExternalProviderSessions,
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

    const sessions = await listExternalProviderSessions(c.env, {
      tenantId,
      providerId: provider.id,
      claimKind: 'sid',
      claim: sid,
    });
    let terminated = 0;
    let terminationFailures = 0;
    for (const session of sessions) {
      try {
        if (!isShardedSessionId(session.sessionId)) continue;
        const { stub } = getSessionStoreBySessionId(c.env, session.sessionId, tenantId);
        const current = (await stub.getSessionRpc(session.sessionId)) as Session | null;
        if (
          !current ||
          current.tenantId !== tenantId ||
          current.data?.external_provider_id !== provider.id ||
          current.data?.external_provider_sid !== sid
        ) {
          continue;
        }
        if (!(await stub.invalidateSessionRpc(session.sessionId))) {
          terminationFailures++;
          continue;
        }
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
      errorType: error instanceof Error ? error.name : 'UnknownError',
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
