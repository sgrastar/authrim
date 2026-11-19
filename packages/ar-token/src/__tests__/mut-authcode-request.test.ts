/**
 * Authorization code grant: request validation and client authentication before the code is
 * spent (src/token.ts tokenHandler / handleAuthorizationCodeGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  postClient,
  postToken,
  codeRequest,
  expectOAuthError,
  accessTokenClaims,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthCodeData, createPublicClient } from './helpers/fixtures';
import { createMockContext, type MockEnv } from './helpers/mocks';
import { tokenHandler } from '../token';

let env: MockEnv;

beforeEach(() => {
  env = resetHarness();
});

describe('token endpoint dispatch', () => {
  it('answers 503 temporarily_unavailable when the security profile settings cannot be read', async () => {
    const client = postClient();
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    mocks.getProtocolSettingsCached.mockRejectedValue(new Error('KV down'));
    const store = useCodeStore(env, data);

    const result = await postToken(env, codeRequest(client, data));

    expectOAuthError(
      result,
      503,
      'temporarily_unavailable',
      'Security profile settings are temporarily unavailable'
    );
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected error from a grant handler', async () => {
    mocks.getClientCached.mockRejectedValue(new Error('boom'));
    await expect(
      tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'c',
            redirect_uri: 'https://a/cb',
            client_id: 'x',
          },
          env,
        })
      )
    ).rejects.toThrow('boom');
  });
});

describe('authorization code request validation', () => {
  it('refuses a grant_type the validator rejects with unsupported_grant_type', async () => {
    mocks.validateGrantType.mockReturnValue({ valid: false, error: 'grant_type is bad' });
    const result = await postToken(env, { grant_type: 'authorization_code', code: 'c' });
    expectOAuthError(result, 400, 'unsupported_grant_type', 'grant_type is bad');
  });

  it('refuses a malformed code with invalid_grant and the validator message', async () => {
    mocks.validateAuthCode.mockReturnValue({ valid: false, error: 'code is malformed' });
    const result = await postToken(env, { grant_type: 'authorization_code', code: '!' });
    expectOAuthError(result, 400, 'invalid_grant', 'code is malformed');
    expect(mocks.validateClientId).not.toHaveBeenCalled();
  });

  it('refuses an invalid client_id with 401 invalid_client', async () => {
    mocks.validateClientId.mockReturnValue({ valid: false, error: 'client_id is required' });
    const result = await postToken(env, { grant_type: 'authorization_code', code: 'c' });
    expectOAuthError(result, 401, 'invalid_client', 'client_id is required');
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('requires a redirect_uri', async () => {
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      client_id: 'confidential-client-001',
    });
    expectOAuthError(result, 400, 'invalid_request', 'redirect_uri is required');
  });

  it('validates the redirect_uri as a token-time (loopback http allowed) URI', async () => {
    mocks.validateRedirectUri.mockReturnValue({ valid: false, error: 'redirect_uri is invalid' });
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      client_id: 'confidential-client-001',
      redirect_uri: 'not a uri',
    });
    expectOAuthError(result, 400, 'invalid_request', 'redirect_uri is invalid');
    expect(mocks.validateRedirectUri).toHaveBeenCalledWith('not a uri', true);
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('answers an unknown client with the generic client authentication failure', async () => {
    const result = await postToken(env, codeRequest(postClient(), createAuthCodeData()));
    expectOAuthError(result, 401, 'invalid_client', 'Client authentication failed');
  });
});

describe('client identification from credentials', () => {
  const bearer = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

  it('takes client_id from the client assertion sub', async () => {
    mocks.parseToken.mockReturnValue({ sub: 'from-sub', iss: 'from-iss' });
    await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example.com/callback',
      client_assertion: 'a.b.c',
      client_assertion_type: bearer,
    });
    expect(mocks.validateClientId).toHaveBeenCalledWith('from-sub');
  });

  it('falls back to the client assertion iss', async () => {
    mocks.parseToken.mockReturnValue({ iss: 'from-iss' });
    await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example.com/callback',
      client_assertion: 'a.b.c',
      client_assertion_type: bearer,
    });
    expect(mocks.validateClientId).toHaveBeenCalledWith('from-iss');
  });

  it('keeps an explicit client_id over the assertion', async () => {
    mocks.parseToken.mockReturnValue({ sub: 'from-sub' });
    await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example.com/callback',
      client_id: 'explicit',
      client_assertion: 'a.b.c',
      client_assertion_type: bearer,
    });
    expect(mocks.validateClientId).toHaveBeenCalledWith('explicit');
  });

  it('does not read an assertion of another type', async () => {
    await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example.com/callback',
      client_id: 'explicit',
      client_assertion: 'a.b.c',
      client_assertion_type: 'urn:other',
    });
    expect(mocks.parseToken).not.toHaveBeenCalled();
  });

  it('refuses an unparsable client assertion', async () => {
    mocks.parseToken.mockImplementation(() => {
      throw new Error('bad jwt');
    });
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      client_assertion: 'garbage',
      client_assertion_type: bearer,
    });
    expectOAuthError(result, 401, 'invalid_client', 'Invalid client_assertion JWT format');
  });

  it('uses Basic credentials when the form carries none', async () => {
    const client = postClient({ token_endpoint_auth_method: 'client_secret_basic' });
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    mocks.parseBasicAuth.mockReturnValue({
      success: true,
      credentials: { username: client.client_id, password: 'basic-secret' },
    });
    useCodeStore(env, data);
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: data.redirectUri,
    });
    expect(result.response.status).toBe(200);
    expect(mocks.validateClientId).toHaveBeenCalledWith(client.client_id);
    expect(mocks.verifyClientSecretHash).toHaveBeenCalledWith(
      'basic-secret',
      client.client_secret_hash
    );
  });

  it('keeps form credentials over Basic credentials', async () => {
    mocks.parseBasicAuth.mockReturnValue({
      success: true,
      credentials: { username: 'basic-id', password: 'basic-secret' },
    });
    const client = postClient();
    mocks.getClientCached.mockResolvedValue(client);
    await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example.com/callback',
      client_id: 'form-id',
      client_secret: 'form-secret',
    });
    expect(mocks.validateClientId).toHaveBeenCalledWith('form-id');
  });

  it.each(['malformed_credentials', 'decode_error'])('refuses a %s Basic header', async (error) => {
    mocks.parseBasicAuth.mockReturnValue({ success: false, error });
    const result = await postToken(env, { grant_type: 'authorization_code', code: 'c' });
    expectOAuthError(result, 401, 'invalid_client', 'Invalid Authorization header format');
  });

  it('ignores a missing Basic header', async () => {
    mocks.parseBasicAuth.mockReturnValue({ success: false, error: 'missing_header' });
    mocks.validateClientId.mockReturnValue({ valid: false, error: 'client_id is required' });
    const result = await postToken(env, { grant_type: 'authorization_code', code: 'c' });
    expectOAuthError(result, 401, 'invalid_client', 'client_id is required');
  });
});

describe('client authentication before the code is spent', () => {
  it('refuses a wrong client secret without consuming the code', async () => {
    const client = postClient();
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    mocks.verifyClientSecretHash.mockReturnValue(false);
    const store = useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 401, 'invalid_client', 'Client authentication failed');
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('refuses a confidential client registered without a secret or key', async () => {
    const client = postClient({ client_secret_hash: undefined });
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    const store = useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 401, 'invalid_client');
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('does not ask a public client for a secret', async () => {
    const client = createPublicClient({ client_secret_hash: 'stale-hash' });
    const data = createAuthCodeData({ redirectUri: 'https://spa.example.com/callback' });
    mocks.getClientCached.mockResolvedValue(client);
    useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    const result = await postToken(
      env,
      {
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: data.redirectUri,
        client_id: client.client_id,
        code_verifier: 'v'.repeat(43),
        channel: 'browser',
      },
      { DPoP: 'proof' }
    );
    expect(mocks.verifyClientSecretHash).not.toHaveBeenCalled();
    expect(result.response.status).toBe(200);
  });

  it('passes the assertion error code through and spends nothing', async () => {
    const client = postClient({
      token_endpoint_auth_method: 'private_key_jwt',
      client_secret_hash: undefined,
    });
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    mocks.parseToken.mockReturnValue({ sub: client.client_id });
    mocks.validateClientAssertion.mockResolvedValue({
      valid: false,
      error: 'invalid_grant',
      error_description: 'expired',
    });
    const store = useCodeStore(env, data);
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: data.redirectUri,
      client_assertion: 'a.b.c',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    expectOAuthError(result, 401, 'invalid_grant', 'Client assertion validation failed');
    expect(mocks.validateClientAssertion).toHaveBeenCalledWith(
      'a.b.c',
      'https://auth.example.com/token',
      client,
      expect.objectContaining({ replayProtection: { env, tenantId: 'default' } })
    );
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('answers invalid_client when the assertion failure names no error', async () => {
    const client = postClient({
      token_endpoint_auth_method: 'private_key_jwt',
      client_secret_hash: undefined,
    });
    mocks.getClientCached.mockResolvedValue(client);
    mocks.parseToken.mockReturnValue({ sub: client.client_id });
    mocks.validateClientAssertion.mockResolvedValue({ valid: false });
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example.com/callback',
      client_assertion: 'a.b.c',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    expectOAuthError(result, 401, 'invalid_client', 'Client assertion validation failed');
  });

  it('refuses a certificate-bound client without a certificate thumbprint', async () => {
    const client = postClient({ tls_client_certificate_bound_access_tokens: true });
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    mocks.validateClientCertificateBinding.mockResolvedValue({ valid: true });
    const store = useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 401, 'invalid_client', 'Client certificate authentication failed');
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('binds the access token to the client certificate thumbprint', async () => {
    const client = postClient({ tls_client_certificate_bound_access_tokens: true });
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    mocks.validateClientCertificateBinding.mockResolvedValue({ valid: true, thumbprint: 'x5t-1' });
    useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data, {}));
    expect(result.response.status).toBe(200);
    expect(accessTokenClaims().cnf).toEqual({ 'x5t#S256': 'x5t-1' });
  });
});

describe('the requested resource', () => {
  it('refuses a resource other than the grant’s before spending the code', async () => {
    const client = postClient();
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    const store = useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data, { resource: 'svc://other-api' }));
    expectOAuthError(
      result,
      400,
      'invalid_target',
      'Requested resource does not match the authorization grant'
    );
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('refuses a resource and audience that disagree', async () => {
    const client = postClient();
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    const store = useCodeStore(env, data);
    const result = await postToken(
      env,
      codeRequest(client, data, { resource: 'svc://confidential-api', audience: 'svc://x' })
    );
    expectOAuthError(
      result,
      400,
      'invalid_target',
      'resource and audience identify different access token targets'
    );
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('refuses every exchange for a client without a default resource', async () => {
    const client = postClient({ default_resource: undefined });
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    const store = useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(
      result,
      400,
      'invalid_target',
      'No target resource is configured for this access token'
    );
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('accepts the grant’s own resource repeated and binds the code to it', async () => {
    const client = postClient();
    const data = createAuthCodeData();
    mocks.getClientCached.mockResolvedValue(client);
    const store = useCodeStore(env, data);
    const result = await postToken(
      env,
      codeRequest(client, data, { resource: 'svc://confidential-api' })
    );
    expect(result.response.status).toBe(200);
    expect(store.consumeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ expectedResource: 'svc://confidential-api' })
    );
  });
});
