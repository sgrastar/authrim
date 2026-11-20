/**
 * Device code grant (RFC 8628 section 3.4/3.5): client authentication, the poll the store
 * records, and every refusal before the device code is reserved.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mocks,
  resetHarness,
  callToken,
  answerQueryOne,
  pollingStore,
  fetchedPaths,
  fetchedRequests,
  DEVICE_GRANT,
  FAL3_SETTINGS,
} from './helpers/mut-grants-harness';
import { createMockDurableObjectNamespace, type MockEnv } from './helpers/mocks';
import { createPublicClient } from './helpers/fixtures';
import { tokenHandler } from '../token';

const CLIENT_ID = 'device-client-001';
const DEVICE_CODE = 'device-code-poll';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    device_code: DEVICE_CODE,
    user_code: 'ABCD-EFGH',
    client_id: CLIENT_ID,
    scope: 'openid profile',
    status: 'approved',
    sub: 'user-123',
    created_at: Date.now() - 10_000,
    expires_at: Date.now() + 60_000,
    ...overrides,
  };
}

describe('device code grant: polling and refusals', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = resetHarness();
    mocks.getClientCached.mockResolvedValue(
      createPublicClient({ client_id: CLIENT_ID, grant_types: [DEVICE_GRANT] })
    );
  });

  function useStore(meta: Record<string, unknown>, options?: Parameters<typeof pollingStore>[2]) {
    const fetch = pollingStore('device_code', meta, options);
    env.DEVICE_CODE_STORE.get = vi.fn().mockReturnValue({ fetch });
    return fetch;
  }

  function poll(extra: Record<string, string> = {}, headers?: Record<string, string>) {
    return callToken(
      tokenHandler,
      env,
      { grant_type: DEVICE_GRANT, device_code: DEVICE_CODE, client_id: CLIENT_ID, ...extra },
      headers
    );
  }

  async function expectRefusedBeforeReservation(
    fetch: ReturnType<typeof pollingStore>,
    result: Awaited<ReturnType<typeof poll>>,
    status: number,
    body: Record<string, unknown>
  ) {
    expect(result.status).toBe(status);
    expect(result.body).toEqual(body);
    expect(fetchedPaths(fetch)).not.toContain('/mark-token-issued');
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  }

  describe('client authentication', () => {
    it('refuses a malformed Basic header before reading the client', async () => {
      const fetch = useStore(metadata());
      const result = await poll({}, { Authorization: 'Basic %%%' });
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({
        error: 'invalid_client',
        error_description: 'Invalid Authorization header format',
      });
      expect(mocks.getClientCached).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses an unknown client with a generic description', async () => {
      const fetch = useStore(metadata());
      mocks.getClientCached.mockResolvedValue(null);
      const result = await poll();
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses a public client presenting a secret it is not registered for', async () => {
      const fetch = useStore(metadata());
      const result = await poll({ client_secret: 'unexpected' });
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: 'invalid_client' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['an invalid certificate', { valid: false, error: 'certificate_required' }],
      ['a certificate without a thumbprint', { valid: true }],
    ])('refuses a certificate-bound client with %s', async (_label, binding) => {
      const fetch = useStore(metadata());
      mocks.getClientCached.mockResolvedValue(
        createPublicClient({
          client_id: CLIENT_ID,
          tls_client_certificate_bound_access_tokens: true,
        })
      );
      mocks.validateClientCertificateBinding.mockResolvedValue(binding);
      const result = await poll();
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client certificate authentication failed',
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('the store the poll goes to', () => {
    it('polls the tenant-scoped legacy store with the tenant header and JSON body', async () => {
      const fetch = useStore(metadata({ status: 'pending' }));
      await poll();
      expect(env.DEVICE_CODE_STORE.idFromName).toHaveBeenCalledWith('tenant:default:device');
      expect(await fetchedRequests(fetch, '/poll')).toEqual([
        {
          method: 'POST',
          contentType: 'application/json',
          tenant: 'default',
          body: { device_code: DEVICE_CODE, client_id: CLIENT_ID },
        },
      ]);
    });

    it('routes a region-sharded device code to its own shard', async () => {
      const fetch = pollingStore('device_code', metadata({ status: 'pending' }));
      mocks.parseDeviceCodeId.mockReturnValue({ shardIndex: 2 });
      mocks.getDeviceCodeStoreById.mockReturnValue({ stub: { fetch } });
      const result = await poll();
      expect(result.body).toMatchObject({ error: 'authorization_pending' });
      expect(mocks.getDeviceCodeStoreById).toHaveBeenCalledWith(env, DEVICE_CODE, 'default');
      expect(env.DEVICE_CODE_STORE.get).not.toHaveBeenCalled();
    });

    it.each([
      ['an error status', () => Response.json({ result: 'ok' }, { status: 500 })],
      ['a null body', () => Response.json(null)],
      ['a body without a result', () => Response.json({ result: 1 })],
      ['a failure', () => Promise.reject(new Error('store down'))],
    ])('answers 503 when the store answers the poll with %s', async (_label, answer) => {
      const fetch = useStore(metadata(), { poll: answer });
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 503, {
        error: 'temporarily_unavailable',
        error_description: 'Device code state is unavailable',
      });
    });

    it('treats an ok poll without metadata as an expired code', async () => {
      const fetch = useStore(metadata(), { poll: () => Response.json({ result: 'ok' }) });
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'expired_token',
        error_description: 'Device code has expired or is invalid',
      });
    });
  });

  describe('the state of the device code', () => {
    it('answers slow_down to a poll the store reports as too fast', async () => {
      useStore(metadata({ status: 'pending' }), { tooFast: true });
      expect((await poll()).body).toEqual({
        error: 'slow_down',
        error_description: 'You are polling too frequently. Please slow down.',
      });
    });

    it('answers authorization_pending while the user has not decided', async () => {
      useStore(metadata({ status: 'pending' }));
      expect((await poll()).body).toEqual({
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the device',
      });
    });

    it('deletes a denied device code with a POST naming it', async () => {
      const fetch = useStore(metadata({ status: 'denied' }));
      const result = await poll();
      expect(result.status).toBe(403);
      expect(result.body).toEqual({
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      });
      expect(await fetchedRequests(fetch, '/delete')).toEqual([
        {
          method: 'POST',
          contentType: 'application/json',
          tenant: 'default',
          body: { device_code: DEVICE_CODE },
        },
      ]);
    });

    it('answers expired_token for an expired code', async () => {
      useStore(metadata({ status: 'expired' }));
      expect((await poll()).body).toEqual({
        error: 'expired_token',
        error_description: 'Device code has expired',
      });
    });

    it('refuses a status it does not know even with a subject', async () => {
      const fetch = useStore(metadata({ status: 'consumed' }));
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_grant',
        error_description: 'Device code is not approved',
      });
    });
  });

  describe('before the approved code is reserved', () => {
    it('refuses the grant at FAL3 (it has no pushed, signed request)', async () => {
      mocks.settings.assurance = FAL3_SETTINGS;
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'unauthorized_client',
        error_description:
          'This grant does not meet the required federation assurance level (FAL3)',
      });
    });

    it('requires a DPoP proof when the profile requires one', async () => {
      mocks.getProtocolSettingsCached.mockResolvedValue({ fapi: { requireDpop: true } });
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_request',
        error_description: 'DPoP proof is required for this request',
      });
    });

    it('validates the DPoP proof against this request and refuses an invalid one', async () => {
      mocks.extractDPoPProof.mockReturnValue('dpop-proof');
      mocks.validateDPoPProof.mockResolvedValue({
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'Proof jti replayed',
      });
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_dpop_proof',
        error_description: 'Proof jti replayed',
      });
      expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
        'dpop-proof',
        'POST',
        'https://auth.example.com/oauth/token',
        undefined,
        env,
        CLIENT_ID,
        'default'
      );
    });

    it('refuses a subject whose account is gone', async () => {
      mocks.resolveAccountDataContextFromHono.mockRejectedValue(
        new Error('account_data_route_not_found')
      );
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_grant',
        error_description: 'The provided authorization grant is invalid, expired, or revoked',
      });
    });

    it('answers 503 and keeps the code when the consent withdrawal cannot be read', async () => {
      answerQueryOne({ oauth_client_consent_revocations: new Error('db down') });
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 503, {
        error: 'temporarily_unavailable',
        error_description: 'Consent state is unavailable',
      });
    });

    it('refuses a code requested before the consent was withdrawn', async () => {
      const created = Date.now() - 10_000;
      answerQueryOne({
        oauth_client_consent_revocations: { generation: 3, revoked_at: created + 1 },
      });
      // Approved under the current generation, but requested before the withdrawal.
      const fetch = useStore(metadata({ created_at: created, consent_generation: 3 }));
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_grant',
        error_description: 'The provided authorization grant is invalid, expired, or revoked',
      });
    });

    it('issues for a code requested and approved after an earlier withdrawal', async () => {
      const created = Date.now() - 10_000;
      answerQueryOne({
        oauth_client_consent_revocations: { generation: 3, revoked_at: created - 1 },
      });
      useStore(metadata({ created_at: created, consent_generation: 3 }));
      const result = await poll();
      expect(result.status).toBe(200);
      expect(mocks.createAccessToken.mock.calls[0][0]).toMatchObject({
        authrim_consent_generation: 3,
      });
    });
  });

  describe('after the approved code is reserved', () => {
    it('reserves the code with a POST naming it', async () => {
      const fetch = useStore(metadata());
      expect((await poll()).status).toBe(200);
      expect(await fetchedRequests(fetch, '/mark-token-issued')).toEqual([
        {
          method: 'POST',
          contentType: 'application/json',
          tenant: 'default',
          body: { device_code: DEVICE_CODE },
        },
      ]);
    });

    it('answers 500 when no signing key can be loaded', async () => {
      useStore(metadata());
      env.AUTHRIM_CONFIG.get = vi.fn().mockResolvedValue('rotated-key-version');
      env.KEY_MANAGER = createMockDurableObjectNamespace({
        rpcMethods: {
          getActiveKeyWithPrivateRpc: vi.fn().mockRejectedValue(new Error('key manager down')),
        },
      });
      const result = await poll();
      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        error: 'server_error',
        error_description: 'Failed to load signing keys',
      });
      expect(mocks.createAccessToken).not.toHaveBeenCalled();
    });

    it('answers 503 when the information release consent cannot be read', async () => {
      answerQueryOne({ oauth_client_consents: new Error('db down') });
      useStore(metadata());
      const result = await poll();
      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Consent state is unavailable',
      });
      expect(mocks.createAccessToken).not.toHaveBeenCalled();
    });
  });
});
