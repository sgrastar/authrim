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
  mockPasskeyRepo,
  mockConsumeTotpAuthenticationState,
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
    mockPasskeyRepo: { findByUserId: vi.fn() },
    mockConsumeTotpAuthenticationState: vi.fn(async () => ({ lastAcceptedTimeStep: 1 })),
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
    ensureAccountAuthenticationState: vi.fn(async () => ({ lifecycle: 'active' })),
    consumeTotpAuthenticationState: mockConsumeTotpAuthenticationState,
    getSessionRevocationStore: vi.fn(() => ({
      consumeTotpTimeStepRpc: vi.fn().mockResolvedValue({ lastAcceptedTimeStep: 1 }),
      deleteCredentialStateRpc: vi.fn().mockResolvedValue(true),
    })),
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return mockRuntimeUserStore;
    }),
    PasskeyRepository: vi.fn(function PasskeyRepositoryMock() {
      return mockPasskeyRepo;
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
  listAccountTotpCredentialsHandler,
  regenerateAccountTotpBackupCodesHandler,
  updateAccountTotpCredentialHandler,
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
    bodyError?: Error;
    settings?: Record<string, unknown>;
    rawSettings?: Record<string, string>;
    env?: Partial<Env>;
    cookie?: string | null;
  } = {}
) {
  const headers = new Headers();
  const cookie =
    options.cookie === null
      ? undefined
      : (options.cookie ?? 'authrim_session=g1%3Aapac%3A3%3Asession_current');
  const request = new Request('https://op.example.com/api/account/totp', {
    headers: cookie ? { Cookie: cookie } : {},
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
          if (options.rawSettings?.[key] !== undefined) {
            return options.rawSettings[key];
          }
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
      json: options.bodyError
        ? vi.fn().mockRejectedValue(options.bodyError)
        : vi.fn().mockResolvedValue(options.body),
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
    mockPasskeyRepo.findByUserId.mockResolvedValue([]);
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

  it('fails closed with 503 when TOTP authentication authority is unavailable', async () => {
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
    mockConsumeTotpAuthenticationState.mockRejectedValueOnce(
      new Error('account_authentication_state_unavailable')
    );

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

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(mockTotpRepo.markUsed).not.toHaveBeenCalled();
    expect(mockSessionStore.updateSessionDataRpc).not.toHaveBeenCalled();
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

  it('lists sanitized credentials and only backup-code counts', async () => {
    mockTotpRepo.findByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        user_id: 'user-001',
        secret_encrypted: 'must-not-leak',
        label: 'Phone',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        status: 'active',
        created_at: 1,
        activated_at: 2,
        last_used_at: null,
      },
    ]);
    mockTotpRepo.listBackupCodes.mockResolvedValue([
      { id: 'b1', code_hash: 'secret', used_at: null },
      { id: 'b2', code_hash: 'secret', used_at: 10 },
    ]);

    const response = await listAccountTotpCredentialsHandler(createMockContext());
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.credentials[0]).not.toHaveProperty('secret_encrypted');
    expect(body.backup_codes).toEqual({ total: 2, remaining: 1 });
  });

  it.each([
    [{}, 400],
    [{ label: 'x'.repeat(101) }, 400],
  ])('rejects invalid TOTP rename payload %#', async (body, status) => {
    const context = createMockContext({ body });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await updateAccountTotpCredentialHandler(context);

    expect(response.status).toBe(status);
    expect(mockTotpRepo.rename).not.toHaveBeenCalled();
  });

  it('does not rename another user TOTP credential', async () => {
    mockTotpRepo.findById.mockResolvedValue({ id: 'totp-001', user_id: 'other' });
    const context = createMockContext({ body: { label: 'New' } });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await updateAccountTotpCredentialHandler(context);

    expect(response.status).toBe(404);
    expect(mockTotpRepo.rename).not.toHaveBeenCalled();
  });

  it('renames an owned TOTP credential and records only changed fields', async () => {
    const credential = {
      id: 'totp-001',
      user_id: 'user-001',
      label: 'Old',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'active',
      created_at: 1,
      activated_at: 2,
      last_used_at: null,
    };
    mockTotpRepo.findById.mockResolvedValue(credential);
    mockTotpRepo.rename.mockResolvedValue({ ...credential, label: 'New' });
    const context = createMockContext({ body: { label: ' New ' } });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await updateAccountTotpCredentialHandler(context);

    expect(response.status).toBe(200);
    expect(mockTotpRepo.rename).toHaveBeenCalledWith('totp-001', 'user-001', 'New');
  });

  it('deletes an owned pending credential without demanding authentication proof', async () => {
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-pending',
      user_id: 'user-001',
      status: 'pending',
      label: 'Pending',
    });
    mockTotpRepo.delete.mockResolvedValue(true);
    const context = createMockContext();
    context.req.param = vi.fn(() => 'totp-pending');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(200);
    expect(mockTotpRepo.delete).toHaveBeenCalledWith('totp-pending', 'user-001');
    expect(mockTotpRepo.consumeBackupCode).not.toHaveBeenCalled();
  });

  it('returns not found when deleting an unknown or cross-user credential', async () => {
    mockTotpRepo.findById.mockResolvedValue(null);
    const context = createMockContext();
    context.req.param = vi.fn(() => 'missing');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(404);
    expect(mockTotpRepo.delete).not.toHaveBeenCalled();
  });

  it('rejects backup-code regeneration when no active TOTP credential exists', async () => {
    mockTotpRepo.findActiveByUserId.mockResolvedValue([]);

    const response = await regenerateAccountTotpBackupCodesHandler(createMockContext());

    expect(response.status).toBe(404);
    expect(mockTotpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('regenerates one-time backup codes after recent passkey authentication', async () => {
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);
    mockTotpRepo.replaceBackupCodes.mockResolvedValue([]);

    const response = await regenerateAccountTotpBackupCodesHandler(createMockContext());
    const body = (await response.json()) as { backup_codes: string[] };

    expect(response.status).toBe(200);
    expect(body.backup_codes).toHaveLength(10);
    expect(mockTotpRepo.replaceBackupCodes).toHaveBeenCalled();
  });

  it('uses enrollment defaults for malformed optional JSON but rejects oversized labels', async () => {
    const malformedResponse = await createAccountTotpOptionsHandler(
      createMockContext({
        bodyError: new Error('bad json'),
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
          },
        },
      })
    );
    expect(malformedResponse.status).toBe(201);
    expect(mockTotpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Authenticator app' })
    );

    mockTotpRepo.create.mockClear();
    const oversizedResponse = await createAccountTotpOptionsHandler(
      createMockContext({
        body: { label: 'x'.repeat(101) },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
          },
        },
      })
    );
    expect(oversizedResponse.status).toBe(400);
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', undefined, new Error('bad json'), 400],
    ['missing fields', {}, undefined, 400],
  ])('rejects activation with %s', async (_label, body, bodyError, status) => {
    const response = await activateAccountTotpCredentialHandler(
      createMockContext({ body, bodyError })
    );

    expect(response.status).toBe(status);
    expect(mockTotpRepo.findById).not.toHaveBeenCalled();
  });

  it('does not activate an unknown, cross-user, or already-active credential', async () => {
    for (const credential of [
      null,
      { id: 'totp-001', user_id: 'other', status: 'pending' },
      { id: 'totp-001', user_id: 'user-001', status: 'active' },
    ]) {
      mockTotpRepo.findById.mockResolvedValueOnce(credential);
      const response = await activateAccountTotpCredentialHandler(
        createMockContext({
          body: { credential_id: 'totp-001', code: '123456' },
          settings: {
            'settings:tenant:default:authentication-methods': {
              'authentication-methods.totp.login_enabled': true,
            },
          },
        })
      );
      expect(response.status).toBe(404);
    }
    expect(mockTotpRepo.activate).not.toHaveBeenCalled();
  });

  it('rejects an invalid activation code without mutating pending state', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      secret_encrypted: encrypted.encrypted,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'pending',
    });

    const response = await activateAccountTotpCredentialHandler(
      createMockContext({
        body: { credential_id: 'totp-001', code: '000000' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(mockTotpRepo.activate).not.toHaveBeenCalled();
  });

  it('reports a concurrent activation state change as conflict', async () => {
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
      user_id: 'user-001',
      secret_encrypted: encrypted.encrypted,
      ...profile,
      status: 'pending',
    });
    mockTotpRepo.activate.mockResolvedValue(null);

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

    expect(response.status).toBe(409);
    expect(mockTotpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('reports a concurrent pending-credential deletion as not found', async () => {
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-pending',
      user_id: 'user-001',
      status: 'pending',
    });
    mockTotpRepo.delete.mockResolvedValue(false);
    const context = createMockContext();
    context.req.param = vi.fn(() => 'totp-pending');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(404);
  });

  it.each([
    ['malformed JSON', undefined, new Error('bad json'), 400],
    ['missing code', {}, undefined, 400],
  ])('rejects TOTP reauthentication with %s', async (_label, body, bodyError, status) => {
    const response = await completeAccountTotpReauthHandler(createMockContext({ body, bodyError }));

    expect(response.status).toBe(status);
    expect(mockTotpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('rejects TOTP reauthentication when the method is disabled', async () => {
    const response = await completeAccountTotpReauthHandler(
      createMockContext({
        body: { code: '123456' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.reauth_enabled': false,
          },
        },
      })
    );

    expect(response.status).toBe(403);
    expect(mockTotpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('rejects an invalid TOTP reauthentication code', async () => {
    mockTotpRepo.findActiveByUserId.mockResolvedValue([]);
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

    expect(response.status).toBe(400);
    expect(mockSessionStore.updateSessionDataRpc).not.toHaveBeenCalled();
  });

  it('allows deleting one of multiple active TOTP credentials after recent TOTP auth', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['totp'] },
    });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
      label: 'Primary',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      { id: 'totp-001', user_id: 'user-001' },
      { id: 'totp-002', user_id: 'user-001' },
    ]);
    mockTotpRepo.delete.mockResolvedValue(true);
    const context = createMockContext();
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(200);
    expect(mockRateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('accepts a passkey as the remaining login method after TOTP deletion', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['totp'] },
    });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
      label: 'Primary',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);
    mockPasskeyRepo.findByUserId.mockResolvedValue([{ id: 'passkey-1' }]);
    mockTotpRepo.delete.mockResolvedValue(true);
    const context = createMockContext({ body: {} });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(200);
    expect(mockPasskeyRepo.findByUserId).toHaveBeenCalledWith('user-001');
  });

  it('blocks deletion of the last active login method', async () => {
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
      label: 'Only method',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);
    mockPasskeyRepo.findByUserId.mockResolvedValue([]);
    mockRuntimeUserStore.findById.mockResolvedValue({ email: null, email_verified: 0 });
    const context = createMockContext({
      settings: {
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.passkey.login_enabled': false,
          'authentication-methods.email_otp.login_enabled': false,
        },
      },
    });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(400);
    expect(mockTotpRepo.delete).not.toHaveBeenCalled();
  });

  it('requires a valid proof when deleting active TOTP without TOTP/passkey reauth', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['email_otp'] },
    });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
      label: 'Primary',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      { id: 'totp-001', user_id: 'user-001' },
      { id: 'totp-002', user_id: 'user-001' },
    ]);
    const context = createMockContext({ body: {} });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(400);
    expect(mockTotpRepo.delete).not.toHaveBeenCalled();
  });

  it('consumes a valid backup code once as deletion proof', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['email_otp'] },
    });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
      label: 'Primary',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      { id: 'totp-001', user_id: 'user-001' },
      { id: 'totp-002', user_id: 'user-001' },
    ]);
    mockTotpRepo.consumeBackupCode.mockResolvedValue({ id: 'backup-1' });
    mockTotpRepo.delete.mockResolvedValue(true);
    const context = createMockContext({ body: { backup_code: 'ABCD-EFGH-IJKL' } });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(200);
    expect(mockTotpRepo.consumeBackupCode).toHaveBeenCalledWith('user-001', expect.any(String));
  });

  it('rate limits backup-code regeneration before checking a TOTP code', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['email_otp'] },
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);
    mockRateLimiter.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 30 });

    const response = await regenerateAccountTotpBackupCodesHandler(
      createMockContext({ body: { code: '123456' } })
    );

    expect(response.status).toBe(429);
    expect(mockTotpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('returns server error when reauthentication cannot update the session', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const step = getTotpTimeStep(Date.now(), 30);
    const code = await generateTotpCode(secret, profile, step);
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        user_id: 'user-001',
        secret_encrypted: encrypted.encrypted,
        last_used_time_step: null,
        ...profile,
      },
    ]);
    mockSessionStore.updateSessionDataRpc.mockResolvedValue(null);

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

    expect(response.status).toBe(500);
  });

  it('requires an account session before listing TOTP credentials', async () => {
    const response = await listAccountTotpCredentialsHandler(createMockContext({ cookie: null }));

    expect(response.status).toBe(401);
    expect(mockTotpRepo.findByUserId).not.toHaveBeenCalled();
  });

  it('requires recent authentication before enrollment', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 301, amr: ['passkey'] },
    });

    const response = await createAccountTotpOptionsHandler(createMockContext());

    expect(response.status).toBe(403);
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
  });

  it('accepts string feature flags and falls back from malformed profile settings', async () => {
    const key = 'settings:tenant:default:authentication-methods';
    const response = await createAccountTotpOptionsHandler(
      createMockContext({
        body: {},
        settings: {
          [key]: {
            'authentication-methods.totp.enabled': 'true',
            'authentication-methods.totp.account_link_enabled': 'true',
            'authentication-methods.totp.login_enabled': 'false',
          },
        },
        env: { PII_ENCRYPTION_KEY_VERSION: 'invalid', ISSUER_URL: 'not a url' },
      })
    );

    expect(response.status).toBe(201);
    expect(mockTotpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ secret_key_version: 1, algorithm: 'SHA1' })
    );
  });

  it('falls back safely when authentication-method settings contain malformed JSON', async () => {
    const key = 'settings:tenant:default:authentication-methods';
    const response = await createAccountTotpOptionsHandler(
      createMockContext({ rawSettings: { [key]: '{bad json' } })
    );

    expect(response.status).toBe(403);
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
  });

  it('uses preferred username then user id when email is absent', async () => {
    mockRuntimeUserStore.findById.mockResolvedValueOnce({ preferred_username: 'preferred-user' });
    const first = await createAccountTotpOptionsHandler(
      createMockContext({
        body: {},
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
          },
        },
        env: { ISSUER_URL: undefined },
      })
    );
    expect(first.status).toBe(201);
    expect(((await first.json()) as { otpauth_uri: string }).otpauth_uri).toContain(
      'preferred-user'
    );

    mockRuntimeUserStore.findById.mockResolvedValueOnce(null);
    const second = await createAccountTotpOptionsHandler(
      createMockContext({
        body: {},
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': true,
          },
        },
      })
    );
    expect(second.status).toBe(201);
    expect(((await second.json()) as { otpauth_uri: string }).otpauth_uri).toContain('user-001');
  });

  it('rejects deletion proof when backup-code hashing is unavailable', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['email_otp'] },
    });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      { id: 'totp-001', user_id: 'user-001' },
      { id: 'totp-002', user_id: 'user-001' },
    ]);
    const context = createMockContext({
      body: { backup_code: 'ABCD-EFGH-IJKL' },
      env: { OTP_HMAC_SECRET: undefined },
    });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(400);
    expect(mockTotpRepo.consumeBackupCode).not.toHaveBeenCalled();
  });

  it('returns a configuration error when regenerating backup codes without HMAC secret', async () => {
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);

    const response = await regenerateAccountTotpBackupCodesHandler(
      createMockContext({ env: { OTP_HMAC_SECRET: undefined } })
    );

    expect(response.status).toBe(500);
    expect(mockTotpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('returns the requested label when rename succeeds but repository reread is unavailable', async () => {
    const credential = {
      id: 'totp-001',
      user_id: 'user-001',
      label: 'Old',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'active',
      created_at: 1,
      activated_at: 2,
      last_used_at: null,
    };
    mockTotpRepo.findById.mockResolvedValue(credential);
    mockTotpRepo.rename.mockResolvedValue(null);
    const context = createMockContext({ body: { label: 'New' } });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await updateAccountTotpCredentialHandler(context);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.credential.label).toBe('New');
  });

  it('allows verified email OTP as the remaining login method', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['totp'] },
    });
    mockTotpRepo.findById.mockResolvedValue({
      id: 'totp-001',
      user_id: 'user-001',
      status: 'active',
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);
    mockRuntimeUserStore.findById.mockResolvedValue({
      id: 'user-001',
      email: 'person@example.com',
      email_verified: 1,
    });
    mockTotpRepo.delete.mockResolvedValue(true);
    const context = createMockContext({
      bodyError: new Error('empty body'),
      settings: {
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.passkey.login_enabled': false,
          'authentication-methods.email_otp.login_enabled': true,
        },
      },
    });
    context.req.param = vi.fn(() => 'totp-001');

    const response = await deleteAccountTotpCredentialHandler(context);

    expect(response.status).toBe(200);
    expect(mockRuntimeUserStore.findById).toHaveBeenCalledWith('user-001');
  });

  it('rejects activation when account enrollment is disabled', async () => {
    const response = await activateAccountTotpCredentialHandler(
      createMockContext({
        body: { credential_id: 'totp-001', code: '123456' },
        settings: {
          'settings:tenant:default:authentication-methods': {
            'authentication-methods.totp.login_enabled': false,
            'authentication-methods.totp.account_link_enabled': false,
          },
        },
      })
    );

    expect(response.status).toBe(403);
    expect(mockTotpRepo.findById).not.toHaveBeenCalled();
  });

  it('requires proof before regenerating backup codes after email-only authentication', async () => {
    mockSessionStore.getSessionRpc.mockResolvedValue({
      ...baseSession,
      expiresAt: Date.now() + 60_000,
      data: { authTime: Math.floor(Date.now() / 1000) - 60, amr: ['email_otp'] },
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([{ id: 'totp-001', user_id: 'user-001' }]);

    const response = await regenerateAccountTotpBackupCodesHandler(createMockContext({ body: {} }));

    expect(response.status).toBe(400);
    expect(mockTotpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });
});
