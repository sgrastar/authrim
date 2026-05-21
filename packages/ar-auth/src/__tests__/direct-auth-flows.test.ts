import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authCodeStore = {
    storeCodeRpc: vi.fn(),
  };
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  };
  const rateLimiter = {
    incrementRpc: vi.fn(),
  };
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const coreAdapter = {
    execute: vi.fn(),
  };
  const userCore = {
    findById: vi.fn(),
    createUser: vi.fn(),
    updatePIIStatus: vi.fn(),
    updateLastLogin: vi.fn(),
  };
  const passkey = {
    findByUserId: vi.fn(),
    findByCredentialId: vi.fn(),
    updateCounterAfterAuth: vi.fn(),
    create: vi.fn(),
  };
  const userPII = {
    findById: vi.fn(),
    findByTenantAndEmail: vi.fn(),
    createPII: vi.fn(),
  };

  return {
    authCodeStore,
    challengeStore,
    rateLimiter,
    sessionStore,
    coreAdapter,
    userCore,
    passkey,
    userPII,
    getClient: vi.fn(),
    getWebOriginRegistry: vi.fn(),
    getTenantSettings: vi.fn(),
    generateUserIdFromSettings: vi.fn(),
    publishEvent: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
    generateRegistrationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    generateEmailCode: vi.fn(),
    hashEmailCode: vi.fn(),
    verifyEmailCodeHash: vi.fn(),
    hashEmail: vi.fn(),
    validateRegistrationFieldSubmissionFromEnv: vi.fn(),
    persistRegistrationFieldValuesFromEnv: vi.fn(),
    getCookie: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mocks.getCookie,
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock('../utils/email-code-utils', () => ({
  generateEmailCode: mocks.generateEmailCode,
  hashEmailCode: mocks.hashEmailCode,
  verifyEmailCodeHash: mocks.verifyEmailCodeHash,
  hashEmail: mocks.hashEmail,
}));

vi.mock('../registration-field-utils', () => ({
  validateRegistrationFieldSubmissionFromEnv: mocks.validateRegistrationFieldSubmissionFromEnv,
  persistRegistrationFieldValuesFromEnv: mocks.persistRegistrationFieldValuesFromEnv,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    getDefaultTenantId: vi.fn(() => 'default'),
    getTenantSettings: mocks.getTenantSettings,
    getClient: mocks.getClient,
    getWebOriginRegistry: mocks.getWebOriginRegistry,
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        userCore: mocks.userCore,
        passkey: mocks.passkey,
      },
    })),
    createPIIContextFromHono: vi.fn(() => ({
      piiRepositories: {
        userPII: mocks.userPII,
      },
    })),
    hasPIIDatabase: vi.fn(() => true),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: mocks.sessionStore })),
    generateUserIdFromSettings: mocks.generateUserIdFromSettings,
    getChallengeStoreByChallengeId: vi.fn(async () => mocks.challengeStore),
    getChallengeStoreByUserId: vi.fn(async () => mocks.challengeStore),
    getPluginContext: vi.fn(() => ({
      registry: {
        getNotifier: vi.fn(() => null),
      },
    })),
    publishEvent: mocks.publishEvent,
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: mocks.warn,
        error: mocks.error,
        info: vi.fn(),
        debug: vi.fn(),
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

function createEnv() {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    ALLOWED_ORIGINS: 'https://app.example.com',
    AUTHRIM_CONFIG: {
      get: vi.fn().mockResolvedValue(null),
    },
    RATE_LIMITER: {
      idFromName: vi.fn(() => 'rate-limit-id'),
      get: vi.fn(() => mocks.rateLimiter),
    },
    AUTH_CODE_STORE: {
      idFromName: vi.fn(() => 'auth-code-id'),
      get: vi.fn(() => mocks.authCodeStore),
    },
  };
}

