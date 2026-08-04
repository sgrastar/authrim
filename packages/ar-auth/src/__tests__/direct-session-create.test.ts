import { beforeEach, describe, expect, it, vi } from 'vitest';

const challengeStore = {
  consumeChallengeRpc: vi.fn(),
  storeChallengeRpc: vi.fn(),
};

const sessionStore = {
  createSessionRpc: vi.fn(),
};

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        if (userId !== 'user_123') return null;
        return {
          id: 'user_123',
          active: 1,
          account_type: 'user',
          email: 'user@example.com',
          name: 'Example User',
          email_verified: 1,
          phone_number_verified: 0,
          created_at: new Date(1700000000000).toISOString(),
          updated_at: new Date(1700000000000).toISOString(),
          last_login_at: null,
        };
      }
    },
    getChallengeStoreByChallengeId: vi.fn(async () => challengeStore),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: sessionStore,
      sessionId: 'sess_managed_browser',
      resolution: {},
      instanceName: 'session-store',
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    createAuthContextFromHono: vi.fn(() => ({
      repositories: {
        userCore: {
          findById: vi.fn(async () => ({ id: 'user_123', is_active: true })),
        },
      },
    })),
    createAccountAuthContextFromHono: vi.fn(() => ({
      coreAdapter: {},
      repositories: {
        userCore: {
          findById: vi.fn(async () => ({ id: 'user_123', is_active: true })),
        },
      },
    })),
    resolveAccountDataContextFromHono: vi.fn(async (_c, userId: string) => ({
      tenantId: 'tenant_test',
      accountId: `account:${userId}`,
      legacyUserId: userId,
    })),
    createPIIContextFromHono: vi.fn(() => ({
      piiRepositories: {
        userPII: {
          findById: vi.fn(async () => ({
            id: 'user_123',
            email: 'user@example.com',
            name: 'Example User',
          })),
        },
      },
    })),
    hasPIIDatabase: vi.fn(() => true),
    generateBrowserState: vi.fn(async () => 'browser-state'),
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
  };
});

async function s256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function createContext(body: Record<string, unknown>, env: Record<string, unknown> = {}) {
  const headers = new Headers();
  return {
    req: {
      url: 'https://auth.example.com/api/v1/auth/direct/session',
      json: vi.fn(async () => body),
    },
    env,
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant_test' : undefined)),
    header: (name: string, value: string) => {
      headers.append(name, value);
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers,
      }),
  };
}

