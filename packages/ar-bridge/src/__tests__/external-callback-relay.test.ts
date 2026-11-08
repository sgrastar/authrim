/**
 * A provider's form post (`response_mode=form_post`, Sign in with Apple) for a tenant whose
 * sign-ins start on its primary custom domain, while the redirect URI registered at the provider
 * names the platform issuer host.
 *
 * On the platform issuer host the callback only keeps the answer for the sign-in still waiting for
 * it and sends the browser on (303) to the same callback on the custom domain, with a one-time
 * handle. There the handle is taken only by the browser that started the sign-in (its state
 * cookie), and the callback goes on with every check it makes: for a link, the session and user
 * that asked for it; for a lite sign-in, its return to the lite callback page.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession, Env } from '@authrim/ar-lib-core';
import type { ExternalIdpAuthState, UpstreamProvider } from '../types';

interface StoredChallenge {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  challenge: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

/** An in-memory model of the ChallengeStore's one-time semantics. */
const challenges = vi.hoisted(() => {
  const entries = new Map<string, StoredChallenge>();
  const store = {
    storeChallengeRpc: async (request: {
      id: string;
      tenantId: string;
      type: string;
      userId: string;
      challenge: string;
      ttl: number;
      metadata?: Record<string, unknown>;
    }) => {
      const now = Date.now();
      entries.set(request.id, {
        id: request.id,
        tenantId: request.tenantId,
        type: request.type,
        userId: request.userId,
        challenge: request.challenge,
        metadata: request.metadata,
        createdAt: now,
        expiresAt: now + request.ttl * 1000,
        consumed: false,
      });
      return { success: true };
    },
    claimChallengeRpc: async (request: {
      id: string;
      tenantId: string;
      type: string;
      userId: string;
      challenge: string;
      ttl: number;
    }) => {
      const held = entries.get(request.id);
      if (held && !held.consumed && held.expiresAt > Date.now()) return { claimed: false };
      await store.storeChallengeRpc(request);
      return { claimed: true };
    },
    getChallengeRpc: async (id: string) => {
      const entry = entries.get(id);
      return entry ? structuredClone(entry) : null;
    },
    consumeChallengeRpc: async (request: {
      id: string;
      tenantId: string;
      type: string;
      challenge?: string;
    }) => {
      const entry = entries.get(request.id);
      if (!entry || entry.consumed) throw new Error('Challenge not found or already consumed');
      if (entry.type !== request.type || entry.tenantId !== request.tenantId) {
        throw new Error('Challenge mismatch');
      }
      if (entry.expiresAt <= Date.now()) throw new Error('Challenge expired');
      if (request.challenge && entry.challenge !== request.challenge) {
        throw new Error('Challenge value mismatch');
      }
      entry.consumed = true;
      return {
        challenge: entry.challenge,
        userId: entry.userId,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      };
    },
    deleteChallengeRpc: async (id: string) => ({ deleted: entries.delete(id) }),
  };
  return { entries, store };
});

const mocks = vi.hoisted(() => ({
  readAccountSession: vi.fn(),
  consumeAuthState: vi.fn(),
  isPendingAuthState: vi.fn(),
  getProvider: vi.fn(),
  handleIdentity: vi.fn(),
  recordActivity: vi.fn(),
  exchangeCode: vi.fn(),
  fetchUserInfo: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAccountSession: mocks.readAccountSession,
    getChallengeStoreByChallengeId: vi.fn(async () => challenges.store),
    getChallengeStoreForLease: vi.fn(() => challenges.store),
    getSessionStoreForNewSession: vi.fn(async () => ({
      sessionId: 'session-new',
      stub: { createSessionRpc: vi.fn().mockResolvedValue(undefined) },
    })),
    resolveSessionTtl: vi.fn().mockResolvedValue({ seconds: 3600 }),
    registerExternalProviderSession: vi.fn().mockResolvedValue(undefined),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      async findById(id: string) {
        return { id, email: 'person@example.com' };
      }
    },
    resolveAccountDataContextByIdentifier: vi.fn().mockResolvedValue({
      tenantId: 'default',
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: {},
      piiDb: {},
    }),
    getTenantIdFromContext: vi.fn(() => 'default'),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.customer.example' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    readLiteModeAuthoritative: vi.fn().mockResolvedValue('always'),
  };
});

