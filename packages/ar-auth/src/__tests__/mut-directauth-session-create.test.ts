import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * directSessionCreateHandler: the artifact's bindings (client, channel, provider, PKCE), the user
 * and guest checks, the Flow profile it follows, and what the session keeps of the proof.
 */
const lifecycleGate = vi.hoisted(() => vi.fn());
const runtimeUserFound = vi.hoisted(() => ({ value: true }));
const challengeStore = vi.hoisted(() => ({
  consumeChallengeRpc: vi.fn(),
  storeChallengeRpc: vi.fn(),
  getChallengeRpc: vi.fn(async () => undefined),
}));
const sessionStore = vi.hoisted(() => ({ createSessionRpc: vi.fn() }));
const flowProfiles = vi.hoisted(() => {
  const ttl = {
    ttl: { seconds: 3600, milliseconds: 3600 * 1000, key: 'session.ttl.direct_auth' },
    snapshot: { session_extension: { enabled: false } },
  };
  return {
    allows: vi.fn(async (..._args: unknown[]) => true),
    forInteraction: vi.fn(async () => ttl),
    forProfile: vi.fn(async () => ({ ...ttl, ttl: { ...ttl.ttl, seconds: 7200 } })),
  };
});

vi.mock('../flow-session-profile', () => ({
  interactionAllowsSignInMethod: flowProfiles.allows,
  sessionTtlForInteraction: flowProfiles.forInteraction,
  sessionTtlForProfile: flowProfiles.forProfile,
  sessionForChallenge: vi.fn(),
  namedInteractionChallengeRefusal: vi.fn(async () => null),
  interactionChallengeMismatchResponse: (c: {
    json: (body: unknown, status: number) => Response;
  }) => c.json({ error: 'authorization_challenge_mismatch' }, 403),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const auth = () => ({
    coreAdapter: { queryOne: vi.fn(async () => null) },
    repositories: { userCore: { findById: vi.fn(async () => ({ id: 'user_123' })) } },
  });
  return {
    ...actual,
    assertGuestCredentialAuthenticationAllowed: lifecycleGate,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        if (!runtimeUserFound.value) return null;
        return { id: userId, active: 1, email: 'user@example.com', name: 'Example User' };
      }
    },
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: sessionStore,
      sessionId: 'sess_new',
      resolution: {},
      instanceName: 'session-store',
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    createAuthContextFromHono: vi.fn(auth),
    createAccountAuthContextFromHono: vi.fn(auth),
    createPIIContextFromHono: vi.fn(() => ({ piiRepositories: {} })),
    hasPIIDatabase: vi.fn(() => true),
    generateBrowserState: vi.fn(async () => 'browser-state'),
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({ module: () => ({ warn: vi.fn(), error: vi.fn() }) })),
  };
});

async function s256(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

const VERIFIER = 'verifier-for-mut-direct-session-create';

function createContext(body: Record<string, unknown>) {
  const headers = new Headers();
  const request = new Request('https://auth.example.com/api/v1/auth/direct/session');
  return {
    req: { url: request.url, raw: request, json: vi.fn(async () => body) },
    env: {},
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant_test' : undefined)),
    header: (name: string, value: string) => headers.append(name, value),
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers }),
  };
}

async function artifact(metadata: Record<string, unknown>, challenge?: string) {
  challengeStore.consumeChallengeRpc.mockResolvedValue({
    challenge: challenge ?? (await s256(VERIFIER)),
    userId: 'user_123',
    metadata: { client_id: 'login-ui', channel: 'browser', method: 'passkey', ...metadata },
  });
}

async function finish(extra: Record<string, unknown> = {}) {
  const { directSessionCreateHandler } = await import('../direct-auth');
  const response = await directSessionCreateHandler(
    createContext({
      direct_auth_artifact: 'artifact_1',
      client_id: 'login-ui',
      code_verifier: VERIFIER,
      channel: 'browser',
      defer_authorization_continuation: true,
      ...extra,
    }) as never
  );
  return { response, body: await response.json<Record<string, unknown>>() };
}

