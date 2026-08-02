import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAnonymousAuthEnabled: vi.fn(),
  validateDeviceId: vi.fn(),
  validateDeviceStability: vi.fn(),
  loadClientContractCached: vi.fn(),
  generateDeviceChallenge: vi.fn(),
  hashDeviceIdentifiers: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  verifyChallengeResponse: vi.fn(),
  verifyDeviceSignature: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  syncUser: vi.fn(),
  deleteUser: vi.fn(),
  touchLastLogin: vi.fn(),
  createSessionRpc: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  error: vi.fn(),
  usesTenantD1AccountStorage: vi.fn(),
  resolveAnonymousRoute: vi.fn(),
  provisionAnonymous: vi.fn(),
  removeAnonymousRoute: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    isAnonymousAuthEnabled: mocks.isAnonymousAuthEnabled,
    validateDeviceId: mocks.validateDeviceId,
    validateDeviceStability: mocks.validateDeviceStability,
    loadClientContractCached: mocks.loadClientContractCached,
    generateDeviceChallenge: mocks.generateDeviceChallenge,
    hashDeviceIdentifiers: mocks.hashDeviceIdentifiers,
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: mocks.storeChallengeRpc,
      consumeChallengeRpc: mocks.consumeChallengeRpc,
    })),
    verifyChallengeResponse: mocks.verifyChallengeResponse,
    verifyDeviceSignature: mocks.verifyDeviceSignature,
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: { queryOne: mocks.queryOne, execute: mocks.execute },
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      syncUser = mocks.syncUser;
      deleteUser = mocks.deleteUser;
      touchLastLogin = mocks.touchLastLogin;
    },
    generateUserIdFromSettings: vi.fn(async () => 'new-user-1'),
    generateId: vi.fn(() => 'anonymous-device-1'),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: { createSessionRpc: mocks.createSessionRpc },
      sessionId: 'session-1',
    })),
    generateBrowserState: vi.fn(async () => 'browser-state-1'),
    publishEvent: mocks.publishEvent,
    createAuditLog: mocks.createAuditLog,
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({
      module: () => ({ error: mocks.error }),
    })),
  };
});

vi.mock('../account-provisioning', () => ({
  usesTenantD1AccountStorage: mocks.usesTenantD1AccountStorage,
  resolveTenantD1AnonymousAccountRoute: mocks.resolveAnonymousRoute,
  provisionTenantD1AnonymousAccount: mocks.provisionAnonymous,
  removeTenantD1AnonymousDeviceRoute: mocks.removeAnonymousRoute,
}));

import { anonLoginChallengeHandler, anonLoginVerifyHandler } from '../anon-login';

const validBody = {
  client_id: 'client-1',
  device_id: 'device-12345678',
  installation_id: 'installation-1',
  fingerprint: 'fingerprint-1',
  platform: 'ios',
};

function createApp() {
  const app = new Hono();
  app.post('/challenge', anonLoginChallengeHandler);
  app.post('/verify', anonLoginVerifyHandler);
  return app;
}

const validVerifyBody = {
  challenge_id: 'challenge-1',
  device_id: 'device-12345678',
  installation_id: 'installation-1',
  fingerprint: 'fingerprint-1',
  platform: 'ios',
  response: 'signed-response',
  timestamp: 1_900_000_000,
};

async function requestVerify(body: unknown, env: Record<string, unknown> = {}) {
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
  const responsePromise = createApp().request(
    '/verify',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.10',
        'User-Agent': 'Authrim Test',
      },
      body: JSON.stringify(body),
    },
    env,
    executionCtx
  );
  await vi.runAllTimersAsync();
  return responsePromise;
}

