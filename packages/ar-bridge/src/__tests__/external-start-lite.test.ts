/**
 * External start for a tenant in lite mode.
 *
 * Such a tenant starts external sign-in only from the lite Login UI, by the one-time start grant
 * ar-auth made for the browser's lite transaction after the page's proof of work. The start
 * consumes the grant before anything else is done (no link intent spent, no OAuth state made
 * without it), then takes everything from the transaction and the grant: nothing from its query.
 */
import { Hono } from 'hono';
import type { Env, LiteTxnSnapshot } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalIdpAuthState, UpstreamProvider } from '../types';

const lite = vi.hoisted((): { mode: 'off' | 'always' | 'unknown' } => ({ mode: 'always' }));
const mocks = vi.hoisted(() => ({
  consumeGrant: vi.fn(),
  verifyHumanVerification: vi.fn(),
  consumeLinkIntent: vi.fn(),
  reserveInvitation: vi.fn(),
  getProvider: vi.fn(),
  storeAuthState: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  fromProvider: vi.fn(),
  findByClientId: vi.fn(),
  challengeKind: vi.fn(),
  resolveInteraction: vi.fn(),
  answersChallenge: vi.fn(),
  reauthPolicy: vi.fn(),
  usageGate: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // The runtime cache says off: a start must go by the store's answer now.
    readLiteModeState: vi.fn(async () => 'off'),
    readLiteModeAuthoritative: vi.fn(async () => {
      if (lite.mode === 'unknown') throw new Error('policy unavailable');
      return lite.mode;
    }),
    consumeLiteStartGrant: mocks.consumeGrant,
    verifyHumanVerificationWithRunner: mocks.verifyHumanVerification,
    readAuthorizationChallengeKind: mocks.challengeKind,
    readExternalProviderReauthPolicy: mocks.reauthPolicy,
    resolveSignInAttemptInteraction: mocks.resolveInteraction,
    assertInteractionAnswersChallenge: mocks.answersChallenge,
    getTenantIdFromContext: vi.fn(() => 'default'),
    getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://auth.example.com' }),
    createDiagnosticLoggerFromContext: vi.fn().mockResolvedValue(null),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: {},
      repositories: { client: { findByClientId: mocks.findByClientId } },
    })),
  };
});
vi.mock('../services/link-intent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/link-intent')>();
  return { ...actual, consumeLinkIntent: mocks.consumeLinkIntent };
});
vi.mock('../services/signup-invitation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/signup-invitation')>();
  return { ...actual, reserveExternalSignupInvitation: mocks.reserveInvitation };
});
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));
vi.mock('../services/external-usage-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/external-usage-gate')>();
  return { ...actual, assertExternalProviderUsageAllowed: mocks.usageGate };
});
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
vi.mock('../clients/oidc-client', () => ({ OIDCRPClient: { fromProvider: mocks.fromProvider } }));

import { handleExternalStart } from '../handlers/start';
import { isLiteExternalFlow, LITE_EXTERNAL_FLOW_PREFIX } from '../services/lite-start';

const ORIGIN = 'https://auth.example.com';
const BINDING = 'b'.repeat(43);
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

const txn: LiteTxnSnapshot = {
  id: 'txn-1',
  bound: {
    tenantId: 'default',
    publicOrigin: ORIGIN,
    purpose: 'login',
    clientId: 'rp-client',
    challengeId: 'challenge-1',
    returnTo: null,
    policyRevision: 'rev-1',
    sessionId: null,
    userId: null,
  },
  state: 'open',
  version: 1,
  csrfToken: 'csrf',
  data: {},
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
};

const env = {
  ISSUER_URL: ORIGIN,
  RP_TOKEN_ENCRYPTION_KEY: 'unused',
  SETTINGS: { get: async () => null, put: async () => undefined },
} as unknown as Env;

/** Everything a start in another mode reads from its query, all of which a lite start ignores. */
const PUBLIC_QUERY = new URLSearchParams({
  redirect_uri: 'https://evil.example/steal',
  client_id: 'attacker-client',
  code_challenge: 'attacker-challenge',
  code_challenge_method: 'S256',
  link_intent: 'link-1',
  invite_token: 'invite-1',
  prompt: 'none',
  login_hint: 'victim@example.com',
  max_age: '5',
  acr_values: 'urn:acr',
  authorization_challenge_id: 'attacker-challenge-id',
  runtime_interaction_id: 'attacker-interaction',
  human_verification_response: 'x',
  flow_id: `${LITE_EXTERNAL_FLOW_PREFIX}forged`,
  state: 'rp-state',
}).toString();

function start(
  path: string,
  query: string,
  cookie: string | null = `__Host-authrim_lite=${BINDING}`
) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/auth/external/:provider/start', (c) => handleExternalStart(c));
  return app.request(
    `/auth/external/${path}/start?${query}`,
    cookie ? { headers: { cookie } } : {},
    env
  );
}

