/**
 * Client Credentials grant (token.ts handleClientCredentialsGrant): the feature switch, how the
 * client is identified and authenticated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TestClientMetadata } from './helpers/fixtures';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  CLIENT_ID,
  JWT_BEARER,
  requestClientCredentials,
  setupM2MClient,
} from './helpers/mut-clientcreds-fixtures';

const mocks = await vi.hoisted(async () => {
  const { createHarnessMocks } = await import('./helpers/mut-nativesso-harness');
  return createHarnessMocks();
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const { arLibCoreMock } = await import('./helpers/mut-nativesso-harness');
  return arLibCoreMock(await importOriginal(), mocks);
});

vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' }),
  importJWK: vi.fn().mockResolvedValue({ type: 'public' }),
}));

import { tokenHandler } from '../token';
import { setupHarness } from './helpers/mut-nativesso-harness';

describe('Client Credentials grant', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const setupClient = (overrides: Partial<TestClientMetadata> = {}) =>
    setupM2MClient(mocks, overrides);
  const request = (
    overrides: Record<string, string | undefined> = {},
    options: { env?: Record<string, unknown>; headers?: Record<string, string> } = {}
  ) => requestClientCredentials(harness, tokenHandler, overrides, options);

  describe('feature switch', () => {
    it('stays off when neither the settings nor the environment enable it', async () => {
      setupClient();

      const { response, body } = await request({}, { env: { ENABLE_CLIENT_CREDENTIALS: 'false' } });

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'unsupported_grant_type',
        error_description: 'Client Credentials grant is not enabled',
      });
      expect(mocks.mockGetProtocolSettingsCached).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { keys: ['feature.enable_client_credentials'] }
      );
    });

    it('is enabled by the settings over the environment', async () => {
      setupClient();
      harness.setSystemSettings({ oidc: { clientCredentials: { enabled: true } } });

      const { response } = await request({}, { env: { ENABLE_CLIENT_CREDENTIALS: undefined } });

      expect(response.status).toBe(200);
    });
  });

  describe('client identification', () => {
    it('takes the client from the assertion sub only when no client_id is given', async () => {
      setupClient({ token_endpoint_auth_method: 'private_key_jwt', client_secret_hash: undefined });
      mocks.mockParseToken.mockReturnValue({ sub: CLIENT_ID });

      const { response } = await request({
        client_id: undefined,
        client_secret: undefined,
        client_assertion: 'header.payload.signature',
        client_assertion_type: JWT_BEARER,
      });

      expect(response.status).toBe(200);
      expect(mocks.mockGetClientCached).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        CLIENT_ID
      );
    });

    it('looks up the client_id given, then refuses an assertion naming another client', async () => {
      setupClient({ token_endpoint_auth_method: 'private_key_jwt', client_secret_hash: undefined });
      mocks.mockParseToken.mockReturnValue({ sub: 'someone-else' });
      const MISMATCH = 'Client assertion iss and sub must be the client_id';
      const REFUSED = 'Client assertion validation failed';
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: false,
        error: 'invalid_client',
        error_description: MISMATCH,
      });

      const { response, body } = await request({
        client_secret: undefined,
        client_assertion: 'header.payload.signature',
        client_assertion_type: JWT_BEARER,
      });

      expect(response.status).toBe(401);
      expect(body).toEqual({ error: 'invalid_client', error_description: REFUSED });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      expect(mocks.mockGetClientCached).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'someone-else'
      );
    });

    it('reads no assertion of another type, nor an assertion type without an assertion', async () => {
      setupClient();

      await request({
        client_assertion: 'header.payload.signature',
        client_assertion_type: 'saml',
      });
      await request({ client_assertion_type: JWT_BEARER });

      expect(mocks.mockParseToken).not.toHaveBeenCalled();
      expect(mocks.mockValidateClientAssertion).not.toHaveBeenCalled();
    });

    it('refuses a malformed Basic Authorization header', async () => {
      setupClient();
      mocks.mockParseBasicAuth.mockReturnValue({ success: false, error: 'malformed_credentials' });

      const { response, body } = await request();

      expect(response.status).toBe(401);
      expect(body).toMatchObject({
        error: 'invalid_client',
        error_description: 'Invalid Authorization header format',
      });
    });

    it('takes the client from Basic credentials', async () => {
      setupClient({ token_endpoint_auth_method: 'client_secret_basic' });
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: { username: CLIENT_ID, password: 'basic-secret' },
      });

      const { response } = await request({ client_id: undefined, client_secret: undefined });

      expect(response.status).toBe(200);
      expect(mocks.mockVerifyClientSecretHash).toHaveBeenCalledWith(
        'basic-secret',
        'hashed-m2m-secret'
      );
    });

    it.each([
      ['an invalid client_id', 'client_id is invalid'],
      ['an unknown client', 'Client authentication failed'],
    ])('refuses %s as invalid_client', async (name, description) => {
      setupClient();
      if (name === 'an invalid client_id') {
        mocks.mockValidateClientId.mockReturnValue({ valid: false, error: description });
      }

      const { response, body } = await request(
        name === 'an unknown client' ? { client_id: 'nobody' } : {}
      );

      expect(response.status).toBe(401);
      expect(body).toMatchObject({ error: 'invalid_client', error_description: description });
    });

    it('reads the tenant profile and publishes for the client tenant', async () => {
      setupClient({ tenant_id: 'tenant-b' });

      expect((await request()).response.status).toBe(200);
      expect(mocks.mockLoadTenantProfileCached).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'tenant-b'
      );
      expect(mocks.mockPublishEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: 'tenant-b' })
      );
    });
  });

  describe('client authentication', () => {
    it('validates a private_key_jwt assertion for the token endpoint with replay protection', async () => {
      const client = setupClient({
        token_endpoint_auth_method: 'private_key_jwt',
        client_secret_hash: undefined,
      });
      mocks.mockParseToken.mockReturnValue({ sub: CLIENT_ID });

      const { response } = await request({
        client_secret: undefined,
        client_assertion: 'header.payload.signature',
        client_assertion_type: JWT_BEARER,
      });

      expect(response.status).toBe(200);
      expect(mocks.mockValidateClientAssertion).toHaveBeenCalledWith(
        'header.payload.signature',
        'https://auth.example.com/token',
        client,
        expect.objectContaining({
          replayProtection: expect.objectContaining({ tenantId: 'default' }) as unknown,
        })
      );
    });

    it('refuses a wrong client secret', async () => {
      setupClient();
      mocks.mockVerifyClientSecretHash.mockReturnValue(false);

      const { response, body } = await request();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: 'invalid_client',
        error_description: 'Invalid client credentials',
      });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('refuses a public client', async () => {
      setupClient({ token_endpoint_auth_method: 'none', client_secret_hash: undefined });

      const { response, body } = await request({ client_secret: undefined });

      expect(response.status).toBe(401);
      expect(body).toMatchObject({
        error: 'invalid_client',
        error_description: 'Client credentials authentication is required',
      });
    });

    it('refuses a certificate-bound client presenting no certificate', async () => {
      setupClient({ tls_client_certificate_bound_access_tokens: true });

      const { response, body } = await request();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: 'invalid_client',
        error_description: 'Client certificate authentication failed',
      });
    });
  });
});
