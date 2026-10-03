/**
 * External start answering an Authrim re-authentication.
 *
 * A sign-in for a re-authentication challenge asks the provider for a new login (prompt=login,
 * max_age=0) and records when it asked, so the callback can require one made after it. Only an
 * OIDC provider (whose ID token dates the login) the tenant lets re-authenticate may answer one.
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
  challengeKind: vi.fn(),
  reauthPolicy: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAccountSession: mocks.readAccountSession,
    readAuthorizationChallengeKind: mocks.challengeKind,
    readExternalProviderReauthPolicy: mocks.reauthPolicy,
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

const env = {
  ISSUER_URL: 'https://auth.example.com',
  RP_TOKEN_ENCRYPTION_KEY: 'unused',
} as unknown as Env;

const SIGN_IN = 'client_id=client-a&code_challenge=abc&code_challenge_method=S256';

async function start(query: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/start', handleExternalStart);
  return app.request(`/auth/external/corp/start?${query}`, {}, env);
}

function storedAuthState(): Omit<ExternalIdpAuthState, 'id' | 'createdAt'> {
  return mocks.storeAuthState.mock.calls[0][1] as Omit<ExternalIdpAuthState, 'id' | 'createdAt'>;
}

describe('external start: answering a re-authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
    mocks.getProvider.mockResolvedValue(provider);
    mocks.storeAuthState.mockResolvedValue('auth-state-id');
    mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
    mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
    mocks.findByClientId.mockResolvedValue(null);
    mocks.challengeKind.mockResolvedValue('reauth');
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
  });

  it('asks the provider for a new login and records when it asked', async () => {
    const before = Date.now();
    const response = await start(`${SIGN_IN}&authorization_challenge_id=reauth_1&prompt=none`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(mocks.challengeKind).toHaveBeenCalledWith(env, 'default', 'reauth_1');
    expect(mocks.reauthPolicy).toHaveBeenCalledWith(env, 'default', {
      providerId: 'provider-a',
      ids: ['provider-a', 'corp'],
    });
    // Never answered silently, whatever prompt the client asked for.
    expect(mocks.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'login', maxAge: 0 })
    );
    const stored = storedAuthState();
    expect(stored).toMatchObject({ reauthChallengeId: 'reauth_1', prompt: 'login', maxAge: 0 });
    expect(stored.reauthRequestedAt).toBeGreaterThanOrEqual(before);
  });

  it('leaves a sign-in for a login challenge as it was', async () => {
    mocks.challengeKind.mockResolvedValue('login');

    const response = await start(`${SIGN_IN}&authorization_challenge_id=login_1`);

    expect(response.status).toBe(302);
    expect(mocks.reauthPolicy).not.toHaveBeenCalled();
    const stored = storedAuthState();
    expect(stored.reauthChallengeId).toBeUndefined();
    expect(stored.reauthRequestedAt).toBeUndefined();
    expect(stored.prompt).toBeUndefined();
  });

  it('refuses a challenge that is not one', async () => {
    mocks.challengeKind.mockResolvedValue(null);

    const response = await start(`${SIGN_IN}&authorization_challenge_id=unknown`);

    expect(response.status).toBe(400);
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it.each([
    ['the tenant turned its re-authentication off', 'oidc', false, 403],
    ['it cannot date a login (OAuth 2.0 only)', 'oauth2', true, 403],
  ] as const)('refuses a provider when %s', async (_label, providerType, reauthEnabled, status) => {
    mocks.getProvider.mockResolvedValue({ ...provider, providerType });
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled, acceptWithoutAuthTime: false });

    const response = await start(`${SIGN_IN}&authorization_challenge_id=reauth_1`);

    expect(response.status).toBe(status);
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
    expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('refuses when the re-authentication settings cannot be read', async () => {
    mocks.reauthPolicy.mockRejectedValue(new Error('kv unavailable'));

    const response = await start(`${SIGN_IN}&authorization_challenge_id=reauth_1`);

    expect(response.status).toBe(503);
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });
});
