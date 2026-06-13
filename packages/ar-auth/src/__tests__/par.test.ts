import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockValidateClientId,
  mockValidateRedirectUri,
  mockValidateScope,
  mockIsRedirectUriRegistered,
  mockCreateOAuthConfigManager,
  mockValidateClientAssertion,
  mockValidateDPoPProof,
  mockVerifyClientSecretHash,
  mockGetTokenFormat,
  mockParseToken,
  mockIsInternalUrl,
  mockValidateAuthorizationDetails,
  mockGetClientCached,
  mockGetPARRequestStoreForNewRequest,
  mockStoreRequestRpc,
  mockGetLogger,
  mockLogger,
  mockJwtVerify,
  mockImportJWK,
  mockCreateRemoteJWKSet,
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    mockValidateClientId: vi.fn(),
    mockValidateRedirectUri: vi.fn(),
    mockValidateScope: vi.fn(),
    mockIsRedirectUriRegistered: vi.fn(),
    mockCreateOAuthConfigManager: vi.fn(),
    mockValidateClientAssertion: vi.fn(),
    mockValidateDPoPProof: vi.fn(),
    mockVerifyClientSecretHash: vi.fn(),
    mockGetTokenFormat: vi.fn(),
    mockParseToken: vi.fn(),
    mockIsInternalUrl: vi.fn(),
    mockValidateAuthorizationDetails: vi.fn(),
    mockGetClientCached: vi.fn(),
    mockGetPARRequestStoreForNewRequest: vi.fn(),
    mockStoreRequestRpc: vi.fn(),
    mockGetLogger: vi.fn().mockReturnValue(logger),
    mockLogger: logger,
    mockJwtVerify: vi.fn(),
    mockImportJWK: vi.fn(),
    mockCreateRemoteJWKSet: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    validateClientId: mockValidateClientId,
    validateRedirectUri: mockValidateRedirectUri,
    validateScope: mockValidateScope,
    isRedirectUriRegistered: mockIsRedirectUriRegistered,
    createOAuthConfigManager: mockCreateOAuthConfigManager,
    validateClientAssertion: mockValidateClientAssertion,
    validateDPoPProof: mockValidateDPoPProof,
    verifyClientSecretHash: mockVerifyClientSecretHash,
    getTokenFormat: mockGetTokenFormat,
    parseToken: mockParseToken,
    isInternalUrl: mockIsInternalUrl,
    validateAuthorizationDetails: mockValidateAuthorizationDetails,
    getClientCached: mockGetClientCached,
    getPARRequestStoreForNewRequest: mockGetPARRequestStoreForNewRequest,
    getLogger: mockGetLogger,
  };
});

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn().mockReturnValue('https://op.example.com'),
}));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: mockJwtVerify,
    importJWK: mockImportJWK,
    createRemoteJWKSet: mockCreateRemoteJWKSet,
  };
});

import { parHandler } from '../par';

function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  const env = {
    ISSUER_URL: 'https://op.example.com',
    SETTINGS: {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as KVNamespace,
    PAR_REQUEST_STORE: {} as Env['PAR_REQUEST_STORE'],
    DPOP_JTI_STORE: {} as DurableObjectNamespace,
    ...options.env,
  } as Env;

  const c = {
    req: {
      method: options.method ?? 'POST',
      header: (name: string) => headers[name.toLowerCase()],
      parseBody: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env,
    json: vi.fn(
      (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'tenantId') return 'default';
      return undefined;
    }),
  } as any;

  return c;
}