function createContext(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    req: {
      url: 'https://app.example.com/api/v1/auth/direct',
      json: vi.fn(async () => body),
      header: vi.fn((name: string) => lowerHeaders[name.toLowerCase()]),
    },
    env: createEnv(),
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant_test' : undefined)),
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

function webHeaders() {
  return {
    origin: 'https://app.example.com',
    host: 'app.example.com',
  };
}

describe('Direct Auth primary passkey and email-code flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantSettings.mockResolvedValue(null);
    mocks.getClient.mockResolvedValue({
      client_id: 'web-client',
      application_type: 'web',
      allowed_redirect_origins: ['https://app.example.com'],
    });
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [{ origin: 'https://app.example.com', handoff_allowed: true }],
    });
    mocks.generateUserIdFromSettings.mockResolvedValue('user_new');
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.authCodeStore.storeCodeRpc.mockResolvedValue(undefined);
    mocks.challengeStore.storeChallengeRpc.mockResolvedValue(undefined);
    mocks.challengeStore.deleteChallengeRpc.mockResolvedValue(undefined);
    mocks.challengeStore.getChallengeRpc.mockReset();
    mocks.challengeStore.consumeChallengeRpc.mockReset();
    mocks.rateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_existing',
      userId: 'user_existing',
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() + 60_000,
      data: { amr: ['passkey'] },
    });
    mocks.coreAdapter.execute.mockResolvedValue(undefined);
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_existing',
      is_active: true,
      created_at: Date.now() - 120_000,
    });
    mocks.userCore.createUser.mockResolvedValue(undefined);
    mocks.userCore.updatePIIStatus.mockResolvedValue(undefined);
    mocks.userCore.updateLastLogin.mockResolvedValue(undefined);
    mocks.passkey.findByUserId.mockResolvedValue([]);
    mocks.passkey.findByCredentialId.mockResolvedValue({
      id: 'passkey_1',
      user_id: 'user_existing',
      credential_id: 'credential-id',
      public_key: Buffer.from([1, 2, 3, 4]).toString('base64'),
      counter: 4,
    });
    mocks.passkey.updateCounterAfterAuth.mockResolvedValue(undefined);
    mocks.passkey.create.mockResolvedValue(undefined);
    mocks.userPII.findByTenantAndEmail.mockResolvedValue(null);
    mocks.userPII.findById.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
      name: 'Example User',
    });
    mocks.userPII.createPII.mockResolvedValue(undefined);
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'passkey-login-challenge',
      timeout: 60_000,
      rpId: 'app.example.com',
      allowCredentials: [],
      userVerification: 'required',
      extensions: undefined,
    });
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });
    mocks.generateRegistrationOptions.mockResolvedValue({
      rp: { id: 'app.example.com', name: 'Authrim' },
      user: { id: 'user_new', name: 'new@example.com', displayName: 'New User' },
      challenge: 'passkey-signup-challenge',
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      timeout: 60_000,
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestation: 'none',
      extensions: undefined,
    });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([9, 8, 7]),
        credentialPublicKey: new Uint8Array([6, 5, 4, 3]),
        counter: 0,
      },
    });
    mocks.generateEmailCode.mockReturnValue('123456');
    mocks.hashEmailCode.mockResolvedValue('hashed-email-code');
    mocks.verifyEmailCodeHash.mockResolvedValue(true);
    mocks.hashEmail.mockResolvedValue('hashed-email');
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValue({
      ok: true,
      values: {},
    });
    mocks.persistRegistrationFieldValuesFromEnv.mockResolvedValue(undefined);
  });

  it('starts passkey login with an existing active user and credential allow-list', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
      name: 'Example User',
    });
    mocks.passkey.findByUserId.mockResolvedValue([
      {
        credential_id: 'credential-id',
        transports: ['internal'],
      },
    ]);
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginStartHandler(
      createContext(
        {
          client_id: 'web-client',
          code_challenge: 'pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          scope: 'openid profile',
          email: 'user@example.com',
        },
        webHeaders()
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: expect.any(String),
      options: expect.objectContaining({
        challenge: 'passkey-login-challenge',
        rpId: 'app.example.com',
      }),
    });
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'app.example.com',
        userVerification: 'required',
        allowCredentials: [
          expect.objectContaining({
            type: 'public-key',
            transports: ['internal'],
          }),
        ],
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_passkey_login',
        userId: 'unknown',
        metadata: expect.objectContaining({
          client_id: 'web-client',
          channel: 'browser',
          code_challenge: 'pkce-challenge',
          email: 'user@example.com',
          origin: 'https://app.example.com',
          rpID: 'app.example.com',
        }),
      })
    );
  }, 10_000);

  it('finishes passkey login and stores a direct-auth authorization code artifact', async () => {
    const codeVerifier = 'passkey-login-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-login-challenge',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid profile',
        transaction_id: 'transaction_1',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
      },
    });
    const { directPasskeyLoginFinishHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginFinishHandler(
      createContext({
        challenge_id: 'challenge_1',
        credential: {
          id: 'credential-id',
          rawId: 'credential-id',
          response: {},
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
    });
    expect(mocks.passkey.updateCounterAfterAuth).toHaveBeenCalledWith('passkey_1', 5);
    expect(mocks.userCore.updateLastLogin).toHaveBeenCalledWith('user_existing');
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_test',
        clientId: 'web-client',
        userId: 'user_existing',
        scope: 'openid profile',
        codeChallenge,
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_auth_code',
        userId: 'user_existing',
        metadata: expect.objectContaining({
          method: 'passkey',
          passkey_id: 'passkey_1',
          transaction_id: 'transaction_1',
        }),
      })
    );
  });

  it('starts passkey signup by creating a new user and storing challenge mapping', async () => {
    const { directPasskeySignupStartHandler } = await import('../direct-auth');

    const response = await directPasskeySignupStartHandler(
      createContext(
        {
          client_id: 'web-client',
          email: 'new@example.com',
          display_name: 'New User',
          code_challenge: 'signup-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          scope: 'openid email',
          authenticator_type: 'platform',
        },
        webHeaders()
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: expect.any(String),
      options: expect.objectContaining({
        challenge: 'passkey-signup-challenge',
      }),
    });
    expect(mocks.userCore.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user_new',
        tenant_id: 'tenant_test',
        email_verified: false,
      })
    );
    expect(mocks.userPII.createPII).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user_new',
        email: 'new@example.com',
        preferred_username: 'new',
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'direct_passkey_signup:user_new',
        type: 'direct_passkey_signup',
        userId: 'user_new',
        metadata: expect.objectContaining({
          client_id: 'web-client',
          channel: 'browser',
          code_challenge: 'signup-pkce-challenge',
          origin: 'https://app.example.com',
        }),
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^direct_passkey_signup_map:/),
        type: 'direct_passkey_signup_map',
        userId: 'user_new',
      })
    );
  });

  it('finishes passkey signup and binds the resulting artifact to the original PKCE challenge', async () => {
    const codeVerifier = 'passkey-signup-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      userId: 'user_new',
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-signup-challenge',
      email: 'new@example.com',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
      },
    });
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_new',
      is_active: true,
      created_at: Date.now(),
    });
    const { directPasskeySignupFinishHandler } = await import('../direct-auth');

    const response = await directPasskeySignupFinishHandler(
      createContext({
        challenge_id: 'signup_challenge',
        credential: {
          id: 'new-credential',
          rawId: 'new-credential',
          response: {
            transports: ['internal'],
          },
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
      is_new_user: true,
    });
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user_new',
        public_key: Buffer.from([6, 5, 4, 3]).toString('base64'),
        transports: ['internal'],
        device_name: 'Direct Auth Passkey',
      })
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      'UPDATE users_core SET email_verified = 1, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [expect.any(Number), 'user_new', 'tenant_test']
    );
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'web-client',
        userId: 'user_new',
        scope: 'openid email',
        codeChallenge,
      })
    );
  });

  it('starts authenticated passkey registration with existing credentials excluded', async () => {
    mocks.passkey.findByUserId.mockResolvedValue([
      {
        credential_id: 'existing-credential',
        transports: ['internal'],
      },
    ]);
    const { directPasskeyRegisterStartHandler } = await import('../direct-auth');

    const response = await directPasskeyRegisterStartHandler(
      createContext(
        {
          display_name: 'Work laptop',
          authenticator_type: 'platform',
        },
        {
          ...webHeaders(),
          authorization: 'Bearer 0_session_existing',
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: expect.any(String),
      options: expect.objectContaining({
        challenge: 'passkey-signup-challenge',
      }),
    });
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'app.example.com',
        userName: 'user@example.com',
        userDisplayName: 'Work laptop',
        excludeCredentials: [
          expect.objectContaining({
            type: 'public-key',
            transports: ['internal'],
          }),
        ],
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: 'platform',
        }),
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'direct_passkey_register:user_existing',
        type: 'direct_passkey_register',
        userId: 'user_existing',
        metadata: expect.objectContaining({
          session_id: '0_session_existing',
          display_name: 'Work laptop',
          origin: 'https://app.example.com',
          rpID: 'app.example.com',
        }),
      })
    );
  });

  it('finishes authenticated passkey registration and removes the challenge mapping', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      userId: 'user_existing',
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-register-challenge',
      metadata: {
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
        session_id: '0_session_existing',
        display_name: 'Work laptop',
        authenticator_type: 'platform',
      },
    });
    const { directPasskeyRegisterFinishHandler } = await import('../direct-auth');

    const response = await directPasskeyRegisterFinishHandler(
      createContext({
        challenge_id: 'register_challenge',
        credential: {
          id: 'registered-credential',
          rawId: 'registered-credential',
          response: {
            transports: ['internal'],
          },
          type: 'public-key',
        },
        device_name: 'Work laptop',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      credential_id: expect.any(String),
      public_key: Buffer.from([6, 5, 4, 3]).toString('base64'),
      authenticator_type: 'platform',
      transports: ['internal'],
    });
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user_existing',
        device_name: 'Work laptop',
        transports: ['internal'],
      })
    );
    expect(mocks.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      'direct_passkey_register_map:register_challenge'
    );
  });

  it('sends an email code for a new user and stores a hashed one-time challenge', async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      createContext(
        {
          client_id: 'web-client',
          email: 'new@example.com',
          code_challenge: 'email-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          scope: 'openid email',
        },
        webHeaders()
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
      _dev_code: '123456',
    });
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      'direct_email_code:new@example.com',
      {
        windowSeconds: 900,
        maxRequests: 3,
      }
    );
    expect(mocks.hashEmailCode).toHaveBeenCalledWith(
      '123456',
      'new@example.com',
      expect.any(String),
      expect.any(Number),
      'https://issuer.example.com'
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_email_code',
        userId: 'user_new',
        challenge: 'hashed-email-code',
        email: 'new@example.com',
        metadata: expect.objectContaining({
          client_id: 'web-client',
          channel: 'browser',
          code_challenge: 'email-pkce-challenge',
          email_hash: 'hashed-email',
        }),
      })
    );
  });

  it('verifies an email code and returns a direct-auth artifact bound to PKCE', async () => {
    const codeVerifier = 'email-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    const issuedAt = Date.now() - 10_000;
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'hashed-email-code',
      userId: 'user_existing',
      email: 'user@example.com',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        transaction_id: 'attempt_1',
        issued_at: issuedAt,
      },
    });
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    const response = await directEmailCodeVerifyHandler(
      createContext({
        attempt_id: 'attempt_1',
        code: '123456',
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
      is_new_user: false,
    });
    expect(mocks.verifyEmailCodeHash).toHaveBeenCalledWith(
      '123456',
      'user@example.com',
      'attempt_1',
      issuedAt,
      'hashed-email-code',
      'https://issuer.example.com'
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [expect.any(Number), expect.any(Number), 'user_existing', 'tenant_test']
    );
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'web-client',
        userId: 'user_existing',
        scope: 'openid email',
        codeChallenge,
      })
    );
  });
});
