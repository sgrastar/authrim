import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockChallengeStore,
  mockGetSessionStoreBySessionId,
  mockGetChallengeStoreByChallengeId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreatePIIContextFromHono,
  mockResolveAccountDataContextFromHono,
  mockEmailNotifier,
  mockCoreAdapter,
  mockPiiAdapter,
  mockPasskeyRepo,
  mockRateLimiter,
  mockRuntimeUserStore,
  mockGenerateAuthenticationOptions,
  mockGenerateRegistrationOptions,
  mockVerifyAuthenticationResponse,
  mockVerifyRegistrationResponse,
  mockAdvancePasskeyAuthenticationState,
  mockPublishAccountExternalSubjectAddition,
  mockPrepareAccountExternalSubjectRemoval,
  mockAttemptImmediateAccountDirectoryRemovals,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
    updateSessionDataRpc: vi.fn(),
  };
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
  };
  const coreAdapter = {
    execute: vi.fn(),
    batch: vi.fn(),
  };
  const piiAdapter = {};
  const emailNotifier = {
    send: vi.fn(),
  };
  const rateLimiter = {
    incrementRpc: vi.fn(),
  };
  const passkeyRepo = {
    findByUserId: vi.fn(),
    findById: vi.fn(),
    rename: vi.fn(),
    findByCredentialId: vi.fn(),
    create: vi.fn(),
    updateCounterAfterAuth: vi.fn(),
    mirrorCounterAfterAuth: vi.fn().mockResolvedValue(true),
  };
  return {
    mockSessionStore: sessionStore,
    mockChallengeStore: challengeStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetChallengeStoreByChallengeId: vi.fn().mockResolvedValue(challengeStore),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter }),
    mockCreatePIIContextFromHono: vi.fn().mockReturnValue({ defaultPiiAdapter: piiAdapter }),
    mockResolveAccountDataContextFromHono: vi.fn(),
    mockEmailNotifier: emailNotifier,
    mockCoreAdapter: coreAdapter,
    mockPiiAdapter: piiAdapter,
    mockPasskeyRepo: passkeyRepo,
    mockRateLimiter: rateLimiter,
    mockRuntimeUserStore: {
      findById: vi.fn(),
    },
    mockGenerateAuthenticationOptions: vi.fn(),
    mockGenerateRegistrationOptions: vi.fn(),
    mockVerifyAuthenticationResponse: vi.fn(),
    mockVerifyRegistrationResponse: vi.fn(),
    mockAdvancePasskeyAuthenticationState: vi.fn(async () => ({
      counter: 13,
      advanced: true,
    })),
    mockPublishAccountExternalSubjectAddition: vi.fn(),
    mockPrepareAccountExternalSubjectRemoval: vi.fn(),
    mockAttemptImmediateAccountDirectoryRemovals: vi.fn(),
  };
});

vi.mock('../account-identifier-addition', () => ({
  publishAccountExternalSubjectAddition: mockPublishAccountExternalSubjectAddition,
  prepareAccountExternalSubjectRemoval: mockPrepareAccountExternalSubjectRemoval,
}));

vi.mock('../account-directory-removal-producer', () => ({
  attemptImmediateAccountDirectoryRemovals: mockAttemptImmediateAccountDirectoryRemovals,
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
}));