function storedAuthState(): Omit<ExternalIdpAuthState, 'id' | 'createdAt'> {
  return mocks.storeAuthState.mock.calls[0][1] as Omit<ExternalIdpAuthState, 'id' | 'createdAt'>;
}

beforeEach(() => {
  vi.clearAllMocks();
  lite.mode = 'always';
  mocks.consumeGrant.mockResolvedValue({
    ok: true,
    txn,
    start: { clientId: 'login-ui', interactionId: 'interaction-1' },
  });
  mocks.verifyHumanVerification.mockResolvedValue({ verified: true });
  mocks.usageGate.mockResolvedValue(undefined);
  mocks.getProvider.mockResolvedValue(provider);
  mocks.storeAuthState.mockResolvedValue('auth-state-id');
  mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
  mocks.fromProvider.mockReturnValue({ createAuthorizationUrl: mocks.createAuthorizationUrl });
  mocks.findByClientId.mockResolvedValue(null);
  mocks.challengeKind.mockResolvedValue('login');
  mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
  mocks.resolveInteraction.mockImplementation(
    async (_db: unknown, input: { interactionId: string }) => input.interactionId
  );
  mocks.answersChallenge.mockResolvedValue(undefined);
});

describe('external start for a tenant in lite mode', () => {
  it.each([
    ['signup', 'login', 'signup'],
    ['login', 'signup', 'login'],
  ] as const)(
    "checks the switch for its transaction's purpose (%s), never the query's (%s)",
    async (purpose, queried, usage) => {
      mocks.consumeGrant.mockResolvedValue({
        ok: true,
        txn: { ...txn, bound: { ...txn.bound, purpose } },
        start: { clientId: 'login-ui', interactionId: null },
      });
      const response = await start(
        'provider-a',
        `lite_txn=txn-1&lite_grant=grant-1&purpose=${queried}&prompt=none`
      );
      expect(response.status).toBe(302);
      expect(mocks.usageGate).toHaveBeenCalledOnce();
      expect(mocks.usageGate.mock.calls[0][3]).toBe(usage);
    }
  );

  it.each(['always', 'unknown'] as const)(
    'refuses it without a grant it can consume when the mode is %s',
    async (mode) => {
      lite.mode = mode;
      mocks.consumeGrant.mockResolvedValue({ ok: false, reason: 'grant_invalid' });
      const query = new URLSearchParams(PUBLIC_QUERY);
      query.delete('link_intent');
      const response = await start('provider-a', query.toString());
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: 'lite_mode_endpoint_unavailable' });
      expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
      expect(mocks.consumeLinkIntent).not.toHaveBeenCalled();
      expect(mocks.reserveInvitation).not.toHaveBeenCalled();
      expect(mocks.getProvider).not.toHaveBeenCalled();
      expect(mocks.storeAuthState).not.toHaveBeenCalled();
    }
  );

  it('consumes the grant named by the query, for this browser binding and the provider', async () => {
    await start('provider-a', `lite_txn=txn-1&lite_grant=grant-1&${PUBLIC_QUERY}`);
    expect(mocks.consumeGrant).toHaveBeenCalledWith(env, {
      tenantId: 'default',
      binding: BINDING,
      txnId: 'txn-1',
      grantId: 'grant-1',
      provider: 'provider-a',
    });
  });

  it('passes on no binding when the browser sent none', async () => {
    mocks.consumeGrant.mockResolvedValue({ ok: false, reason: 'invalid_binding' });
    const response = await start('provider-a', 'lite_txn=txn-1&lite_grant=grant-1', null);
    expect(response.status).toBe(403);
    expect(mocks.consumeGrant.mock.calls[0][1]).toMatchObject({ binding: undefined });
  });

  it.each(['always', 'unknown'] as const)(
    'takes a link from the account page by its intent alone when the mode is %s',
    async (mode) => {
      lite.mode = mode;
      // An intent no longer usable (or never made): back to the account page, nothing started.
      mocks.consumeLinkIntent.mockResolvedValue(null);
      const response = await start('provider-a', PUBLIC_QUERY);
      expect(response.status).toBe(302);
      const location = new URL(String(response.headers.get('location')));
      expect(location.pathname).toBe('/account');
      expect(location.searchParams.get('social_link')).toBe('error');
      expect(location.searchParams.get('reason')).toBe('session_expired');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(mocks.consumeLinkIntent).toHaveBeenCalledWith(env, 'default', 'link-1');
      // Not a lite start (no grant is asked for), and no sign-in: no proof, no state stored.
      expect(mocks.consumeGrant).not.toHaveBeenCalled();
      expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
      expect(mocks.reserveInvitation).not.toHaveBeenCalled();
      expect(mocks.storeAuthState).not.toHaveBeenCalled();
    }
  );

  it('starts from the transaction and the grant, ignoring every public parameter', async () => {
    const response = await start('provider-a', `lite_txn=txn-1&lite_grant=grant-1&${PUBLIC_QUERY}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(IDP_AUTHORIZE);
    // No human verification here (the grant was made after it), no link, no invitation.
    expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
    expect(mocks.consumeLinkIntent).not.toHaveBeenCalled();
    expect(mocks.reserveInvitation).not.toHaveBeenCalled();
    // The challenge it answers is the transaction's.
    expect(mocks.challengeKind).toHaveBeenCalledWith(env, 'default', 'challenge-1');
    const stored = storedAuthState();
    expect(stored).toMatchObject({
      clientId: 'login-ui',
      providerId: 'provider-a',
      redirectUri: `${ORIGIN}/callback?lite_txn=txn-1&lite_grant=grant-1`,
      attemptInteractionId: 'interaction-1',
      // The request it answers, for the callback to hold the sign-in to.
      flowChallengeId: 'challenge-1',
    });
    // The interaction was started for that request.
    expect(mocks.answersChallenge).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'interaction-1',
      'challenge-1'
    );
    expect(stored.userId).toBeUndefined();
    expect(stored.sessionId).toBeUndefined();
    expect(stored.prompt).toBeUndefined();
    expect(stored.maxAge).toBeUndefined();
    expect(stored.acrValues).toBeUndefined();
    expect(stored.inviteId).toBeUndefined();
    // The Bridge's own PKCE challenge, not the query's.
    expect(stored.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(stored.codeChallenge).not.toBe('attacker-challenge');
    expect(isLiteExternalFlow(stored.flowId)).toBe(true);
    expect(stored.flowId).not.toBe(`${LITE_EXTERNAL_FLOW_PREFIX}forged`);
    const authorization = mocks.createAuthorizationUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(authorization).toMatchObject({ prompt: undefined, loginHint: undefined });
  });

  it('refuses an interaction that was started for another request', async () => {
    const { InteractionChallengeMismatchError } = await import('@authrim/ar-lib-core');
    mocks.answersChallenge.mockRejectedValueOnce(new InteractionChallengeMismatchError());
    const response = await start('provider-a', 'lite_txn=txn-1&lite_grant=grant-1');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'authorization_challenge_mismatch' });
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it("reserves the invitation its grant carries (the sign-up's), never the query's", async () => {
    mocks.consumeGrant.mockResolvedValue({
      ok: true,
      txn,
      start: { clientId: 'login-ui', interactionId: 'interaction-1', inviteToken: 'grant-invite' },
    });
    mocks.reserveInvitation.mockResolvedValue({ id: 'reservation-1' });
    const response = await start('provider-a', `lite_txn=txn-1&lite_grant=grant-1&${PUBLIC_QUERY}`);
    expect(response.status).toBe(302);
    expect(mocks.reserveInvitation).toHaveBeenCalledTimes(1);
    expect(mocks.reserveInvitation.mock.calls[0][1]).toMatchObject({ token: 'grant-invite' });
  });

  it('starts no re-authentication (its proof was not made for one)', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');
    const response = await start('provider-a', 'lite_txn=txn-1&lite_grant=grant-1');
    expect(response.status).toBe(403);
    expect(mocks.challengeKind).toHaveBeenCalledWith(env, 'default', 'challenge-1');
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('refuses a provider without SSO, whose code no one here can exchange', async () => {
    mocks.getProvider.mockResolvedValue({ ...provider, enableSso: false });
    const response = await start('provider-a', 'lite_txn=txn-1&lite_grant=grant-1');
    expect(response.status).toBe(403);
    expect(mocks.storeAuthState).not.toHaveBeenCalled();
  });

  it('takes the provider by the ID or slug its grant was made for, as the SPA start does', async () => {
    const response = await start('corp', 'lite_txn=txn-1&lite_grant=grant-1');
    expect(response.status).toBe(302);
    // The grant is consumed for the name in the path, the one the lite page's grant named.
    expect(mocks.consumeGrant.mock.calls[0][1]).toMatchObject({ provider: 'corp' });
    expect(storedAuthState()).toMatchObject({ providerId: 'provider-a' });
  });
});

describe('external start for a tenant not in lite mode', () => {
  it('never makes a lite flow ID, whatever its query says', async () => {
    lite.mode = 'off';
    const query = new URLSearchParams({
      client_id: 'client-a',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      flow_id: `${LITE_EXTERNAL_FLOW_PREFIX}forged`,
      flowId: `${LITE_EXTERNAL_FLOW_PREFIX}forged`,
      diagnostic_flow_id: `${LITE_EXTERNAL_FLOW_PREFIX}forged`,
      lite_txn: 'txn-1',
      lite_grant: 'grant-1',
    }).toString();
    const response = await start('corp', query);
    expect(response.status).toBe(302);
    expect(mocks.consumeGrant).not.toHaveBeenCalled();
    const stored = storedAuthState();
    expect(stored.flowId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(isLiteExternalFlow(stored.flowId)).toBe(false);
  });
});
