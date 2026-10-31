/**
 * External start in link mode (account page → provider).
 *
 * Only a one-use link intent, matched to the browser's own fresh, non-guest session, may start a
 * link. A link skips the sign-in checks (human verification, the client's PKCE), never answers
 * silently, and always returns to the account page. A start without an intent is unchanged.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession, Env } from '@authrim/ar-lib-core';
import type { ExternalIdpAuthState, UpstreamProvider } from '../types';

const mocks = vi.hoisted(() => ({
  readAccountSession: vi.fn(),
  verifyHumanVerification: vi.fn(),
  consumeLinkIntent: vi.fn(),
  getProvider: vi.fn(),
  storeAuthState: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  fromProvider: vi.fn(),
  findByClientId: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAccountSession: mocks.readAccountSession,
    verifyHumanVerificationWithRunner: mocks.verifyHumanVerification,
    getTenantIdFromContext: vi.fn(() => 'default'),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    createAuthContextFromHono: vi.fn(() => ({
      repositories: { client: { findByClientId: mocks.findByClientId } },
    })),
  };
});

vi.mock('../services/link-intent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/link-intent')>();
  return { ...actual, consumeLinkIntent: mocks.consumeLinkIntent };
});

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.getProvider,
}));

vi.mock('../services/dynamic-registration', () => ({
  ensureDynamicClientRegistration: vi.fn(
    async (input: { provider: UpstreamProvider }) =>
      ({ provider: input.provider, clientSecret: 'upstream-secret' }) as const
  ),
  getDynamicClientRegistrationConfig: vi.fn(() => undefined),
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
  return { ...actual, storeAuthState: mocks.storeAuthState };
});

vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: mocks.fromProvider },
}));

import { handleExternalStart } from '../handlers/start';

const TOKEN = 'L'.repeat(43);
const ACCOUNT_PAGE = 'https://login.example.com/account';
const LINKED_URL = `${ACCOUNT_PAGE}?social_link=linked`;
const IDP_AUTHORIZE = 'https://idp.example.com/authorize?state=upstream-state';

const provider: UpstreamProvider = {
  id: 'provider-a',
  slug: 'corp',
  tenantId: 'default',
  name: 'Corp IdP',
  providerType: 'oidc',
  enabled: true,
  priority: 0,
  issuer: 'https://idp.example.com',
  clientId: 'upstream-client',
  clientSecretEncrypted: 'encrypted-secret',
  scopes: 'openid email',
  attributeMapping: {},
  autoLinkEmail: false,
  jitProvisioning: false,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function liveSession(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'session-a',
    userId: 'user-a',
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    authTime: nowSeconds() - 10,
    ...overrides,
  };
}

const env = {
  ISSUER_URL: 'https://auth.example.com',
  RP_TOKEN_ENCRYPTION_KEY: 'unused',
} as unknown as Env;

async function start(query: string, cookie: string | null = 'authrim_session=session-a') {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/start', handleExternalStart);
  return app.request(
    `/auth/external/corp/start?${query}`,
    { headers: cookie ? { Cookie: cookie } : {} },
    env
  );
}

function linkError(reason: string): string {
  return `${ACCOUNT_PAGE}?social_link=error&reason=${reason}`;
}

/** The auth state the start stored (first call). */
function storedAuthState(): Omit<ExternalIdpAuthState, 'id' | 'createdAt'> {
  return mocks.storeAuthState.mock.calls[0][1] as Omit<ExternalIdpAuthState, 'id' | 'createdAt'>;
}

