/**
 * External start and the tenant's per-provider sign-in switch
 * (authentication-methods.external_provider_usage loginEnabled).
 *
 * The login screen only hides a provider the tenant turned off; the start endpoint is what keeps
 * it from being used when its URL is called directly. A provider with no saved switch stays on,
 * as the login screen shows it.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { UpstreamProvider } from '../types';

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
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAccountSession: mocks.readAccountSession,
    readAuthorizationChallengeKind: mocks.challengeKind,
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

const SETTINGS_KEY = 'settings:tenant:default:authentication-methods';

function envWith(usage: unknown): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
    RP_TOKEN_ENCRYPTION_KEY: 'unused',
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key !== SETTINGS_KEY || usage === undefined) return null;
        if (usage === 'unreadable') return '{';
        return JSON.stringify({
          'authentication-methods.external_provider_usage': JSON.stringify(usage),
        });
      }),
    },
  } as unknown as Env;
}

const SIGN_IN = 'client_id=client-a&code_challenge=abc&code_challenge_method=S256';

async function start(query: string, env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/start', handleExternalStart);
  return app.request(`/auth/external/corp/start?${query}`, {}, env);
}

const entry = (fields: Record<string, unknown>) => [
  { id: 'corp', providerId: 'provider-a', ...fields },
];

describe("external start: the tenant's sign-in switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
    mocks.getProvider.mockResolvedValue(provider);
    mocks.storeAuthState.mockResolvedValue('auth-state-id');
    mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
    mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
    mocks.findByClientId.mockResolvedValue(null);
    mocks.challengeKind.mockResolvedValue('login');
  });

  const expectNothingStarted = () => {
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
    expect(mocks.fromProvider).not.toHaveBeenCalled();
    expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
  };

  it('refuses a sign-in when the tenant turned the provider off, before any state is stored', async () => {
    const response = await start(SIGN_IN, envWith(entry({ loginEnabled: false })));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
    expectNothingStarted();
  });

  it('refuses a silent sign-in (prompt=none) and a login challenge the same way', async () => {
    const off = envWith(entry({ loginEnabled: false }));

    expect((await start(`${SIGN_IN}&prompt=none`, off)).status).toBe(403);
    expect((await start(`${SIGN_IN}&authorization_challenge_id=login_1`, off)).status).toBe(403);
    expectNothingStarted();
  });

  it('answers 503, starting nothing, when the switches cannot be read', async () => {
    const response = await start(SIGN_IN, envWith('unreadable'));

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
    expectNothingStarted();
  });

  it.each([
    ['nothing saved for the tenant', undefined],
    ['no entry for the provider', [{ id: 'other', providerId: 'p-other', loginEnabled: false }]],
    ['an entry that leaves the switch out', entry({ reauthEnabled: false })],
    ['an explicit on', entry({ loginEnabled: true, signupEnabled: false })],
  ])('starts the sign-in as before with %s', async (_label, usage) => {
    const response = await start(SIGN_IN, envWith(usage));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(mocks.storeAuthState).toHaveBeenCalledOnce();
  });

  it('keeps the provider to the entry naming it, not one that once had its slug', async () => {
    const response = await start(
      SIGN_IN,
      envWith([{ id: 'corp', providerId: 'provider-old', loginEnabled: false }])
    );

    expect(response.status).toBe(302);
  });

  it('leaves a re-authentication to its own switch', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');

    const response = await start(
      `${SIGN_IN}&authorization_challenge_id=reauth_1`,
      envWith(entry({ loginEnabled: false, reauthEnabled: true }))
    );

    expect(response.status).toBe(302);
    expect(mocks.storeAuthState).toHaveBeenCalledOnce();
  });
});
