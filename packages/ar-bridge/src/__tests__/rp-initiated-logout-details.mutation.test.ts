/**
 * RP-initiated logout at an upstream provider: the answers, headers, logger and URI lists in detail.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { argRec } from './helpers/mock-args';

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
  moduleNames: [] as string[],
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
  getLogger: () => ({
    module: (name: string) => {
      mocks.moduleNames.push(name);
      return { warn: mocks.warn };
    },
  }),
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
  mocks.moduleNames.length = 0;
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

const FLOW_HEADER = 'X-Authrim-Diagnostic-Flow-Id';
const noStore = (response: Response) =>
  expect(response.headers.get('Cache-Control')).toBe('no-store');
const INVALID_CALLBACK = { error: 'invalid_logout_callback' };

describe('post-logout URI lists', () => {
  const askFor = (uri: string) => logout(`post_logout_redirect_uri=${encodeURIComponent(uri)}`);

  it('takes a JSON list written with leading whitespace', async () => {
    mocks.findByClientId.mockResolvedValue({
      post_logout_redirect_uris: '  ["https://rp.example/after"]',
    });
    expect((await askFor('https://rp.example/after')).status).toBe(302);
  });

  it.each([
    ['text that is not JSON', '[oops'],
    ['a JSON value that is not a list', '[]x'],
    ['an object', { a: 1 }],
    ['a number', 5],
    ['nothing', undefined],
  ])('registers nothing for %s', async (_n, uris) => {
    mocks.findByClientId.mockResolvedValue({ post_logout_redirect_uris: uris });
    const response = await askFor('Stryker was here!');
    expect(response.status).toBe(400);
  });

  it('keeps only the text entries of a list', async () => {
    mocks.findByClientId.mockResolvedValue({
      post_logout_redirect_uris: '[5, "https://rp.example/after", null]',
    });
    expect((await askFor('https://rp.example/after')).status).toBe(302);
    mocks.findByClientId.mockResolvedValue({ post_logout_redirect_uris: ['Stryker was here!'] });
    expect((await askFor('https://rp.example/other')).status).toBe(400);
  });
});

describe('the answers of the start', () => {
  it('logs under RP-INITIATED-LOGOUT and gives the provider a client with no credentials', async () => {
    await logout();
    expect(new Set(mocks.moduleNames)).toEqual(new Set(['RP-INITIATED-LOGOUT']));
    expect(mocks.fromProvider).toHaveBeenCalledWith(provider, '', '');
  });

  it('clears the local session cookie for the whole site, and ties the return cookie to https', async () => {
    const response = await logout();
    const cookies = response.headers.getSetCookie();
    const cleared = cookies.find((c) => c.startsWith('authrim_session='));
    expect(cleared).toContain('Path=/');
    expect(cleared).toMatch(/Max-Age=0|Expires=/);
    const bound = cookies.find((c) => c.startsWith('authrim_upstream_logout='));
    expect(bound).toContain('Secure');
    expect(bound).toContain('HttpOnly');
    expect(bound).toContain('SameSite=Lax');
  });

  it('reports a failed local session deletion as its own step', async () => {
    mocks.sessionFetch.mockResolvedValue(new Response(null, { status: 500 }));
    const response = await logout();
    expect(response.status).toBe(502);
    expect(mocks.warn).toHaveBeenCalledWith('RP-initiated logout operation failed', {
      operation: 'session_termination',
      error: 'session_store_delete_failed',
    });
  });

  it('records the kinds of session fields present when the provider does not match', async () => {
    mocks.getSession.mockResolvedValue({
      ...sessionRecord(),
      data: { external_idp: 'other', external_provider_id: 'other' },
    });
    await logout();
    expect(argRec(mocks.logAuthDecision).context).toMatchObject({
      session_provider_id_present: true,
      session_external_idp_present: true,
    });
    mocks.getSession.mockResolvedValue({ ...sessionRecord(), data: { external_provider_id: 'o' } });
    await logout();
    expect(argRec(mocks.logAuthDecision, 1).context).toMatchObject({
      session_provider_id_present: true,
      session_external_idp_present: false,
    });
  });

  it('names a missing client for a requested redirect', async () => {
    mocks.getSession.mockResolvedValue(sessionRecord({ client_id: undefined }));
    const response = await logout('post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fafter');
    expect(response.status).toBe(400);
    expect(argRec(mocks.logAuthDecision).context).toMatchObject({
      validation_error: 'unregistered_post_logout_redirect_uri',
    });
  });
});

describe('the answers of the return', () => {
  const challenge = (metadata: Record<string, unknown> = {}) => ({
    metadata: {
      provider_id: 'prov-1',
      target_uri: 'https://rp.example/after',
      op_state: 'op',
      ...metadata,
    },
  });
  beforeEach(() => mocks.consumeChallenge.mockResolvedValue(challenge()));

  it('logs under RP-INITIATED-LOGOUT and labels the flow of its diagnostics', async () => {
    await callback();
    expect(new Set(mocks.moduleNames)).toEqual(new Set(['RP-INITIATED-LOGOUT']));
    expect(argRec(mocks.logAuthDecision)).toMatchObject({ flow: 'rp_initiated_logout' });
  });

  it('labels the flow of a refusal too', async () => {
    mocks.consumeChallenge.mockResolvedValue(challenge({ provider_id: 'other' }));
    await callback();
    expect(argRec(mocks.logAuthDecision)).toMatchObject({
      flow: 'rp_initiated_logout',
      context: { validation_error: 'provider_mismatch' },
    });
  });

  it('answers every refusal with the same body, no-store and the flow id', async () => {
    const refusals: Array<() => Promise<Response>> = [
      async () => {
        mocks.getProvider.mockResolvedValue(null);
        return callback();
      },
      async () => {
        mocks.consumeChallenge.mockImplementation(async () => {
          throw new Error('gone');
        });
        return callback();
      },
      async () => {
        mocks.consumeChallenge.mockResolvedValue(challenge({ provider_id: 'other' }));
        return callback();
      },
      async () => {
        mocks.consumeChallenge.mockResolvedValue(challenge({ target_uri: 'not a url' }));
        return callback();
      },
    ];
    for (const refuse of refusals) {
      vi.clearAllMocks();
      mocks.getProvider.mockResolvedValue(provider);
      mocks.consumeChallenge.mockResolvedValue(challenge());
      const response = await refuse();
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID_CALLBACK);
      noStore(response);
      expect(response.headers.get(FLOW_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('carries the flow id of the start on a successful return', async () => {
    mocks.consumeChallenge.mockResolvedValue(challenge({ diagnostic_flow_id: 'flow-from-start' }));
    const response = await callback();
    expect(response.headers.get(FLOW_HEADER)).toBe('flow-from-start');
  });
});
