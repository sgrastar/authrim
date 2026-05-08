import { beforeEach, describe, expect, it, vi } from 'vitest';

const challengeStore = {
  getChallengeRpc: vi.fn(),
};
const getWebOriginRegistry = vi.fn();
const isIframeOidcAuthEnabled = vi.fn();

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    getWebOriginRegistry,
    isIframeOidcAuthEnabled,
    getLogger: vi.fn(() => ({
      module: () => ({
        error: vi.fn(),
      }),
    })),
  };
});

function createContext(challengeId = 'challenge_123', env: Record<string, unknown> = {}) {
  return {
    req: {
      query: vi.fn((name: string) => (name === 'challenge_id' ? challengeId : undefined)),
    },
    env,
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

describe('login challenge metadata contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebOriginRegistry.mockResolvedValue({ origins: [] });
    isIframeOidcAuthEnabled.mockResolvedValue(false);
  });

  it('returns server-authoritative managed browser session metadata and web origins', async () => {
    challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'challenge_123',
      type: 'login',
      userId: 'anonymous',
      metadata: {
        client_id: 'rp_web',
        client_name: 'Example RP',
        redirect_uri: 'https://app.example.com/callback',
        scope: 'openid profile',
        nonce: 'nonce-123',
        prompt: 'login consent',
        max_age: '300',
        acr_values: 'urn:authrim:acr:phishing-resistant urn:authrim:acr:mfa',
        claims: { id_token: { auth_time: { essential: true } } },
        allowed_redirect_origins: [
          'https://app.example.com',
          'https://admin.example.com/settings',
          'not-a-url',
        ],
        session_mode: 'managed_browser_session',
        handoff_methods: ['cookie_session_finalize'],
      },
    });
    const { loginChallengeGetHandler } = await import('../login-challenge');

    const response = await loginChallengeGetHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: 'challenge_123',
      client: {
        client_id: 'rp_web',
        client_name: 'Example RP',
      },
      session_mode: 'managed_browser_session',
      handoff_methods: ['cookie_session_finalize'],
      oidc: {
        prompt: 'login consent',
        max_age: 300,
        acr_values: ['urn:authrim:acr:phishing-resistant', 'urn:authrim:acr:mfa'],
        nonce_present: true,
        claims_present: true,
      },
    });
    expect(body.web_origin_registry).toEqual({
      origins: [
        {
          origin: 'https://app.example.com',
          client_ids: ['rp_web'],
          cors: { allowed: true },
          csp: {},
          handoff_allowed: true,
          iframe_allowed: false,
        },
        {
          origin: 'https://admin.example.com',
          client_ids: ['rp_web'],
          cors: { allowed: true },
          csp: {},
          handoff_allowed: true,
          iframe_allowed: false,
        },
      ],
    });
  });

  it('maps token sessions to DPoP handoff when explicit metadata is absent', async () => {
    challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'challenge_123',
      type: 'reauth',
      userId: 'user_123',
      metadata: {
        client_id: 'rp_token',
        redirect_uri: 'https://token.example.com/callback',
        session_mode: 'token_session',
      },
    });
    const { loginChallengeGetHandler } = await import('../login-challenge');

    const response = await loginChallengeGetHandler(createContext() as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      session_mode: 'token_session',
      handoff_methods: ['dpop_token_verify'],
      web_origin_registry: {
        origins: [
          {
            origin: 'https://token.example.com',
            client_ids: ['rp_token'],
            cors: { allowed: true },
            csp: {},
            handoff_allowed: true,
            iframe_allowed: false,
          },
        ],
      },
    });
  });

  it('prefers dedicated web_origin_registry and gates iframe metadata behind tenant flag', async () => {
    isIframeOidcAuthEnabled.mockResolvedValueOnce(true);
    getWebOriginRegistry.mockResolvedValueOnce({
      origins: [
        {
          origin: 'https://app.example.com',
          client_ids: ['rp_web'],
          cors: { allowed: true },
          csp: { frame_ancestors: ['https://app.example.com'] },
          handoff_allowed: true,
          iframe_allowed: true,
        },
      ],
    });
    challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'challenge_123',
      type: 'login',
      userId: 'anonymous',
      metadata: {
        client_id: 'rp_web',
        client_name: 'Example RP',
        redirect_uri: 'https://fallback.example.com/callback',
        allowed_redirect_origins: ['https://fallback.example.com'],
        tenant_id: 'tenant_a',
      },
    });
    const { loginChallengeGetHandler } = await import('../login-challenge');

    const response = await loginChallengeGetHandler(
      createContext('challenge_123', { DB: {}, DEFAULT_TENANT_ID: 'default' }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(getWebOriginRegistry).toHaveBeenCalledWith(expect.anything(), 'tenant_a', 'rp_web');
    expect(body.web_origin_registry).toEqual({
      origins: [
        {
          origin: 'https://app.example.com',
          client_ids: ['rp_web'],
          cors: { allowed: true },
          csp: { frame_ancestors: ['https://app.example.com'] },
          handoff_allowed: true,
          iframe_allowed: true,
        },
      ],
    });
  });
});
