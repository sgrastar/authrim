import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleGate = vi.hoisted(() => vi.fn());
const lifecycleRow = vi.hoisted(() => vi.fn());

const challengeStore = {
  consumeChallengeRpc: vi.fn(),
  storeChallengeRpc: vi.fn(),
};

const sessionStore = {
  createSessionRpc: vi.fn(),
};

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  lifecycleGate.mockImplementation(actual.assertGuestCredentialAuthenticationAllowed);
  return {
    ...actual,
    assertGuestCredentialAuthenticationAllowed: lifecycleGate,
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
      coreAdapter: { queryOne: lifecycleRow },
      repositories: {
        userCore: {
          findById: vi.fn(async () => ({ id: 'user_123', is_active: true })),
        },
      },
    })),
    createAccountAuthContextFromHono: vi.fn(() => ({
      coreAdapter: { queryOne: lifecycleRow },
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
  const request = new Request('https://auth.example.com/api/v1/auth/direct/session', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    },
  }) as Request & { cf?: { country?: string } };
  request.cf = { country: 'JP' };
  return {
    req: {
      url: request.url,
      raw: request,
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
    lifecycleRow.mockResolvedValue(null);
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

  it.each(['active', 'upgrading', 'deleting', 'deleted'])(
    'does not create a credential session in %s lifecycle state',
    async (phase) => {
      const verifier = 'verifier-for-managed-browser-session';
      challengeStore.consumeChallengeRpc.mockResolvedValue({
        challenge: await s256Challenge(verifier),
        userId: 'user_123',
        metadata: { client_id: 'login-ui', channel: 'browser', method: 'passkey' },
      });
      lifecycleRow.mockResolvedValue({ phase });
      const { directSessionCreateHandler } = await import('../direct-auth');
      const response = await directSessionCreateHandler(
        createContext({
          direct_auth_artifact: 'artifact_123',
          client_id: 'login-ui',
          code_verifier: verifier,
          channel: 'browser',
        }) as never
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(lifecycleGate).toHaveBeenCalledWith(expect.anything(), 'tenant_test', 'user_123');
      expect(sessionStore.createSessionRpc).not.toHaveBeenCalled();
    }
  );
  it.each([
    [
      'external_idp',
      'urn:mace:incommon:iap:silver',
      { upstream_acr: 'urn:mace:incommon:iap:silver' },
    ],
    ['passkey', 'urn:mace:incommon:iap:silver', {}],
    ['external_idp', 'x'.repeat(1025), {}],
  ])(
    'keeps the upstream acr of a %s login only from an external IdP (%#)',
    async (method, upstreamAcr, expected) => {
      const codeVerifier = 'verifier-for-upstream-acr-session';
      challengeStore.consumeChallengeRpc.mockResolvedValue({
        challenge: await s256Challenge(codeVerifier),
        userId: 'user_123',
        metadata: { client_id: 'login-ui', channel: 'browser', method, upstream_acr: upstreamAcr },
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
      expect(response.status).toBe(200);
      const data = sessionStore.createSessionRpc.mock.calls.at(-1)?.[3] as Record<string, unknown>;
      expect(data.amr).toEqual([method]);
      if ('upstream_acr' in expected) expect(data.upstream_acr).toBe(expected.upstream_acr);
      else expect(data).not.toHaveProperty('upstream_acr');
    }
  );

  it.each([
    [{ proven_at: 1_700_000_000_123 }, { proven_at: 1_700_000_000_123 }],
    // The artifact's storage time is not a proof time.
    [{}, {}],
  ])(
    'records when the producer verified the authentication, not when it was stored (%#)',
    async (extra, expected) => {
      const codeVerifier = 'verifier-for-proven-at';
      challengeStore.consumeChallengeRpc.mockResolvedValue({
        challenge: await s256Challenge(codeVerifier),
        userId: 'user_123',
        createdAt: 1_800_000_000_000,
        metadata: { client_id: 'login-ui', channel: 'browser', method: 'passkey', ...extra },
      });
      const { directSessionCreateHandler } = await import('../direct-auth');
      await directSessionCreateHandler(
        createContext({
          direct_auth_artifact: 'artifact_123',
          client_id: 'login-ui',
          code_verifier: codeVerifier,
          channel: 'browser',
        }) as never
      );
      const data = sessionStore.createSessionRpc.mock.calls.at(-1)?.[3] as Record<string, unknown>;
      if ('proven_at' in expected) expect(data.proven_at).toBe(expected.proven_at);
      else expect(data).not.toHaveProperty('proven_at');
    }
  );

  it.each([
    // The IdP's times are in its own clock: an external IdP login records no proof time.
    [{ upstream_auth_time: 1_700_000_000 }, {}],
    [{ proven_at: 1_700_000_000_123 }, {}],
    [{}, {}],
  ])('records no proof time for an external IdP login (%#)', async (extra, expected) => {
    const codeVerifier = 'verifier-for-upstream-auth-time';
    challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: await s256Challenge(codeVerifier),
      userId: 'user_123',
      createdAt: 1_800_000_000_000,
      metadata: { client_id: 'login-ui', channel: 'browser', method: 'external_idp', ...extra },
    });
    const { directSessionCreateHandler } = await import('../direct-auth');
    await directSessionCreateHandler(
      createContext({
        direct_auth_artifact: 'artifact_123',
        client_id: 'login-ui',
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const data = sessionStore.createSessionRpc.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    if ('proven_at' in expected) expect(data.proven_at).toBe(expected.proven_at);
    // Not the code's minting: the IdP login may be older.
    else expect(data).not.toHaveProperty('proven_at');
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
        userAgent: expect.stringContaining('iPhone'),
        countryCode: 'JP',
      }),
      'tenant_test'
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_managed_browser');
  }, 15000);

  it('resolves the account-scoped user store for a tenant-exclusive artifact exchange', async () => {
    const codeVerifier = 'verifier-for-tenant-exclusive-session';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: codeChallenge,
      userId: 'user_123',
      metadata: {
        client_id: 'login-ui',
        channel: 'browser',
        method: 'passkey_signup',
      },
    });
    const context = createContext({
      direct_auth_artifact: 'artifact_tenant_exclusive',
      client_id: 'login-ui',
      code_verifier: codeVerifier,
      channel: 'browser',
    });
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;

    const { directSessionCreateHandler } = await import('../direct-auth');
    const response = await directSessionCreateHandler(context as never);

    expect(response.status).toBe(200);
    const core = await import('@authrim/ar-lib-core');
    expect(core.resolveAccountDataContextFromHono).toHaveBeenCalledWith(context, 'user_123');
  }, 15000);

  it('resolves the account-scoped user store for a shared-pool artifact exchange', async () => {
    const codeVerifier = 'verifier-for-shared-pool-session';
    const codeChallenge = await s256Challenge(codeVerifier);
    challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: codeChallenge,
      userId: 'user_123',
      metadata: {
        client_id: 'login-ui',
        channel: 'browser',
        method: 'passkey_signup',
      },
    });
    const context = createContext({
      direct_auth_artifact: 'artifact_shared_pool',
      client_id: 'login-ui',
      code_verifier: codeVerifier,
      channel: 'browser',
    });
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return {
          tenantId: 'tenant_test',
          storageProfileId: 'builtin:storage:shared-pool',
          route: { allocationScope: 'shared_pool' },
        };
      }
      return undefined;
    }) as never;

    const { directSessionCreateHandler } = await import('../direct-auth');
    const response = await directSessionCreateHandler(context as never);

    expect(response.status).toBe(200);
    const core = await import('@authrim/ar-lib-core');
    expect(core.resolveAccountDataContextFromHono).toHaveBeenCalledWith(context, 'user_123');
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
          browserBinding: expect.any(String),
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
    expect(response.headers.get('set-cookie')).toContain('authrim_authorize_confirmation=');
  });

  it('carries a re-authentication time and step-up into its confirmation', async () => {
    const codeVerifier = 'verifier-for-reauth-continuation';
    const stepUp = {
      prior_session_id: 'g1:apac:3:session_prior',
      required_aal: 'AAL2',
      issued_at: 5,
    };
    challengeStore.consumeChallengeRpc
      .mockResolvedValueOnce({
        challenge: await s256Challenge(codeVerifier),
        userId: 'user_123',
        metadata: {
          client_id: 'login-ui',
          channel: 'browser',
          method: 'passkey',
          authorization_challenge_id: 'reauth_challenge_123',
        },
      })
      .mockRejectedValueOnce(new Error('not a login challenge'))
      .mockResolvedValueOnce({
        userId: 'user_123',
        metadata: {
          response_type: 'code',
          client_id: 'rp_web',
          redirect_uri: 'https://rp.example.com/callback',
          scope: 'openid',
          state: 'state-123',
          issuer: 'https://issuer.example.com',
          sessionUserId: 'user_123',
          reauth_issued_at: 1_700_000_000_000,
          assurance_step_up: stepUp,
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

    expect(response.status).toBe(200);
    expect(challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reauth',
        metadata: expect.objectContaining({
          purpose: 'authorize_confirmation',
          reauth_issued_at: 1_700_000_000_000,
          assurance_step_up: stepUp,
        }),
      })
    );
  });

  it.each([
    ['external_idp', 200],
    ['passkey_signup', 403],
  ])(
    're-authenticates from a %s artifact only when the method proves the user',
    async (method, status) => {
      const codeVerifier = `verifier-for-${method}-reauth`;
      challengeStore.consumeChallengeRpc
        .mockResolvedValueOnce({
          challenge: await s256Challenge(codeVerifier),
          userId: 'user_123',
          metadata: {
            client_id: 'login-ui',
            channel: 'browser',
            method,
            authorization_challenge_id: 'reauth_challenge_123',
          },
        })
        .mockRejectedValueOnce(new Error('not a login challenge'))
        .mockResolvedValueOnce({
          userId: 'user_123',
          metadata: {
            response_type: 'code',
            client_id: 'rp_web',
            redirect_uri: 'https://rp.example.com/callback',
            scope: 'openid',
            state: 'state-123',
            issuer: 'https://issuer.example.com',
            sessionUserId: 'user_123',
            reauth_issued_at: 1_700_000_000_000,
          },
        });
      const { directSessionCreateHandler } = await import('../direct-auth');

      const response = await directSessionCreateHandler(
        createContext({
          direct_auth_artifact: `artifact_${method}`,
          client_id: 'login-ui',
          code_verifier: codeVerifier,
          channel: 'browser',
        }) as never
      );

      expect(response.status).toBe(status);
    }
  );

  it.each([
    // Proven 100 ms before the re-authentication was asked for, in the same second.
    [1_700_000_000_000 - 100, 403],
    [1_700_000_000_000 + 100, 200],
  ])(
    'dates the session by its proof (%d) and judges a re-authentication by it',
    async (provenAt, status) => {
      const codeVerifier = `verifier-for-proof-${provenAt}`;
      challengeStore.consumeChallengeRpc
        .mockResolvedValueOnce({
          challenge: await s256Challenge(codeVerifier),
          userId: 'user_123',
          metadata: {
            client_id: 'login-ui',
            channel: 'browser',
            method: 'passkey',
            proven_at: provenAt,
            authorization_challenge_id: 'reauth_challenge_123',
          },
        })
        .mockRejectedValueOnce(new Error('not a login challenge'))
        .mockResolvedValueOnce({
          userId: 'user_123',
          metadata: {
            response_type: 'code',
            client_id: 'rp_web',
            redirect_uri: 'https://rp.example.com/callback',
            scope: 'openid',
            state: 'state-123',
            issuer: 'https://issuer.example.com',
            sessionUserId: 'user_123',
            reauth_issued_at: 1_700_000_000_000,
          },
        });
      const { directSessionCreateHandler } = await import('../direct-auth');

      const response = await directSessionCreateHandler(
        createContext({
          direct_auth_artifact: `artifact_proof_${provenAt}`,
          client_id: 'login-ui',
          code_verifier: codeVerifier,
          channel: 'browser',
        }) as never
      );

      expect(response.status).toBe(status);
      if (status === 200) {
        expect(sessionStore.createSessionRpc).toHaveBeenCalledWith(
          expect.any(String),
          'user_123',
          expect.any(Number),
          expect.objectContaining({
            authTime: Math.floor(provenAt / 1000),
            proven_at: provenAt,
          }),
          expect.anything()
        );
      }
    }
  );

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
