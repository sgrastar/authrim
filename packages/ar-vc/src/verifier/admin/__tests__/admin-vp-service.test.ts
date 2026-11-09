import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAdminPresentationInput } from '@authrim/ar-lib-core';
import type { Env } from '../../../types';

const mocks = vi.hoisted(() => ({
  locate: vi.fn(),
  allocate: vi.fn(),
  configured: vi.fn(),
  verify: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('../../../utils/vp-request-sharding', () => ({
  getVPRequestStoreById: mocks.locate,
  getVPRequestStoreForNewRequest: mocks.allocate,
}));
vi.mock('../../../utils/configured-shard', () => ({ isConfiguredShard: mocks.configured }));
vi.mock('../admin-vp-protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-vp-protocol')>()),
  verifyAdminPresentation: mocks.verify,
  decryptDcApiAnswer: mocks.decrypt,
}));

import {
  acceptAdminResponse,
  consumeAdminPresentation,
  createAdminPresentationRequest,
  getAdminPresentationStatus,
  getAdminRequestObject,
  submitAdminPresentationResponse,
} from '../admin-vp-service';

const NOW = 1_800_000_000_000;
const REQUEST_ID = 'g1:apac:0:vp_admin';
const HOLDER_JKT = 'a'.repeat(43);
const ref = {
  tenantId: 'tenant-a',
  adminUserId: 'admin-a',
  sessionId: 'session-a',
  requestId: REQUEST_ID,
};
const createInput: CreateAdminPresentationInput = {
  tenantId: 'tenant-a',
  adminUserId: 'admin-a',
  sessionId: 'session-a',
  purpose: 'step_up',
  holderJkts: [HOLDER_JKT],
  credentialIssuer: 'https://issuer.example.test',
  tenantLabel: ' Tenant A ',
  context: { action: 'key_enrollment' },
};

function fixture() {
  const stub = {
    createAdminRequestRpc: vi.fn(async (_input: unknown) => undefined),
    getAdminRequestObjectRpc: vi.fn(async () => 'signed-request'),
    reserveAdminResponseRpc: vi.fn(),
    completeAdminResponseRpc: vi.fn(async () => true),
    failAdminResponseRpc: vi.fn(async () => true),
    releaseAdminResponseRpc: vi.fn(async () => true),
    getAdminStatusRpc: vi.fn(async () => ({ status: 'pending', expiresAt: NOW + 300_000 })),
    consumeAdminResultRpc: vi.fn(async () => ({
      purpose: 'step_up',
      context: {},
      holderJkt: HOLDER_JKT,
      credentialId: 'credential-a',
      verifiedAt: NOW,
    })),
  };
  const signing = {
    signAdminVPRequestRpc: vi.fn(async () => ({ token: 'signed-request' })),
    getVcIssuerJwksRpc: vi.fn(async () => ({ keys: [] })),
  };
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn(() => signing);
  const env = { KEY_MANAGER: { idFromName, get } } as unknown as Env;
  mocks.locate.mockReturnValue({
    stub,
    resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
  });
  mocks.allocate.mockResolvedValue({ stub, requestId: REQUEST_ID });
  mocks.configured.mockResolvedValue(true);
  return { env, stub, signing, idFromName, get };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ ok: true, holderJkt: HOLDER_JKT, credentialId: 'credential-a' });
  mocks.decrypt.mockResolvedValue('decrypted-vp-token');
});