vi.mock('../services/link-intent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/link-intent')>();
  return { ...actual, recordSocialAccountActivity: mocks.recordActivity };
});

vi.mock('../services/identity-stitching', () => ({
  handleIdentity: mocks.handleIdentity,
  completeExternalIdpJIT: vi.fn(),
}));

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.getProvider,
}));

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    decrypt: vi.fn().mockResolvedValue('upstream-secret'),
    getEncryptionKeyOrUndefined: vi.fn(() => 'encryption-key'),
  };
});

vi.mock('../utils/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/state')>();
  return {
    ...actual,
    consumeAuthState: mocks.consumeAuthState,
    isPendingAuthState: mocks.isPendingAuthState,
  };
});

vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: {
    fromProvider: vi.fn(() => ({
      exchangeCode: mocks.exchangeCode,
      fetchUserInfoWithMeta: mocks.fetchUserInfo,
    })),
  },
}));

import { handleExternalCallback } from '../handlers/callback';
import { LITE_EXTERNAL_FLOW_PREFIX } from '../services/lite-start';
import { getAuthStateCookieName } from '../utils/state';

const CUSTOM_ORIGIN = 'https://login.customer.example';
const PLATFORM_ORIGIN = 'https://default.authrim.example';
const STATE = 'upstream-state-0123456789';
const CALLBACK_PATH = '/auth/external/corp/callback';
const LITE_RETURN = `${CUSTOM_ORIGIN}/callback?lite_txn=txn-1&lite_grant=grant-1`;

const provider: UpstreamProvider = {
  id: 'provider-a',
  slug: 'corp',
  tenantId: 'default',
  name: 'Corp IdP',
  providerType: 'oauth2',
  enabled: true,
  priority: 0,
  clientId: 'upstream-client',
  clientSecretEncrypted: 'encrypted-secret',
  scopes: 'name email',
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  userinfoEndpoint: 'https://idp.example.com/userinfo',
  attributeMapping: {},
  autoLinkEmail: false,
  jitProvisioning: true,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

function authState(overrides: Partial<ExternalIdpAuthState> = {}): ExternalIdpAuthState {
  return {
    id: 'auth-state-a',
    tenantId: 'default',
    providerId: 'provider-a',
    state: STATE,
    nonce: 'nonce-a',
    codeVerifier: 'verifier-a',
    flowId: 'flow-a',
    redirectUri: `${CUSTOM_ORIGIN}/account?social_link=linked`,
    enableSso: true,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function linkState(): ExternalIdpAuthState {
  return authState({ userId: 'user-a', sessionId: 'session-a' });
}

function liteState(): ExternalIdpAuthState {
  return authState({
    clientId: 'login-ui',
    codeChallenge: 'code-challenge-a',
    flowId: `${LITE_EXTERNAL_FLOW_PREFIX}flow-a`,
    redirectUri: LITE_RETURN,
  });
}

function session(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'session-a',
    userId: 'user-a',
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    authTime: Math.floor(Date.now() / 1000) - 10,
    ...overrides,
  };
}

const env = {
  BASE_DOMAIN: 'authrim.example',
  RP_TOKEN_ENCRYPTION_KEY: 'unused',
  SETTINGS: {
    get: vi.fn(async (key: string) =>
      key === 'settings:tenant:default:authentication-methods'
        ? JSON.stringify({
            'authentication-methods.external_provider_usage': JSON.stringify([
              { id: 'corp', providerId: 'provider-a', loginEnabled: true, signupEnabled: true },
            ]),
          })
        : null
    ),
  },
} as unknown as Env;

/**
 * The Bridge's callback as the request context middleware leaves it: on the platform issuer host
 * it names the custom domain to relay to; on the custom domain, nothing.
 */
function bridge(host: 'platform' | 'custom') {
  const app = new Hono<{ Bindings: Env }>();
  if (host === 'platform') {
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: string): void }).set(
        'externalCallbackRelayOrigin',
        CUSTOM_ORIGIN
      );
      await next();
    });
  }
  for (const path of ['/auth/external/:provider/callback', '/api/external/:provider/callback']) {
    app.get(path, handleExternalCallback);
    app.post(path, handleExternalCallback);
  }
  return app;
}

