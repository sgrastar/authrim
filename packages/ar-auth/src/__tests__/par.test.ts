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
    json: vi.fn((body: unknown, status = 200) =>
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
});