async function requestChallenge(body: unknown, env: Record<string, unknown> = {}) {
  const responsePromise = createApp().request(
    '/challenge',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
  await vi.runAllTimersAsync();
  return responsePromise;
}

describe('anonymous login challenge handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.isAnonymousAuthEnabled.mockResolvedValue(true);
    mocks.validateDeviceId.mockReturnValue(true);
    mocks.validateDeviceStability.mockReturnValue(true);
    mocks.loadClientContractCached.mockResolvedValue({
      anonymousAuth: {
        enabled: true,
        deviceStability: 'installation',
      },
    });
    mocks.generateDeviceChallenge.mockReturnValue({
      challenge_id: 'challenge-1',
      challenge: 'challenge-value',
      expires_at: 2_000_000_000,
    });
    mocks.hashDeviceIdentifiers.mockResolvedValue({
      device_id_hash: 'device-hash',
      installation_id_hash: 'installation-hash',
      fingerprint_hash: 'fingerprint-hash',
      device_platform: 'ios',
    });
    mocks.storeChallengeRpc.mockResolvedValue(undefined);
    mocks.consumeChallengeRpc.mockResolvedValue({
      challenge: 'challenge-value',
      userId: '',
      metadata: {
        client_id: 'client-1',
        device_signature: { device_id_hash: 'device-hash' },
        device_stability: 'installation',
        platform: 'ios',
      },
    });
    mocks.verifyChallengeResponse.mockResolvedValue(true);
    mocks.verifyDeviceSignature.mockResolvedValue(true);
    mocks.queryOne.mockResolvedValue({
      id: 'anonymous-device-existing',
      user_id: 'existing-user-1',
      expires_at: null,
      is_active: 1,
    });
    mocks.execute.mockResolvedValue({ success: true });
    mocks.syncUser.mockResolvedValue(undefined);
    mocks.deleteUser.mockResolvedValue(undefined);
    mocks.touchLastLogin.mockResolvedValue(undefined);
    mocks.createSessionRpc.mockResolvedValue(undefined);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.usesTenantD1AccountStorage.mockReturnValue(false);
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({
      accountId: 'account:new-user-1',
      legacyUserId: 'new-user-1',
    });
    mocks.provisionAnonymous.mockResolvedValue({
      status: 'ready',
      accountId: 'account:new-user-1',
      userId: 'new-user-1',
    });
    mocks.removeAnonymousRoute.mockResolvedValue(201);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects requests when anonymous authentication is disabled', async () => {
    mocks.isAnonymousAuthEnabled.mockResolvedValueOnce(false);

    const response = await requestChallenge(validBody);

    expect(response.status).toBe(400);
    expect(mocks.loadClientContractCached).not.toHaveBeenCalled();
  });

  it.each([
    [{ device_id: validBody.device_id }, 'client_id'],
    [{ client_id: validBody.client_id }, 'device_id'],
  ])('rejects a missing required field before loading the client', async (body, _field) => {
    const response = await requestChallenge(body);

    expect(response.status).toBe(400);
    expect(mocks.loadClientContractCached).not.toHaveBeenCalled();
  });

  it('rejects an invalid device identifier', async () => {
    mocks.validateDeviceId.mockReturnValueOnce(false);

    const response = await requestChallenge(validBody);

    expect(response.status).toBe(400);
    expect(mocks.loadClientContractCached).not.toHaveBeenCalled();
  });

  it('does not disclose an unknown client', async () => {
    mocks.loadClientContractCached.mockResolvedValueOnce(null);

    const response = await requestChallenge(validBody);

    expect(response.status).toBe(401);
    expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('rejects a client that has not enabled anonymous authentication', async () => {
    mocks.loadClientContractCached.mockResolvedValueOnce({ anonymousAuth: { enabled: false } });

    const response = await requestChallenge(validBody);

    expect(response.status).toBe(400);
    expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('rejects an invalid per-request device stability override', async () => {
    mocks.validateDeviceStability.mockReturnValueOnce(false);

    const response = await requestChallenge({ ...validBody, device_stability: 'device' });

    expect(response.status).toBe(400);
    expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('fails closed when no private device HMAC secret is configured', async () => {
    const response = await requestChallenge(validBody);

    expect(response.status).toBe(500);
    expect(mocks.hashDeviceIdentifiers).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      'DEVICE_HMAC_SECRET or OTP_HMAC_SECRET must be configured for anonymous auth',
      { action: 'security_config' }
    );
  });

  it('uses OTP_HMAC_SECRET as the supported fallback', async () => {
    const response = await requestChallenge(validBody, { OTP_HMAC_SECRET: 'otp-secret' });

    expect(response.status).toBe(200);
    expect(mocks.hashDeviceIdentifiers).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: validBody.device_id }),
      'otp-secret'
    );
  });

  it('stores a tenant-scoped five-minute challenge without plaintext device IDs', async () => {
    const response = await requestChallenge(
      { ...validBody, device_stability: 'device' },
      { DEVICE_HMAC_SECRET: 'device-secret' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challenge_id: 'challenge-1',
      challenge: 'challenge-value',
      expires_at: 2_000_000_000,
    });
    expect(mocks.storeChallengeRpc).toHaveBeenCalledWith({
      id: 'anon_login:challenge-1',
      tenantId: 'tenant-1',
      type: 'anon_login',
      userId: '',
      challenge: 'challenge-value',
      ttl: 300,
      metadata: {
        client_id: 'client-1',
        device_signature: {
          device_id_hash: 'device-hash',
          installation_id_hash: 'installation-hash',
          fingerprint_hash: 'fingerprint-hash',
          device_platform: 'ios',
        },
        device_stability: 'device',
        platform: 'ios',
      },
    });
    expect(JSON.stringify(mocks.storeChallengeRpc.mock.calls[0])).not.toContain(
      validBody.device_id
    );
  });

  it('returns a generic internal error when challenge persistence fails', async () => {
    mocks.storeChallengeRpc.mockRejectedValueOnce(new Error('storage unavailable'));

    const response = await requestChallenge(validBody, { DEVICE_HMAC_SECRET: 'device-secret' });

    expect(response.status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith(
      'Anon login challenge error',
      { action: 'challenge' },
      expect.any(Error)
    );
  });
});

describe('anonymous login verify handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.isAnonymousAuthEnabled.mockResolvedValue(true);
    mocks.validateDeviceId.mockReturnValue(true);
    mocks.consumeChallengeRpc.mockResolvedValue({
      challenge: 'challenge-value',
      userId: '',
      metadata: {
        client_id: 'client-1',
        device_signature: { device_id_hash: 'device-hash' },
        device_stability: 'installation',
        platform: 'ios',
      },
    });
    mocks.verifyChallengeResponse.mockResolvedValue(true);
    mocks.verifyDeviceSignature.mockResolvedValue(true);
    mocks.hashDeviceIdentifiers.mockResolvedValue({
      device_id_hash: 'device-hash',
      installation_id_hash: 'installation-hash',
      fingerprint_hash: 'fingerprint-hash',
      device_platform: 'ios',
    });
    mocks.queryOne.mockResolvedValue({
      id: 'anonymous-device-existing',
      user_id: 'existing-user-1',
      expires_at: null,
      is_active: 1,
    });
    mocks.execute.mockResolvedValue({ success: true });
    mocks.syncUser.mockResolvedValue(undefined);
    mocks.deleteUser.mockResolvedValue(undefined);
    mocks.touchLastLogin.mockResolvedValue(undefined);
    mocks.createSessionRpc.mockResolvedValue(undefined);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.loadClientContractCached.mockResolvedValue({
      anonymousAuth: { enabled: true, deviceStability: 'installation', expiresInDays: 30 },
    });
    mocks.usesTenantD1AccountStorage.mockReturnValue(false);
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({
      accountId: 'account:new-user-1',
      legacyUserId: 'new-user-1',
    });
    mocks.provisionAnonymous.mockResolvedValue({
      status: 'ready',
      accountId: 'account:new-user-1',
      userId: 'new-user-1',
    });
    mocks.removeAnonymousRoute.mockResolvedValue(201);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects verification when the feature is disabled without consuming a challenge', async () => {
    mocks.isAnonymousAuthEnabled.mockResolvedValueOnce(false);

    const response = await requestVerify(validVerifyBody);

    expect(response.status).toBe(400);
    expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it.each(['challenge_id', 'device_id', 'response', 'timestamp'])(
    'requires %s before consuming a challenge',
    async (field) => {
      const response = await requestVerify({ ...validVerifyBody, [field]: undefined });

      expect(response.status).toBe(400);
      expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('rejects an invalid device ID before consuming the single-use challenge', async () => {
    mocks.validateDeviceId.mockReturnValueOnce(false);

    const response = await requestVerify(validVerifyBody);

    expect(response.status).toBe(400);
    expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('maps a consumed or missing challenge to a generic invalid-code response', async () => {
    mocks.consumeChallengeRpc.mockRejectedValueOnce(new Error('already consumed'));

    const response = await requestVerify(validVerifyBody);

    expect(response.status).toBe(400);
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        data: expect.objectContaining({ errorCode: 'challenge_error' }),
      })
    );
    expect(mocks.verifyChallengeResponse).not.toHaveBeenCalled();
  });

  it('rejects challenge data without a bound client ID', async () => {
    mocks.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: 'challenge-value',
      userId: '',
      metadata: {},
    });

    const response = await requestVerify(validVerifyBody);

    expect(response.status).toBe(400);
    expect(mocks.verifyChallengeResponse).not.toHaveBeenCalled();
  });

  it('fails closed after consumption when the private HMAC secret is absent', async () => {
    const response = await requestVerify(validVerifyBody);

    expect(response.status).toBe(500);
    expect(mocks.verifyChallengeResponse).not.toHaveBeenCalled();
  });

  it('rejects an invalid response without looking up the anonymous device', async () => {
    mocks.verifyChallengeResponse.mockResolvedValueOnce(false);

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(400);
    expect(mocks.queryOne).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: expect.objectContaining({ errorCode: 'invalid_response' }) })
    );
  });

  it('rejects device identifiers that do not match the challenge signature', async () => {
    mocks.verifyDeviceSignature.mockResolvedValueOnce(false);

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(400);
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  it('resumes an active device and creates a tenant-scoped anonymous session', async () => {
    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      session_id: 'session-1',
      user_id: 'existing-user-1',
      is_new_user: false,
      upgrade_eligible: true,
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE anonymous_devices SET last_used_at'),
      [expect.any(Number), 'anonymous-device-existing', 'tenant-1']
    );
    expect(mocks.createSessionRpc).toHaveBeenCalledWith(
      'session-1',
      'existing-user-1',
      86_400,
      expect.objectContaining({
        amr: ['anon'],
        is_anonymous: true,
        device_id_hash: 'device-hash',
        client_id: 'client-1',
      }),
      'tenant-1'
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=session-1');
    expect(mocks.touchLastLogin).toHaveBeenCalledWith('existing-user-1', expect.any(Number));
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'existing-user-1',
        ipAddress: '192.0.2.10',
      })
    );
  });

  it('resolves an existing tenant-D1 anonymous device before primary authority access', async () => {
    mocks.usesTenantD1AccountStorage.mockReturnValue(true);
    mocks.resolveAnonymousRoute.mockResolvedValue({
      accountId: 'account:existing-user-1',
      legacyUserId: 'existing-user-1',
    });

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(200);
    expect(mocks.resolveAnonymousRoute).toHaveBeenCalledWith(expect.anything(), 'device-hash');
    expect(mocks.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM anonymous_devices'),
      ['tenant-1', 'device-hash'],
      { consistencyClass: 'primary_required' }
    );
    expect(mocks.provisionAnonymous).not.toHaveBeenCalled();
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  it('durably releases an expired tenant-D1 device route before requiring a restart', async () => {
    mocks.usesTenantD1AccountStorage.mockReturnValue(true);
    mocks.resolveAnonymousRoute.mockResolvedValue({
      accountId: 'account:existing-user-1',
      legacyUserId: 'existing-user-1',
    });
    mocks.queryOne.mockResolvedValueOnce({
      id: 'anonymous-device-existing',
      user_id: 'existing-user-1',
      expires_at: 1,
    });

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'anonymous_credential_recycling',
      restart_required: true,
      retry_after_ms: 500,
    });
    expect(mocks.execute).toHaveBeenCalledWith(expect.stringContaining('SET is_active = FALSE'), [
      'anonymous-device-existing',
      'tenant-1',
      'existing-user-1',
    ]);
    expect(mocks.removeAnonymousRoute).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      userId: 'existing-user-1',
      deviceId: 'anonymous-device-existing',
      deviceIdHash: 'device-hash',
    });
    expect(mocks.createSessionRpc).not.toHaveBeenCalled();
  });

  it('uses durable normal-pool provisioning for a new tenant-D1 anonymous device', async () => {
    mocks.usesTenantD1AccountStorage.mockReturnValue(true);
    mocks.resolveAnonymousRoute.mockRejectedValue(new Error('account_data_route_not_found'));
    mocks.queryOne.mockResolvedValueOnce({ user_id: 'new-user-1' });

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user_id: 'new-user-1', is_new_user: true });
    expect(mocks.provisionAnonymous).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        candidateUserId: 'new-user-1',
        device: expect.objectContaining({
          deviceIdHash: 'device-hash',
          stability: 'installation',
        }),
      })
    );
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'new-user-1'
    );
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  it('returns the provisioning continuation before creating a session when routing is pending', async () => {
    mocks.usesTenantD1AccountStorage.mockReturnValue(true);
    mocks.resolveAnonymousRoute.mockRejectedValue(new Error('account_data_route_not_found'));
    mocks.provisionAnonymous.mockResolvedValueOnce({
      status: 'pending',
      response: Response.json(
        {
          status: 'provisioning',
          provisioning_token: 'opaque-token',
          status_endpoint: '/api/v1/auth/account-provisioning/status',
          retry_after_ms: 500,
        },
        { status: 202 }
      ),
    });

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'provisioning',
      retry_after_ms: 500,
    });
    expect(mocks.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.publishEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'auth.login.succeeded' })
    );
  });

  it('returns a session-store error without reporting login success', async () => {
    mocks.createSessionRpc.mockRejectedValueOnce(new Error('session unavailable'));

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(500);
    expect(mocks.publishEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: expect.objectContaining({ sessionId: 'session-1' }) })
    );
  });

  it('creates a canonical anonymous user when no active device exists', async () => {
    mocks.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ user_id: 'new-user-1' });

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user_id: 'new-user-1', is_new_user: true });
    expect(mocks.syncUser).toHaveBeenCalledWith({
      userId: 'new-user-1',
      active: true,
      emailVerified: false,
      userType: 'anonymous',
      sourceRef: 'anonymous_login',
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO anonymous_devices'),
      expect.arrayContaining(['tenant-1', 'new-user-1', 'device-hash'])
    );
  });

  it('adopts the winning user and cleans up its orphan during a concurrent registration', async () => {
    mocks.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user_id: 'concurrent-user-1' });

    const response = await requestVerify(validVerifyBody, { DEVICE_HMAC_SECRET: 'secret' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user_id: 'concurrent-user-1',
      is_new_user: false,
    });
    expect(mocks.deleteUser).toHaveBeenCalledWith('new-user-1');
    expect(mocks.execute).toHaveBeenCalledWith(
      'DELETE FROM anonymous_devices WHERE id = ? AND tenant_id = ?',
      ['anonymous-device-1', 'tenant-1']
    );
  });
});
