/**
 * CIBA grant (CIBA Core section 10/11): client authentication, the poll the store records, and
 * every refusal before the auth_req_id is reserved.
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
  CIBA_GRANT,
  CLIENT_SECRET,
  CLIENT_SECRET_HASH,
  FAL3_SETTINGS,
} from './helpers/mut-grants-harness';
import type { MockEnv } from './helpers/mocks';
import { createCIBAClient } from './helpers/fixtures';
import { tokenHandler } from '../token';

const CLIENT_ID = 'ciba-client-001';
const AUTH_REQ_ID = 'auth-req-poll';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    auth_req_id: AUTH_REQ_ID,
    client_id: CLIENT_ID,
    scope: 'openid profile',
    status: 'approved',
    sub: 'user-123',
    delivery_mode: 'poll',
    interval: 5,
    created_at: Date.now() - 10_000,
    expires_at: Date.now() + 60_000,
    token_issued: false,
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return createCIBAClient({
    client_secret_hash: CLIENT_SECRET_HASH,
    token_endpoint_auth_method: 'client_secret_post',
    ...overrides,
  });
}

describe('CIBA grant: polling and refusals', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = resetHarness();
    mocks.getClientCached.mockResolvedValue(client());
  });

  function useStore(meta: Record<string, unknown>, options?: Parameters<typeof pollingStore>[2]) {
    const fetch = pollingStore('auth_req_id', meta, options);
    env.CIBA_REQUEST_STORE.get = vi.fn().mockReturnValue({ fetch });
    return fetch;
  }

  function poll(extra: Record<string, string> = {}, headers?: Record<string, string>) {
    return callToken(
      tokenHandler,
      env,
      {
        grant_type: CIBA_GRANT,
        auth_req_id: AUTH_REQ_ID,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        ...extra,
      },
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

    it.each([
      ['an invalid certificate', { valid: false, error: 'certificate_required' }],
      ['a certificate without a thumbprint', { valid: true }],
    ])('refuses a certificate-bound client with %s', async (_label, binding) => {
      const fetch = useStore(metadata());
      mocks.getClientCached.mockResolvedValue(
        client({ tls_client_certificate_bound_access_tokens: true })
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
      expect(env.CIBA_REQUEST_STORE.idFromName).toHaveBeenCalledWith('tenant:default:ciba');
      expect(await fetchedRequests(fetch, '/poll')).toEqual([
        {
          method: 'POST',
          contentType: 'application/json',
          tenant: 'default',
          body: { auth_req_id: AUTH_REQ_ID, client_id: CLIENT_ID },
        },
      ]);
    });

    it('routes a region-sharded auth_req_id to its own shard', async () => {
      const fetch = pollingStore('auth_req_id', metadata({ status: 'pending' }));
      mocks.parseCIBARequestId.mockReturnValue({ shardIndex: 1 });
      mocks.getCIBARequestStoreById.mockReturnValue({ stub: { fetch } });
      const result = await poll();
      expect(result.body).toMatchObject({ error: 'authorization_pending' });
      expect(mocks.getCIBARequestStoreById).toHaveBeenCalledWith(env, AUTH_REQ_ID, 'default');
      expect(env.CIBA_REQUEST_STORE.get).not.toHaveBeenCalled();
    });

    it('answers 503 when the store cannot evaluate the poll', async () => {
      const fetch = useStore(metadata(), { poll: () => Promise.reject(new Error('down')) });
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 503, {
        error: 'temporarily_unavailable',
        error_description: 'CIBA request state is unavailable',
      });
    });

    it('treats an ok poll without metadata as an expired request', async () => {
      const fetch = useStore(metadata(), { poll: () => Response.json({ result: 'ok' }) });
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'expired_token',
        error_description: 'CIBA request has expired or is invalid',
      });
    });
  });

  describe('the state of the request', () => {
    it('answers slow_down to a poll the store reports as too fast', async () => {
      useStore(metadata({ status: 'pending' }), { tooFast: true });
      expect((await poll()).body).toEqual({
        error: 'slow_down',
        error_description: 'You are polling too frequently. Please slow down.',
      });
    });

    it('deletes a denied request with a POST naming it', async () => {
      const fetch = useStore(metadata({ status: 'denied' }));
      const result = await poll();
      expect(result.body).toMatchObject({ error: 'access_denied' });
      expect(await fetchedRequests(fetch, '/delete')).toEqual([
        {
          method: 'POST',
          contentType: 'application/json',
          tenant: 'default',
          body: { auth_req_id: AUTH_REQ_ID },
        },
      ]);
    });

    it('refuses a status it does not know even with a subject', async () => {
      const fetch = useStore(metadata({ status: 'consumed' }));
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_grant',
        error_description: 'CIBA request is not approved',
      });
    });
  });

  describe('before the approved request is reserved', () => {
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

    it('lets a certificate-bound client through without a DPoP proof', async () => {
      mocks.getProtocolSettingsCached.mockResolvedValue({ fapi: { requireDpop: true } });
      mocks.getClientCached.mockResolvedValue(
        client({ tls_client_certificate_bound_access_tokens: true })
      );
      mocks.validateClientCertificateBinding.mockResolvedValue({ valid: true, thumbprint: 't' });
      useStore(metadata());
      expect((await poll()).status).toBe(200);
    });

    it('validates the DPoP proof against the token endpoint and refuses an invalid one', async () => {
      mocks.extractDPoPProof.mockReturnValue('dpop-proof');
      mocks.validateDPoPProof.mockResolvedValue({
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'Proof htu mismatch',
      });
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_dpop_proof',
        error_description: 'Proof htu mismatch',
      });
      expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
        'dpop-proof',
        'POST',
        'https://auth.example.com/token',
        undefined,
        env,
        CLIENT_ID,
        'default'
      );
    });

    it('refuses a client without a target resource', async () => {
      mocks.getClientCached.mockResolvedValue(client({ default_resource: undefined }));
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_target',
        error_description: 'No target resource is configured for this access token',
      });
    });

    it('answers 503 while the subject account route is unavailable', async () => {
      mocks.resolveAccountDataContextFromHono.mockRejectedValue(new Error('route down'));
      const fetch = useStore(metadata());
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 503, {
        error: 'temporarily_unavailable',
        error_description: 'Account data is unavailable',
      });
    });

    it.each([['oauth_client_consent_revocations'], ['oauth_client_consents']])(
      'answers 503 and keeps the request when %s cannot be read',
      async (table) => {
        answerQueryOne({ [table]: new Error('db down') });
        const fetch = useStore(metadata());
        const result = await poll();
        await expectRefusedBeforeReservation(fetch, result, 503, {
          error: 'temporarily_unavailable',
          error_description: 'Consent state is unavailable',
        });
      }
    );

    it('refuses a request made before the consent was withdrawn', async () => {
      const created = Date.now() - 10_000;
      answerQueryOne({
        oauth_client_consent_revocations: { generation: 2, revoked_at: created + 1 },
      });
      const fetch = useStore(metadata({ created_at: created, consent_generation: 2 }));
      const result = await poll();
      await expectRefusedBeforeReservation(fetch, result, 400, {
        error: 'invalid_grant',
        error_description: 'The provided authorization grant is invalid, expired, or revoked',
      });
    });

    it('issues for a request made and approved after an earlier withdrawal', async () => {
      const created = Date.now() - 10_000;
      answerQueryOne({
        oauth_client_consent_revocations: { generation: 2, revoked_at: created - 1 },
      });
      useStore(metadata({ created_at: created, consent_generation: 2 }));
      const result = await poll();
      expect(result.status).toBe(200);
      expect(mocks.createAccessToken.mock.calls[0][0]).toMatchObject({
        authrim_consent_generation: 2,
      });
    });

    it('reserves the request with a POST naming it', async () => {
      const fetch = useStore(metadata());
      expect((await poll()).status).toBe(200);
      expect(await fetchedRequests(fetch, '/mark-token-issued')).toEqual([
        {
          method: 'POST',
          contentType: 'application/json',
          tenant: 'default',
          body: { auth_req_id: AUTH_REQ_ID },
        },
      ]);
    });
  });
});
