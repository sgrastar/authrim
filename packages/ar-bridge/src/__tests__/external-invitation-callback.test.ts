/**
 * External callback for a sign-in started from an invitation.
 *
 * The invitation goes only to an account the callback creates: its reserved use is applied to that
 * account before any code or session is issued, and given back when the sign-in finds an existing
 * account or fails. An invitation that names an email is passed to identity handling so no account
 * is created for another email.
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

const invitation = { inviteId: 'invite-1', inviteReservationId: 'inr-1' };

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
    ...invitation,
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

describe('external callback: a sign-in started from an invitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockResolvedValue(provider);
    mocks.consumeAuthState.mockResolvedValue(signInState());
    mocks.exchangeCode.mockResolvedValue({
      tokens: { access_token: 'upstream-access', token_type: 'Bearer', expires_in: 3600 },
      requestContext: {
        tokenEndpoint: 'https://idp.example.com/token',
        authMethod: 'client_secret_basic',
        authHeaderPresent: true,
      },
    });
    mocks.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'external-subject-a', email: 'invited@example.com', email_verified: true },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: false,
    });
    mocks.requirement.mockResolvedValue({
      invitedEmail: 'invited@example.com',
      requireVerifiedEmail: true,
    });
    mocks.handleIdentity.mockResolvedValue(identityResult(true));
    mocks.apply.mockResolvedValue(true);
    mocks.release.mockResolvedValue(undefined);
    mocks.challengeStore.storeChallengeRpc.mockResolvedValue(undefined);
  });

  it('applies the reserved use to the account it created before issuing the code', async () => {
    const response = await callback();

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    expect(mocks.requirement).toHaveBeenCalledWith(env, {
      tenantId: 'default',
      inviteId: 'invite-1',
    });
    expect(mocks.handleIdentity).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        invitation: { invitedEmail: 'invited@example.com', requireVerifiedEmail: true },
      })
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({
        ...invitation,
        tenantId: 'default',
        userId: 'user-new',
        accountCoreAdapter: expect.anything(),
      })
    );
    expect(mocks.apply.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.challengeStore.storeChallengeRpc.mock.invocationCallOrder[0]
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('gives the use back when the sign-in finds an existing account', async () => {
    mocks.handleIdentity.mockResolvedValue(identityResult(false));

    const response = await callback();

    expect(response.status).toBe(302);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(env, expect.anything(), {
      ...invitation,
      tenantId: 'default',
    });
  });

  it('gives the use back when no account is created for the invited email', async () => {
    mocks.handleIdentity.mockRejectedValue(
      new ExternalIdPError(
        ExternalIdPErrorCode.INVITATION_EMAIL_MISMATCH,
        'This invitation is for another email address.'
      )
    );

    const response = await callback();

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invitation_email_mismatch'
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(env, expect.anything(), {
      ...invitation,
      tenantId: 'default',
    });
  });

  it('handles a sign-in without an invitation as before', async () => {
    mocks.consumeAuthState.mockResolvedValue(
      signInState({ inviteId: undefined, inviteReservationId: undefined })
    );

    const response = await callback();

    expect(response.status).toBe(302);
    expect(mocks.requirement).not.toHaveBeenCalled();
    expect(mocks.handleIdentity).toHaveBeenCalledWith(
      env,
      expect.not.objectContaining({ invitation: expect.anything() })
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
