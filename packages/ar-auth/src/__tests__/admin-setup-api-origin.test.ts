import { describe, expect, it, vi, beforeEach } from 'vitest';
import { adminSetupApiApp } from '../admin-setup-api';

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => mocks);

function createMockAdminDb(firstResults: unknown[], allResults: unknown[][] = []) {
  const queue = [...firstResults];
  const allQueue = [...allResults];
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(async () => queue.shift() ?? null),
      all: vi.fn(async () => ({ results: allQueue.shift() ?? [] })),
      run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
    })),
  };
}

function adminUserRow() {
  const now = Date.now();
  return {
    id: 'admin-1',
    tenant_id: 'default',
    email: 'admin@example.com',
    email_verified: 1,
    name: 'Admin User',
    password_hash: null,
    is_active: 1,
    status: 'active',
    mfa_enabled: 0,
    mfa_method: null,
    totp_secret_encrypted: null,
    last_login_at: null,
    last_login_ip: null,
    failed_login_count: 0,
    locked_until: null,
    created_by: null,
    created_at: now,
    updated_at: now,
  };
}

describe('admin passkey login origin resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'admin-login-challenge',
    });
    mocks.generateRegistrationOptions.mockResolvedValue({
      challenge: 'admin-registration-challenge',
    });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([1, 2, 3]),
        credentialPublicKey: new Uint8Array([4, 5, 6]),
        counter: 0,
      },
    });
  });

  it('uses the Admin UI browser origin as RP ID behind the BFF proxy', async () => {
    const config = {
      put: vi.fn(),
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/auth/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://test.authrim.com',
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          'X-Authrim-Forwarded-Origin': 'https://test-ar-admin-ui.sgrastar.workers.dev',
        },
        body: '{}',
      },
      {
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://test.authrim.com',
        ADMIN_UI_URL: 'https://test-ar-admin-ui.sgrastar.workers.dev',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'test-ar-admin-ui.sgrastar.workers.dev',
      })
    );

    const storedChallenge = JSON.parse(config.put.mock.calls[0][1]) as {
      rpID: string;
      origin: string;
    };
    expect(storedChallenge).toMatchObject({
      rpID: 'test-ar-admin-ui.sgrastar.workers.dev',
      origin: 'https://test-ar-admin-ui.sgrastar.workers.dev',
    });
  });

  it('falls back to the request Origin outside the BFF proxy', async () => {
    const config = {
      put: vi.fn(),
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/auth/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.authrim.example',
        },
        body: '{}',
      },
      {
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://authrim.example',
        ADMIN_UI_URL: 'https://admin.authrim.example',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.authrim.example',
      })
    );
  });

  it('rejects an unconfigured forwarded Admin UI browser origin', async () => {
    const config = {
      put: vi.fn(),
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/auth/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://test.authrim.com',
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          'X-Authrim-Forwarded-Origin': 'https://evil.example.com',
        },
        body: '{}',
      },
      {
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://test.authrim.com',
        ADMIN_UI_URL: 'https://admin.example.com',
      }
    );

    expect(response.status).toBe(400);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(config.put).not.toHaveBeenCalled();
  });

  it('requires resident credentials and user verification during initial Admin setup', async () => {
    const config = {
      put: vi.fn(),
    };
    const token = {
      id: 'setup-token',
      admin_user_id: 'admin-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/setup-token/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.authrim.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'setup-token',
          rp_id: 'admin.authrim.example',
        }),
      },
      {
        DB_ADMIN: createMockAdminDb([token, adminUserRow()]),
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://authrim.example',
        ADMIN_UI_URL: 'https://admin.authrim.example',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.authrim.example',
        authenticatorSelection: expect.objectContaining({
          residentKey: 'required',
          userVerification: 'required',
        }),
      })
    );
  });

  it('requires user verification when completing initial Admin passkey setup', async () => {
    const config = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          challenge: 'admin-registration-challenge',
          rpID: 'admin.authrim.example',
          origin: 'https://admin.authrim.example',
          userId: 'admin-1',
          token: 'setup-token',
        })
      ),
      delete: vi.fn(),
    };
    const token = {
      id: 'setup-token',
      admin_user_id: 'admin-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/setup-token/passkey/complete',
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.authrim.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'setup-token',
          challenge_id: 'challenge-1',
          origin: 'https://admin.authrim.example',
          passkey_response: {
            id: 'credential-1',
            rawId: 'credential-1',
            type: 'public-key',
            response: {
              transports: ['internal'],
            },
          },
        }),
      },
      {
        DB_ADMIN: createMockAdminDb([token, adminUserRow()]),
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://authrim.example',
        ADMIN_UI_URL: 'https://admin.authrim.example',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'admin-registration-challenge',
        expectedOrigin: 'https://admin.authrim.example',
        expectedRPID: 'admin.authrim.example',
        requireUserVerification: true,
      })
    );
  });
});