describe('administrator presentation request admission', () => {
  it.each([
    [{ ...createInput, tenantId: '../tenant' }, 'invalid_tenant_id'],
    [{ ...createInput, adminUserId: 'bad/user' }, 'invalid_admin_user_id'],
    [{ ...createInput, sessionId: '' }, 'invalid_session_id'],
    [{ ...createInput, purpose: 'unknown' }, 'invalid_purpose'],
    [{ ...createInput, holderJkts: [] }, 'no_registered_holder_key'],
    [{ ...createInput, holderJkts: ['short'] }, 'invalid_holder_jkts'],
    [{ ...createInput, holderJkts: Array(33).fill(HOLDER_JKT) }, 'invalid_holder_jkts'],
    [{ ...createInput, walletMode: 'recovery' }, 'invalid_wallet_mode'],
    [
      { ...createInput, credentialIssuer: 'http://issuer.example.test' },
      'invalid_credential_issuer',
    ],
    [
      { ...createInput, credentialIssuer: 'https://issuer.example.test/path' },
      'invalid_credential_issuer',
    ],
  ] as const)('rejects invalid input before allocating state: %s', async (input, error) => {
    const { env, signing } = fixture();
    await expect(
      createAdminPresentationRequest(env, input as CreateAdminPresentationInput, NOW)
    ).rejects.toThrow(error);
    expect(mocks.allocate).not.toHaveBeenCalled();
    expect(signing.signAdminVPRequestRpc).not.toHaveBeenCalled();
  });

  it('stores a signed direct-post request with deduplicated holder bindings', async () => {
    const { env, stub, signing, idFromName } = fixture();
    const result = await createAdminPresentationRequest(
      env,
      { ...createInput, holderJkts: [HOLDER_JKT, HOLDER_JKT] },
      NOW
    );
    expect(result).toMatchObject({ requestId: REQUEST_ID, expiresAt: NOW + 300_000 });
    expect(result.matchCode).toMatch(/^\d{2}$/);
    const qrRequestUri = new URL(result.qr ?? '').searchParams.get('request_uri');
    expect(qrRequestUri).not.toBeNull();
    expect(new URL(qrRequestUri ?? '').origin).toBe('https://issuer.example.test');
    expect(decodeURIComponent(new URL(qrRequestUri ?? '').pathname)).toContain(REQUEST_ID);
    expect(idFromName).toHaveBeenCalledExactlyOnceWith('tenant-a-v3');
    expect(signing.signAdminVPRequestRpc).toHaveBeenCalledOnce();
    expect(stub.createAdminRequestRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REQUEST_ID,
        tenantId: 'tenant-a',
        adminUserId: 'admin-a',
        sessionId: 'session-a',
        holderJkts: [HOLDER_JKT],
        mode: 'direct_post',
        context: { action: 'key_enrollment' },
        requestObject: 'signed-request',
        createdAt: NOW,
        expiresAt: NOW + 300_000,
      })
    );
  });

  it('requires an exact HTTPS console origin for a DC API request', async () => {
    const { env, stub, signing } = fixture();
    for (const origin of [
      'http://console.example.test',
      'https://console.example.test/path',
      'https://console.example.test/',
    ]) {
      await expect(
        createAdminPresentationRequest(env, { ...createInput, mode: 'dc_api', origin }, NOW)
      ).rejects.toThrow('invalid_origin');
    }
    expect(stub.createAdminRequestRpc).not.toHaveBeenCalled();
    expect(signing.signAdminVPRequestRpc).not.toHaveBeenCalled();
  });

  it('stores an origin-bound ephemeral encryption key for DC API mode', async () => {
    const { env, stub } = fixture();
    const result = await createAdminPresentationRequest(
      env,
      { ...createInput, mode: 'dc_api', origin: 'https://console.example.test' },
      NOW
    );
    expect(result.dcRequest).toMatchObject({ data: { request: 'signed-request' } });
    expect(result).not.toHaveProperty('qr');
    expect(result).not.toHaveProperty('matchCode');
    expect(stub.createAdminRequestRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'dc_api',
        matchCode: '',
        expectedOrigin: 'https://console.example.test',
      })
    );
    const stored = stub.createAdminRequestRpc.mock.calls[0][0] as { encryptionJwk: string };
    expect(JSON.parse(stored.encryptionJwk)).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });
});

describe('administrator presentation request lookup', () => {
  it('passes exact tenant and admin session identity to status and consumption', async () => {
    const { env, stub } = fixture();
    await expect(getAdminPresentationStatus(env, ref, NOW)).resolves.toEqual({
      status: 'pending',
      expiresAt: NOW + 300_000,
    });
    await expect(consumeAdminPresentation(env, ref, NOW)).resolves.toMatchObject({
      credentialId: 'credential-a',
    });
    expect(stub.getAdminStatusRpc).toHaveBeenCalledExactlyOnceWith({
      id: REQUEST_ID,
      tenantId: 'tenant-a',
      adminUserId: 'admin-a',
      sessionId: 'session-a',
      now: NOW,
    });
    expect(stub.consumeAdminResultRpc).toHaveBeenCalledExactlyOnceWith({
      id: REQUEST_ID,
      tenantId: 'tenant-a',
      adminUserId: 'admin-a',
      sessionId: 'session-a',
      now: NOW,
    });
  });

  it('rejects malformed admin identity before locating a request', async () => {
    const { env } = fixture();
    await expect(
      getAdminPresentationStatus(env, { ...ref, sessionId: '../other' }, NOW)
    ).rejects.toThrow('invalid_session_id');
    await expect(consumeAdminPresentation(env, { ...ref, tenantId: '' }, NOW)).rejects.toThrow(
      'invalid_tenant_id'
    );
    expect(mocks.locate).not.toHaveBeenCalled();
  });

  it('returns no request when its shard is forged or no longer configured', async () => {
    const { env, stub } = fixture();
    mocks.locate.mockImplementationOnce(() => {
      throw new Error('malformed_request_id');
    });
    await expect(getAdminRequestObject(env, 'tenant-a', 'forged', NOW)).resolves.toBeNull();
    mocks.configured.mockResolvedValueOnce(false);
    await expect(getAdminPresentationStatus(env, ref, NOW)).resolves.toBeNull();
    expect(stub.getAdminRequestObjectRpc).not.toHaveBeenCalled();
    expect(stub.getAdminStatusRpc).not.toHaveBeenCalled();
  });
});

