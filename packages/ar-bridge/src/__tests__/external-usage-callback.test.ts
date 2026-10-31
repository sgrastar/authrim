/**
 * External callback and the tenant's per-provider sign-in switch
 * (authentication-methods.external_provider_usage loginEnabled).
 *
 * The switch may be turned off after a sign-in started, so the callback decides it again: before
 * the code is exchanged and before any account, session or artifact is made. A provider with no
 * saved switch stays on; a link and a re-authentication have their own switches.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { ExternalIdpAuthState, UpstreamProvider } from '../types';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  consumeAuthState: vi.fn(),
  fromProvider: vi.fn(),
  handleIdentity: vi.fn(),
  getSessionStore: vi.fn(),
  getChallengeStore: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'default'),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    getSessionStoreForNewSession: mocks.getSessionStore,
    getChallengeStoreByChallengeId: mocks.getChallengeStore,
    publishEvent: mocks.publishEvent,
  };
});

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.getProvider,
}));

vi.mock('../services/identity-stitching', () => ({
  completeExternalIdpJIT: vi.fn(),
  handleIdentity: mocks.handleIdentity,
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
    matchesAuthStateCookie: vi.fn(() => true),
  };
});

vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: mocks.fromProvider },
}));

import { handleExternalCallback } from '../handlers/callback';

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
  jitProvisioning: true,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

const authState: ExternalIdpAuthState = {
  id: 'auth-state-a',
  tenantId: 'default',
  clientId: 'client-a',
  providerId: 'provider-a',
  state: 'client-state',
  nonce: 'nonce',
  codeVerifier: 'verifier',
  codeChallenge: 'challenge',
  redirectUri: 'https://login.example.com/callback',
  enableSso: true,
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
};

const SETTINGS_KEY = 'settings:tenant:default:authentication-methods';

function envWith(usage: unknown): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
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

async function callback(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/callback', handleExternalCallback);
  return app.request(
    '/auth/external/corp/callback?code=upstream-code&state=client-state',
    { headers: { Cookie: 'authrim_external_state=x' } },
    env
  );
}

function errorOf(response: Response): string | null {
  return new URL(response.headers.get('location') ?? 'https://x.invalid').searchParams.get('error');
}

const entry = (fields: Record<string, unknown>) => [
  { id: 'corp', providerId: 'provider-a', ...fields },
];

describe("external callback: the tenant's sign-in switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockResolvedValue(provider);
    mocks.consumeAuthState.mockResolvedValue(authState);
    mocks.publishEvent.mockResolvedValue(undefined);
    // Past the gate the exchange is the first thing to run; it fails here, which is enough to
    // show the gate let the sign-in through.
    mocks.fromProvider.mockImplementation(() => {
      throw new Error('stop after the gate');
    });
  });

  const expectNothingMade = () => {
    expect(mocks.fromProvider).not.toHaveBeenCalled();
    expect(mocks.handleIdentity).not.toHaveBeenCalled();
    expect(mocks.getSessionStore).not.toHaveBeenCalled();
    expect(mocks.getChallengeStore).not.toHaveBeenCalled();
  };

  it('refuses the sign-in when the tenant turned the provider off after it started', async () => {
    const response = await callback(envWith(entry({ loginEnabled: false })));

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe('access_denied');
    expect(response.headers.get('location')).not.toContain('code=');
    expectNothingMade();
  });

  it('answers temporarily_unavailable, making nothing, when the switches cannot be read', async () => {
    const response = await callback(envWith('unreadable'));

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe('temporarily_unavailable');
    expectNothingMade();
  });

  it.each([
    ['nothing saved for the tenant', undefined],
    ['no entry for the provider', [{ id: 'other', providerId: 'p-other', loginEnabled: false }]],
    ['an entry that leaves the switch out', entry({ signupEnabled: false })],
    ['an explicit on', entry({ loginEnabled: true })],
  ])('lets the sign-in on to the exchange with %s', async (_label, usage) => {
    await callback(envWith(usage));

    expect(mocks.fromProvider).toHaveBeenCalledOnce();
  });

  it('leaves a link to the account page and a re-authentication to its own switch', async () => {
    const off = envWith(entry({ loginEnabled: false }));

    mocks.consumeAuthState.mockResolvedValue({ ...authState, userId: 'user-a', sessionId: 's1' });
    await callback(off);
    expect(mocks.fromProvider).toHaveBeenCalledOnce();

    mocks.fromProvider.mockClear();
    mocks.consumeAuthState.mockResolvedValue({
      ...authState,
      reauthChallengeId: 'reauth_1',
      reauthRequestedAt: Date.now(),
    });
    await callback(off);
    expect(mocks.fromProvider).toHaveBeenCalledOnce();
  });
});