describe('admin setup API rejection matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const request = (
    path: string,
    body: unknown,
    env: Record<string, unknown> = {},
    headers: Record<string, string> = {}
  ) =>
    adminSetupApiApp.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      env
    );

  it.each([
    [{}, {}, 400, 'invalid_request'],
    [{ token: 'setup-token' }, {}, 500, 'server_error'],
    [{ token: 'setup-token' }, { DB_ADMIN: createMockAdminDb([null]) }, 401, 'invalid_token'],
    [
      { token: 'setup-token' },
      {
        DB_ADMIN: createMockAdminDb([
          {
            id: 'setup-token',
            admin_user_id: 'admin-1',
            status: 'used',
            expires_at: Date.now() + 1,
          },
        ]),
      },
      401,
      'token_used',
    ],
    [
      { token: 'setup-token' },
      {
        DB_ADMIN: createMockAdminDb([
          { id: 'setup-token', admin_user_id: 'admin-1', status: 'pending', expires_at: 0 },
        ]),
      },
      401,
      'token_expired',
    ],
    [
      { token: 'setup-token' },
      {
        DB_ADMIN: createMockAdminDb([
          {
            id: 'setup-token',
            admin_user_id: 'admin-1',
            status: 'pending',
            expires_at: Date.now() + 60_000,
          },
          null,
        ]),
      },
      404,
      'user_not_found',
    ],
  ] as const)(
    'verifies setup-token failure %# without leaking token data',
    async (body, env, status, error) => {
      const response = await request('/api/admin/setup-token/verify', body, env);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error });
    }
  );

  it('returns only the intended public admin fields for a valid setup token', async () => {
    const token = {
      id: 'setup-token',
      admin_user_id: 'admin-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
    };
    const response = await request(
      '/api/admin/setup-token/verify',
      { token: 'setup-token' },
      { DB_ADMIN: createMockAdminDb([token, adminUserRow()]) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      valid: true,
      user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin User' },
    });
  });

  it.each([
    [{}, {}, {}, 400],
    [{ token: 't', rp_id: 'admin.example' }, {}, {}, 500],
    [{ token: 't', rp_id: 'admin.example' }, { DB_ADMIN: createMockAdminDb([]) }, {}, 500],
    [
      { token: 't', rp_id: 'admin.example' },
      { DB_ADMIN: createMockAdminDb([]), AUTHRIM_CONFIG: { put: vi.fn() } },
      { Origin: 'https://evil.example' },
      400,
    ],
  ] as const)(
    'rejects invalid passkey option precondition %#',
    async (body, env, headers, status) => {
      const response = await request('/api/admin/setup-token/passkey/options', body, env, headers);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toHaveProperty('error');
      expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{}, {}, 400],
    [
      { token: 't', challenge_id: 'c', origin: 'https://admin.example', passkey_response: {} },
      {},
      500,
    ],
    [
      { token: 't', challenge_id: 'c', origin: 'https://admin.example', passkey_response: {} },
      { DB_ADMIN: createMockAdminDb([]), AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue(null) } },
      400,
    ],
  ] as const)('rejects invalid passkey completion precondition %#', async (body, env, status) => {
    const response = await request('/api/admin/setup-token/passkey/complete', body, env);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toHaveProperty('error');
    expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('requires a configured and matching browser origin for admin login options', async () => {
    const response = await request(
      '/api/admin/auth/passkey/options',
      {},
      {
        AUTHRIM_CONFIG: { put: vi.fn() },
        ADMIN_UI_URL: 'https://admin.example',
      }
    );

    expect(response.status).toBe(400);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it.each([
    [{}, {}, 400],
    [{ challengeId: 'c', credential: {} }, {}, 500],
    [
      { challengeId: 'c', credential: {} },
      { DB_ADMIN: createMockAdminDb([]), AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue(null) } },
      400,
    ],
  ] as const)(
    'rejects invalid admin passkey verification precondition %#',
    async (body, env, status) => {
      const response = await request('/api/admin/auth/passkey/verify', body, env);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toHaveProperty('error');
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{}, {}, 400, 'invalid_request'],
    [{ admin_user_id: 'admin-1' }, {}, 500, 'server_error'],
    [
      { admin_user_id: 'admin-1', recovery_key: 'secret' },
      { DB_ADMIN: createMockAdminDb([]) },
      401,
      'unauthorized',
    ],
    [
      { admin_user_id: 'admin-1', recovery_key: 'wrong' },
      {
        DB_ADMIN: createMockAdminDb([]),
        AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue('secret') },
      },
      401,
      'unauthorized',
    ],
    [
      { admin_user_id: 'admin-1', recovery_key: 'secret' },
      {
        DB_ADMIN: createMockAdminDb([null]),
        AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue('secret') },
      },
      404,
      'user_not_found',
    ],
  ] as const)(
    'fails closed when setup-token generation precondition %# is unmet',
    async (body, env, status, error) => {
      const response = await request('/api/admin/setup-token/generate', body, env);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error });
    }
  );

  it('prevents recovery-key reuse after passkey setup is already complete', async () => {
    const response = await request(
      '/api/admin/setup-token/generate',
      { admin_user_id: 'admin-1', recovery_key: 'secret' },
      {
        DB_ADMIN: createMockAdminDb([adminUserRow()], [[{ id: 'passkey-1' }]]),
        AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue('secret') },
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'already_setup' });
  });

  it('revokes prior pending setup tokens before issuing a replacement', async () => {
    const db = createMockAdminDb([adminUserRow()]);
    const response = await request(
      '/api/admin/setup-token/generate',
      { admin_user_id: 'admin-1', recovery_key: 'secret' },
      {
        DB_ADMIN: db,
        AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue('secret') },
      }
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      token: expect.any(String),
      expires_at: expect.any(Number),
      admin_user: { id: 'admin-1', email: 'admin@example.com' },
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("SET status = 'revoked'"));
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_setup_tokens')
    );
  });

  const authChallenge = JSON.stringify({
    challenge: 'challenge',
    rpID: 'admin.example',
    origin: 'https://admin.example',
  });
  const authCredential = { id: 'credential-1', type: 'public-key', response: {} };

  it.each([
    [null, null, 401, 'Passkey not found'],
    [
      {
        id: 'passkey-1',
        admin_user_id: 'admin-1',
        credential_id: 'credential-1',
        public_key: 'AQID',
        counter: 0,
      },
      null,
      401,
      'Admin user not found',
    ],
  ] as const)(
    'rejects unknown passkey identity %# and consumes its challenge',
    async (passkey, user, status, description) => {
      const config = {
        get: vi.fn().mockResolvedValue(authChallenge),
        delete: vi.fn(),
      };
      const response = await request(
        '/api/admin/auth/passkey/verify',
        { challengeId: 'c', credential: authCredential },
        { DB_ADMIN: createMockAdminDb([passkey, user]), AUTHRIM_CONFIG: config }
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error_description: description });
      expect(config.delete).toHaveBeenCalledWith('admin_auth:challenge:c');
    }
  );

  it.each([
    ['unverified response', { verified: false }, false],
    ['verification exception', new Error('bad authenticator response'), true],
  ] as const)('rejects %s and consumes the one-time challenge', async (_name, result, rejects) => {
    const config = {
      get: vi.fn().mockResolvedValue(authChallenge),
      delete: vi.fn(),
    };
    const passkey = {
      id: 'passkey-1',
      admin_user_id: 'admin-1',
      credential_id: 'credential-1',
      public_key: 'AQID',
      counter: 0,
    };
    if (rejects) mocks.verifyAuthenticationResponse.mockRejectedValueOnce(result);
    else mocks.verifyAuthenticationResponse.mockResolvedValueOnce(result);

    const response = await request(
      '/api/admin/auth/passkey/verify',
      { challengeId: 'c', credential: authCredential },
      { DB_ADMIN: createMockAdminDb([passkey, adminUserRow()]), AUTHRIM_CONFIG: config }
    );

    expect(response.status).toBe(401);
    expect(config.delete).toHaveBeenCalledWith('admin_auth:challenge:c');
  });

  it('creates an admin session only after a verified passkey assertion', async () => {
    const config = {
      get: vi.fn().mockResolvedValue(authChallenge),
      delete: vi.fn(),
    };
    const db = createMockAdminDb([
      {
        id: 'passkey-1',
        admin_user_id: 'admin-1',
        credential_id: 'AQI',
        public_key: 'AQID',
        counter: 0,
      },
      adminUserRow(),
    ]);
    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });

    const response = await request(
      '/api/admin/auth/passkey/verify',
      { challengeId: 'c', credential: { ...authCredential, id: 'AQI=' } },
      { DB_ADMIN: db, AUTHRIM_CONFIG: config }
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      verified: true,
      userId: 'admin-1',
      user: { id: 'admin-1', email: 'admin@example.com', email_verified: true },
    });
    expect(response.headers.get('Set-Cookie')).toContain('authrim_admin_session=');
    expect(config.delete).toHaveBeenCalledWith('admin_auth:challenge:c');
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE admin_passkeys'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO admin_sessions'));
  });
});