function sessionData(): Record<string, unknown> {
  return sessionStore.createSessionRpc.mock.calls.at(-1)?.[3] as Record<string, unknown>;
}

describe('Direct Auth session create (mutation hardening)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeUserFound.value = true;
    lifecycleGate.mockResolvedValue(undefined);
    sessionStore.createSessionRpc.mockResolvedValue({ id: 'sess_new' });
  });

  it.each([
    [{ client_id: undefined }, ['client_id']],
    [{ channel: undefined }, ['channel']],
    [{ code_verifier: '' }, ['code_verifier']],
  ])('names only the field that is missing (%#)', async (override, missing) => {
    const { response, body } = await finish(override);
    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_request',
      error_description: `Missing required fields: ${missing.join(', ')}`,
      error_details: { code: 'DIRECT_SESSION_REQUIRED_FIELDS_MISSING', missing_fields: missing },
    });
    expect(challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a channel other than browser with its own code', async () => {
    const { response, body } = await finish({ channel: 'native' });
    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_request',
      error_description: 'managed browser session finish requires channel=browser',
      error_details: { code: 'DIRECT_SESSION_INVALID_CHANNEL', expected: 'browser' },
    });
    expect(challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('consumes the artifact as a direct auth code of the tenant', async () => {
    await artifact({});
    await finish();
    expect(challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'direct_auth:artifact_1',
      tenantId: 'tenant_test',
      type: 'direct_auth_code',
    });
  });

  it('refuses an artifact that cannot be consumed', async () => {
    challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('Challenge not found'));
    const { response, body } = await finish();
    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_grant',
      error_description: 'Direct Auth artifact is invalid or expired',
    });
  });

  it.each([
    [{ client_id: 'other-client' }, 'Direct Auth artifact client binding mismatch'],
    [{ channel: 'native' }, 'Direct Auth artifact channel binding mismatch'],
  ])('refuses an artifact bound elsewhere (%#)', async (metadata, description) => {
    await artifact(metadata);
    const { response, body } = await finish();
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_grant', error_description: description });
    expect(sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['provider_id', undefined],
    ['provider_slug', 'github'],
    ['provider', 'github'],
  ])('holds an artifact bound by %s to its provider', async (key, requested) => {
    await artifact({ method: 'external_idp', [key]: 'google' });
    const { response, body } = await finish(requested ? { provider_id: requested } : {});
    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_grant',
      error_description: 'Direct Auth artifact provider binding mismatch',
    });
  });

  it('takes an artifact for the provider it was bound to, as that provider’s method', async () => {
    await artifact({ method: 'external_idp', provider_slug: 'google', provider_id: '' });
    const { response } = await finish({ provider_id: 'google' });
    expect(response.status).toBe(200);
    expect(flowProfiles.allows.mock.calls[0]?.[3]).toBe('google');
    expect(sessionData().amr).toEqual(['external_idp']);
  });

  it('refuses a code verifier that does not match the artifact', async () => {
    await artifact({}, await s256('another-verifier'));
    const { response, body } = await finish();
    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_grant',
      error_description: 'Direct Auth artifact PKCE verification failed',
    });
  });

  it('refuses an artifact whose user is gone', async () => {
    runtimeUserFound.value = false;
    await artifact({});
    const { response, body } = await finish();
    expect(response.status).toBe(400);
    expect(body.error_code).toBe('AR030001');
    expect(lifecycleGate).not.toHaveBeenCalled();
  });

  it('refuses a guest that may not sign in, and reports a lifecycle it cannot read', async () => {
    await artifact({});
    lifecycleGate.mockRejectedValueOnce(new Error('account_authentication_not_allowed'));
    const denied = await finish();
    expect(denied.body.error_code).toBe('AR030001');

    lifecycleGate.mockRejectedValueOnce(new Error('database down'));
    const unavailable = await finish();
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication state unavailable.',
    });
    expect(sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ method: 'passkey_signup' }, 'passkey', 'signup'],
    [{ method: 'email_code', usage: 'signup' }, 'email_code', 'signup'],
    [{ method: 'passkey' }, 'passkey', 'login'],
    [{ method: undefined }, 'unknown', 'login'],
  ])('reports the method and usage a Flow refused (%#)', async (metadata, method, usage) => {
    await artifact(metadata);
    flowProfiles.allows.mockResolvedValueOnce(false);
    const { response, body } = await finish();
    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      error_code: 'AR050006',
      authentication_method: method,
      usage,
    });
  });

  it('reports a Flow profile it cannot read', async () => {
    await artifact({});
    flowProfiles.forInteraction.mockRejectedValueOnce(new Error('profile store down'));
    const { response, body } = await finish();
    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Session settings are unavailable.',
    });
  });

  it('follows the registration profile only for a sign-up made outside an interaction', async () => {
    await artifact({ method: 'passkey_signup', runtime_interaction_id: 'interaction_1' });
    await finish();
    expect(flowProfiles.forInteraction).toHaveBeenCalledTimes(1);
    expect(flowProfiles.forProfile).not.toHaveBeenCalled();
    expect(sessionStore.createSessionRpc.mock.calls[0]?.[2]).toBe(3600);
    expect(sessionData().runtime_interaction_id).toBe('interaction_1');

    await artifact({ method: 'passkey' });
    await finish();
    expect(flowProfiles.forProfile).not.toHaveBeenCalled();
    expect(sessionData()).not.toHaveProperty('runtime_interaction_id');
  });

  it('names the session method direct_auth when the artifact names none', async () => {
    await artifact({ method: undefined });
    const { body } = await finish();
    expect(sessionData().amr).toEqual(['direct_auth']);
    expect((body.session as Record<string, unknown>).amr).toEqual(['direct_auth']);
  });

  it.each([
    [{ proven_at: 0 }, {}],
    [{ proven_at: 1.5 }, {}],
    [{ proven_at: 1_700_000_000_000 }, { proven_at: 1_700_000_000_000 }],
  ])('keeps only a positive whole proof time (%#)', async (metadata, expected) => {
    await artifact(metadata);
    await finish();
    if ('proven_at' in expected) expect(sessionData().proven_at).toBe(expected.proven_at);
    else expect(sessionData()).not.toHaveProperty('proven_at');
  });

  it.each([
    [{ reauth_proven_at: 1_700_000_000_000, reauth_proven_amr: ['otp', 7] }, ['otp']],
    [{ reauth_proven_at: 1_700_000_000_000, reauth_proven_amr: [] }, null],
    [{ reauth_proven_at: 1_700_000_000_000, reauth_proven_amr: [1] }, null],
    [{ reauth_proven_at: 0, reauth_proven_amr: ['otp'] }, null],
    [{ reauth_proven_amr: ['otp'] }, null],
  ])('keeps the re-authentication proof only as a whole pair (%#)', async (metadata, amr) => {
    await artifact(metadata);
    await finish();
    if (amr) {
      expect(sessionData()).toMatchObject({
        reauth_proven_at: 1_700_000_000_000,
        reauth_proven_amr: amr,
      });
    } else {
      expect(sessionData()).not.toHaveProperty('reauth_proven_at');
      expect(sessionData()).not.toHaveProperty('reauth_proven_amr');
    }
  });

  it('keeps an upstream acr of exactly the longest length allowed', async () => {
    await artifact({ method: 'external_idp', upstream_acr: 'a'.repeat(1024) });
    await finish();
    expect(sessionData().upstream_acr).toBe('a'.repeat(1024));
    await artifact({ method: 'external_idp', upstream_acr: '' });
    await finish();
    expect(sessionData()).not.toHaveProperty('upstream_acr');
  });
});
