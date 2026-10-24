/**
 * External sign-ins and the failed-sign-in attempt records.
 *
 * The start endpoint checks the Flow interaction the login screen passed
 * (runtime_interaction_id) and keeps only the validated one with the auth state. The callback
 * records a failed sign-in (never a failed link) against it, with the reason in the records'
 * closed vocabulary. A sign-in that did not carry an interaction records nothing.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession, Env } from '@authrim/ar-lib-core';
import type { ExternalIdpAuthState, UpstreamProvider } from '../types';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';

type ScheduleOptions = {
  waitUntil?: unknown;
  core: unknown;
  env: unknown;
};
type RecordInput = { interactionId?: string | null; userId?: string | null } & Record<
  string,
  unknown
>;

const mocks = vi.hoisted(() => ({
  // start
  readAccountSession: vi.fn(),
  verifyHumanVerification: vi.fn(),
  consumeLinkIntent: vi.fn(),
  storeAuthState: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  findByClientId: vi.fn(),
  challengeKind: vi.fn(),
  resolveInteraction: vi.fn(),
  // callback
  consumeAuthState: vi.fn(),
  handleIdentity: vi.fn(),
  publishEvent: vi.fn(),
  resolveAccount: vi.fn(),
  exchangeCode: vi.fn(),
  fetchUserInfo: vi.fn(),
  scheduleRecord: vi.fn<(options: ScheduleOptions, input: RecordInput) => void>(),
  // both
  getProvider: vi.fn(),
  fromProvider: vi.fn(),
}));

const CORE_ADAPTER = { name: 'core-adapter' };

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    readAccountSession: mocks.readAccountSession,
    readAuthorizationChallengeKind: mocks.challengeKind,
    verifyHumanVerificationWithRunner: mocks.verifyHumanVerification,
    resolveSignInAttemptInteraction: mocks.resolveInteraction,
    scheduleSignInAttemptFailureRecord: mocks.scheduleRecord,
    publishEvent: mocks.publishEvent,
    resolveAccountDataContextByIdentifier: mocks.resolveAccount,
    getTenantIdFromContext: vi.fn(() => 'default'),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: CORE_ADAPTER,
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

vi.mock('../services/identity-stitching', () => ({
  completeExternalIdpJIT: vi.fn(),
  handleIdentity: mocks.handleIdentity,
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
  return {
    ...actual,
    storeAuthState: mocks.storeAuthState,
    consumeAuthState: mocks.consumeAuthState,
    matchesAuthStateCookie: vi.fn(() => true),
  };
});

vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: mocks.fromProvider },
}));

import { handleExternalStart } from '../handlers/start';
import { handleExternalCallback } from '../handlers/callback';

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
  jitProvisioning: true,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
};

const SETTINGS_KEY = 'settings:tenant:default:authentication-methods';

function envWith(usage?: unknown): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
    RP_TOKEN_ENCRYPTION_KEY: 'unused',
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key !== SETTINGS_KEY || usage === undefined) return null;
        return JSON.stringify({
          'authentication-methods.external_provider_usage': JSON.stringify(usage),
        });
      }),
    },
  } as unknown as Env;
}

describe('external start: the interaction a sign-in is recorded against', () => {
  const SIGN_IN = 'client_id=client-a&code_challenge=abc&code_challenge_method=S256';

  async function start(query: string, cookie?: string) {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/auth/external/:provider/start', handleExternalStart);
    return app.request(
      `/auth/external/corp/start?${query}`,
      { headers: cookie ? { Cookie: cookie } : {} },
      envWith()
    );
  }

  const storedState = () =>
    mocks.storeAuthState.mock.calls[0][1] as Omit<ExternalIdpAuthState, 'id' | 'createdAt'>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
    mocks.getProvider.mockResolvedValue({ ...provider, jitProvisioning: false });
    mocks.storeAuthState.mockResolvedValue('auth-state-id');
    mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
    mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
    mocks.findByClientId.mockResolvedValue(null);
    mocks.challengeKind.mockResolvedValue('login');
    mocks.resolveInteraction.mockResolvedValue(null);
  });

  it('stores the interaction the tenant confirmed live, checked against the core database', async () => {
    mocks.resolveInteraction.mockResolvedValue('int-1');

    const response = await start(`${SIGN_IN}&runtime_interaction_id=int-query`);

    expect(response.status).toBe(302);
    expect(mocks.resolveInteraction).toHaveBeenCalledWith(CORE_ADAPTER, {
      tenantId: 'default',
      interactionId: 'int-query',
    });
    expect(mocks.storeAuthState).toHaveBeenCalledOnce();
    expect(storedState().attemptInteractionId).toBe('int-1');
  });

  it('stores the checked id, never the raw query value', async () => {
    mocks.resolveInteraction.mockResolvedValue('int-checked');

    await start(`${SIGN_IN}&runtime_interaction_id=int-raw`);

    expect(storedState().attemptInteractionId).toBe('int-checked');
  });

  it('stores no interaction when it is not a live one of the tenant', async () => {
    mocks.resolveInteraction.mockResolvedValue(null);

    const response = await start(`${SIGN_IN}&runtime_interaction_id=int-gone`);

    expect(response.status).toBe(302);
    expect(mocks.resolveInteraction).toHaveBeenCalledOnce();
    expect(storedState().attemptInteractionId).toBeUndefined();
  });

  it('starts the sign-in, with no interaction, when the check itself fails', async () => {
    mocks.resolveInteraction.mockRejectedValue(new Error('database unavailable'));

    const response = await start(`${SIGN_IN}&runtime_interaction_id=int-1`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(storedState().attemptInteractionId).toBeUndefined();
  });

  it('stores no interaction for a start that carries none', async () => {
    const response = await start(SIGN_IN);

    expect(response.status).toBe(302);
    expect(storedState().attemptInteractionId).toBeUndefined();
  });

  it('never checks or stores an interaction on a link, which is not a sign-in', async () => {
    mocks.resolveInteraction.mockResolvedValue('int-1');
    mocks.consumeLinkIntent.mockResolvedValue({
      userId: 'user-a',
      sessionId: 'session-a',
      providerId: 'provider-a',
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    mocks.readAccountSession.mockResolvedValue({
      sessionId: 'session-a',
      userId: 'user-a',
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
      authTime: nowSeconds - 10,
    } satisfies AccountSession);

    const response = await start(
      `link_intent=${'L'.repeat(43)}&runtime_interaction_id=int-1`,
      'authrim_session=session-a'
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    expect(mocks.resolveInteraction).not.toHaveBeenCalled();
    expect(mocks.storeAuthState).toHaveBeenCalledOnce();
    expect(storedState().userId).toBe('user-a');
    expect(storedState().attemptInteractionId).toBeUndefined();
  });
});

describe('external callback: recording a failed sign-in', () => {
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
    attemptInteractionId: 'int-1',
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  };

  async function callback(query: string, env: Env = envWith()) {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/auth/external/:provider/callback', handleExternalCallback);
    return app.request(
      `/auth/external/corp/callback?${query}`,
      { headers: { Cookie: 'authrim_external_state=x' } },
      env
    );
  }

  const PROVIDER_DENIED = 'error=access_denied&state=client-state';
  const WITH_CODE = 'code=upstream-code&state=client-state';

  function errorOf(response: Response): string | null {
    return new URL(response.headers.get('location') ?? 'https://x.invalid').searchParams.get(
      'error'
    );
  }

  /** The first (and only) failure recorded, or null when the callback recorded nothing. */
  function recorded() {
    const calls = mocks.scheduleRecord.mock.calls.filter(([, input]) => input.interactionId);
    expect(calls.length).toBeLessThanOrEqual(1);
    return calls[0]?.[1] ?? null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockResolvedValue(provider);
    mocks.consumeAuthState.mockResolvedValue(authState);
    mocks.publishEvent.mockResolvedValue(undefined);
    // The client is built before the provider's answer is read; what it does is not under test
    // until a case makes it throw.
    mocks.fromProvider.mockReturnValue({});
    mocks.handleIdentity.mockReset();
    mocks.resolveAccount.mockReset();
  });

  it('records a provider refusal against the interaction as an upstream error', async () => {
    const response = await callback(PROVIDER_DENIED);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe('access_denied');
    expect(mocks.scheduleRecord).toHaveBeenCalledOnce();
    expect(mocks.scheduleRecord.mock.calls[0][1]).toEqual({
      tenantId: 'default',
      interactionId: 'int-1',
      userId: null,
      method: 'external_idp',
      dedupeKey: authState.id,
      reasonCode: 'upstream_error',
    });
  });

  it('records a callback without a code as an upstream error', async () => {
    const response = await callback('state=client-state');

    expect(errorOf(response)).toBe('invalid_request');
    expect(recorded()).toEqual({
      tenantId: 'default',
      interactionId: 'int-1',
      userId: null,
      method: 'external_idp',
      dedupeKey: authState.id,
      reasonCode: 'upstream_error',
    });
  });

  it('records a state that belongs to another provider as a challenge mismatch', async () => {
    mocks.consumeAuthState.mockResolvedValue({ ...authState, providerId: 'provider-other' });

    const response = await callback(WITH_CODE);

    expect(errorOf(response)).toBe('invalid_state');
    expect(recorded()).toMatchObject({ interactionId: 'int-1', reasonCode: 'challenge_mismatch' });
  });

  it('records nothing for a sign-in that carried no interaction', async () => {
    mocks.consumeAuthState.mockResolvedValue({ ...authState, attemptInteractionId: undefined });

    const response = await callback(PROVIDER_DENIED);

    expect(errorOf(response)).toBe('access_denied');
    expect(recorded()).toBeNull();
  });

  it('records nothing when no state could be consumed, there being no interaction to name', async () => {
    mocks.consumeAuthState.mockResolvedValue(null);

    const response = await callback(PROVIDER_DENIED);

    expect(errorOf(response)).toBe('invalid_state');
    expect(recorded()).toBeNull();
  });

  it('records nothing for a failed link, which is not a sign-in', async () => {
    const link = { ...authState, userId: 'user-a', sessionId: 'session-a' };
    mocks.consumeAuthState.mockResolvedValue(link);

    await callback(PROVIDER_DENIED);
    await callback('state=client-state');
    mocks.fromProvider.mockImplementation(() => {
      throw new Error('exchange failed');
    });
    await callback(WITH_CODE);

    expect(recorded()).toBeNull();
  });

  it('records a provider the tenant turned off after the start as a disabled method', async () => {
    const response = await callback(
      WITH_CODE,
      envWith([{ id: 'corp', providerId: 'provider-a', loginEnabled: false }])
    );

    expect(errorOf(response)).toBe('access_denied');
    expect(mocks.fromProvider).not.toHaveBeenCalled();
    expect(recorded()).toEqual({
      tenantId: 'default',
      interactionId: 'int-1',
      userId: null,
      method: 'external_idp',
      dedupeKey: authState.id,
      reasonCode: 'method_disabled',
    });
  });

  it('hands the records the tenant and the failure after the response, not before', async () => {
    await callback(PROVIDER_DENIED);

    const [options] = mocks.scheduleRecord.mock.calls[0];
    expect(typeof options.waitUntil).toBe('function');
    expect(typeof options.core).toBe('function');
    expect(options.env).toBeDefined();
  });

  describe('the account a failure is recorded with', () => {
    // A provider whose code exchange and userinfo succeed, so the sign-in reaches handleIdentity.
    function providerReturnsAnAccount() {
      mocks.exchangeCode.mockResolvedValue({
        tokens: { access_token: 'upstream-access', token_type: 'Bearer' },
        requestContext: {},
      });
      mocks.fetchUserInfo.mockResolvedValue({
        userInfo: { sub: 'upstream-sub', email: 'user@example.com' },
        endpoint: 'https://idp.example.com/userinfo',
        signedResponse: false,
      });
      mocks.fromProvider.mockReturnValue({
        exchangeCode: mocks.exchangeCode,
        fetchUserInfoWithMeta: mocks.fetchUserInfo,
      });
    }

    it('names the account identity resolution found when the sign-in fails after it', async () => {
      providerReturnsAnAccount();
      mocks.handleIdentity.mockResolvedValue({
        status: 'ready',
        userId: 'user-1',
        isNewUser: false,
      });
      // The first step after identity resolution; the smallest thing to make fail.
      mocks.resolveAccount.mockRejectedValue(new Error('account database unavailable'));

      const response = await callback(WITH_CODE);

      expect(response.status).toBe(302);
      expect(mocks.exchangeCode).toHaveBeenCalledOnce();
      expect(mocks.handleIdentity).toHaveBeenCalledOnce();
      expect(recorded()).toEqual({
        tenantId: 'default',
        interactionId: 'int-1',
        userId: 'user-1',
        method: 'external_idp',
        dedupeKey: authState.id,
        reasonCode: 'verification_failed',
      });
    });

    it('names no account for a failure before identity resolution', async () => {
      await callback(PROVIDER_DENIED);

      expect(recorded()).toMatchObject({ interactionId: 'int-1', userId: null });
      expect(mocks.handleIdentity).not.toHaveBeenCalled();
    });

    it('names no account for an exchange failure that happens before identity resolution', async () => {
      providerReturnsAnAccount();
      mocks.exchangeCode.mockRejectedValue(new Error('token endpoint unavailable'));

      await callback(WITH_CODE);

      expect(mocks.handleIdentity).not.toHaveBeenCalled();
      expect(recorded()).toMatchObject({ interactionId: 'int-1', userId: null });
    });

    it('names no account when identity resolution itself fails', async () => {
      providerReturnsAnAccount();
      mocks.handleIdentity.mockRejectedValue(
        new ExternalIdPError(ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'x')
      );

      await callback(WITH_CODE);

      expect(recorded()).toMatchObject({
        userId: null,
        reasonCode: 'account_not_linked',
      });
    });
  });

  describe('the reason a failure inside the sign-in is recorded with', () => {
    it.each([
      [
        'a provider error',
        new ExternalIdPError(ExternalIdPErrorCode.PROVIDER_ERROR, 'x'),
        'upstream_error',
      ],
      [
        'a policy denial',
        new ExternalIdPError(ExternalIdPErrorCode.POLICY_ACCESS_DENIED, 'x'),
        'policy_denied',
      ],
      [
        'an unmet assurance level',
        new ExternalIdPError(ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED, 'x'),
        'assurance_not_met',
      ],
      [
        'an account that could not be created',
        new ExternalIdPError(ExternalIdPErrorCode.ACCOUNT_CREATION_FAILED, 'x'),
        'provisioning_failed',
      ],
      [
        'an account that has to be linked first',
        new ExternalIdPError(ExternalIdPErrorCode.ACCOUNT_EXISTS_LINK_REQUIRED, 'x'),
        'account_not_linked',
      ],
      [
        'an unverified email',
        new ExternalIdPError(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED, 'x'),
        'email_not_verified',
      ],
      [
        'sign-up that is off',
        new ExternalIdPError(ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED, 'x'),
        'signup_disabled',
      ],
      [
        'settings that could not be read',
        new ExternalIdPError(ExternalIdPErrorCode.SETTINGS_UNAVAILABLE, 'x'),
        'service_unavailable',
      ],
      [
        'an invitation for another email',
        new ExternalIdPError(ExternalIdPErrorCode.INVITATION_EMAIL_MISMATCH, 'x'),
        'provisioning_failed',
      ],
      ['an acr mismatch in a plain error', new Error('acr mismatch'), 'assurance_not_met'],
      ['any other error', new Error('boom'), 'verification_failed'],
    ])('%s', async (_label, thrown, reasonCode) => {
      mocks.fromProvider.mockImplementation(() => {
        throw thrown;
      });

      const response = await callback(WITH_CODE);

      expect(response.status).toBe(302);
      expect(recorded()).toEqual({
        tenantId: 'default',
        interactionId: 'int-1',
        userId: null,
        method: 'external_idp',
        dedupeKey: authState.id,
        reasonCode,
      });
    });
  });
});
