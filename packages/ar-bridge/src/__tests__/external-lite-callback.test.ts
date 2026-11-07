/**
 * External callback for a tenant in lite mode: an account is created (JIT) only for a sign-in begun
 * at a lite start, whose grant was made after a proof that also met the sign-up requirement. A
 * sign-in begun before the tenant switched to lite mode creates none.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  ExternalIdPError,
  ExternalIdPErrorCode,
  type ExternalIdpAuthState,
  type UpstreamProvider,
} from '../types';

const lite = vi.hoisted((): { mode: 'off' | 'always' | 'unknown' } => ({ mode: 'always' }));
const mocks = vi.hoisted(() => ({
  challengeStore: { storeChallengeRpc: vi.fn() },
  consumeAuthState: vi.fn(),
  getProvider: vi.fn(),
  handleIdentity: vi.fn(),
  exchangeCode: vi.fn(),
  fetchUserInfo: vi.fn(),
  requirement: vi.fn(),
  apply: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: vi.fn(async () => mocks.challengeStore),
    getTenantIdFromContext: vi.fn(() => 'default'),
    resolveAccountDataContextByIdentifier: vi.fn().mockResolvedValue({
      tenantId: 'default',
      accountId: 'account:user-new',
      legacyUserId: 'user-new',
      coreDb: {},
      piiDb: {},
    }),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    readLiteModeAuthoritative: vi.fn(async () => {
      if (lite.mode === 'unknown') throw new Error('policy unavailable');
      return lite.mode;
    }),
  };
});

vi.mock('../services/signup-invitation', () => ({
  externalSignupInvitationRequirement: mocks.requirement,
  applyExternalSignupInvitation: mocks.apply,
  releaseExternalSignupInvitation: mocks.release,
}));

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
import { LITE_EXTERNAL_FLOW_PREFIX } from '../services/lite-start';

const STATE = 'upstream-state-0123456789';

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
  jitProvisioning: true,
  requireEmailVerified: false,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

function signInState(overrides: Partial<ExternalIdpAuthState> = {}): ExternalIdpAuthState {
  return {
    id: 'auth-state-a',
    tenantId: 'default',
    clientId: 'client-a',
    providerId: 'provider-a',
    state: STATE,
    codeChallenge: 'code-challenge-a',
    nonce: 'nonce-a',
    codeVerifier: 'verifier-a',
    flowId: 'flow-a',
    redirectUri: 'https://login.example.com/callback',
    enableSso: false,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

const env = {
  ISSUER_URL: 'https://auth.example.com',
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

async function callback() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/callback', handleExternalCallback);
  return app.request(
    `/auth/external/corp/callback?code=upstream-code&state=${STATE}`,
    { headers: { Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}` } },
    env
  );
}

function identityResult(isNewUser: boolean) {
  return {
    status: 'ready',
    userId: isNewUser ? 'user-new' : 'user-existing',
    isNewUser,
    linkedIdentityId: 'linked-identity-a',
    stitchedFromExisting: false,
  };
}

describe('external callback for a tenant in lite mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lite.mode = 'always';
    mocks.getProvider.mockResolvedValue(provider);
    mocks.exchangeCode.mockResolvedValue({
      tokens: { access_token: 'upstream-access', token_type: 'Bearer', expires_in: 3600 },
      requestContext: {
        tokenEndpoint: 'https://idp.example.com/token',
        authMethod: 'client_secret_basic',
        authHeaderPresent: true,
      },
    });
    mocks.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'external-subject-a', email: 'new@example.com', email_verified: true },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: false,
    });
    mocks.handleIdentity.mockResolvedValue(identityResult(true));
    mocks.challengeStore.storeChallengeRpc.mockResolvedValue(undefined);
  });

  it('lets a sign-in begun at a lite start create an account', async () => {
    mocks.consumeAuthState.mockResolvedValue(
      signInState({ flowId: `${LITE_EXTERNAL_FLOW_PREFIX}flow-a` })
    );
    const response = await callback();
    expect(response.status).toBe(302);
    expect(mocks.handleIdentity.mock.calls[0][1]).not.toHaveProperty('accountCreationAllowed');
  });

  it.each(['always', 'unknown'] as const)(
    'creates no account for another sign-in when the mode is %s',
    async (mode) => {
      lite.mode = mode;
      mocks.consumeAuthState.mockResolvedValue(signInState({ flowId: 'flow-a' }));
      await callback();
      expect(mocks.handleIdentity).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ accountCreationAllowed: false })
      );
    }
  );

  it('takes no flow ID as a lite one unless it carries the prefix the start makes', async () => {
    for (const flowId of [undefined, '', 'lite', 'LITE:flow-a', ' lite:flow-a', 'xlite:flow-a']) {
      mocks.handleIdentity.mockClear();
      mocks.consumeAuthState.mockResolvedValue(signInState({ flowId }));
      await callback();
      expect(mocks.handleIdentity.mock.calls[0]?.[1]).toMatchObject({
        accountCreationAllowed: false,
      });
    }
  });

  it("sends a lite sign-in's failure to its lite callback page, not the sign-in page", async () => {
    const liteReturn = 'https://auth.example.com/callback?lite_txn=txn-1&lite_grant=grant-1';
    lite.mode = 'always';
    mocks.consumeAuthState.mockResolvedValue(
      signInState({ flowId: `${LITE_EXTERNAL_FLOW_PREFIX}flow-a`, redirectUri: liteReturn })
    );
    mocks.handleIdentity.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED, 'no')
    );
    const response = await callback();
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://auth.example.com/callback');
    expect(location.searchParams.get('lite_txn')).toBe('txn-1');
    expect(location.searchParams.get('lite_grant')).toBe('grant-1');
    expect(location.searchParams.get('error')).toBeTruthy();
  });

  it("sends any other sign-in's failure to the sign-in page as before", async () => {
    lite.mode = 'off';
    mocks.consumeAuthState.mockResolvedValue(signInState({ flowId: 'flow-a' }));
    mocks.handleIdentity.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED, 'no')
    );
    const response = await callback();
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('leaves a tenant not in lite mode as it was', async () => {
    lite.mode = 'off';
    mocks.consumeAuthState.mockResolvedValue(signInState({ flowId: 'flow-a' }));
    await callback();
    expect(mocks.handleIdentity.mock.calls[0][1]).not.toHaveProperty('accountCreationAllowed');
  });
});
