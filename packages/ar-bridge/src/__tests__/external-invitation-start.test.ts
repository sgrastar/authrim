/**
 * External start for a sign-in started from an invitation.
 *
 * The start reserves one use of the invitation for the sign-in (held by its flow) and records it
 * on the stored state, so the callback can apply it to the account it creates. An invitation that
 * is not usable stops the start before anything is stored; a silent sign-in, which creates no
 * account, carries no invitation.
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
  reserve: vi.fn(),
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

vi.mock('../services/signup-invitation', () => ({
  reserveExternalSignupInvitation: mocks.reserve,
}));

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

describe('external start: an invitation', () => {
  const env = () => envWith(entry({ loginEnabled: true, signupEnabled: true }));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
    mocks.getProvider.mockResolvedValue(provider);
    mocks.storeAuthState.mockResolvedValue('auth-state-id');
    mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
    mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
    mocks.findByClientId.mockResolvedValue(null);
    mocks.challengeKind.mockResolvedValue('login');
    mocks.reserve.mockResolvedValue({ inviteId: 'invite-1', inviteReservationId: 'inr-1' });
  });

  it('reserves a use for the sign-in and records it on the stored state', async () => {
    const response = await start(`${SIGN_IN}&invite_token=invite-token`, env());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), {
      token: 'invite-token',
      tenantId: 'default',
      flowId: expect.any(String),
    });
    const stored = mocks.storeAuthState.mock.calls[0][1] as { flowId: string };
    expect(stored).toMatchObject({ inviteId: 'invite-1', inviteReservationId: 'inr-1' });
    // Held by this sign-in's flow, so a restart of it keeps the one use.
    const reserved = mocks.reserve.mock.calls[0][1] as { flowId: string };
    expect(reserved.flowId).toBe(stored.flowId);
  });

  it('stops before storing anything when the invitation cannot be used', async () => {
    mocks.reserve.mockResolvedValue(null);

    const response = await start(`${SIGN_IN}&invite_token=invite-token`, env());

    expect(response.status).toBe(404);
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
    expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(513)])('rejects a malformed invitation token', async (token) => {
    const response = await start(`${SIGN_IN}&invite_token=${token}`, env());

    expect(response.status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('carries no invitation on a silent sign-in, which creates no account', async () => {
    await start(`${SIGN_IN}&prompt=none&invite_token=invite-token`, env());

    expect(mocks.reserve).not.toHaveBeenCalled();
    if (mocks.storeAuthState.mock.calls.length > 0) {
      expect(mocks.storeAuthState.mock.calls[0][1]).not.toHaveProperty('inviteId');
    }
  });

  it('stores no invitation for a sign-in without one', async () => {
    await start(SIGN_IN, env());

    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.storeAuthState.mock.calls[0][1]).not.toHaveProperty('inviteId');
  });
});
