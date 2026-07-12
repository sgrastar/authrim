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
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    isAnonymousAuthEnabled: mocks.isAnonymousAuthEnabled,
    validateDeviceId: mocks.validateDeviceId,
    validateDeviceStability: mocks.validateDeviceStability,
    loadClientContractCached: mocks.loadClientContractCached,
    generateDeviceChallenge: mocks.generateDeviceChallenge,
    hashDeviceIdentifiers: mocks.hashDeviceIdentifiers,
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: mocks.storeChallengeRpc,
    })),
    getLogger: vi.fn(() => ({
      module: () => ({ error: mocks.error }),
    })),
  };
});

import { anonLoginChallengeHandler } from '../anon-login';

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
  return app;
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