describe('PAR Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockValidateClientId.mockReturnValue({ valid: true });
    mockValidateRedirectUri.mockReturnValue({ valid: true });
    mockValidateScope.mockReturnValue({ valid: true });
    mockIsRedirectUriRegistered.mockReturnValue(true);
    mockCreateOAuthConfigManager.mockReturnValue({});
    mockValidateClientAssertion.mockResolvedValue({ valid: true });
    mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'thumbprint' });
    mockVerifyClientSecretHash.mockResolvedValue(true);
    mockGetTokenFormat.mockReturnValue('jwt');
    mockParseToken.mockReturnValue(null);
    mockIsInternalUrl.mockReturnValue(false);
    mockValidateAuthorizationDetails.mockReturnValue({
      valid: true,
      sanitized: [{ type: 'payment_initiation' }],
    });
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
    });
    mockStoreRequestRpc.mockResolvedValue(undefined);
    mockGetPARRequestStoreForNewRequest.mockResolvedValue({
      requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
      stub: {
        storeRequestRpc: mockStoreRequestRpc,
      },
    });
    mockGetLogger.mockReturnValue(mockLogger);
    mockImportJWK.mockResolvedValue({ type: 'public' } as CryptoKey);
    mockJwtVerify.mockResolvedValue({
      payload: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });
    mockCreateRemoteJWKSet.mockReturnValue(vi.fn());
  });

  it('rejects non form-encoded requests before processing the payload', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/json',
      },
      body: {
        client_id: 'client-123',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Content-Type must be application/x-www-form-urlencoded',
    });
    expect(mockGetClientCached).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests before parsing the request body', async () => {
    const c = createMockContext({
      method: 'GET',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'PAR endpoint only accepts POST requests',
    });
    expect(c.req.parseBody).not.toHaveBeenCalled();
    expect(mockGetClientCached).not.toHaveBeenCalled();
  });

  it('redacts RFC error details from PAR logs in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const c = createMockContext({
      method: 'GET',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    try {
      const response = await parHandler(c);

      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid_request',
        error_description: 'PAR endpoint only accepts POST requests',
      });
      expect(mockLogger.error).toHaveBeenCalledWith('PAR error', {
        action: 'handler',
        rfcError: 'invalid_request',
        status: 405,
      });
      expect(c.req.parseBody).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('rejects unknown clients before attempting client authentication or storage', async () => {
    mockGetClientCached.mockResolvedValue(null);
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
    expect(mockVerifyClientSecretHash).not.toHaveBeenCalled();
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects confidential clients without a valid client secret before storing the PAR request', async () => {
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      client_secret_hash: 'hash_secret',
      redirect_uris: ['https://client.example.com/callback'],
    });
    mockVerifyClientSecretHash.mockResolvedValue(false);
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        client_secret: 'wrong-secret',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
    expect(mockVerifyClientSecretHash).toHaveBeenCalledWith('wrong-secret', 'hash_secret');
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('enforces private_key_jwt for FAPI PAR requests', async () => {
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      client_secret_hash: 'hash_secret',
      redirect_uris: ['https://client.example.com/callback'],
    });

    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        client_secret: 'secret',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      },
      env: {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(
            JSON.stringify({
              fapi: {
                enabled: true,
              },
            })
          ),
        } as unknown as KVNamespace,
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'FAPI 2.0 requires private_key_jwt authentication for PAR',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects FAPI requests that do not use S256 PKCE', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
      env: {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(
            JSON.stringify({
              fapi: {
                enabled: true,
                requirePrivateKeyJwt: false,
              },
            })
          ),
        } as unknown as KVNamespace,
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'FAPI 2.0 requires PKCE with S256 method',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects malformed request objects before redirect and scope validation', async () => {
    mockGetTokenFormat.mockReturnValue('unknown');
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        request: 'not-a-jwt-or-jwe',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request_object',
      error_description: 'Invalid request object format',
    });
    expect(mockValidateRedirectUri).not.toHaveBeenCalled();
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects request object client_id mismatch before storing the request', async () => {
    mockGetTokenFormat.mockReturnValue('jwt');
    mockParseToken.mockReturnValue({
      header: {
        alg: 'none',
      },
      client_id: 'other-client',
      response_type: 'code',
    });
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        request: 'unsigned-request-object',
      },
      env: {
        ENVIRONMENT: 'development',
        SETTINGS: {
          get: vi.fn().mockResolvedValue(
            JSON.stringify({
              oidc: {
                allowNoneAlgorithm: true,
              },
            })
          ),
        } as unknown as KVNamespace,
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'client_id mismatch between request parameter and request object',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('verifies signed request objects with the matching kid and explicit algorithm allowlist', async () => {
    const matchingKey = {
      kty: 'RSA',
      kid: 'client-key-2',
      alg: 'RS256',
      use: 'sig',
      n: 'test-modulus',
      e: 'AQAB',
    };
    const firstKey = {
      kty: 'RSA',
      kid: 'client-key-1',
      alg: 'RS256',
      use: 'sig',
      n: 'wrong-modulus',
      e: 'AQAB',
    };
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
      jwks: {
        keys: [firstKey, matchingKey],
      },
    });
    mockParseToken.mockReturnValue({
      header: {
        alg: 'RS256',
        kid: 'client-key-2',
      },
    });
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        request: 'signed-request-object',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(201);
    expect(mockImportJWK).toHaveBeenCalledWith(matchingKey, 'RS256');
    expect(mockJwtVerify).toHaveBeenCalledWith(
      'signed-request-object',
      { type: 'public' },
      {
        issuer: 'client-123',
        audience: 'https://op.example.com',
        algorithms: ['RS256'],
      }
    );
    expect(mockStoreRequestRpc).toHaveBeenCalled();
  });

  it('rejects signed request objects that do not use RS256', async () => {
    mockParseToken.mockReturnValue({
      header: {
        alg: 'ES256',
        kid: 'client-key-1',
      },
    });
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
      jwks: {
        keys: [
          {
            kty: 'EC',
            kid: 'client-key-1',
            alg: 'ES256',
            use: 'sig',
          },
        ],
      },
    });
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        request: 'signed-request-object',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request_object',
      error_description: 'Unsupported request object signing algorithm',
    });
    expect(mockImportJWK).not.toHaveBeenCalled();
    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects embedded JWKS request objects when the kid does not match a signing key', async () => {
    mockParseToken.mockReturnValue({
      header: {
        alg: 'RS256',
        kid: 'missing-key',
      },
    });
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
      jwks: {
        keys: [
          {
            kty: 'RSA',
            kid: 'client-key-1',
            alg: 'RS256',
            use: 'sig',
            n: 'test-modulus',
            e: 'AQAB',
          },
        ],
      },
    });
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        request: 'signed-request-object',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request_object',
      error_description: 'No suitable signing key found in client jwks',
    });
    expect(mockImportJWK).not.toHaveBeenCalled();
    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('stores sanitized authorization_details when RAR is enabled', async () => {
    const authorizationDetails = [{ type: 'payment_initiation', amount: '100.00' }];
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        authorization_details: JSON.stringify(authorizationDetails),
      },
      env: {
        ENABLE_RAR: 'true',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(201);
    expect(mockValidateAuthorizationDetails).toHaveBeenCalledWith(authorizationDetails, {
      allowedTypes: ['ai_agent_action', 'payment_initiation', 'account_information'],
    });
    expect(mockStoreRequestRpc).toHaveBeenCalledWith({
      requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
      data: expect.objectContaining({
        authorization_details: JSON.stringify([{ type: 'payment_initiation' }]),
      }),
      ttl: 600,
    });
  });

  it('rejects unregistered redirect_uri before PAR storage', async () => {
    mockIsRedirectUriRegistered.mockReturnValue(false);
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://evil.example.com/callback',
        scope: 'openid profile',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'redirect_uri not registered for this client',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects malformed scopes and unsupported response types before PAR storage', async () => {
    mockValidateScope.mockReturnValue({
      valid: false,
      error: 'scope must include openid',
    });
    const invalidScopeContext = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'profile',
      },
    });

    const invalidScopeResponse = await parHandler(invalidScopeContext);

    expect(invalidScopeResponse.status).toBe(400);
    await expect(invalidScopeResponse.json()).resolves.toMatchObject({
      error: 'invalid_scope',
      error_description: 'scope must include openid',
    });

    vi.clearAllMocks();
    mockValidateClientId.mockReturnValue({ valid: true });
    mockValidateRedirectUri.mockReturnValue({ valid: true });
    mockValidateScope.mockReturnValue({ valid: true });
    mockIsRedirectUriRegistered.mockReturnValue(true);
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
    });
    mockGetPARRequestStoreForNewRequest.mockResolvedValue({
      requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
      stub: {
        storeRequestRpc: mockStoreRequestRpc,
      },
    });
    const unsupportedResponseTypeContext = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'token',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });

    const unsupportedResponseTypeResponse = await parHandler(unsupportedResponseTypeContext);

    expect(unsupportedResponseTypeResponse.status).toBe(400);
    await expect(unsupportedResponseTypeResponse.json()).resolves.toMatchObject({
      error: 'unsupported_response_type',
      error_description: expect.stringContaining('Unsupported response_type'),
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects malformed PKCE parameters before PAR storage', async () => {
    const missingMethodContext = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        code_challenge: 'a'.repeat(43),
      },
    });

    const missingMethodResponse = await parHandler(missingMethodContext);

    expect(missingMethodResponse.status).toBe(400);
    await expect(missingMethodResponse.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'code_challenge_method is required when code_challenge is present',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockValidateClientId.mockReturnValue({ valid: true });
    mockValidateRedirectUri.mockReturnValue({ valid: true });
    mockValidateScope.mockReturnValue({ valid: true });
    mockIsRedirectUriRegistered.mockReturnValue(true);
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
    });
    const shortChallengeContext = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        code_challenge: 'short',
        code_challenge_method: 'S256',
      },
    });

    const shortChallengeResponse = await parHandler(shortChallengeContext);

    expect(shortChallengeResponse.status).toBe(400);
    await expect(shortChallengeResponse.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'code_challenge must be between 43 and 128 characters',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('caps FAPI request_uri expiry at 60 seconds on successful requests', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        state: 'state-123',
      },
      env: {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(
            JSON.stringify({
              fapi: {
                enabled: true,
                requirePrivateKeyJwt: false,
                maxRequestUriExpiry: 120,
              },
            })
          ),
        } as unknown as KVNamespace,
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      request_uri: 'urn:ietf:params:oauth:request_uri:par_test',
      expires_in: 60,
    });
    expect(mockStoreRequestRpc).toHaveBeenCalledWith({
      requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
      data: expect.objectContaining({
        client_id: 'client-123',
        state: 'state-123',
      }),
      ttl: 60,
    });
  });

  it('rejects authorization_details when RAR is not enabled', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        authorization_details: JSON.stringify([{ type: 'payment_initiation' }]),
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description:
        'authorization_details parameter is not supported. Enable RAR feature to use Rich Authorization Requests.',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('stores the DPoP key thumbprint with a successful PAR request', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        dpop: 'dpop-proof.jwt',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(201);
    expect(mockValidateDPoPProof).toHaveBeenCalledWith(
      'dpop-proof.jwt',
      'POST',
      'https://op.example.com/par',
      undefined,
      c.env,
      'client-123',
      'default'
    );
    expect(mockStoreRequestRpc).toHaveBeenCalledWith({
      requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
      data: expect.objectContaining({
        client_id: 'client-123',
        dpop_jkt: 'thumbprint',
      }),
      ttl: 600,
    });
  });

  it('rejects invalid DPoP proofs before storing the PAR request', async () => {
    mockValidateDPoPProof.mockResolvedValue({
      valid: false,
      error: 'use_dpop_nonce',
      error_description: 'DPoP nonce required',
    });
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        dpop: 'stale-proof.jwt',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'use_dpop_nonce',
      error_description: 'DPoP nonce required',
    });
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('returns server_error when PAR storage is not bound', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
      env: {
        PAR_REQUEST_STORE: undefined as unknown as Env['PAR_REQUEST_STORE'],
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'server_error',
      error_description: 'PAR request storage unavailable',
    });
    expect(mockGetPARRequestStoreForNewRequest).not.toHaveBeenCalled();
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });

  it('returns server_error when the PAR request cannot be persisted', async () => {
    mockStoreRequestRpc.mockRejectedValueOnce(new Error('storage unavailable'));
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
      },
    });

    const response = await parHandler(c);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'server_error',
      error_description: 'Failed to store PAR request',
    });
    expect(mockGetPARRequestStoreForNewRequest).toHaveBeenCalledWith(
      c.env,
      'default',
      'client-123',
      expect.any(String)
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'PAR store error',
      { action: 'store' },
      expect.any(Error)
    );
  });

  it('returns server_error when request body parsing fails unexpectedly', async () => {
    const c = createMockContext({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    c.req.parseBody.mockRejectedValueOnce(new Error('malformed form body'));

    const response = await parHandler(c);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      'PAR unexpected error',
      { action: 'handler', redacted: false },
      expect.any(Error)
    );
    expect(mockStoreRequestRpc).not.toHaveBeenCalled();
  });
});