describe('administrator presentation response state', () => {
  it.each([
    ['not_found', 'unknown'],
    ['expired', 'unknown'],
    ['replayed', 'replayed'],
    ['unavailable', 'unavailable'],
  ] as const)('maps a %s reservation without verifying the token', async (reason, kind) => {
    const { env, stub } = fixture();
    stub.reserveAdminResponseRpc.mockResolvedValue({ reserved: false, reason });
    await expect(
      acceptAdminResponse(env, 'tenant-a', REQUEST_ID, 'vp-token', NOW)
    ).resolves.toEqual({ kind });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(stub.completeAdminResponseRpc).not.toHaveBeenCalled();
  });

  it('fails a reserved request permanently when credential validation refuses it', async () => {
    const { env, stub } = fixture();
    stub.reserveAdminResponseRpc.mockResolvedValue({
      reserved: true,
      reservationId: 'reservation-a',
      request: { id: REQUEST_ID },
    });
    mocks.verify.mockResolvedValue({ ok: false, error: 'invalid_vp_token' });
    await expect(
      acceptAdminResponse(env, 'tenant-a', REQUEST_ID, 'vp-token', NOW)
    ).resolves.toEqual({ kind: 'refused', error: 'invalid_vp_token' });
    expect(stub.failAdminResponseRpc).toHaveBeenCalledExactlyOnceWith({
      id: REQUEST_ID,
      tenantId: 'tenant-a',
      reservationId: 'reservation-a',
      errorCode: 'invalid_vp_token',
    });
    expect(stub.releaseAdminResponseRpc).not.toHaveBeenCalled();
  });

  it('completes a reserved request only after successful verification', async () => {
    const { env, stub } = fixture();
    stub.reserveAdminResponseRpc.mockResolvedValue({
      reserved: true,
      reservationId: 'reservation-a',
      request: { id: REQUEST_ID },
    });
    await expect(
      acceptAdminResponse(env, 'tenant-a', REQUEST_ID, 'vp-token', NOW)
    ).resolves.toEqual({ kind: 'verified' });
    expect(stub.completeAdminResponseRpc).toHaveBeenCalledExactlyOnceWith({
      id: REQUEST_ID,
      tenantId: 'tenant-a',
      reservationId: 'reservation-a',
      holderJkt: HOLDER_JKT,
      credentialId: 'credential-a',
      now: NOW,
    });
    expect(stub.failAdminResponseRpc).not.toHaveBeenCalled();
  });

  it('releases the lease and preserves an infrastructure failure for retry', async () => {
    const { env, stub } = fixture();
    const failure = new Error('issuer_keys_unavailable');
    stub.reserveAdminResponseRpc.mockResolvedValue({
      reserved: true,
      reservationId: 'reservation-a',
      request: { id: REQUEST_ID },
    });
    mocks.verify.mockRejectedValue(failure);
    await expect(acceptAdminResponse(env, 'tenant-a', REQUEST_ID, 'vp-token', NOW)).rejects.toBe(
      failure
    );
    expect(stub.releaseAdminResponseRpc).toHaveBeenCalledExactlyOnceWith({
      id: REQUEST_ID,
      tenantId: 'tenant-a',
      reservationId: 'reservation-a',
      now: NOW,
    });
    expect(stub.completeAdminResponseRpc).not.toHaveBeenCalled();
    expect(stub.failAdminResponseRpc).not.toHaveBeenCalled();
  });

  it('rejects an oversized DC API answer before reserving the request', async () => {
    const { env, stub } = fixture();
    await expect(
      submitAdminPresentationResponse(env, ref, { answer: 'x'.repeat(96 * 1024) }, NOW)
    ).resolves.toEqual({ kind: 'refused', error: 'invalid_vp_token' });
    expect(stub.reserveAdminResponseRpc).not.toHaveBeenCalled();
  });

  it('decrypts the DC API answer before verification under the caller session', async () => {
    const { env, stub } = fixture();
    stub.reserveAdminResponseRpc.mockResolvedValue({
      reserved: true,
      reservationId: 'reservation-a',
      request: { id: REQUEST_ID, encryptionJwk: '{"kty":"EC"}' },
    });
    const answer = { response: 'encrypted-token' };
    await expect(submitAdminPresentationResponse(env, ref, answer, NOW)).resolves.toEqual({
      kind: 'verified',
    });
    expect(mocks.decrypt).toHaveBeenCalledExactlyOnceWith(answer, '{"kty":"EC"}');
    expect(mocks.verify).toHaveBeenCalledWith(
      'decrypted-vp-token',
      expect.any(Object),
      expect.any(String),
      expect.any(Object),
      Math.floor(NOW / 1000)
    );
    expect(stub.reserveAdminResponseRpc).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dc_api', tenantId: 'tenant-a' })
    );
  });
});
