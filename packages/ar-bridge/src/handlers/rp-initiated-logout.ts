/** OpenID Connect RP-Initiated Logout for upstream identity providers. */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  buildIssuerUrl,
  createAuthContextFromHono,
  createDiagnosticLoggerFromContext,
  getChallengeStoreByChallengeId,
  getDiagnosticSessionId,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
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
  await sessionStore.fetch(
    new Request(`https://session-store/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  );
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
  const tenantId = getTenantIdFromContext(c);
  const providerName = c.req.param('provider');
  const sessionId = getCookie(c, 'authrim_session');
  if (!providerName || !sessionId || !isShardedSessionId(sessionId)) {
    return c.json({ error: 'login_required' }, 401, { 'Cache-Control': 'no-store' });
  }

  const provider = await getProviderByIdOrSlug(c.env, providerName, tenantId);
  if (!provider?.issuer) {
    return c.json({ error: 'unknown_provider' }, 404, { 'Cache-Control': 'no-store' });
  }
  const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
  const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
  const sessionData = session?.data;
  if (
    !session ||
    (sessionData?.external_provider_id !== provider.id && sessionData?.external_idp !== provider.id)
  ) {
    return c.json({ error: 'login_required' }, 401, { 'Cache-Control': 'no-store' });
  }

  const encryptedIdToken = sessionData?.upstream_id_token_encrypted;
  const encryptionKey = getEncryptionKeyOrUndefined(c.env);
  if (typeof encryptedIdToken !== 'string' || !encryptionKey) {
    return c.json({ error: 'upstream_logout_unavailable' }, 409, {
      'Cache-Control': 'no-store',
    });
  }
  const idTokenHint = await decrypt(encryptedIdToken, encryptionKey);
  const targetUri = await resolveTargetUri(
    c,
    tenantId,
    typeof sessionData?.client_id === 'string' ? sessionData.client_id : undefined,
    c.req.query('post_logout_redirect_uri')
  ).catch(() => undefined);
  if (!targetUri) {
    return c.json({ error: 'invalid_post_logout_redirect_uri' }, 400, {
      'Cache-Control': 'no-store',
    });
  }

  const client = OIDCRPClient.fromProvider(provider, '', '');
  const metadata = await client.discover();
  if (!metadata.end_session_endpoint) {
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
    },
  });

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

  const diagnostic = await createDiagnosticLoggerFromContext(c, {
    tenantId,
    clientId: provider.clientId,
  });
  if (diagnostic) {
    await diagnostic.logAuthDecision({
      diagnosticSessionId: getDiagnosticSessionId(c),
      decision: 'allow',
      reason: 'rp_initiated_logout_redirect',
      flow: 'external_idp',
      context: {
        provider: providerIdentifier,
        end_session_endpoint: `${endSession.origin}${endSession.pathname}`,
        post_logout_redirect_uri: postLogoutCallback,
      },
    });
    await diagnostic.cleanup();
  }

  return c.redirect(endSession.toString(), 302);
}

export async function handleRpInitiatedLogoutCallback(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const providerName = c.req.param('provider');
  const logoutId = getCookie(c, LOGOUT_COOKIE);
  if (!providerName || !logoutId) {
    return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
  }
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
    return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
  }
  const provider = await getProviderByIdOrSlug(c.env, providerName, tenantId);
  if (!provider || challenge.metadata?.provider_id !== provider.id) {
    return c.json({ error: 'invalid_logout_callback' }, 400, { 'Cache-Control': 'no-store' });
  }

  deleteCookie(c, LOGOUT_COOKIE, { path: callbackPath(provider.slug || provider.id) });
  const target = challenge.metadata.target_uri || buildIssuerUrl(c.env, tenantId);
  const redirect = new URL(target);
  if (challenge.metadata.application_state) {
    redirect.searchParams.set('state', challenge.metadata.application_state);
  }
  return c.redirect(redirect.toString(), 302);
}
