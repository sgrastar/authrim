import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreatePIIContextFromHono,
  mockCoreAdapter,
  mockPiiAdapter,
  mockTotpRepo,
  mockRuntimeUserStore,
  mockRateLimiter,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
    updateSessionDataRpc: vi.fn(),
  };
  const coreAdapter = {
    execute: vi.fn(),
  };
  const piiAdapter = {};
  const totpRepo = {
    create: vi.fn(),
    findById: vi.fn(),
    findByUserId: vi.fn(),
    findActiveByUserId: vi.fn(),
    activate: vi.fn(),
    markUsed: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    replaceBackupCodes: vi.fn(),
    listBackupCodes: vi.fn(),
    consumeBackupCode: vi.fn(),
  };
  const rateLimiter = {
    incrementRpc: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter,
      repositories: {
        totp: totpRepo,
      },
    }),
    mockCreatePIIContextFromHono: vi.fn().mockReturnValue({ defaultPiiAdapter: piiAdapter }),
    mockCoreAdapter: coreAdapter,
    mockPiiAdapter: piiAdapter,
    mockTotpRepo: totpRepo,
    mockRuntimeUserStore: {
      findById: vi.fn(),
    },
    mockRateLimiter: rateLimiter,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return mockRuntimeUserStore;
    }),
  };
});

import {
  encryptValue,
  generateTotpCode,
  getTotpTimeStep,
  type TotpProfile,
} from '@authrim/ar-lib-core';
import {
  activateAccountTotpCredentialHandler,
  completeAccountTotpReauthHandler,
  createAccountTotpOptionsHandler,
  deleteAccountTotpCredentialHandler,
} from '../account-totp';

const encryptionKey = '00'.repeat(32);
const baseSession = {
  id: 'g1:apac:3:session_current',
  tenantId: 'default',
  userId: 'user-001',
  createdAt: 1_777_000_000_000,
  expiresAt: Date.now() + 60_000,
  data: {
    authTime: Math.floor(Date.now() / 1000) - 60,
    amr: ['passkey'],
  },
};

