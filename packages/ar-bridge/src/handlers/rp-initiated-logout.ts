/** OpenID Connect RP-Initiated Logout for upstream identity providers. */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  buildIssuerUrl,
  createAuthContextFromHono,
  createDiagnosticLoggerFromContext,
  DIAGNOSTIC_FLOW_ID_HEADER,
  getChallengeStoreByChallengeId,
  getDiagnosticSessionId,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  getLogger,
  isShardedSessionId,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';

const LOGOUT_COOKIE = 'authrim_upstream_logout';
const LOGOUT_TTL_SECONDS = 10 * 60;

interface LogoutChallenge {
  metadata?: {
    provider_id?: string;
    target_uri?: string;
    application_state?: string;
    op_state?: string;
    diagnostic_session_id?: string;
    diagnostic_flow_id?: string;
  };
}

function callbackPath(provider: string): string {
  return `/auth/external/${encodeURIComponent(provider)}/logout/callback`;
}

function parseRedirectUris(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  if (!value.trim().startsWith('[')) return [value];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

async function resolveTargetUri(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientId: string | undefined,
  requested: string | undefined
): Promise<string> {
  const fallback = buildIssuerUrl(c.env, tenantId);
  if (!requested) return fallback;
  if (!clientId) throw new Error('session_missing_client');
  const auth = createAuthContextFromHono(c, tenantId);
  const client = await auth.repositories.client.findByClientId(clientId);
  if (!client || !parseRedirectUris(client.redirect_uris).includes(requested)) {
    throw new Error('unregistered_post_logout_redirect_uri');
  }
  return requested;
}

async function terminateLocalSession(
  env: Env,
  tenantId: string,
  sessionId: string,
  sessionStore: ReturnType<typeof getSessionStoreBySessionId>['stub']
): Promise<void> {
  const response = await sessionStore.fetch(
    new Request(`https://session-store/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  );
  if (!response.ok) throw new Error('session_store_delete_failed');
  try {
    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      `bridge-rp-initiated-logout:${tenantId}`,
      { tenantId }
    );
    await adapter.execute('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [
      sessionId,
      tenantId,
    ]);
  } catch {
    // The sharded SessionStore is authoritative; the D1 row is a lookup index.
  }
}

export async function handleRpInitiatedLogout(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('RP-INITIATED-LOGOUT');
  const tenantId = getTenantIdFromContext(c);
  const flowId = crypto.randomUUID();
  c.header(DIAGNOSTIC_FLOW_ID_HEADER, flowId);
  const providerName = c.req.param('provider');
  const sessionId = getCookie(c, 'authrim_session');
  if (!providerName || !sessionId || !isShardedSessionId(sessionId)) {
    return c.json({ error: 'login_required' }, 401, { 'Cache-Control': 'no-store' });
  }

  const provider = await getProviderByIdOrSlug(c.env, providerName, tenantId);
  if (!provider?.issuer) {
    return c.json({ error: 'unknown_provider' }, 404, { 'Cache-Control': 'no-store' });
  }
  const diagnostic = await createDiagnosticLoggerFromContext(c, {
    tenantId,
    clientId: provider.clientId,
  }).catch(() => null);
  const reject = async (validationError: string): Promise<void> => {
    await recordLogoutDiagnostic(log, () =>
      diagnostic?.logAuthDecision({
        diagnosticSessionId: getDiagnosticSessionId(c),
        flowId,
        decision: 'deny',
        reason: 'rp_initiated_logout_rejected',
        flow: 'rp_initiated_logout',
        context: { validation_error: validationError },
      })
    );
  };
  let operation = 'session_lookup';
  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
    const sessionData = session?.data;
    if (
      !session ||
      (sessionData?.external_provider_id !== provider.id &&
        sessionData?.external_idp !== provider.id)
    ) {
      await reject('session_provider_mismatch');
      return c.json({ error: 'login_required' }, 401, { 'Cache-Control': 'no-store' });
    }

    const encryptedIdToken = sessionData?.upstream_id_token_encrypted;
    const encryptionKey = getEncryptionKeyOrUndefined(c.env);
    if (typeof encryptedIdToken !== 'string' || !encryptionKey) {
      await reject('missing_upstream_id_token');
      return c.json({ error: 'upstream_logout_unavailable' }, 409, {
        'Cache-Control': 'no-store',
      });
    }
    operation = 'id_token_decryption';
    const idTokenHint = await decrypt(encryptedIdToken, encryptionKey);
    const targetUri = await resolveTargetUri(
      c,
      tenantId,
      typeof sessionData?.client_id === 'string' ? sessionData.client_id : undefined,
      c.req.query('post_logout_redirect_uri')
    ).catch(() => undefined);
    if (!targetUri) {
      await reject('unregistered_post_logout_redirect_uri');
      return c.json({ error: 'invalid_post_logout_redirect_uri' }, 400, {
        'Cache-Control': 'no-store',
      });
    }

    operation = 'provider_discovery';
    const client = OIDCRPClient.fromProvider(provider, '', '');
    const metadata = await client.discover();
    if (!metadata.end_session_endpoint) {
      await reject('missing_end_session_endpoint');
      return c.json({ error: 'end_session_endpoint_unavailable' }, 409, {
        'Cache-Control': 'no-store',
      });
    }

    const logoutId = crypto.randomUUID();
    const opState = crypto.randomUUID();
    const providerIdentifier = provider.slug || provider.id;
    const postLogoutCallback = new URL(
      callbackPath(providerIdentifier),
      buildIssuerUrl(c.env, tenantId)
    ).toString();
    operation = 'challenge_store';
    const challengeStore = await getChallengeStoreByChallengeId(c.env, logoutId, tenantId);
    await challengeStore.storeChallengeRpc({
      id: `upstream_logout:${logoutId}`,
      tenantId,
      type: 'upstream_logout',
      userId: session.userId,
      challenge: logoutId,
      ttl: LOGOUT_TTL_SECONDS,
      metadata: {
        provider_id: provider.id,
        target_uri: targetUri,
        application_state: c.req.query('state'),
        op_state: opState,
        diagnostic_session_id: getDiagnosticSessionId(c),
        diagnostic_flow_id: flowId,
      },
    });

    operation = 'session_termination';
    await terminateLocalSession(c.env, tenantId, sessionId, sessionStore);
    deleteCookie(c, 'authrim_session', { path: '/' });
    setCookie(c, LOGOUT_COOKIE, logoutId, {
      path: callbackPath(providerIdentifier),
      httpOnly: true,
      secure: postLogoutCallback.startsWith('https://'),
      sameSite: 'Lax',
      maxAge: LOGOUT_TTL_SECONDS,
    });

    const endSession = new URL(metadata.end_session_endpoint);
    endSession.searchParams.set('id_token_hint', idTokenHint);
    endSession.searchParams.set('post_logout_redirect_uri', postLogoutCallback);
    endSession.searchParams.set('state', opState);

    await recordLogoutDiagnostic(log, () =>
      diagnostic?.logAuthDecision({
        diagnosticSessionId: getDiagnosticSessionId(c),
        flowId,
        decision: 'allow',
        reason: 'rp_initiated_logout_redirect',
        flow: 'rp_initiated_logout',
        context: {
          provider: providerIdentifier,
          end_session_endpoint: `${endSession.origin}${endSession.pathname}`,
          post_logout_redirect_uri: postLogoutCallback,
          id_token_hint_present: true,
          state_present: true,
          post_logout_redirect_uri_registered: true,
        },
      })
    );

    return c.redirect(endSession.toString(), 302);
  } catch (error) {
    const validationError = `${operation}_failed`;
    await reject(validationError);
    log.warn('RP-initiated logout operation failed', {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: 'upstream_logout_failed' }, 502, { 'Cache-Control': 'no-store' });
  } finally {
    await cleanupLogoutDiagnostic(log, diagnostic);
  }
}

export async function handleRpInitiatedLogoutCallback(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const log = getLogger(c).module('RP-INITIATED-LOGOUT');
  const tenantId = getTenantIdFromContext(c);
  const flowId = crypto.randomUUID();
  c.header(DIAGNOSTIC_FLOW_ID_HEADER, flowId);
  const providerName = c.req.param('provider');
  const logoutId = getCookie(c, LOGOUT_COOKIE);
  if (!providerName || !logoutId) {
    return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
  }
  const provider = await getProviderByIdOrSlug(c.env, providerName, tenantId);
  if (!provider) {
    return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
  }
  const diagnostic = await createDiagnosticLoggerFromContext(c, {
    tenantId,
    clientId: provider.clientId,
  }).catch(() => null);
  const reject = async (validationError: string): Promise<void> => {
    await recordLogoutDiagnostic(log, () =>
      diagnostic?.logAuthDecision({
        diagnosticSessionId: getDiagnosticSessionId(c),
        flowId,
        decision: 'deny',
        reason: 'rp_initiated_logout_callback_rejected',
        flow: 'rp_initiated_logout',
        context: { validation_error: validationError },
      })
    );
  };
  try {
    const challengeStore = await getChallengeStoreByChallengeId(c.env, logoutId, tenantId);
    let challenge: LogoutChallenge;
    try {
      challenge = (await challengeStore.consumeChallengeRpc({
        id: `upstream_logout:${logoutId}`,
        tenantId,
        type: 'upstream_logout',
        challenge: logoutId,
      })) as LogoutChallenge;
    } catch {
      await reject('invalid_or_expired_logout_challenge');
      return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
    }
    if (challenge.metadata?.provider_id !== provider.id) {
      await reject('provider_mismatch');
      return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
    }

    deleteCookie(c, LOGOUT_COOKIE, { path: callbackPath(provider.slug || provider.id) });
    const target = challenge.metadata.target_uri || buildIssuerUrl(c.env, tenantId);
    const redirect = new URL(target);
    if (challenge.metadata.application_state) {
      redirect.searchParams.set('state', challenge.metadata.application_state);
    }
    const returnedState = c.req.query('state');
    const expectedState = challenge.metadata.op_state;
    const callbackDiagnosticSessionId = challenge.metadata.diagnostic_session_id;
    const callbackFlowId = challenge.metadata.diagnostic_flow_id || flowId;
    c.header(DIAGNOSTIC_FLOW_ID_HEADER, callbackFlowId);
    await recordLogoutDiagnostic(log, () =>
      diagnostic?.logAuthDecision({
        diagnosticSessionId: callbackDiagnosticSessionId || getDiagnosticSessionId(c),
        flowId: callbackFlowId,
        decision: 'allow',
        reason: 'rp_initiated_logout_callback_processed',
        flow: 'rp_initiated_logout',
        context: {
          browser_cookie_valid: true,
          provider_valid: true,
          op_state_status: !returnedState
            ? 'missing_accepted'
            : returnedState === expectedState
              ? 'matched'
              : 'unexpected_ignored',
        },
      })
    );
    return c.redirect(redirect.toString(), 302);
  } catch (error) {
    await reject('callback_processing_failed');
    log.warn('RP-initiated logout callback failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
  } finally {
    await cleanupLogoutDiagnostic(log, diagnostic);
  }
}

async function recordLogoutDiagnostic(
  log: ReturnType<ReturnType<typeof getLogger>['module']>,
  write: () => Promise<void> | undefined
): Promise<void> {
  try {
    await write();
  } catch (error) {
    log.warn('Failed to record RP-initiated logout diagnostic event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function cleanupLogoutDiagnostic(
  log: ReturnType<ReturnType<typeof getLogger>['module']>,
  diagnostic: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>>
): Promise<void> {
  try {
    await diagnostic?.cleanup();
  } catch (error) {
    log.warn('Failed to flush RP-initiated logout diagnostic events', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
