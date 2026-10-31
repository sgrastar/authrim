/**
 * External callback for a link started from the account page.
 *
 * A link attaches the external identity to the account that asked for it, while its session still
 * stands, and signs no one in: no new session, no session cookie, no handoff or auth code. Every
 * outcome returns to the account page, never to /login.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession, Env } from '@authrim/ar-lib-core';
import {
  ExternalIdPError,
  ExternalIdPErrorCode,
  type ExternalIdpAuthState,
  type UpstreamProvider,
} from '../types';

const mocks = vi.hoisted(() => ({
  readAccountSession: vi.fn(),
  getSessionStoreForNewSession: vi.fn(),
  getChallengeStore: vi.fn(),
  registerExternalProviderSession: vi.fn(),
  consumeAuthState: vi.fn(),
  getProvider: vi.fn(),
  handleIdentity: vi.fn(),
  completeJit: vi.fn(),
  recordActivity: vi.fn(),
  exchangeCode: vi.fn(),
  fetchUserInfo: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAccountSession: mocks.readAccountSession,
    getSessionStoreForNewSession: mocks.getSessionStoreForNewSession,
    getChallengeStoreByChallengeId: mocks.getChallengeStore,
    registerExternalProviderSession: mocks.registerExternalProviderSession,
    getTenantIdFromContext: vi.fn(() => 'default'),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../services/link-intent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/link-intent')>();
  return { ...actual, recordSocialAccountActivity: mocks.recordActivity };
});

vi.mock('../services/identity-stitching', () => ({
  handleIdentity: mocks.handleIdentity,
  completeExternalIdpJIT: mocks.completeJit,
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
  return { ...actual, consumeAuthState: mocks.consumeAuthState };
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
import { getAuthStateCookieName } from '../utils/state';

const STATE = 'upstream-state-0123456789';
const ACCOUNT_PAGE = 'https://login.example.com/account';

// OAuth 2.0 (no ID token) keeps the path to identity handling short: code → tokens → userinfo.
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
  scopes: 'profile email',
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  userinfoEndpoint: 'https://idp.example.com/userinfo',
  attributeMapping: {},
  autoLinkEmail: false,
  jitProvisioning: false,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

const userInfo = { sub: 'external-subject-a', email: 'person@example.com', email_verified: true };

function linkState(overrides: Partial<ExternalIdpAuthState> = {}): ExternalIdpAuthState {
  return {
    id: 'auth-state-a',
    tenantId: 'default',
    providerId: 'provider-a',
    state: STATE,
    nonce: 'nonce-a',
    codeVerifier: 'verifier-a',
    flowId: 'flow-a',
    redirectUri: `${ACCOUNT_PAGE}?social_link=linked`,
    userId: 'user-a',
    sessionId: 'session-a',
    enableSso: true,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function liveSession(overrides: Partial<AccountSession> = {}): AccountSession {
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
  ISSUER_URL: 'https://auth.example.com',
  RP_TOKEN_ENCRYPTION_KEY: 'unused',
} as unknown as Env;

async function callback(query: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/callback', handleExternalCallback);
  return app.request(
    `/auth/external/corp/callback?${query}&state=${STATE}`,
    { headers: { Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}` } },
    env
  );
}

function linkError(reason: string): string {
  return `${ACCOUNT_PAGE}?social_link=error&reason=${reason}`;
}

function expectNoSignIn(response: Response) {
  expect(mocks.getSessionStoreForNewSession).not.toHaveBeenCalled();
  expect(mocks.getChallengeStore).not.toHaveBeenCalled();
  expect(mocks.registerExternalProviderSession).not.toHaveBeenCalled();
  expect(response.headers.get('set-cookie') ?? '').not.toContain('authrim_session=');
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.pathname).toBe('/account');
  expect(location.searchParams.has('handoff_token')).toBe(false);
  expect(location.searchParams.has('code')).toBe(false);
}

describe('external callback: linking from the account page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockResolvedValue(provider);
    mocks.consumeAuthState.mockResolvedValue(linkState());
    mocks.readAccountSession.mockResolvedValue(liveSession());
    mocks.exchangeCode.mockResolvedValue({
      tokens: { access_token: 'upstream-access', token_type: 'Bearer', expires_in: 3600 },
      requestContext: {
        tokenEndpoint: 'https://idp.example.com/token',
        authMethod: 'client_secret_basic',
        authHeaderPresent: true,
      },
    });
    mocks.fetchUserInfo.mockResolvedValue({
      userInfo: { ...userInfo },
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
    mocks.recordActivity.mockResolvedValue(undefined);
  });

  it('links to the requesting account, records it, and signs no one in', async () => {
    const response = await callback('code=upstream-code');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PAGE}?social_link=linked`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mocks.readAccountSession).toHaveBeenCalledWith(env, 'default', 'session-a');
    expect(mocks.handleIdentity).toHaveBeenCalledOnce();
    expect(mocks.handleIdentity).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        provider,
        linkingUserId: 'user-a',
        tenantId: 'default',
      })
    );
    expect(
      (mocks.handleIdentity.mock.calls[0][1] as { userInfo: { sub: string } }).userInfo.sub
    ).toBe('external-subject-a');
    expect(mocks.readAccountSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.handleIdentity.mock.invocationCallOrder[0]
    );
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'account.social_account.linked',
      { linkedIdentityId: 'linked-identity-a', providerId: 'provider-a' }
    );
    expectNoSignIn(response);
  });

  it.each([
    ['the session is gone', () => mocks.readAccountSession.mockResolvedValue(null)],
    [
      'the session now belongs to another user',
      () => mocks.readAccountSession.mockResolvedValue(liveSession({ userId: 'user-b' })),
    ],
    [
      'the state carries no session',
      () => mocks.consumeAuthState.mockResolvedValue(linkState({ sessionId: undefined })),
    ],
  ])('returns session_expired without linking when %s', async (_label, arrange) => {
    arrange();

    const response = await callback('code=upstream-code');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError('session_expired'));
    expect(mocks.handleIdentity).not.toHaveBeenCalled();
    expect(mocks.recordActivity).not.toHaveBeenCalled();
    expectNoSignIn(response);
  });

  it.each([
    ['access_denied', 'cancelled'],
    ['server_error', 'failed'],
  ])('maps a provider error=%s to %s', async (providerError, reason) => {
    const response = await callback(`error=${providerError}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError(reason));
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.handleIdentity).not.toHaveBeenCalled();
    expectNoSignIn(response);
  });

  it.each([
    [
      'the external account belongs to another account',
      new ExternalIdPError(ExternalIdPErrorCode.ACCOUNT_ALREADY_LINKED, 'taken'),
      'already_linked',
    ],
    [
      'the provider email is not verified',
      new ExternalIdPError(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED, 'unverified'),
      'email_not_verified',
    ],
    [
      'another identity error',
      new ExternalIdPError(ExternalIdPErrorCode.CALLBACK_FAILED, 'nope'),
      'failed',
    ],
    ['an unexpected error', new Error('d1 unavailable'), 'failed'],
  ])('maps %s to %s', async (_label, error, reason) => {
    mocks.handleIdentity.mockRejectedValue(error);

    const response = await callback('code=upstream-code');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(linkError(reason));
    expect(mocks.recordActivity).not.toHaveBeenCalled();
    expectNoSignIn(response);
  });

  it('fails when identity handling does not complete a link for this user', async () => {
    mocks.handleIdentity.mockResolvedValue({
      status: 'ready',
      userId: 'user-b',
      isNewUser: false,
      linkedIdentityId: 'linked-identity-b',
      stitchedFromExisting: false,
    });

    const response = await callback('code=upstream-code');

    expect(response.headers.get('location')).toBe(linkError('failed'));
    expect(mocks.recordActivity).not.toHaveBeenCalled();
    expectNoSignIn(response);
  });

  it('fails on an upstream token or session store error, still on the account page', async () => {
    mocks.exchangeCode.mockRejectedValueOnce(new Error('token endpoint 500'));
    const tokenFailure = await callback('code=upstream-code');
    expect(tokenFailure.headers.get('location')).toBe(linkError('failed'));
    expectNoSignIn(tokenFailure);

    mocks.readAccountSession.mockRejectedValueOnce(new Error('session store down'));
    const storeFailure = await callback('code=upstream-code');
    expect(storeFailure.headers.get('location')).toBe(linkError('failed'));
    expect(mocks.handleIdentity).not.toHaveBeenCalled();
    expectNoSignIn(storeFailure);
  });

  it('fails on the account page when the provider returns no subject', async () => {
    mocks.fetchUserInfo.mockResolvedValueOnce({
      userInfo: { email: 'person@example.com' },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: false,
    });

    const response = await callback('code=upstream-code');

    expect(response.headers.get('location')).toBe(linkError('failed'));
    expect(mocks.handleIdentity).not.toHaveBeenCalled();
    expectNoSignIn(response);
  });

  it('keeps sign-in errors on /login when the state is not a link', async () => {
    mocks.consumeAuthState.mockResolvedValue(
      linkState({ userId: undefined, sessionId: undefined, clientId: 'client-a' })
    );

    const response = await callback('error=access_denied');

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });
});