function createMockContext(
  options: {
    body?: unknown;
    settings?: Record<string, unknown>;
    env?: Partial<Env>;
  } = {}
) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/totp', {
    headers: {
      Cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_current',
    },
  });
  return {
    env: {
      ISSUER_URL: 'https://op.example.com',
      PII_ENCRYPTION_KEY: encryptionKey,
      PII_ENCRYPTION_KEY_VERSION: '7',
      OTP_HMAC_SECRET: 'backup-code-secret',
      RATE_LIMITER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => mockRateLimiter),
      },
      SETTINGS: {
        get: vi.fn(async (key: string) => {
          const value = options.settings?.[key];
          return value === undefined ? null : JSON.stringify(value);
        }),
      },
      ...options.env,
    } as unknown as Env,
    req: {
      method: 'POST',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
      param: vi.fn(),
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

describe('Account Page TOTP API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
    });
    mockSessionStore.updateSessionDataRpc.mockResolvedValue({
      ...baseSession,
      data: {
        authTime: Math.floor(Date.now() / 1000),
        amr: ['passkey', 'otp', 'totp'],
      },
    });
    mockRuntimeUserStore.findById.mockResolvedValue({
      id: 'user-001',
      email: 'person@example.com',
      preferred_username: 'person',
    });
    mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
    mockRateLimiter.incrementRpc.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mockTotpRepo.create.mockImplementation(async (input) => ({
      id: 'totp-001',
      tenant_id: 'default',
      ...input,
      secret_key_version: input.secret_key_version ?? 1,
      status: input.status ?? 'pending',
      last_used_time_step: null,
      created_at: Date.now(),
      activated_at: null,
      last_used_at: null,
    }));
    mockTotpRepo.replaceBackupCodes.mockResolvedValue([]);
    mockTotpRepo.markUsed.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts enrollment with an encrypted pending secret and strong preset parameters', async () => {
    const response = await createAccountTotpOptionsHandler(
      createMockContext({
        body: { label: 'Work phone' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.account_link_enabled': true,
            'authentication-methods.totp.preset': 'strong',
          },
        },
      })
    );
    const body = (await response.json()) as {
      secret: string;
      otpauth_uri: string;
      profile: TotpProfile;
    };

    expect(response.status).toBe(201);
    expect(body.profile).toEqual({ algorithm: 'SHA256', digits: 8, period: 30, window: 1 });
    expect(body.otpauth_uri).toContain('issuer=op.example.com');
    expect(mockTotpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-001',
        label: 'Work phone',
        algorithm: 'SHA256',
        digits: 8,
        status: 'pending',
        secret_key_version: 7,
      })
    );
    const createInput = mockTotpRepo.create.mock.calls[0][0];
    expect(createInput.secret_encrypted).toMatch(/^enc:v7:gcm:/);
    expect(createInput.secret_encrypted).not.toContain(body.secret);
  });

  it('starts enrollment when TOTP login is enabled without account-link enablement', async () => {
    const response = await createAccountTotpOptionsHandler(
      createMockContext({
        body: { label: 'Login app' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
            'authentication-methods.totp.account_link_enabled': false,
          },
        },
      })
    );

    expect(response.status).toBe(201);
    expect(mockTotpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-001',
        label: 'Login app',
        status: 'pending',
      })
    );
  });

  it('rejects enrollment when TOTP login and account linking are both disabled', async () => {
    const response = await createAccountTotpOptionsHandler(
      createMockContext({
        body: { label: 'Blocked app' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': false,
            'authentication-methods.totp.account_link_enabled': false,
          },
        },
      })
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('method_disabled');
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
  });

  it('rejects enrollment before creating a pending credential when backup code hashing is not configured', async () => {
    const response = await createAccountTotpOptionsHandler(
      createMockContext({
        body: { label: 'Work phone' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.account_link_enabled': true,
          },
        },
        env: { OTP_HMAC_SECRET: undefined },
      })
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe('server_error');
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
  });

  it('activates a pending credential and returns one-time backup codes once', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const timeStep = getTotpTimeStep(Date.now(), profile.period);
    const code = await generateTotpCode(secret, profile, timeStep);
    const pendingCredential = {
      id: 'totp-001',
      tenant_id: 'default',
      user_id: 'user-001',
      secret_encrypted: encrypted.encrypted,
      secret_key_version: 1,
      label: 'Authenticator app',
      ...profile,
      status: 'pending',
      last_used_time_step: null,
      created_at: Date.now(),
      activated_at: null,
      last_used_at: null,
    };
    mockTotpRepo.findById.mockResolvedValue(pendingCredential);
    mockTotpRepo.activate.mockResolvedValue({
      ...pendingCredential,
      status: 'active',
      activated_at: Date.now(),
      last_used_at: Date.now(),
      last_used_time_step: timeStep,
    });

    const response = await activateAccountTotpCredentialHandler(
      createMockContext({
        body: { credential_id: 'totp-001', code },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as { backup_codes: string[] };

    expect(response.status).toBe(200);
    expect(body.backup_codes).toHaveLength(10);
    expect(mockTotpRepo.activate).toHaveBeenCalledWith('totp-001', 'user-001', timeStep);
    expect(mockTotpRepo.replaceBackupCodes).toHaveBeenCalledWith(
      'user-001',
      'totp-001',
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 'user-001',
          credential_id: 'totp-001',
          code_hash: expect.any(String),
          code_prefix: expect.any(String),
        }),
      ])
    );
  });

  it('rejects activation before mutating the credential when backup code hashing is not configured', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const code = await generateTotpCode(
      secret,
      profile,
      getTotpTimeStep(Date.now(), profile.period)
    );
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      tenant_id: 'default',
      user_id: 'user-001',
      secret_encrypted: encrypted.encrypted,
      secret_key_version: 1,
      label: 'Authenticator app',
      ...profile,
      status: 'pending',
      last_used_time_step: null,
      created_at: Date.now(),
      activated_at: null,
      last_used_at: null,
    });

    const response = await activateAccountTotpCredentialHandler(
      createMockContext({
        body: { credential_id: 'totp-001', code },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.account_link_enabled': true,
          },
        },
        env: { OTP_HMAC_SECRET: undefined },
      })
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe('server_error');
    expect(mockTotpRepo.activate).not.toHaveBeenCalled();
    expect(mockTotpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('rate limits pending credential activation before checking the TOTP secret', async () => {
    mockRateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      tenant_id: 'default',
      user_id: 'user-001',
      secret_encrypted: 'not-encrypted-for-this-test',
      secret_key_version: 1,
      label: 'Authenticator app',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'pending',
      last_used_time_step: null,
      created_at: Date.now(),
      activated_at: null,
      last_used_at: null,
    });

    const response = await activateAccountTotpCredentialHandler(
      createMockContext({
        body: { credential_id: 'totp-001', code: '123456' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.account_link_enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as { error: string; retry_after: number };

    expect(response.status).toBe(429);
    expect(body).toEqual(
      expect.objectContaining({
        error: 'rate_limited',
        retry_after: 120,
      })
    );
    expect(mockRateLimiter.incrementRpc).toHaveBeenCalledWith('activate:user-001:totp-001', {
      windowSeconds: 300,
      maxRequests: 10,
    });
    expect(mockTotpRepo.activate).not.toHaveBeenCalled();
  });

  it('rate limits active credential deletion before consuming a backup code', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: {
        authTime: Math.floor(Date.now() / 1000) - 60,
        amr: ['email_otp'],
      },
    });
    mockRateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      tenant_id: 'default',
      user_id: 'user-001',
      secret_encrypted: 'not-encrypted-for-this-test',
      secret_key_version: 1,
      label: 'Authenticator app',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'active',
      last_used_time_step: null,
      created_at: Date.now(),
      activated_at: Date.now(),
      last_used_at: null,
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        tenant_id: 'default',
        user_id: 'user-001',
        secret_encrypted: 'not-encrypted-for-this-test',
        secret_key_version: 1,
        label: 'Authenticator app',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        status: 'active',
        last_used_time_step: null,
        created_at: Date.now(),
        activated_at: Date.now(),
        last_used_at: null,
      },
      {
        id: 'totp-002',
        tenant_id: 'default',
        user_id: 'user-001',
        secret_encrypted: 'not-encrypted-for-this-test',
        secret_key_version: 1,
        label: 'Backup phone',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        status: 'active',
        last_used_time_step: null,
        created_at: Date.now(),
        activated_at: Date.now(),
        last_used_at: null,
      },
    ]);

    const context = createMockContext({ body: { backup_code: 'ABCD-EFGH-IJKL' } });
    context.req.param = vi.fn((name: string) => (name === 'id' ? 'totp-001' : ''));
    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(429);
    expect(mockRateLimiter.incrementRpc).toHaveBeenCalledWith('delete:user-001:totp-001', {
      windowSeconds: 300,
      maxRequests: 10,
    });
    expect(mockTotpRepo.consumeBackupCode).not.toHaveBeenCalled();
    expect(mockTotpRepo.delete).not.toHaveBeenCalled();
  });

  it('completes TOTP reauthentication and refreshes the account session auth time', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const timeStep = getTotpTimeStep(Date.now(), profile.period);
    const code = await generateTotpCode(secret, profile, timeStep);
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        tenant_id: 'default',
        user_id: 'user-001',
        secret_encrypted: encrypted.encrypted,
        secret_key_version: 1,
        label: 'Authenticator app',
        ...profile,
        status: 'active',
        last_used_time_step: null,
        created_at: Date.now(),
        activated_at: Date.now(),
        last_used_at: null,
      },
    ]);

    const response = await completeAccountTotpReauthHandler(
      createMockContext({
        body: { code },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.reauth_enabled': true,
          },
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockTotpRepo.markUsed).toHaveBeenCalledWith('totp-001', 'user-001', timeStep);
    expect(mockSessionStore.updateSessionDataRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_current',
      expect.objectContaining({
        amr: ['passkey', 'otp', 'totp'],
      })
    );
  });

  it('rate limits TOTP reauthentication before checking active credentials', async () => {
    mockRateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 180 });

    const response = await completeAccountTotpReauthHandler(
      createMockContext({
        body: { code: '123456' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.reauth_enabled': true,
          },
        },
      })
    );
    const body = (await response.json()) as { error: string; retry_after: number };

    expect(response.status).toBe(429);
    expect(body).toEqual(
      expect.objectContaining({
        error: 'rate_limited',
        retry_after: 180,
      })
    );
    expect(mockRateLimiter.incrementRpc).toHaveBeenCalledWith('reauth:user-001', {
      windowSeconds: 300,
      maxRequests: 10,
    });
    expect(mockTotpRepo.findActiveByUserId).not.toHaveBeenCalled();
    expect(mockSessionStore.updateSessionDataRpc).not.toHaveBeenCalled();
  });
});
