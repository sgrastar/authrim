/**
 * refresh_token grant (RFC 6749 section 6): how the client is identified and authenticated
 * before the refresh token is read, and the tenant and profile policies applied to it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mocks, resetHarness } from './helpers/mut-grants-harness';
import {
  presentRefreshToken,
  refresh,
  RT_CLIENT_ID,
  RT_SECRET,
  type PresentedRefreshToken,
} from './helpers/mut-grants-refresh-fixture';
import type { MockEnv } from './helpers/mocks';

const JWT_BEARER_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

describe('refresh_token grant: client authentication', () => {
  let env: MockEnv;
  let presented: PresentedRefreshToken;

  beforeEach(() => {
    env = resetHarness();
    presented = presentRefreshToken(env);
  });

  function expectNoRefreshRead() {
    expect(mocks.getRefreshToken).not.toHaveBeenCalled();
    expect(presented.rotateRpc).not.toHaveBeenCalled();
  }

  describe('the client a client assertion names', () => {
    function assertionClaims(claims: Record<string, unknown>) {
      mocks.parseToken.mockImplementation((jwt: string) =>
        jwt === 'client-assertion' ? claims : presented.payload
      );
    }

    it.each([
      ['sub', { sub: 'assertion-sub-client', iss: 'assertion-iss-client' }, 'assertion-sub-client'],
      ['iss', { iss: 'assertion-iss-client' }, 'assertion-iss-client'],
    ])('takes the client_id from the assertion %s', async (_claim, claims, clientId) => {
      assertionClaims(claims);
      mocks.getClientCached.mockResolvedValue(null);
      const result = await refresh(env, presented, {
        client_id: undefined,
        client_secret: undefined,
        client_assertion: 'client-assertion',
        client_assertion_type: JWT_BEARER_ASSERTION,
      });
      expect(result.status).toBe(401);
      expect(mocks.getClientCached).toHaveBeenCalledWith(expect.anything(), env, clientId);
    });

    it('ignores an assertion of another type', async () => {
      assertionClaims({ sub: 'assertion-sub-client' });
      const result = await refresh(env, presented, {
        client_id: undefined,
        client_secret: undefined,
        client_assertion: 'client-assertion',
        client_assertion_type: 'urn:example:other',
      });
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: 'invalid_client' });
      expect(mocks.getClientCached).not.toHaveBeenCalled();
    });

    it('refuses an assertion that is not a JWT', async () => {
      mocks.parseToken.mockImplementation(() => {
        throw new Error('not a JWT');
      });
      const result = await refresh(env, presented, {
        client_assertion: 'client-assertion',
        client_assertion_type: JWT_BEARER_ASSERTION,
      });
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Invalid client_assertion JWT format',
      });
    });

    it('authenticates a private_key_jwt client by its assertion at the token endpoint', async () => {
      presented = presentRefreshToken(env, {
        client: { token_endpoint_auth_method: 'private_key_jwt', client_secret_hash: undefined },
      });
      mocks.parseToken.mockImplementation((jwt: string) =>
        jwt === 'client-assertion' ? { sub: RT_CLIENT_ID } : presented.payload
      );
      mocks.validateClientAssertion.mockResolvedValue({ valid: false });
      const result = await refresh(env, presented, {
        client_secret: undefined,
        client_assertion: 'client-assertion',
        client_assertion_type: JWT_BEARER_ASSERTION,
      });
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client assertion validation failed',
      });
      expect(mocks.validateClientAssertion).toHaveBeenCalledWith(
        'client-assertion',
        'https://auth.example.com/token',
        expect.objectContaining({ client_id: RT_CLIENT_ID }),
        expect.objectContaining({ replayProtection: { env, tenantId: 'default' } })
      );
      expectNoRefreshRead();
    });

    it('answers with the error the assertion validation gives', async () => {
      presented = presentRefreshToken(env, {
        client: { token_endpoint_auth_method: 'private_key_jwt', client_secret_hash: undefined },
      });
      mocks.validateClientAssertion.mockResolvedValue({ valid: false, error: 'invalid_grant' });
      const result = await refresh(env, presented, {
        client_secret: undefined,
        client_assertion: 'client-assertion',
        client_assertion_type: JWT_BEARER_ASSERTION,
      });
      expect(result.body).toMatchObject({ error: 'invalid_grant' });
    });
  });

  describe('HTTP Basic', () => {
    it('takes the client_id and secret from a Basic header', async () => {
      const result = await refresh(
        env,
        presented,
        { client_id: undefined, client_secret: undefined },
        { Authorization: `Basic ${btoa(`${RT_CLIENT_ID}:basic-secret`)}` }
      );
      // The client is registered for client_secret_post, so Basic is refused after it is read.
      expect(mocks.getClientCached).toHaveBeenCalledWith(expect.anything(), env, RT_CLIENT_ID);
      expect(result.status).toBe(401);
    });

    it('verifies the Basic password of a client registered for client_secret_basic', async () => {
      presented = presentRefreshToken(env, {
        client: { token_endpoint_auth_method: 'client_secret_basic' },
      });
      mocks.verifyClientSecretHash.mockResolvedValue(false);
      const result = await refresh(
        env,
        presented,
        { client_id: undefined, client_secret: undefined },
        { Authorization: `Basic ${btoa(`${RT_CLIENT_ID}:basic-secret`)}` }
      );
      expect(mocks.verifyClientSecretHash).toHaveBeenCalledWith(
        'basic-secret',
        'hashed-secret-value'
      );
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    });

    it.each([
      ['undecodable', 'Basic %%%'],
      ['without a colon', `Basic ${btoa('no-colon')}`],
    ])('refuses a Basic header that is %s', async (_label, header) => {
      const result = await refresh(env, presented, {}, { Authorization: header });
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Invalid Authorization header format',
      });
      expect(mocks.getClientCached).not.toHaveBeenCalled();
    });
  });

  describe('request validation', () => {
    it('requires a refresh_token', async () => {
      const result = await refresh(env, presented, { refresh_token: undefined });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      });
    });

    it('requires a client_id', async () => {
      const result = await refresh(env, presented, { client_id: undefined });
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: 'invalid_client' });
      expect(mocks.getClientCached).not.toHaveBeenCalled();
    });

    it('refuses an unknown client with a generic description', async () => {
      mocks.getClientCached.mockResolvedValue(null);
      const result = await refresh(env, presented);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    });
  });

  describe('secrets', () => {
    it('refuses a confidential client that sends no secret', async () => {
      const result = await refresh(env, presented, { client_secret: undefined });
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error: 'invalid_client' });
      expectNoRefreshRead();
    });

    it('refuses a wrong secret', async () => {
      mocks.verifyClientSecretHash.mockResolvedValue(false);
      const result = await refresh(env, presented);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
      expect(mocks.verifyClientSecretHash).toHaveBeenCalledWith(RT_SECRET, 'hashed-secret-value');
      expectNoRefreshRead();
    });

    it('refuses a secret-registered client whose secret hash is missing', async () => {
      presented = presentRefreshToken(env, { client: { client_secret_hash: undefined } });
      const result = await refresh(env, presented);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication configuration is invalid',
      });
      expectNoRefreshRead();
    });
  });

  describe('tenant and profile policy', () => {
    it("applies the tenant profile of the client's own tenant", async () => {
      presented = presentRefreshToken(env, { client: { tenant_id: 'tenant-b' } });
      mocks.loadTenantProfileCached.mockImplementation(
        async (_c: unknown, _kv: unknown, _env: unknown, tenantId: string) => ({
          allows_refresh_token: tenantId !== 'tenant-b',
        })
      );
      const result = await refresh(env, presented);
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: 'unauthorized_client' });
    });

    it('refuses the grant when the tenant profile does not allow refresh tokens', async () => {
      mocks.loadTenantProfileCached.mockResolvedValue({ allows_refresh_token: false });
      const result = await refresh(env, presented);
      expect(result.status).toBe(403);
      expect(result.body).toEqual({
        error: 'unauthorized_client',
        error_description: 'refresh_token grant is not allowed for this tenant profile',
      });
      expectNoRefreshRead();
    });

    it('requires a DPoP proof when the profile requires one', async () => {
      mocks.getProtocolSettingsCached.mockResolvedValue({ fapi: { requireDpop: true } });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_request',
        error_description: 'DPoP proof is required for this request',
      });
    });

    it('reads the FAPI refresh policy for the client and answers 503 when it cannot', async () => {
      mocks.getProtocolSettingsCached.mockImplementation(
        async (_c: unknown, _env: unknown, options: { keys: string[] }) => {
          if (options.keys.includes('security.fapi_enabled')) throw new Error('settings down');
          return null;
        }
      );
      const result = await refresh(env, presented);
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: 'temporarily_unavailable' });
      expectNoRefreshRead();
    });

    it('keeps the refresh token stable for a FAPI 2.0 tenant', async () => {
      presented = presentRefreshToken(env, {
        client: { token_endpoint_auth_method: 'private_key_jwt', client_secret_hash: undefined },
      });
      mocks.parseToken.mockImplementation((jwt: string) =>
        jwt === 'client-assertion' ? { sub: RT_CLIENT_ID } : presented.payload
      );
      mocks.getProtocolSettingsCached.mockImplementation(
        async (_c: unknown, _env: unknown, options: { clientId: string; keys: string[] }) =>
          options.clientId === RT_CLIENT_ID && options.keys.includes('security.fapi_enabled')
            ? { fapi: { enabled: true, requireDpop: false } }
            : null
      );
      const result = await refresh(env, presented, {
        client_secret: undefined,
        client_assertion: 'client-assertion',
        client_assertion_type: JWT_BEARER_ASSERTION,
      });
      expect(result.status).toBe(200);
      expect(result.body.refresh_token).toBe(presented.token);
      expect(presented.rotateRpc).not.toHaveBeenCalled();
    });

    it('rotates the refresh token outside FAPI', async () => {
      const result = await refresh(env, presented);
      expect(result.status).toBe(200);
      expect(result.body.refresh_token).toBe('mock-refresh-token');
      expect(presented.rotateRpc).toHaveBeenCalledTimes(1);
    });
  });
});
