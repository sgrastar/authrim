/**
 * Resuming a provisioning that an earlier external sign-in left pending, and the tenant's
 * per-provider sign-in and sign-up switches (authentication-methods.external_provider_usage).
 *
 * The account was provisioned when the switches allowed it; they may be turned off before the
 * browser comes back. The resume decides them again, before the identity is activated and before
 * any session or artifact is made. A sign-in's handoff artifact names its provider so that
 * redeeming it checks the sign-in switch once more.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const lite = vi.hoisted((): { mode: 'off' | 'always' | 'unknown' } => ({ mode: 'off' }));
const mocks = vi.hoisted(() => ({
  getChallengeStore: vi.fn(),
  getSessionStore: vi.fn(),
  completeJit: vi.fn(),
  getProvider: vi.fn(),
  createSession: vi.fn(),
}));

// The sign-in's Flow (its profiles): the tenant's own, as with no Flow.
vi.mock('../services/external-email-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/external-email-check')>()),
  externalSessionProfile: vi.fn(async () => ({
    allowed: true,
    profiled: {
      ttl: { seconds: 3600, milliseconds: 3_600_000, key: 'session.default_ttl' },
      snapshot: { session_extension: { enabled: true, max_lifetime_ms: 2_592_000_000 } },
    },
  })),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: mocks.getChallengeStore,
    getSessionStoreForNewSession: mocks.getSessionStore,
    resolveSessionTtl: vi.fn().mockResolvedValue({ seconds: 3600 }),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      async findById() {
        return { id: 'user-a', email: 'person@example.com' };
      }
    },
    registerExternalProviderSession: vi.fn().mockResolvedValue(undefined),
    resolveAccountDataContextByIdentifier: vi.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: {},
      piiDb: {},
    }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    readLiteModeAuthoritative: vi.fn(async () => {
      if (lite.mode === 'unknown') throw new Error('policy unavailable');
      return lite.mode;
    }),
  };
});

vi.mock('../services/identity-stitching', () => ({
  completeExternalIdpJIT: mocks.completeJit,
  handleIdentity: vi.fn(),
}));

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.getProvider,
}));

import { handleExternalProvisioningResume } from '../handlers/callback';
import { encrypt } from '../utils/crypto';

const ENCRYPTION_KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const TOKEN = 'A'.repeat(43);
const SETTINGS_KEY = 'settings:tenant:tenant-a:authentication-methods';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function resume(options: {
  usage?: unknown;
  enableSso?: boolean;
  reauth?: boolean;
  flowId?: string;
}) {
  const digest = await sha256Hex(TOKEN);
  const challengeId = `external_idp_provisioning:${digest}`;
  const continuation = {
    schemaVersion: 1,
    authState: {
      id: 'auth-state-a',
      tenantId: 'tenant-a',
      clientId: 'client-a',
      providerId: 'provider-a',
      state: 'client-state-a',
      codeChallenge: 'code-challenge-a',
      redirectUri: 'https://login.example.com/callback',
      enableSso: options.enableSso ?? false,
      ...(options.flowId ? { flowId: options.flowId } : {}),
      ...(options.reauth ? { reauthChallengeId: 'reauth_1', reauthRequestedAt: Date.now() } : {}),
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    },
    providerId: 'provider-a',
    userInfo: { sub: 'provider-user-a', email: 'person@example.com', email_verified: true },
    result: {
      status: 'pending',
      userId: 'user-a',
      isNewUser: true,
      stitchedFromExisting: false,
      accountId: 'account:user-a',
      operationId: 'account-create-operation-a',
      providerId: 'provider-a',
      providerUserId: 'provider-user-a',
    },
  };
  const consumeChallengeRpc = vi.fn().mockResolvedValue({ userId: 'user-a' });
  const storeChallengeRpc = vi.fn().mockResolvedValue(undefined);
  mocks.getChallengeStore.mockResolvedValue({
    getChallengeRpc: vi.fn().mockResolvedValue({
      id: challengeId,
      tenantId: 'tenant-a',
      type: 'external_idp_provisioning_resume',
      userId: 'user-a',
      challenge: digest,
      consumed: false,
      expiresAt: Date.now() + 60_000,
      metadata: {
        encrypted_payload: await encrypt(JSON.stringify(continuation), ENCRYPTION_KEY),
      },
    }),
    consumeChallengeRpc,
    storeChallengeRpc,
  });
  const app = new Hono<{ Bindings: Env }>();
  app.get('/resume', handleExternalProvisioningResume);
  const response = await app.request(
    `/resume?token=${TOKEN}&tenant=tenant-a`,
    { headers: { Cookie: `authrim_external_provisioning_${digest.slice(0, 24)}=${digest}` } },
    {
      RP_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      ISSUER_URL: 'https://auth.example.com',
      SETTINGS: {
        get: vi.fn(async (key: string) => {
          if (key !== SETTINGS_KEY || options.usage === undefined) return null;
          if (options.usage === 'unreadable') return '{';
          return JSON.stringify({
            'authentication-methods.external_provider_usage': JSON.stringify(options.usage),
          });
        }),
      },
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
        getExternalIdpAccountProvisioningStatus: vi.fn().mockResolvedValue({
          status: 'ready',
          operationId: 'account-create-operation-a',
          accountId: 'account:user-a',
          userId: 'user-a',
        }),
      },
    } as unknown as Env
  );
  return { response, consumeChallengeRpc, storeChallengeRpc };
}

const entry = (fields: Record<string, unknown>) => [
  { id: 'corp', providerId: 'provider-a', ...fields },
];

function errorOf(response: Response): string | null {
  return new URL(response.headers.get('location') ?? 'https://x.invalid').searchParams.get('error');
}

describe("external provisioning resume: the tenant's sign-in and sign-up switches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lite.mode = 'off';
    mocks.completeJit.mockResolvedValue({
      linkedIdentityId: 'external-link-a',
      roles_assigned: [],
      orgs_joined: [],
    });
    mocks.getProvider.mockResolvedValue({
      id: 'provider-a',
      slug: 'corp',
      tenantId: 'tenant-a',
      name: 'Provider A',
      providerType: 'oidc',
      enabled: true,
      priority: 0,
      clientId: 'upstream-client-a',
      clientSecretEncrypted: 'encrypted-secret',
      scopes: 'openid',
      attributeMapping: {},
      autoLinkEmail: false,
      jitProvisioning: true,
      requireEmailVerified: true,
      providerQuirks: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mocks.createSession.mockResolvedValue(undefined);
    mocks.getSessionStore.mockResolvedValue({
      sessionId: 'session-a',
      stub: { createSessionRpc: mocks.createSession },
    });
  });

  it.each([
    ['sign-up', { signupEnabled: false }, 'external_signup_disabled'],
    [
      'sign-in and sign-up',
      { loginEnabled: false, signupEnabled: false },
      'external_signup_disabled',
    ],
  ])(
    'activates nothing and makes no code when the tenant turned %s off since',
    async (_label, fields, error) => {
      const { response, consumeChallengeRpc, storeChallengeRpc } = await resume({
        usage: entry(fields),
      });

      expect(response.status).toBe(302);
      expect(errorOf(response)).toBe(error);
      expect(response.headers.get('location')).not.toContain('code=');
      expect(mocks.completeJit).not.toHaveBeenCalled();
      expect(consumeChallengeRpc).not.toHaveBeenCalled();
      expect(storeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    }
  );

  it.each(['always', 'unknown'] as const)(
    'finishes no account a sign-in begun outside a lite start left pending, when the mode is %s',
    async (mode) => {
      lite.mode = mode;
      const { response, consumeChallengeRpc, storeChallengeRpc } = await resume({
        flowId: 'flow-before-the-switch',
      });
      // The resume answers its failures as one error; nothing is finished.
      expect(errorOf(response)).toBeTruthy();
      expect(response.headers.get('location')).not.toContain('code=');
      expect(mocks.completeJit).not.toHaveBeenCalled();
      expect(consumeChallengeRpc).not.toHaveBeenCalled();
      expect(storeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    }
  );

  it('finishes the account of a sign-in begun at a lite start', async () => {
    lite.mode = 'always';
    const { response } = await resume({ flowId: 'lite:flow-a' });
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    expect(mocks.completeJit).toHaveBeenCalledOnce();
  });

  it('finishes the account with a provider for sign-up only: finishing it is its creation', async () => {
    const { response } = await resume({
      usage: entry({ loginEnabled: false, signupEnabled: true }),
    });

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    expect(mocks.completeJit).toHaveBeenCalledOnce();
  });

  it('answers temporarily_unavailable, activating nothing, when the switches cannot be read', async () => {
    const { response, storeChallengeRpc } = await resume({ usage: 'unreadable' });

    expect(errorOf(response)).toBe('temporarily_unavailable');
    expect(mocks.completeJit).not.toHaveBeenCalled();
    expect(storeChallengeRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing saved for the tenant', undefined],
    ['an entry that leaves the switches out', entry({ reauthEnabled: false })],
    ['both on', entry({ loginEnabled: true, signupEnabled: true })],
  ])('resumes as before with %s', async (_label, usage) => {
    const { response, storeChallengeRpc } = await resume({ usage });

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    expect(mocks.completeJit).toHaveBeenCalledOnce();
    expect(storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct_auth_code' })
    );
  });

  it("leaves a re-authentication's sign-in to its own switch, but sign-up still holds", async () => {
    const allowed = await resume({ usage: entry({ loginEnabled: false }), reauth: true });
    expect(mocks.completeJit).toHaveBeenCalledOnce();
    expect(
      new URL(allowed.response.headers.get('location') ?? '').searchParams.get('code')
    ).toBeTruthy();

    mocks.completeJit.mockClear();
    const refused = await resume({ usage: entry({ signupEnabled: false }), reauth: true });
    expect(errorOf(refused.response)).toBe('external_signup_disabled');
    expect(mocks.completeJit).not.toHaveBeenCalled();
  });

  it("names the provider in the sign-in's handoff artifact, so redeeming it checks the switch again", async () => {
    const { response, storeChallengeRpc } = await resume({ enableSso: true });

    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('handoff_token')
    ).toBeTruthy();
    const handoff = storeChallengeRpc.mock.calls
      .map(([request]) => request as { type: string; metadata: Record<string, unknown> })
      .find((request) => request.type === 'handoff');
    expect(handoff?.metadata).toMatchObject({
      aud: 'handoff',
      external_provider_usage_key: { providerId: 'provider-a', ids: ['provider-a', 'corp'] },
      // The sign-in created the account: redeeming it takes the sign-up switch too.
      external_provider_usage: 'signup',
    });
  });

  it('names no provider in the artifact of a re-authentication, which has its own switch', async () => {
    const { storeChallengeRpc } = await resume({ enableSso: true, reauth: true });

    const handoff = storeChallengeRpc.mock.calls
      .map(([request]) => request as { type: string; metadata: Record<string, unknown> })
      .find((request) => request.type === 'handoff');
    expect(handoff).toBeDefined();
    expect(handoff?.metadata).not.toHaveProperty('external_provider_usage_key');
  });
});
