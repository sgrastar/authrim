/**
 * RP-initiated logout at an upstream provider: each refusal, what is stored and sent, and the
 * return from the provider.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { argRec, callArg, rec } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sessionFetch: vi.fn(),
  storeChallenge: vi.fn(),
  consumeChallenge: vi.fn(),
  getChallengeStore: vi.fn(),
  findByClientId: vi.fn(),
  discover: vi.fn(),
  fromProvider: vi.fn(),
  getProvider: vi.fn(),
  decrypt: vi.fn(),
  getKey: vi.fn(),
  createDiag: vi.fn(),
  logAuthDecision: vi.fn(),
  cleanup: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  buildIssuerUrl: () => 'https://tenant.example',
  createAuthContextFromHono: () => ({
    repositories: { client: { findByClientId: mocks.findByClientId } },
  }),
  createDiagnosticLoggerFromContext: mocks.createDiag,
  getChallengeStoreByChallengeId: mocks.getChallengeStore,
  getDiagnosticSessionId: () => 'diag-session',
  getSessionStoreBySessionId: () => ({
    stub: { getSessionRpc: mocks.getSession, fetch: mocks.sessionFetch },
  }),
  getTenantIdFromContext: () => 'tenant-1',
  getLogger: () => ({ module: () => ({ warn: mocks.warn }) }),
  isShardedSessionId: (id: string) => id.startsWith('0_'),
}));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));
vi.mock('../clients/oidc-client', () => ({ OIDCRPClient: { fromProvider: mocks.fromProvider } }));
vi.mock('../utils/crypto', () => ({
  decrypt: mocks.decrypt,
  getEncryptionKeyOrUndefined: mocks.getKey,
}));

import {
  handleRpInitiatedLogout,
  handleRpInitiatedLogoutCallback,
} from '../handlers/rp-initiated-logout';

const ENV = {} as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/:provider/logout', handleRpInitiatedLogout);
  instance.get('/auth/external/:provider/logout/callback', handleRpInitiatedLogoutCallback);
  instance.get('/logout', handleRpInitiatedLogout);
  instance.get('/logout/callback', handleRpInitiatedLogoutCallback);
  return instance;
}
const call = (path: string, cookie?: string) =>
  Promise.resolve(
    app().request(
      `https://tenant.example${path}`,
      cookie ? { headers: { Cookie: cookie } } : {},
      ENV
    )
  );
const logout = (query = '', cookie: string | undefined = 'authrim_session=0_session-1') =>
  call(`/auth/external/suite/logout${query ? `?${query}` : ''}`, cookie);
const callback = (query = '', cookie: string | undefined = 'authrim_upstream_logout=logout-1') =>
  call(`/auth/external/suite/logout/callback${query ? `?${query}` : ''}`, cookie);

const provider = {
  id: 'prov-1',
  slug: 'suite',
  issuer: 'https://op.example',
  clientId: 'upstream-client',
};
const sessionRecord = (data: Record<string, unknown> = {}) => ({
  id: '0_session-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  data: {
    client_id: 'client-a',
    external_provider_id: 'prov-1',
    upstream_id_token_encrypted: 'enc-id-token',
    ...data,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProvider.mockResolvedValue(provider);
  mocks.getKey.mockReturnValue('key');
  mocks.decrypt.mockResolvedValue('upstream.id.token');
  mocks.getSession.mockResolvedValue(sessionRecord());
  mocks.sessionFetch.mockResolvedValue(new Response(null, { status: 204 }));
  mocks.findByClientId.mockResolvedValue({
    redirect_uris: '["https://rp.example/signin"]',
    post_logout_redirect_uris: '["https://rp.example/after"]',
  });
  mocks.fromProvider.mockReturnValue({ discover: mocks.discover });
  mocks.discover.mockResolvedValue({ end_session_endpoint: 'https://op.example/end-session' });
  mocks.getChallengeStore.mockResolvedValue({
    storeChallengeRpc: mocks.storeChallenge,
    consumeChallengeRpc: mocks.consumeChallenge,
  });
  mocks.storeChallenge.mockResolvedValue(undefined);
  mocks.createDiag.mockResolvedValue({
    logAuthDecision: mocks.logAuthDecision,
    cleanup: mocks.cleanup,
  });
  mocks.logAuthDecision.mockResolvedValue(undefined);
  mocks.cleanup.mockResolvedValue(undefined);
});

const noStore = (response: Response) =>
  expect(response.headers.get('Cache-Control')).toBe('no-store');
const deny = (reason: string) =>
  expect(argRec(mocks.logAuthDecision)).toMatchObject({
    decision: 'deny',
    reason: 'rp_initiated_logout_rejected',
    flow: 'rp_initiated_logout',
    context: { validation_error: reason },
  });

describe('starting the logout', () => {
  it('ends the local session and redirects to the provider end-session endpoint', async () => {
    const response = await logout(
      'post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter&state=app-state'
    );
    expect(response.status).toBe(302);
    const location = new URL(String(response.headers.get('Location')));
    expect(location.origin + location.pathname).toBe('https://op.example/end-session');
    const stored = argRec(mocks.storeChallenge);
    const metadata = rec(stored.metadata);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      id_token_hint: 'upstream.id.token',
      post_logout_redirect_uri: 'https://tenant.example/auth/external/suite/logout/callback',
      state: String(metadata.op_state),
    });
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toBe(metadata.diagnostic_flow_id);
    expect(decryptedWith()).toEqual(['enc-id-token', 'key']);
  });

  const decryptedWith = () => [callArg(mocks.decrypt, 0, 0), callArg(mocks.decrypt, 0, 1)];

  it('stores a ten minute challenge naming provider, target, state and diagnostics', async () => {
    await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter&state=app-state');
    const stored = argRec(mocks.storeChallenge);
    const { id, challenge, metadata, ...rest } = stored;
    expect(rest).toEqual({
      tenantId: 'tenant-1',
      type: 'upstream_logout',
      userId: 'user-1',
      ttl: 600,
    });
    expect(String(id)).toBe(`upstream_logout:${String(challenge)}`);
    expect(challenge).toMatch(/^[0-9a-f-]{36}$/);
    expect(callArg(mocks.getChallengeStore, 0, 1)).toBe(challenge);
    expect(rec(metadata)).toMatchObject({
      provider_id: 'prov-1',
      target_uri: 'https://rp.example/after',
      application_state: 'app-state',
      diagnostic_session_id: 'diag-session',
    });
    expect(rec(metadata).op_state).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec(metadata).op_state).not.toBe(challenge);
  });

  it('deletes the local session, clears its cookie and sets the return cookie', async () => {
    const response = await logout();
    expect(response.status).toBe(302);
    const request = callArg(mocks.sessionFetch, 0, 0);
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).method).toBe('DELETE');
    expect((request as Request).url).toBe('https://session-store/session/0_session-1');
    const cookies = response.headers.getSetCookie();
    const cleared = cookies.find((cookie) => cookie.startsWith('authrim_session='));
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    const ret = String(cookies.find((cookie) => cookie.startsWith('authrim_upstream_logout=')));
    expect(ret).toContain(
      `authrim_upstream_logout=${String(argRec(mocks.storeChallenge).challenge)}`
    );
    expect(ret).toContain('Path=/auth/external/suite/logout/callback');
    expect(ret).toContain('HttpOnly');
    expect(ret).toContain('Secure');
    expect(ret).toContain('SameSite=Lax');
    expect(ret).toContain('Max-Age=600');
  });

  it('falls back to the issuer URL as the target and to the provider id in the paths', async () => {
    mocks.getProvider.mockResolvedValue({ ...provider, slug: undefined });
    const response = await logout();
    expect(response.status).toBe(302);
    expect(rec(argRec(mocks.storeChallenge).metadata).target_uri).toBe('https://tenant.example');
    expect(rec(argRec(mocks.storeChallenge).metadata).application_state).toBeUndefined();
    const location = new URL(String(response.headers.get('Location')));
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://tenant.example/auth/external/prov-1/logout/callback'
    );
  });

  it('accepts a session made through external_idp instead of external_provider_id', async () => {
    mocks.getSession.mockResolvedValue(
      sessionRecord({ external_provider_id: undefined, external_idp: 'prov-1' })
    );
    expect((await logout()).status).toBe(302);
  });

  it('records the redirect in the diagnostics and cleans up', async () => {
    await logout();
    expect(argRec(mocks.logAuthDecision)).toMatchObject({
      diagnosticSessionId: 'diag-session',
      decision: 'allow',
      reason: 'rp_initiated_logout_redirect',
      flow: 'rp_initiated_logout',
      context: {
        provider: 'suite',
        end_session_endpoint: 'https://op.example/end-session',
        post_logout_redirect_uri: 'https://tenant.example/auth/external/suite/logout/callback',
        id_token_hint_present: true,
        state_present: true,
        post_logout_redirect_uri_registered: true,
      },
    });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  describe('post-logout redirect URIs', () => {
    it('accepts a registered post-logout URI for a disabled client too, as ar-auth does', async () => {
      mocks.findByClientId.mockResolvedValue({
        enabled: false,
        post_logout_redirect_uris: '["https://rp.example/after"]',
      });
      expect(
        (await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter')).status
      ).toBe(302);
    });

    it.each([
      ['a JSON list', '["https://rp.example/other","https://rp.example/after"]'],
      ['a single URI', 'https://rp.example/after'],
      ['an array', ['https://rp.example/after', 5]],
    ])('accepts a registered one from %s', async (_name, redirectUris) => {
      mocks.findByClientId.mockResolvedValue({ post_logout_redirect_uris: redirectUris });
      const response = await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter');
      expect(response.status).toBe(302);
    });

    it.each([
      ['an unregistered one', { post_logout_redirect_uris: '["https://rp.example/other"]' }],
      [
        'one registered only as a login redirect URI',
        { redirect_uris: '["https://rp.example/after"]' },
      ],
      [
        'one registered only as a login redirect URI of a disabled client',
        { enabled: false, redirect_uris: '["https://rp.example/after"]' },
      ],
      ['no such client', null],
      ['a malformed list', { post_logout_redirect_uris: '[oops' }],
      ['a non-list JSON value', { post_logout_redirect_uris: '[]x' }],
      ['an object list', { post_logout_redirect_uris: { a: 1 } }],
    ])('refuses %s with 400', async (_name, client) => {
      mocks.findByClientId.mockResolvedValue(client);
      const response = await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_post_logout_redirect_uri' });
      noStore(response);
      deny('unregistered_post_logout_redirect_uri');
      expect(mocks.sessionFetch).not.toHaveBeenCalled();
      expect(mocks.storeChallenge).not.toHaveBeenCalled();
    });

    it('refuses a redirect when the session names no client', async () => {
      mocks.getSession.mockResolvedValue(sessionRecord({ client_id: undefined }));
      const response = await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter');
      expect(response.status).toBe(400);
      mocks.getSession.mockResolvedValue(sessionRecord({ client_id: 5 }));
      expect(
        (await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter')).status
      ).toBe(400);
      expect(mocks.findByClientId).not.toHaveBeenCalled();
    });

    it('does not look up the client when no redirect is asked for', async () => {
      mocks.getSession.mockResolvedValue(sessionRecord({ client_id: undefined }));
      expect((await logout()).status).toBe(302);
      expect(mocks.findByClientId).not.toHaveBeenCalled();
    });
  });

  describe('refusals', () => {
    it.each([
      ['no cookie', undefined, '/auth/external/suite/logout'],
      ['an unsharded session id', 'authrim_session=plain-session', '/auth/external/suite/logout'],
      ['no provider in the route', 'authrim_session=0_session-1', '/logout'],
    ])('answers 401 for %s', async (_name, cookie, path) => {
      const response = await call(path, cookie);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'login_required' });
      noStore(response);
      expect(mocks.getProvider).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown provider or one without an issuer', async () => {
      mocks.getProvider.mockResolvedValue(null);
      const response = await logout();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'unknown_provider' });
      noStore(response);
      mocks.getProvider.mockResolvedValue({ ...provider, issuer: undefined });
      expect((await logout()).status).toBe(404);
      expect(mocks.getSession).not.toHaveBeenCalled();
    });

    it('answers 401 when the session is missing or belongs to another provider', async () => {
      for (const found of [null, sessionRecord({ external_provider_id: 'other' })]) {
        mocks.getSession.mockResolvedValue(found);
        mocks.logAuthDecision.mockClear();
        const response = await logout();
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'login_required' });
        noStore(response);
        deny('session_provider_mismatch');
      }
      mocks.logAuthDecision.mockClear();
      mocks.getSession.mockResolvedValue(
        sessionRecord({ external_provider_id: 'other', external_idp: 5 })
      );
      await logout();
      expect(rec(argRec(mocks.logAuthDecision).context)).toEqual({
        validation_error: 'session_provider_mismatch',
        provider_id_present: true,
        session_present: true,
        session_tenant_match: true,
        session_provider_id_present: true,
        session_external_idp_present: false,
      });
      expect(mocks.sessionFetch).not.toHaveBeenCalled();
    });

    it('describes a missing session without leaking it', async () => {
      mocks.getSession.mockResolvedValue(null);
      await logout();
      expect(rec(argRec(mocks.logAuthDecision).context)).toMatchObject({
        session_present: false,
        session_tenant_match: false,
        session_provider_id_present: false,
        session_external_idp_present: false,
      });
    });

    it('answers 409 without the upstream ID token or the encryption key', async () => {
      mocks.getSession.mockResolvedValue(sessionRecord({ upstream_id_token_encrypted: undefined }));
      let response = await logout();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'upstream_logout_unavailable' });
      noStore(response);
      deny('missing_upstream_id_token');
      mocks.getSession.mockResolvedValue(sessionRecord());
      mocks.getKey.mockReturnValue(undefined);
      response = await logout();
      expect(response.status).toBe(409);
      expect(mocks.decrypt).not.toHaveBeenCalled();
    });

    it('answers 409 when the provider has no end-session endpoint', async () => {
      mocks.discover.mockResolvedValue({});
      const response = await logout();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'end_session_endpoint_unavailable' });
      noStore(response);
      deny('missing_end_session_endpoint');
      expect(mocks.storeChallenge).not.toHaveBeenCalled();
      expect(mocks.sessionFetch).not.toHaveBeenCalled();
    });

    it.each([
      ['id_token_decryption', () => mocks.decrypt.mockRejectedValue(new Error('bad key'))],
      ['provider_discovery', () => mocks.discover.mockRejectedValue(new Error('offline'))],
      ['challenge_store', () => mocks.storeChallenge.mockRejectedValue(new Error('store down'))],
      [
        'session_termination',
        () => mocks.sessionFetch.mockResolvedValue(new Response(null, { status: 500 })),
      ],
    ])('answers 502 when %s fails, naming the step', async (step, arrange) => {
      arrange();
      const response = await logout();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'upstream_logout_failed' });
      noStore(response);
      deny(`${step}_failed`);
      const warned = argRec(mocks.warn, 0, 1);
      expect(callArg(mocks.warn, 0, 0)).toBe('RP-initiated logout operation failed');
      expect(warned.operation).toBe(step);
      expect(typeof warned.error).toBe('string');
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    });

    it('names the session lookup when it fails and stringifies other failures', async () => {
      mocks.getSession.mockRejectedValue('plain failure');
      expect((await logout()).status).toBe(502);
      deny('session_lookup_failed');
      expect(rec(argRec(mocks.warn, 0, 1))).toEqual({
        operation: 'session_lookup',
        error: 'plain failure',
      });
    });
  });

  it('survives failing diagnostics', async () => {
    mocks.logAuthDecision.mockRejectedValue(new Error('diag down'));
    mocks.cleanup.mockRejectedValue(new Error('flush failed'));
    expect((await logout()).status).toBe(302);
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to record RP-initiated logout diagnostic event',
      {
        error: 'diag down',
      }
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to flush RP-initiated logout diagnostic events',
      {
        error: 'flush failed',
      }
    );
    mocks.logAuthDecision.mockRejectedValue('text');
    mocks.cleanup.mockRejectedValue('text');
    mocks.warn.mockClear();
    await logout();
    expect(rec(argRec(mocks.warn, 0, 1))).toEqual({ error: 'text' });
    mocks.createDiag.mockRejectedValue(new Error('no logger'));
    expect((await logout()).status).toBe(302);
  });
});

describe('returning from the provider', () => {
  const challenge = (metadata: Record<string, unknown> = {}) => ({
    metadata: {
      provider_id: 'prov-1',
      target_uri: 'https://rp.example/after',
      application_state: 'app-state',
      op_state: 'op-state-1',
      diagnostic_session_id: 'diag-from-start',
      diagnostic_flow_id: 'flow-from-start',
      ...metadata,
    },
  });

  beforeEach(() => mocks.consumeChallenge.mockResolvedValue(challenge()));

  it('consumes the challenge and redirects to the target with the application state', async () => {
    const response = await callback('state=op-state-1');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://rp.example/after?state=app-state');
    expect(argRec(mocks.consumeChallenge)).toEqual({
      id: 'upstream_logout:logout-1',
      tenantId: 'tenant-1',
      type: 'upstream_logout',
      challenge: 'logout-1',
    });
    expect(callArg(mocks.getChallengeStore, 0, 1)).toBe('logout-1');
    expect(callArg(mocks.getChallengeStore, 0, 2)).toBe('tenant-1');
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toBe('flow-from-start');
    expect(response.headers.getSetCookie().join(';')).toContain('authrim_upstream_logout=;');
    expect(response.headers.getSetCookie().join(';')).toContain(
      'Path=/auth/external/suite/logout/callback'
    );
  });

  it('adds no state when the application sent none, and falls back to the issuer URL', async () => {
    mocks.consumeChallenge.mockResolvedValue(
      challenge({ application_state: undefined, target_uri: undefined })
    );
    const response = await callback();
    expect(response.headers.get('Location')).toBe('https://tenant.example/');
  });

  it('records how the provider state compared', async () => {
    for (const [query, status] of [
      ['state=op-state-1', 'matched'],
      ['state=other', 'unexpected_ignored'],
      ['', 'missing_accepted'],
    ] as const) {
      mocks.logAuthDecision.mockClear();
      await callback(query);
      expect(argRec(mocks.logAuthDecision)).toEqual({
        diagnosticSessionId: 'diag-from-start',
        flowId: 'flow-from-start',
        decision: 'allow',
        reason: 'rp_initiated_logout_callback_processed',
        flow: 'rp_initiated_logout',
        context: { browser_cookie_valid: true, provider_valid: true, op_state_status: status },
      });
    }
  });

  it('uses this request diagnostics when the challenge carries none', async () => {
    mocks.consumeChallenge.mockResolvedValue(
      challenge({ diagnostic_session_id: undefined, diagnostic_flow_id: undefined })
    );
    const response = await callback();
    expect(argRec(mocks.logAuthDecision).diagnosticSessionId).toBe('diag-session');
    expect(argRec(mocks.logAuthDecision).flowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toBe(
      argRec(mocks.logAuthDecision).flowId
    );
  });

  it.each([
    ['no cookie', undefined, '/auth/external/suite/logout/callback'],
    ['no provider in the route', 'authrim_upstream_logout=logout-1', '/logout/callback'],
  ])('answers 400 for %s', async (_name, cookie, path) => {
    const response = await call(path, cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_logout_callback' });
    noStore(response);
    expect(mocks.consumeChallenge).not.toHaveBeenCalled();
  });

  it('answers 400 for an unknown provider, an unusable challenge or another provider', async () => {
    mocks.getProvider.mockResolvedValue(null);
    expect((await callback()).status).toBe(400);
    mocks.getProvider.mockResolvedValue(provider);
    mocks.consumeChallenge.mockRejectedValue(new Error('gone'));
    let response = await callback();
    expect(response.status).toBe(400);
    expect(argRec(mocks.logAuthDecision)).toMatchObject({
      reason: 'rp_initiated_logout_callback_rejected',
      context: { validation_error: 'invalid_or_expired_logout_challenge' },
    });
    mocks.logAuthDecision.mockClear();
    mocks.consumeChallenge.mockResolvedValue(challenge({ provider_id: 'other' }));
    response = await callback();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_logout_callback' });
    expect(argRec(mocks.logAuthDecision).context).toEqual({
      validation_error: 'provider_mismatch',
    });
    expect(response.headers.get('Location')).toBeNull();
  });

  it('answers 400 when the stored target is not a URL, recording the failure', async () => {
    mocks.consumeChallenge.mockResolvedValue(challenge({ target_uri: 'not a url' }));
    const response = await callback();
    expect(response.status).toBe(400);
    expect(argRec(mocks.logAuthDecision).context).toEqual({
      validation_error: 'callback_processing_failed',
    });
    expect(callArg(mocks.warn, 0, 0)).toBe('RP-initiated logout callback failed');
    expect(typeof argRec(mocks.warn, 0, 1).error).toBe('string');
    mocks.getChallengeStore.mockRejectedValue('plain');
    mocks.warn.mockClear();
    await callback();
    expect(rec(argRec(mocks.warn, 0, 1))).toEqual({ error: 'plain' });
    expect(mocks.cleanup).toHaveBeenCalled();
  });

  it('survives failing diagnostics', async () => {
    mocks.logAuthDecision.mockRejectedValue(new Error('diag down'));
    mocks.cleanup.mockRejectedValue(new Error('flush failed'));
    expect((await callback()).status).toBe(302);
    mocks.createDiag.mockRejectedValue(new Error('no logger'));
    expect((await callback()).status).toBe(302);
  });
});