describe('external start: linking from the account page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeLinkIntent.mockResolvedValue({
      userId: 'user-a',
      sessionId: 'session-a',
      providerId: 'provider-a',
    });
    mocks.readAccountSession.mockResolvedValue(liveSession());
    mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
    mocks.getProvider.mockResolvedValue(provider);
    mocks.storeAuthState.mockResolvedValue('auth-state-id');
    mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
    mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
    mocks.findByClientId.mockResolvedValue(null);
  });

  it('stores a link state bound to the session and goes to the provider', async () => {
    const response = await start(`link_intent=${TOKEN}`, 'other=1; authrim_session=session-a');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(mocks.consumeLinkIntent).toHaveBeenCalledWith(env, 'default', TOKEN);
    expect(mocks.readAccountSession).toHaveBeenCalledWith(env, 'default', 'session-a');
    expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
    expect(mocks.storeAuthState).toHaveBeenCalledOnce();
    const stored = storedAuthState();
    expect(stored).toMatchObject({
      tenantId: 'default',
      providerId: 'provider-a',
      userId: 'user-a',
      sessionId: 'session-a',
      redirectUri: LINKED_URL,
    });
    expect(stored.clientId).toBeUndefined();
    expect(stored.codeChallenge).toBeUndefined();
    expect(stored.prompt).toBeUndefined();
    // The browser is bound to the upstream state as for a sign-in.
    expect(response.headers.get('set-cookie')).toMatch(/Path=\/auth\/external\//);
  });

  it('ignores client parameters, redirect_uri and prompt=none on a link', async () => {
    const response = await start(
      `link_intent=${TOKEN}&client_id=client-a&code_challenge=abc&code_challenge_method=S256` +
        `&redirect_uri=${encodeURIComponent('https://login.example.com/callback')}&prompt=none`
    );

    expect(response.status).toBe(302);
    // No silent answer (handoff/login_required): the browser goes to the provider.
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    const stored = storedAuthState();
    expect(stored.clientId).toBeUndefined();
    expect(stored.codeChallenge).toBeUndefined();
    expect(stored.prompt).toBeUndefined();
    expect(stored.redirectUri).toBe(LINKED_URL);
    expect(mocks.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: undefined })
    );
  });

  it.each([
    ['an unknown, expired or used intent', () => mocks.consumeLinkIntent.mockResolvedValue(null)],
    ['no session cookie', () => mocks.readAccountSession.mockResolvedValue(null)],
    [
      'another session of the same user',
      () => mocks.readAccountSession.mockResolvedValue(liveSession({ sessionId: 'session-b' })),
    ],
    [
      "another user's session",
      () => mocks.readAccountSession.mockResolvedValue(liveSession({ userId: 'user-b' })),
    ],
    [
      'a guest session',
      () => mocks.readAccountSession.mockResolvedValue(liveSession({ isGuestSession: true })),
    ],
    [
      'a session authenticated too long ago',
      () =>
        mocks.readAccountSession.mockResolvedValue(liveSession({ authTime: nowSeconds() - 600 })),
    ],
    [
      'a session store failure',
      () => mocks.readAccountSession.mockRejectedValue(new Error('session store down')),
    ],
  ])('returns to the account page as session_expired on %s', async (_label, arrange) => {
    arrange();

    const response = await start(`link_intent=${TOKEN}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError('session_expired'));
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
    expect(mocks.fromProvider).not.toHaveBeenCalled();
    expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
  });

  it('does not read the session when the intent is not valid', async () => {
    mocks.consumeLinkIntent.mockResolvedValue(null);

    await start(`link_intent=${TOKEN}`);

    expect(mocks.readAccountSession).not.toHaveBeenCalled();
  });

  it('treats an empty link_intent as a link attempt, not as a sign-in', async () => {
    mocks.consumeLinkIntent.mockResolvedValue(null);

    const response = await start('link_intent=&client_id=client-a&code_challenge=abc');

    expect(response.headers.get('location')).toBe(linkError('session_expired'));
    expect(mocks.consumeLinkIntent).toHaveBeenCalledWith(env, 'default', '');
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('returns to the account page as failed when the intent names another provider', async () => {
    mocks.consumeLinkIntent.mockResolvedValue({
      userId: 'user-a',
      sessionId: 'session-a',
      providerId: 'provider-other',
    });

    const response = await start(`link_intent=${TOKEN}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError('failed'));
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
    expect(mocks.fromProvider).not.toHaveBeenCalled();
  });

  it('returns to the account page when the provider was disabled after the intent', async () => {
    mocks.getProvider.mockResolvedValue({ ...provider, enabled: false });

    const response = await start(`link_intent=${TOKEN}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError('failed'));
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('ignores sign-in hints (max_age, login_hint, acr_values) on a link', async () => {
    const response = await start(
      `link_intent=${TOKEN}&max_age=not-a-number&login_hint=a%40example.com&acr_values=urn%3Aacr`
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    const stored = storedAuthState();
    expect(stored.maxAge).toBeUndefined();
    expect(stored.acrValues).toBeUndefined();
    expect(mocks.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ loginHint: undefined, maxAge: undefined, acrValues: undefined })
    );
  });

  it('returns to the account page when the start fails after the intent is used', async () => {
    mocks.storeAuthState.mockRejectedValue(new Error('d1 down'));

    const response = await start(`link_intent=${TOKEN}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError('failed'));
  });
});

describe('external start: sign-in (no link intent) is unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
    mocks.getProvider.mockResolvedValue(provider);
    mocks.storeAuthState.mockResolvedValue('auth-state-id');
    mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
    mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
    mocks.findByClientId.mockResolvedValue(null);
  });

  it('requires human verification', async () => {
    mocks.verifyHumanVerification.mockResolvedValue({ verified: false });

    const response = await start(
      'client_id=client-a&code_challenge=abc&code_challenge_method=S256'
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'Human verification failed',
    });
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('requires client_id', async () => {
    const response = await start('code_challenge=abc&code_challenge_method=S256');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'client_id is required',
    });
    expect(mocks.verifyHumanVerification).toHaveBeenCalledOnce();
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it.each([
    ['no code_challenge', 'client_id=client-a&code_challenge_method=S256'],
    ['a plain method', 'client_id=client-a&code_challenge=abc&code_challenge_method=plain'],
  ])('requires S256 PKCE (%s)', async (_label, query) => {
    const response = await start(query);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'code_challenge and code_challenge_method=S256 are required',
    });
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('stores a sign-in state with the client and no account binding', async () => {
    const response = await start(
      'client_id=client-a&code_challenge=abc&code_challenge_method=S256',
      null
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(mocks.consumeLinkIntent).not.toHaveBeenCalled();
    expect(mocks.readAccountSession).not.toHaveBeenCalled();
    const stored = storedAuthState();
    expect(stored).toMatchObject({ clientId: 'client-a', codeChallenge: 'abc' });
    expect(stored.userId).toBeUndefined();
    expect(stored.sessionId).toBeUndefined();
    expect(stored.redirectUri).toBe('https://login.example.com/');
  });
});