describe('managed Direct Auth browser session finish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.createSessionRpc.mockResolvedValue({ id: 'sess_managed_browser' });
    challengeStore.storeChallengeRpc.mockResolvedValue(undefined);
  });

  it('reports the missing required fields without consuming an artifact', async () => {
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext({
        client_id: 'login-ui',
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as {
      error: string;
      error_description: string;
      error_details?: { code?: string; missing_fields?: string[] };
    };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'Missing required fields: direct_auth_artifact, code_verifier',
      error_details: {
        code: 'DIRECT_SESSION_REQUIRED_FIELDS_MISSING',
        missing_fields: ['direct_auth_artifact', 'code_verifier'],
      },
    });
    expect(challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('redeems an artifact into a cookie session without returning token material', async () => {
    const codeVerifier = 'verifier-for-managed-browser-session';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: codeChallenge,
      userId: 'user_123',
      metadata: {
        client_id: 'login-ui',
        channel: 'browser',
        method: 'passkey',
      },
    });
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext({
        direct_auth_artifact: 'artifact_123',
        client_id: 'login-ui',
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('refresh_token');
    expect(body).not.toHaveProperty('id_token');
    expect(body).not.toHaveProperty('session.id');
    expect(sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_managed_browser',
      'user_123',
      86400,
      expect.objectContaining({
        amr: ['passkey'],
        authTime: expect.any(Number),
        client_id: 'login-ui',
        direct_auth_channel: 'browser',
      }),
      'tenant_test'
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_managed_browser');
  }, 15000);

  it('returns configured post-login redirect for direct Login UI sign-in', async () => {
    const codeVerifier = 'verifier-for-post-login-redirect';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: codeChallenge,
      userId: 'user_123',
      metadata: {
        client_id: 'login-ui',
        channel: 'browser',
        method: 'passkey',
      },
    });
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === 'settings:tenant:tenant_test:login-entry') {
          return JSON.stringify({
            'login-entry.post_login_behavior': 'custom_url',
            'login-entry.post_login_redirect_url': '/mypage',
          });
        }
        return null;
      }),
    };
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext(
        {
          direct_auth_artifact: 'artifact_123',
          client_id: 'login-ui',
          code_verifier: codeVerifier,
          channel: 'browser',
        },
        { SETTINGS: settings }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.redirect_url).toBe('/mypage');
  });

  it('can resume an OAuth login challenge without returning browser token material', async () => {
    const codeVerifier = 'verifier-for-oauth-login-continuation';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc
      .mockResolvedValueOnce({
        challenge: codeChallenge,
        userId: 'user_123',
        metadata: {
          client_id: 'login-ui',
          channel: 'browser',
          method: 'email_code',
        },
      })
      .mockResolvedValueOnce({
        userId: 'anonymous',
        metadata: {
          response_type: 'code',
          client_id: 'rp_web',
          redirect_uri: 'https://rp.example.com/callback',
          scope: 'openid profile',
          state: 'state-123',
          nonce: 'nonce-123',
          code_challenge: 'pkce-challenge',
          code_challenge_method: 'S256',
          prompt: 'login',
          max_age: '300',
          acr_values: 'urn:authrim:acr:mfa',
          issuer: 'https://issuer.example.com',
          authorization_request_source: 'par',
          authorization_request_integrity_protected: true,
        },
      });
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext({
        direct_auth_artifact: 'artifact_123',
        client_id: 'login-ui',
        code_verifier: codeVerifier,
        channel: 'browser',
        authorization_challenge_id: 'oauth_challenge_123',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('refresh_token');
    expect(body.redirect_url).toEqual(
      expect.stringContaining('https://issuer.example.com/authorize?')
    );

    const redirect = new URL(String(body.redirect_url));
    expect(redirect.origin).toBe('https://issuer.example.com');
    expect([...redirect.searchParams.keys()]).toEqual(['_confirmation_challenge']);
    expect(redirect.searchParams.get('_confirmation_challenge')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reauth',
        metadata: expect.objectContaining({
          purpose: 'authorize_confirmation',
          authorization_request: expect.objectContaining({
            source: 'par',
            authorization_server: 'default',
            integrity_protected: true,
            client_id: 'rp_web',
            state: 'state-123',
          }),
        }),
      })
    );
  });

  it('can resume an OAuth login challenge from artifact metadata when the request omits it', async () => {
    const codeVerifier = 'verifier-for-oauth-login-continuation-metadata';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc
      .mockResolvedValueOnce({
        challenge: codeChallenge,
        userId: 'user_123',
        metadata: {
          client_id: 'login-ui',
          channel: 'browser',
          method: 'passkey',
          authorization_challenge_id: 'oauth_challenge_from_artifact',
        },
      })
      .mockResolvedValueOnce({
        userId: 'anonymous',
        metadata: {
          response_type: 'code',
          client_id: 'rp_web',
          redirect_uri: 'https://rp.example.com/callback',
          scope: 'openid profile',
          state: 'state-123',
          code_challenge: 'pkce-challenge',
          code_challenge_method: 'S256',
          issuer: 'https://issuer.example.com',
        },
      });
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext({
        direct_auth_artifact: 'artifact_123',
        client_id: 'login-ui',
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authorization: {
        challenge_id: 'oauth_challenge_from_artifact',
        type: 'login',
      },
    });
    expect(body.redirect_url).toEqual(
      expect.stringContaining('https://issuer.example.com/authorize?')
    );
    expect(challengeStore.consumeChallengeRpc).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'oauth_challenge_from_artifact',
        type: 'login',
      })
    );
  });

  it('can defer OAuth continuation when a runtime flow still has later steps', async () => {
    const codeVerifier = 'verifier-for-deferred-oauth-continuation';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: codeChallenge,
      userId: 'user_123',
      metadata: {
        client_id: 'login-ui',
        channel: 'browser',
        method: 'passkey',
        authorization_challenge_id: 'oauth_challenge_from_artifact',
      },
    });
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext({
        direct_auth_artifact: 'artifact_123',
        client_id: 'login-ui',
        code_verifier: codeVerifier,
        channel: 'browser',
        defer_authorization_continuation: true,
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('authorization');
    expect(challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(challengeStore.consumeChallengeRpc).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'oauth_challenge_from_artifact',
      })
    );
  });

  it('rejects non-browser channels for managed browser session finish', async () => {
    const { directSessionCreateHandler } = await import('../direct-auth');

    const response = await directSessionCreateHandler(
      createContext({
        direct_auth_artifact: 'artifact_123',
        client_id: 'login-ui',
        code_verifier: 'verifier',
        channel: 'native',
      }) as never
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });
});