/** The provider's cross-site form post to the platform issuer host: no cookie of the custom domain. */
async function providerFormPost(body: Record<string, string> = {}) {
  return bridge('platform').request(
    `${PLATFORM_ORIGIN}${CALLBACK_PATH}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'upstream-code',
        state: STATE,
        user: '{"name":{"firstName":"Pat"},"email":"pat@example.com"}',
        ...body,
      }).toString(),
    },
    env
  );
}

/** The browser following the relay to the custom domain, with the cookies it has there. */
async function follow(location: string, cookies: { state?: boolean; session?: string } = {}) {
  const sent: string[] = [];
  if (cookies.state !== false) sent.push(`${await getAuthStateCookieName(STATE)}=${STATE}`);
  if (cookies.session !== undefined) sent.push(`authrim_session=${cookies.session}`);
  return bridge('custom').request(location, { headers: { Cookie: sent.join('; ') } }, env);
}

async function relayLocation(): Promise<string> {
  const response = await providerFormPost();
  expect(response.status).toBe(303);
  return response.headers.get('location') ?? '';
}

function relayEntries() {
  return [...challenges.entries.values()].filter((entry) => entry.id.startsWith('callback_relay:'));
}

describe('external callback: a form post relayed from the platform issuer host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    challenges.entries.clear();
    mocks.getProvider.mockResolvedValue(provider);
    mocks.isPendingAuthState.mockResolvedValue(true);
    mocks.exchangeCode.mockResolvedValue({
      tokens: { access_token: 'upstream-access', token_type: 'Bearer', expires_in: 3600 },
      requestContext: {
        tokenEndpoint: 'https://idp.example.com/token',
        authMethod: 'client_secret_basic',
        authHeaderPresent: true,
      },
    });
    mocks.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'external-subject-a', email: 'pat@example.com', email_verified: true },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: false,
    });
    mocks.handleIdentity.mockResolvedValue({
      status: 'ready',
      userId: 'user-a',
      isNewUser: false,
      linkedIdentityId: 'linked-identity-a',
      stitchedFromExisting: false,
    });
    mocks.readAccountSession.mockImplementation(async (_env: Env, _tenant: string, id: string) =>
      id === 'session-a'
        ? session()
        : id === 'session-b'
          ? session({ sessionId: 'session-b', userId: 'user-b' })
          : null
    );
  });

  describe('on the platform issuer host', () => {
    it('keeps the answer server-side and sends the browser on to the custom domain', async () => {
      const response = await providerFormPost();

      expect(response.status).toBe(303);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('set-cookie')).toBeNull();
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.origin).toBe(CUSTOM_ORIGIN);
      expect(location.pathname).toBe(CALLBACK_PATH);
      // Only the handle goes into the URL: never the code, the state or Apple's user data.
      expect([...location.searchParams.keys()]).toEqual(['relay']);
      expect(location.searchParams.get('relay')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(location.toString()).not.toContain('upstream-code');
      expect(location.toString()).not.toContain(STATE);

      const [kept] = relayEntries();
      expect(kept).toMatchObject({
        type: 'external_idp_callback_relay',
        tenantId: 'default',
        challenge: STATE,
        metadata: { provider: 'corp', params: { code: 'upstream-code', state: STATE } },
      });
      expect(kept.expiresAt - kept.createdAt).toBe(120_000);
      expect(mocks.isPendingAuthState).toHaveBeenCalledWith(env, 'default', 'provider-a', STATE);
      // Nothing of the sign-in is done on this host.
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });

    it('sends a post to the /api/external callback on to the path its state cookie is for', async () => {
      const response = await bridge('platform').request(
        `${PLATFORM_ORIGIN}/api/external/corp/callback`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code: 'upstream-code', state: STATE }).toString(),
        },
        env
      );
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(`${CUSTOM_ORIGIN}${CALLBACK_PATH}`);
    });

    it('keeps one answer at a time for a state, however often it is posted', async () => {
      expect((await providerFormPost()).status).toBe(303);
      for (let i = 0; i < 3; i++) {
        const again = await providerFormPost({ code: `forged-${i}` });
        expect(again.status).toBe(302);
        expect(new URL(again.headers.get('location') ?? '').searchParams.get('error')).toBe(
          'invalid_state'
        );
      }
      expect(relayEntries()).toHaveLength(1);
      expect(relayEntries()[0].metadata).toMatchObject({ params: { code: 'upstream-code' } });
    });

    it('relays a JARM answer by the state inside its response (verified by the callback)', async () => {
      const header = btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/u, '');
      const payload = btoa(JSON.stringify({ state: STATE })).replace(/=+$/u, '');
      mocks.consumeAuthState.mockResolvedValue(liteState());
      const response = await providerFormPost({
        code: '',
        state: '',
        response: `${header}.${payload}.`,
      });
      expect(response.status).toBe(303);
      expect(relayEntries()[0]).toMatchObject({ challenge: STATE });
      expect(mocks.isPendingAuthState).toHaveBeenCalledWith(env, 'default', 'provider-a', STATE);

      // On the custom domain the answer is taken by the state cookie that state names, and goes
      // on to the callback's own handling of the response (here: no code in it, refused there).
      const finished = await follow(response.headers.get('location') ?? '');
      expect(mocks.consumeAuthState).toHaveBeenCalledWith(env, 'default', STATE);
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
      expect(new URL(finished.headers.get('location') ?? '').pathname).toBe('/callback');
      expect(relayEntries()).toHaveLength(0);
    });

    it('keeps nothing for a state no sign-in is waiting on', async () => {
      mocks.isPendingAuthState.mockResolvedValue(false);
      const response = await providerFormPost();
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );
      expect(relayEntries()).toHaveLength(0);
    });

    it('keeps nothing without a state, or for an answer longer than any provider sends', async () => {
      for (const body of [{ state: '' }, { code: 'x'.repeat(5000) }] as Record<string, string>[]) {
        const response = await providerFormPost(body);
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
          'invalid_request'
        );
      }
      expect(relayEntries()).toHaveLength(0);
      expect(mocks.isPendingAuthState).not.toHaveBeenCalled();
    });

    it('keeps nothing for an unknown provider', async () => {
      mocks.getProvider.mockResolvedValue(null);
      const response = await providerFormPost();
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'unknown_provider'
      );
      expect(relayEntries()).toHaveLength(0);
    });
  });

  describe('linking from the account page', () => {
    beforeEach(() => {
      mocks.consumeAuthState.mockResolvedValue(linkState());
    });

    it('links the account for the browser and session that asked', async () => {
      const response = await follow(await relayLocation(), { session: 'session-a' });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${CUSTOM_ORIGIN}/account?social_link=linked`);
      expect(mocks.consumeAuthState).toHaveBeenCalledWith(env, 'default', STATE);
      expect(mocks.handleIdentity).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ linkingUserId: 'user-a' })
      );
      // The answer is not kept once taken.
      expect(relayEntries()).toHaveLength(0);
    });

    it('lets another browser (without the state cookie) neither take nor spend the answer', async () => {
      const location = await relayLocation();

      const stranger = await follow(location, { state: false, session: 'session-a' });
      expect(stranger.status).toBe(302);
      expect(new URL(stranger.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
      expect(mocks.handleIdentity).not.toHaveBeenCalled();

      // The browser that started still finishes.
      const owner = await follow(location, { session: 'session-a' });
      expect(owner.headers.get('location')).toBe(`${CUSTOM_ORIGIN}/account?social_link=linked`);
    });

    it('attaches nothing when the browser now brings another session', async () => {
      const response = await follow(await relayLocation(), { session: 'session-b' });
      expect(response.headers.get('location')).toBe(
        `${CUSTOM_ORIGIN}/account?social_link=error&reason=session_expired`
      );
      expect(mocks.handleIdentity).not.toHaveBeenCalled();
    });

    it('attaches nothing once the session that asked has ended', async () => {
      mocks.readAccountSession.mockResolvedValue(null);
      const response = await follow(await relayLocation(), { session: 'session-a' });
      expect(response.headers.get('location')).toBe(
        `${CUSTOM_ORIGIN}/account?social_link=error&reason=session_expired`
      );
      expect(mocks.handleIdentity).not.toHaveBeenCalled();
    });

    it('takes no answer once it has expired', async () => {
      const location = await relayLocation();
      for (const entry of challenges.entries.values()) entry.expiresAt = Date.now() - 1;
      const response = await follow(location, { session: 'session-a' });
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
    });

    it('takes an answer once', async () => {
      const location = await relayLocation();
      await follow(location, { session: 'session-a' });
      mocks.handleIdentity.mockClear();
      mocks.consumeAuthState.mockClear();

      const replay = await follow(location, { session: 'session-a' });
      expect(new URL(replay.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
      expect(mocks.handleIdentity).not.toHaveBeenCalled();
    });

    it("takes no answer at another provider's callback", async () => {
      const location = new URL(await relayLocation());
      location.pathname = '/auth/external/other/callback';
      const response = await follow(location.toString(), { session: 'session-a' });
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
      expect(relayEntries()).toHaveLength(1);
    });

    it('takes nothing for a handle that names no answer, or by a form post', async () => {
      const unknown = await follow(`${CUSTOM_ORIGIN}${CALLBACK_PATH}?relay=${'a'.repeat(43)}`, {
        session: 'session-a',
      });
      expect(new URL(unknown.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );

      // A post to the custom domain's callback is a provider's own answer, never a relay's.
      const location = await relayLocation();
      const posted = await bridge('custom').request(
        location,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}`,
          },
          body: '',
        },
        env
      );
      expect(new URL(posted.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_request'
      );
      expect(relayEntries()).toHaveLength(1);
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
    });
  });

  describe('a lite sign-in', () => {
    beforeEach(() => {
      mocks.consumeAuthState.mockResolvedValue(liteState());
    });

    it("returns to the lite callback page on the custom domain with the sign-in's handoff", async () => {
      const response = await follow(await relayLocation());

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(`${CUSTOM_ORIGIN}/callback`);
      expect(location.searchParams.get('lite_txn')).toBe('txn-1');
      expect(location.searchParams.get('lite_grant')).toBe('grant-1');
      expect(location.searchParams.get('handoff_token')).toBeTruthy();
      expect(location.searchParams.get('state')).toBe(STATE);
      expect(mocks.handleIdentity).toHaveBeenCalledTimes(1);
    });

    it('signs no one in for another browser', async () => {
      const response = await follow(await relayLocation(), { state: false });
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'invalid_state'
      );
      expect(mocks.consumeAuthState).not.toHaveBeenCalled();
      expect(mocks.handleIdentity).not.toHaveBeenCalled();
      expect(response.headers.get('set-cookie') ?? '').not.toContain('authrim_session=');
    });

    it("sends a provider's error to the lite callback page, as a direct answer does", async () => {
      const response = await providerFormPost({ code: '', error: 'access_denied' });
      const finished = await follow(response.headers.get('location') ?? '');
      const location = new URL(finished.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(`${CUSTOM_ORIGIN}/callback`);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });
  });

  it('handles the answer where it lands when no relay is asked for (no custom domain)', async () => {
    mocks.consumeAuthState.mockResolvedValue(liteState());
    const response = await bridge('custom').request(
      `${CUSTOM_ORIGIN}${CALLBACK_PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}`,
        },
        body: new URLSearchParams({ code: 'upstream-code', state: STATE }).toString(),
      },
      env
    );
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('handoff_token')
    ).toBeTruthy();
    expect(relayEntries()).toHaveLength(0);
  });
});
