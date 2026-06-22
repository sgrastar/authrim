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
  mockCoreAdapter,
  mockPiiAdapter,
  mockPasskeyRepo,
  mockRuntimeUserStore,
  mockGenerateRegistrationOptions,
  mockVerifyRegistrationResponse,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
  };
  const coreAdapter = {
    execute: vi.fn(),
  };
  const piiAdapter = {};
  const passkeyRepo = {
    findByUserId: vi.fn(),
    findById: vi.fn(),
    rename: vi.fn(),
    findByCredentialId: vi.fn(),
    create: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockChallengeStore: challengeStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetChallengeStoreByChallengeId: vi.fn().mockResolvedValue(challengeStore),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({ coreAdapter }),
    mockCreatePIIContextFromHono: vi.fn().mockReturnValue({ defaultPiiAdapter: piiAdapter }),
    mockCoreAdapter: coreAdapter,
    mockPiiAdapter: piiAdapter,
    mockPasskeyRepo: passkeyRepo,
    mockRuntimeUserStore: {
      findById: vi.fn(),
    },
    mockGenerateRegistrationOptions: vi.fn(),
    mockVerifyRegistrationResponse: vi.fn(),
  };
});

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getChallengeStoreByChallengeId: mockGetChallengeStoreByChallengeId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    generateId: vi.fn(() => 'challenge-001'),
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    PasskeyRepository: vi.fn(function PasskeyRepositoryMock() {
      return mockPasskeyRepo;
    }),
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return mockRuntimeUserStore;
    }),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import {
  createAccountPasskeyOptionsHandler,
  completeAccountPasskeyRegistrationHandler,
  listAccountPasskeysHandler,
  updateAccountPasskeyHandler,
  deleteAccountPasskeyHandler,
} from '../account-passkeys';

const basePasskey = {
  id: 'pk_001',
  tenant_id: 'default',
  user_id: 'user-001',
  credential_id: 'credential-secret',
  public_key: 'public-key-secret',
  counter: 12,
  transports: ['internal'],
  device_name: 'MacBook',
  created_at: 1_777_000_000_000,
  last_used_at: 1_777_100_000_000,
};

function createMockContext(
  options: {
    cookie?: string;
    origin?: string;
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
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(headers.entries()),
        },
      }),
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
      device_name: 'Phone',
    });
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    mockRuntimeUserStore.findById.mockResolvedValue(null);
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
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockPasskeyRepo.findByUserId).toHaveBeenCalledWith('user-001');
    expect(body.total).toBe(1);
    expect(body.passkeys[0]).toEqual({
      id: 'pk_001',
      device_name: 'MacBook',
      created_at: 1_777_000_000_000,
      last_used_at: 1_777_100_000_000,
    });
    expect(body.passkeys[0]).not.toHaveProperty('credential_id');
    expect(body.passkeys[0]).not.toHaveProperty('public_key');
    expect(body.passkeys[0]).not.toHaveProperty('counter');
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
    const body = (await response.json()) as { passkey: Record<string, unknown> };

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
      })
    );
    expect(body.passkey).toEqual({
      id: 'pk_new',
      device_name: 'Phone',
      created_at: 1_777_000_000_000,
      last_used_at: 1_777_100_000_000,
    });
    expect(body.passkey).not.toHaveProperty('credential_id');
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
    const body = (await response.json()) as { passkey: Record<string, unknown> };

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
    const body = (await response.json()) as { passkey: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COUNT(*) FROM passkeys'),
      ['pk_001', 'default', 'user-001', 'default', 'user-001']
    );
    expect(body.passkey).toEqual({
      id: 'pk_001',
      deleted: true,
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
      })
    );
    const body = (await response.json()) as { passkey: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM passkeys WHERE id = ? AND tenant_id = ? AND user_id = ?',
      ['pk_001', 'default', 'user-001']
    );
    expect(body.passkey).toEqual({
      id: 'pk_001',
      deleted: true,
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