vi.mock('@authrim/ar-lib-core/webauthn/aaguid-metadata', () => ({
  resolveAaguidAuthenticator: vi.fn((aaguid: string | null | undefined) =>
    aaguid
      ? {
          aaguid,
          name: 'Windows Hello',
          icon_dark: 'data:image/svg+xml;base64,dark',
          icon_light: 'data:image/svg+xml;base64,light',
          known: true,
        }
      : null
  ),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getChallengeStoreByChallengeId: mockGetChallengeStoreByChallengeId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    getTenantMetadataContextFromHono: vi.fn(() => undefined),
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createAccountAuthContextFromHono: mockCreateAuthContextFromHono,
    resolveAccountDataContextFromHono: mockResolveAccountDataContextFromHono,
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    ensureAccountAuthenticationState: vi.fn(async () => ({ lifecycle: 'active' })),
    advancePasskeyAuthenticationState: mockAdvancePasskeyAuthenticationState,
    getSessionRevocationStore: vi.fn(() => ({
      advancePasskeyCounterRpc: vi.fn().mockResolvedValue({ counter: 13, advanced: true }),
      deleteCredentialStateRpc: vi.fn().mockResolvedValue(true),
    })),
    generateId: vi.fn(() => 'challenge-001'),
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    PasskeyRepository: vi.fn(function PasskeyRepositoryMock() {
      return mockPasskeyRepo;
    }),
    resolveAaguidAuthenticator: vi.fn((aaguid: string | null | undefined) =>
      aaguid
        ? {
            aaguid,
            name: 'Windows Hello',
            icon_dark: 'data:image/svg+xml;base64,dark',
            icon_light: 'data:image/svg+xml;base64,light',
            known: true,
          }
        : null
    ),
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return mockRuntimeUserStore;
    }),
    getRequiredPluginContext: () => ({
      registry: {
        getNotifier: vi.fn((channel: string) => (channel === 'email' ? mockEmailNotifier : null)),
      },
    }),
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      const result = await mockEmailNotifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'PLATFORM_NOTIFICATION_DB',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import {
  completeAccountEmailCodeReauthHandler,
  createAccountPasskeyReauthOptionsHandler,
  createAccountPasskeyOptionsHandler,
  completeAccountPasskeyReauthHandler,
  completeAccountPasskeyRegistrationHandler,
  sendAccountEmailCodeReauthHandler,
  listAccountPasskeysHandler,
  updateAccountPasskeyHandler,
  deleteAccountPasskeyHandler,
} from '../account-passkeys';

const basePasskey = {
  id: 'pk_001',
  tenant_id: 'default',
  user_id: 'user-001',
  credential_id: 'credential-secret',
  rp_id: 'op.example.com',
  public_key: 'public-key-secret',
  counter: 12,
  transports: ['internal'],
  device_name: 'MacBook',
  aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
  created_at: 1_777_000_000_000,
  last_used_at: 1_777_100_000_000,
};

async function hashTestEmailCode(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${code}:${email.toLowerCase()}:${sessionId}:${issuedAt}`);
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createMockContext(
  options: {
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: unknown;
    settings?: Record<string, unknown>;
  } = {}
) {
  const headers = new Headers();
  const requestHeaders: Record<string, string> = {};
  if (options.cookie) {
    requestHeaders.Cookie = options.cookie;
  }
  if (options.origin) {
    requestHeaders.Origin = options.origin;
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    requestHeaders[name] = value;
  }
  const request = new Request('https://op.example.com/api/account/passkeys', {
    headers: requestHeaders,
  });
  return {
    env: {
      SETTINGS: {
        get: vi.fn(async (key: string) => {
          const value = options.settings?.[key];
          return value === undefined ? null : JSON.stringify(value);
        }),
      },
      OTP_HMAC_SECRET: 'test-secret',
      EMAIL_FROM: 'noreply@example.com',
      RATE_LIMITER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => mockRateLimiter),
      },
      ACCOUNT_DIRECTORY: {},
    } as unknown as Env,
    req: {
      method: 'GET',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
      param: (name: string) => options.params?.[name] ?? '',
      json: vi.fn().mockResolvedValue(options.body),
    },
    header: (name: string, value: string) => {
      headers.append(name, value);
    },
    json: (body: unknown, status = 200, responseHeaders?: HeadersInit) => {
      const mergedHeaders = new Headers(responseHeaders);
      mergedHeaders.set('Content-Type', 'application/json');
      for (const [name, value] of headers.entries()) mergedHeaders.set(name, value);
      return new Response(JSON.stringify(body), { status, headers: mergedHeaders });
    },
    executionCtx: { waitUntil: vi.fn() },
  } as any;
}

describe('Account Page passkey management API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000) - 60,
      },
    });
    mockPasskeyRepo.findByUserId.mockResolvedValue([basePasskey]);
    mockPasskeyRepo.findById.mockResolvedValue(basePasskey);
    mockPasskeyRepo.rename.mockResolvedValue({ ...basePasskey, device_name: 'Work Mac' });
    mockPasskeyRepo.findByCredentialId.mockResolvedValue(null);
    mockPasskeyRepo.create.mockResolvedValue({
      ...basePasskey,
      id: 'pk_new',
      credential_id: 'credential-new',
      device_name: 'Phone',
    });
    mockPasskeyRepo.updateCounterAfterAuth.mockResolvedValue({
      ...basePasskey,
      counter: 13,
    });
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    mockCoreAdapter.batch.mockResolvedValue([
      { rowsAffected: 1, success: true },
      { rowsAffected: 1, success: true },
    ]);
    mockPublishAccountExternalSubjectAddition.mockResolvedValue({ status: 201 });
    mockPrepareAccountExternalSubjectRemoval.mockResolvedValue({
      operationId: 'account-passkey-remove-pk_001',
      tenantId: 'default',
      accountId: 'account:user-001',
    });
    mockAttemptImmediateAccountDirectoryRemovals.mockResolvedValue(undefined);
    mockRateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
    mockEmailNotifier.send.mockResolvedValue({ success: true, messageId: 'email-001' });
    mockRuntimeUserStore.findById.mockResolvedValue(null);
    mockResolveAccountDataContextFromHono.mockResolvedValue({
      tenantId: 'default',
      accountId: 'account:user-001',
      legacyUserId: 'user-001',
      membership: { routeProjection: { targets: [] } },
    });
    mockGenerateAuthenticationOptions.mockResolvedValue({
      challenge: 'reauth-challenge-value',
      rpId: 'op.example.com',
      allowCredentials: [{ id: 'credential-secret', type: 'public-key' }],
      userVerification: 'required',
    });
    mockGenerateRegistrationOptions.mockResolvedValue({
      challenge: 'challenge-value',
      rp: { id: 'op.example.com', name: 'Authrim' },
      user: { id: 'user-001', name: 'user-001', displayName: 'user-001' },
      pubKeyCredParams: [],
    });
    mockChallengeStore.storeChallengeRpc.mockResolvedValue({ success: true });
    mockChallengeStore.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-001',
      challenge: 'challenge-value',
      metadata: {
        rpID: 'op.example.com',
        origin: 'https://op.example.com',
        deviceName: 'Phone',
      },
    });
    mockVerifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: 'credential-new',
        credentialPublicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      },
    });
    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 13,
      },
    });
    mockSessionStore.updateSessionDataRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000),
        amr: ['passkey'],
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists passkeys without credential material', async () => {
    const response = await listAccountPasskeysHandler(
      createMockContext({ cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current' })
    );
    const body = (await response.json()) as {
      passkeys: Array<Record<string, unknown>>;
      total: number;
      webauthn_signal?: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockPasskeyRepo.findByUserId).toHaveBeenCalledWith('user-001');
    expect(body.total).toBe(1);
    expect(body.passkeys[0]).toEqual({
      id: 'pk_001',
      device_name: 'MacBook',
      aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      provider: {
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
        name: 'Windows Hello',
        icon_dark: 'data:image/svg+xml;base64,dark',
        icon_light: 'data:image/svg+xml;base64,light',
        known: true,
      },
      created_at: 1_777_000_000_000,
      last_used_at: 1_777_100_000_000,
    });
    expect(body.webauthn_signal).toEqual({
      rp_id: 'op.example.com',
      user_id: 'dXNlci0wMDE',
      credential_ids: ['credential-secret'],
    });
    expect(body.passkeys[0]).not.toHaveProperty('credential_id');
    expect(body.passkeys[0]).not.toHaveProperty('public_key');
    expect(body.passkeys[0]).not.toHaveProperty('counter');
  });

  it('creates passkey re-authentication options for the current session user', async () => {
    const response = await createAccountPasskeyReauthOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {},
      })
    );
    const body = (await response.json()) as {
      challenge_id: string;
      options: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockGenerateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'op.example.com',
        userVerification: 'required',
        allowCredentials: [
          {
            id: 'credential-secret',
            type: 'public-key',
            transports: ['internal'],
          },
        ],
      })
    );
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'account_passkey_reauth:challenge-001',
        tenantId: 'default',
        type: 'passkey_reauth',
        userId: 'user-001',
        challenge: 'reauth-challenge-value',
        metadata: {
          rpID: 'op.example.com',
          origin: 'https://op.example.com',
          sessionId: 'g1:apac:3:session_current',
        },
      })
    );
    expect(body.challenge_id).toBe('challenge-001');
    expect(body.options).toHaveProperty('challenge', 'reauth-challenge-value');
  });

  it('uses the browser origin for passkey re-authentication through the Login UI proxy', async () => {
    const response = await createAccountPasskeyReauthOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        headers: {
          'x-authrim-ui-proxy': 'login-ui',
          'x-authrim-browser-origin': 'https://login.example.com',
          'x-authrim-forwarded-host': 'op.example.com',
        },
        body: {},
      })
    );

    expect(response.status).toBe(200);
    expect(mockGenerateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'login.example.com',
      })
    );
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          rpID: 'login.example.com',
          origin: 'https://login.example.com',
        }),
      })
    );
  });

  it('completes passkey re-authentication and refreshes session authTime', async () => {
    mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user-001',
      challenge: 'reauth-challenge-value',
      metadata: {
        rpID: 'op.example.com',
        origin: 'https://op.example.com',
        sessionId: 'g1:apac:3:session_current',
      },
    });
    mockPasskeyRepo.findByCredentialId.mockResolvedValueOnce(basePasskey);

    const response = await completeAccountPasskeyReauthHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {
          challenge_id: 'challenge-001',
          credential: { id: 'credential-secret' },
        },
      })
    );
    const body = (await response.json()) as {
      ok: boolean;
      reauth: { authenticated_at: number; expires_at: number; methods: string[] };
    };

    expect(response.status).toBe(200);
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'reauth-challenge-value',
        expectedOrigin: 'https://op.example.com',
        expectedRPID: 'op.example.com',
        requireUserVerification: true,
      })
    );
    expect(mockPasskeyRepo.mirrorCounterAfterAuth).toHaveBeenCalledWith('pk_001', 13);
    expect(mockSessionStore.updateSessionDataRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_current',
      expect.objectContaining({
        authTime: Math.floor(Date.now() / 1000),
        amr: ['passkey'],
      })
    );
    expect(body.ok).toBe(true);
    expect(body.reauth.expires_at).toBe(body.reauth.authenticated_at + 300);
  });

  it('fails closed with 503 when Passkey authentication authority is unavailable', async () => {
    mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user-001',
      challenge: 'reauth-challenge-value',
      metadata: {
        rpID: 'op.example.com',
        origin: 'https://op.example.com',
        sessionId: 'g1:apac:3:session_current',
      },
    });
    mockPasskeyRepo.findByCredentialId.mockResolvedValueOnce(basePasskey);
    mockAdvancePasskeyAuthenticationState.mockRejectedValueOnce(
      new Error('account_authentication_state_unavailable')
    );

    const response = await completeAccountPasskeyReauthHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {
          challenge_id: 'challenge-001',
          credential: { id: 'credential-secret' },
        },
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(mockSessionStore.updateSessionDataRpc).not.toHaveBeenCalled();
    expect(mockPasskeyRepo.mirrorCounterAfterAuth).not.toHaveBeenCalled();
  });

  it('uses the browser origin when completing passkey re-authentication through the Login UI proxy', async () => {
    mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user-001',
      challenge: 'reauth-challenge-value',
      metadata: {
        rpID: 'login.example.com',
        origin: 'https://login.example.com',
        sessionId: 'g1:apac:3:session_current',
      },
    });
    mockPasskeyRepo.findByCredentialId.mockResolvedValueOnce(basePasskey);

    const response = await completeAccountPasskeyReauthHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        headers: {
          'x-authrim-ui-proxy': 'login-ui',
          'x-authrim-browser-origin': 'https://login.example.com',
          'x-authrim-forwarded-host': 'op.example.com',
        },
        body: {
          challenge_id: 'challenge-001',
          credential: { id: 'credential-secret' },
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'https://login.example.com',
        expectedRPID: 'login.example.com',
      })
    );
  });

  it('rejects passkey re-authentication when passkey reauth is disabled', async () => {
    const response = await createAccountPasskeyReauthOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {},
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.passkey.enabled': true,
            'authentication-methods.passkey.reauth_enabled': false,
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error).toBe('no_reauth_method');
    expect(mockGenerateAuthenticationOptions).not.toHaveBeenCalled();
    expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('sends an email-code re-authentication challenge to the current verified user email', async () => {
    mockRuntimeUserStore.findById.mockResolvedValueOnce({
      id: 'user-001',
      email: 'User@Example.com',
      email_verified: 1,
      name: 'User One',
    });

    const response = await sendAccountEmailCodeReauthHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        body: {},
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.email_otp.enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.masked_email).toBe('u***r@example.com');
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^account_email_reauth:/),
        tenantId: 'default',
        type: 'account_email_reauth',
        userId: 'user-001',
        email: 'user@example.com',
        metadata: expect.objectContaining({
          sessionId: 'g1:apac:3:session_current',
        }),
      })
    );
    expect(mockEmailNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'user@example.com',
        subject: 'Your re-authentication code',
      })
    );
  });

  it('returns a redacted server error when email-code re-authentication delivery is rejected', async () => {
    mockRuntimeUserStore.findById.mockResolvedValueOnce({
      id: 'user-001',
      email: 'User@Example.com',
      email_verified: 1,
      name: 'User One',
    });
    mockEmailNotifier.send.mockResolvedValueOnce({
      success: false,
      error: 'provider secret detail',
    });

    const response = await sendAccountEmailCodeReauthHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        body: {},
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.email_otp.enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('provider secret detail');
  });

  it('completes email-code re-authentication and refreshes session authTime', async () => {
    const issuedAt = Date.now();
    const codeHash = await hashTestEmailCode(
      '123456',
      'user@example.com',
      'email-reauth-001',
      issuedAt,
      'test-secret'
    );
    mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user-001',
      email: 'user@example.com',
      challenge: codeHash,
      metadata: {
        sessionId: 'g1:apac:3:session_current',
        issuedAt,
      },
    });

    const response = await completeAccountEmailCodeReauthHandler(
      createMockContext({
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.email_otp.enabled': true,
          },
        },
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        body: {
          challenge_id: 'email-reauth-001',
          code: '123456',
        },
      })
    );
    const body = (await response.json()) as {
      ok: boolean;
      reauth: { authenticated_at: number; expires_at: number; methods: string[] };
    };

    expect(response.status).toBe(200);
    expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'account_email_reauth:email-reauth-001',
      tenantId: 'default',
      type: 'account_email_reauth',
    });
    expect(mockSessionStore.updateSessionDataRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_current',
      expect.objectContaining({
        authTime: Math.floor(Date.now() / 1000),
        amr: ['email_code'],
      })
    );
    expect(body.ok).toBe(true);
    expect(body.reauth.methods).toEqual(['email_code']);
  });

  it('creates registration options with a stored one-time challenge', async () => {
    const response = await createAccountPasskeyOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: { device_name: 'Phone' },
      })
    );
    const body = (await response.json()) as {
      challenge_id: string;
      options: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpName: 'Authrim',
        rpID: 'op.example.com',
        userName: 'user-001',
      })
    );
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'account_passkey_registration:challenge-001',
        tenantId: 'default',
        type: 'passkey_registration',
        userId: 'user-001',
        challenge: 'challenge-value',
        metadata: {
          rpID: 'op.example.com',
          origin: 'https://op.example.com',
          deviceName: 'Phone',
        },
      })
    );
    expect(body.challenge_id).toBe('challenge-001');
    expect(body.options).toHaveProperty('challenge', 'challenge-value');
  });

  it('uses the browser origin for registration options through the Login UI proxy', async () => {
    const response = await createAccountPasskeyOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        headers: {
          'x-authrim-ui-proxy': 'login-ui',
          'x-authrim-browser-origin': 'https://login.example.com',
          'x-authrim-forwarded-host': 'op.example.com',
        },
        body: { device_name: 'Phone' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'login.example.com',
      })
    );
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          rpID: 'login.example.com',
          origin: 'https://login.example.com',
        }),
      })
    );
  });

  it('rejects registration options without an Origin header', async () => {
    const response = await createAccountPasskeyOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        body: { device_name: 'Phone' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('rejects non-local HTTP origins for registration options', async () => {
    const response = await createAccountPasskeyOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'http://op.example.com',
        body: { device_name: 'Phone' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('allows localhost HTTP origins for local registration testing', async () => {
    const response = await createAccountPasskeyOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'http://localhost:5173',
        body: { device_name: 'Phone' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'localhost',
      })
    );
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          origin: 'http://localhost:5173',
          rpID: 'localhost',
        }),
      })
    );
  });

  it('requires recent authentication before creating registration options', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000) - 301,
      },
    });

    const response = await createAccountPasskeyOptionsHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: { device_name: 'Phone' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error).toBe('reauth_required');
    expect(mockGenerateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('completes registration by consuming the challenge and storing sanitized passkey output', async () => {
    const response = await completeAccountPasskeyRegistrationHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {
          challenge_id: 'challenge-001',
          passkey_response: {
            id: 'credential-new',
            rawId: 'credential-new',
            response: { transports: ['internal'] },
            type: 'public-key',
            clientExtensionResults: {},
          },
        },
      })
    );
    const body = (await response.json()) as {
      passkey: Record<string, unknown>;
      webauthn_signal?: Record<string, unknown>;
    };

    expect(response.status).toBe(201);
    expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'account_passkey_registration:challenge-001',
      tenantId: 'default',
      type: 'passkey_registration',
    });
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'challenge-value',
        expectedOrigin: 'https://op.example.com',
        expectedRPID: 'op.example.com',
        requireUserVerification: true,
      })
    );
    expect(mockPasskeyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-001',
        credential_id: 'credential-new',
        public_key: 'AQID',
        device_name: 'Phone',
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      })
    );
    expect(body.passkey).toEqual({
      id: 'pk_new',
      device_name: 'Phone',
      aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      provider: {
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
        name: 'Windows Hello',
        icon_dark: 'data:image/svg+xml;base64,dark',
        icon_light: 'data:image/svg+xml;base64,light',
        known: true,
      },
      created_at: 1_777_000_000_000,
      last_used_at: 1_777_100_000_000,
    });
    expect(body.webauthn_signal).toEqual({
      rp_id: 'op.example.com',
      user_id: 'dXNlci0wMDE',
      credential_ids: ['credential-secret', 'credential-new'],
    });
    expect(body.passkey).not.toHaveProperty('credential_id');
  });

  it('uses the browser origin when completing registration through the Login UI proxy', async () => {
    mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user-001',
      challenge: 'challenge-value',
      metadata: {
        rpID: 'login.example.com',
        origin: 'https://login.example.com',
        deviceName: 'Phone',
      },
    });

    const response = await completeAccountPasskeyRegistrationHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        headers: {
          'x-authrim-ui-proxy': 'login-ui',
          'x-authrim-browser-origin': 'https://login.example.com',
          'x-authrim-forwarded-host': 'op.example.com',
        },
        body: {
          challenge_id: 'challenge-001',
          passkey_response: {
            id: 'credential-new',
            rawId: 'credential-new',
            response: { transports: ['internal'] },
            type: 'public-key',
            clientExtensionResults: {},
          },
        },
      })
    );
    const body = (await response.json()) as {
      webauthn_signal?: Record<string, unknown>;
    };

    expect(response.status).toBe(201);
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'https://login.example.com',
        expectedRPID: 'login.example.com',
      })
    );
    expect(body.webauthn_signal).toEqual({
      rp_id: 'login.example.com',
      user_id: 'dXNlci0wMDE',
      credential_ids: ['credential-secret', 'credential-new'],
    });
  });

  it('rejects passkey completion when the stored challenge belongs to another user', async () => {
    mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'other-user',
      challenge: 'challenge-value',
      metadata: {
        rpID: 'op.example.com',
        origin: 'https://op.example.com',
      },
    });

    const response = await completeAccountPasskeyRegistrationHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {
          challenge_id: 'challenge-001',
          passkey_response: { response: {}, type: 'public-key' },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_challenge');
    expect(mockPasskeyRepo.create).not.toHaveBeenCalled();
  });

  it('rejects passkey completion when the request origin does not match the challenge', async () => {
    const response = await completeAccountPasskeyRegistrationHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://evil.example.com',
        body: {
          challenge_id: 'challenge-001',
          passkey_response: { response: {}, type: 'public-key' },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_challenge');
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
    expect(mockPasskeyRepo.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate passkey credentials', async () => {
    mockPasskeyRepo.findByCredentialId.mockResolvedValueOnce(basePasskey);

    const response = await completeAccountPasskeyRegistrationHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        origin: 'https://op.example.com',
        body: {
          challenge_id: 'challenge-001',
          passkey_response: {
            id: 'credential-new',
            rawId: 'credential-new',
            response: { transports: ['internal'] },
            type: 'public-key',
            clientExtensionResults: {},
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('credential_exists');
    expect(mockPasskeyRepo.create).not.toHaveBeenCalled();
  });

  it('renames an owned passkey with normalized display text', async () => {
    const response = await updateAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
        body: { device_name: '  Work   Mac  ' },
      })
    );
    const body = (await response.json()) as {
      passkey: Record<string, unknown>;
      webauthn_signal?: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockPasskeyRepo.rename).toHaveBeenCalledWith('pk_001', 'Work Mac');
    expect(body.passkey).toMatchObject({
      id: 'pk_001',
      device_name: 'Work Mac',
    });
  });

  it('does not rename a passkey owned by another user', async () => {
    mockPasskeyRepo.findById.mockResolvedValueOnce({ ...basePasskey, user_id: 'other-user' });

    const response = await updateAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
        body: { device_name: 'Work Mac' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(mockPasskeyRepo.rename).not.toHaveBeenCalled();
  });

  it('requires recent authentication before deleting a passkey', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValueOnce({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000) - 301,
      },
    });

    const response = await deleteAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error).toBe('reauth_required');
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });

  it('deletes an owned passkey only when another passkey remains', async () => {
    mockPasskeyRepo.findByUserId.mockResolvedValueOnce([
      basePasskey,
      { ...basePasskey, id: 'pk_002', credential_id: 'credential-secret-2' },
    ]);

    const response = await deleteAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
      })
    );
    const body = (await response.json()) as {
      passkey: Record<string, unknown>;
      webauthn_signal?: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockCoreAdapter.batch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('SELECT COUNT(*) FROM passkeys'),
          params: ['pk_001', 'default', 'user-001', 'default', 'user-001'],
        }),
      ])
    );
    expect(body.passkey).toEqual({
      id: 'pk_001',
      deleted: true,
    });
    expect(body.webauthn_signal).toEqual({
      rp_id: 'op.example.com',
      user_id: 'dXNlci0wMDE',
      credential_ids: ['credential-secret-2'],
    });
  });

  it('blocks deleting the last available login method', async () => {
    const response = await deleteAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('remaining_login_method_required');
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });

  it('allows deleting the last passkey when verified email code login remains available', async () => {
    mockRuntimeUserStore.findById.mockResolvedValueOnce({
      id: 'user-001',
      email: 'user@example.com',
      email_verified: 1,
    });

    const response = await deleteAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.email_otp.enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as {
      passkey: Record<string, unknown>;
      webauthn_signal?: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockCoreAdapter.batch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sql: 'DELETE FROM passkeys WHERE id = ? AND tenant_id = ? AND user_id = ?',
          params: ['pk_001', 'default', 'user-001'],
        }),
      ])
    );
    expect(body.passkey).toEqual({
      id: 'pk_001',
      deleted: true,
    });
    expect(body.webauthn_signal).toEqual({
      rp_id: 'op.example.com',
      user_id: 'dXNlci0wMDE',
      credential_ids: [],
    });
  });

  it('does not treat email account linking as a remaining login method', async () => {
    mockRuntimeUserStore.findById.mockResolvedValueOnce({
      id: 'user-001',
      email: 'user@example.com',
      email_verified: 1,
    });

    const response = await deleteAccountPasskeyHandler(
      createMockContext({
        cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
        params: { id: 'pk_001' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.email_otp.enabled': true,
            'authentication-methods.email_otp.login_enabled': false,
            'authentication-methods.email_otp.account_link_enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('remaining_login_method_required');
    expect(mockCoreAdapter.execute).not.toHaveBeenCalled();
  });
});
