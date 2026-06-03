/**
 * Issuer Routes Tests
 *
 * Tests for OpenID4VCI issuer endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { issuerMetadataRoute } from '../metadata';
import { credentialOfferRoute } from '../offer';
import { credentialRoute } from '../credential';
import { deferredCredentialRoute } from '../deferred';
import type { Context } from 'hono';
import type { Env } from '../../../types';

// Mock jose
vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue({} as CryptoKey),
}));

// Shared mock data for IssuedCredentialRepository
let mockDeferredCredential: unknown = null;
const routeCoreMocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  allocateIndex: vi.fn(),
}));

// Mock @authrim/ar-lib-core - keep real implementations for region sharding functions
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createSDJWTVC: vi.fn().mockResolvedValue({
      combined: 'header.payload.signature~disclosure1~disclosure2~',
      issuerSignedJwt: 'header.payload.signature',
      disclosures: ['disclosure1', 'disclosure2'],
    }),
    loadFeatureConfig: vi.fn().mockResolvedValue({ enabled: false }),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue({}),
    D1Adapter: class {
      constructor() {}
    },
    D1StatusListRepository: class {
      constructor() {}
    },
    StatusListManager: class {
      constructor() {}
      allocateIndex = routeCoreMocks.allocateIndex;
    },
    IssuedCredentialRepository: class {
      constructor() {}
      createCredential = routeCoreMocks.createCredential;
      findDeferredByIdAndUser = vi.fn().mockImplementation(async () => mockDeferredCredential);
      updateStatus = vi.fn().mockResolvedValue(undefined);
      parseClaims = vi
        .fn()
        .mockImplementation((cred: { claims: string }): Record<string, unknown> | null => {
          try {
            return JSON.parse(cred.claims) as Record<string, unknown>;
          } catch {
            return null;
          }
        });
      parseHolderBinding = vi.fn().mockReturnValue(null);
    },
  };
});

// Helper to set mock deferred credential for tests
const setMockDeferredCredential = (cred: unknown) => {
  mockDeferredCredential = cred;
};

// Type for token validation result
interface TokenValidationResult {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  error?: string;
  vct?: string;
  claims?: Record<string, unknown>;
  holderBinding?: {
    jwk?: object;
    did?: string;
  };
}

// Mock token validation service
const tokenValidationMocks = vi.hoisted(() => ({
  mockValidateVCIAccessToken: vi.fn(),
  mockValidateProofOfPossession: vi.fn(),
}));
const mockValidateVCIAccessToken = tokenValidationMocks.mockValidateVCIAccessToken as ReturnType<
  typeof vi.fn<() => Promise<TokenValidationResult>>
>;
const mockValidateProofOfPossession =
  tokenValidationMocks.mockValidateProofOfPossession as ReturnType<
    typeof vi.fn<
      (
        env: Env,
        proof: { proof_type: string; jwt?: string },
        expectedNonce: string,
        expectedAudience: string
      ) => Promise<{ valid: boolean; holderPublicKey?: object; error?: string }>
    >
  >;
vi.mock('../../services/token-validation', () => ({
  validateVCIAccessToken: (): Promise<TokenValidationResult> =>
    tokenValidationMocks.mockValidateVCIAccessToken() as Promise<TokenValidationResult>,
  validateProofOfPossession: tokenValidationMocks.mockValidateProofOfPossession,
}));

// Mock crypto utilities
vi.mock('../../../utils/crypto', () => ({
  generateSecureNonce: vi.fn().mockResolvedValue('mock-c-nonce-12345'),
}));

// Helper to create mock context
const createMockContext = (
  overrides: Partial<{
    env: Partial<Env>;
    req: Partial<{
      url: string;
      method: string;
      param: (key: string) => string;
      json: <T>() => Promise<T>;
      header: (key: string) => string | undefined;
    }>;
  }> = {}
): Context<{ Bindings: Env }> => {
  const mockOfferStub = {
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
  };

  const mockKeyManagerStub = {
    fetch: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kid: 'key-1',
          algorithm: 'ES256',
          privatePEM: '-----BEGIN PRIVATE KEY-----\nMIGH...\n-----END PRIVATE KEY-----',
        })
      )
    ),
  };

  const defaultEnv: Env = {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    } as unknown as D1Database,
    AUTHRIM_CONFIG: {} as KVNamespace,
    VP_REQUEST_STORE: {} as DurableObjectNamespace,
    CREDENTIAL_OFFER_STORE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
      get: vi.fn().mockReturnValue(mockOfferStub),
    } as unknown as DurableObjectNamespace,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-km-id' }),
      get: vi.fn().mockReturnValue(mockKeyManagerStub),
    } as unknown as DurableObjectNamespace,
    POLICY_SERVICE: {} as Fetcher,
    VERIFIER_IDENTIFIER: 'did:web:authrim.com',
    HAIP_POLICY_VERSION: 'draft-06',
    VP_REQUEST_EXPIRY_SECONDS: '300',
    NONCE_EXPIRY_SECONDS: '300',
    ISSUER_IDENTIFIER: 'did:web:authrim.com',
    CREDENTIAL_OFFER_EXPIRY_SECONDS: '600',
    C_NONCE_EXPIRY_SECONDS: '300',
    ...overrides.env,
  };

  const url = overrides.req?.url || 'https://authrim.com/vci/test';
  const rawRequest = new Request(url, {
    method: overrides.req?.method || 'GET',
    headers: {
      Host: new URL(url).host,
    },
  });

  return {
    env: defaultEnv,
    req: {
      raw: rawRequest,
      url,
      method: overrides.req?.method || 'GET',
      param: vi.fn().mockReturnValue('test-id'),
      json: vi.fn().mockResolvedValue({}),
      header: vi.fn().mockReturnValue(undefined),
      ...overrides.req,
    },
    json: vi.fn((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    // Mock get method for getLogger
    get: vi.fn().mockReturnValue(undefined),
  } as unknown as Context<{ Bindings: Env }>;
};

describe('Issuer Metadata Route', () => {
  it('should return issuer metadata', async () => {
    const c = createMockContext();
    const response = await issuerMetadataRoute(c);
    const data = (await response.json()) as {
      credential_issuer: string;
      credential_endpoint: string;
      deferred_credential_endpoint: string;
      credential_configurations_supported: Record<string, object>;
    };

    expect(response.status).toBe(200);
    expect(data.credential_issuer).toBe('did:web:authrim.com');
    expect(data.credential_endpoint).toContain('/vci/credential');
    expect(data.deferred_credential_endpoint).toContain('/vci/deferred');
    expect(data.credential_configurations_supported).toBeDefined();
  });

  it('should include supported credential configurations', async () => {
    const c = createMockContext();
    const response = await issuerMetadataRoute(c);
    const data = (await response.json()) as {
      credential_configurations_supported: Record<
        string,
        {
          format: string;
          vct: string;
          claims: object;
        }
      >;
    };

    expect(data.credential_configurations_supported).toHaveProperty('AuthrimIdentityCredential');
    expect(data.credential_configurations_supported).toHaveProperty('AuthrimAgeVerification');

    const identityCred = data.credential_configurations_supported.AuthrimIdentityCredential;
    expect(identityCred.format).toBe('dc+sd-jwt');
    expect(identityCred.vct).toBe('https://authrim.com/credentials/identity/v1');
    expect(identityCred.claims).toHaveProperty('given_name');
    expect(identityCred.claims).toHaveProperty('family_name');
    expect(identityCred.claims).toHaveProperty('email');
    expect(identityCred.claims).toHaveProperty('birthdate');

    const ageCred = data.credential_configurations_supported.AuthrimAgeVerification;
    expect(ageCred.format).toBe('dc+sd-jwt');
    expect(ageCred.vct).toBe('https://authrim.com/credentials/age-verification/v1');
    expect(ageCred.claims).toHaveProperty('age_over_18');
    expect(ageCred.claims).toHaveProperty('age_over_21');
  });

  it('uses the request host as credential issuer even when ISSUER_IDENTIFIER is configured', async () => {
    const c = createMockContext({
      env: { ISSUER_IDENTIFIER: 'did:web:custom-issuer.com' },
      req: { url: 'https://tenant1.example.com/.well-known/openid-credential-issuer' },
    });

    const response = await issuerMetadataRoute(c);
    const data = (await response.json()) as { credential_issuer: string };

    expect(data.credential_issuer).toBe('did:web:tenant1.example.com');
  });
});

describe('Credential Offer Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Region-sharded offer ID format: g{gen}:{region}:{shard}:co_{uuid}
  const VALID_OFFER_ID = 'g1:apac:3:co_550e8400-e29b-41d4-a716-446655440000';
  const NOT_FOUND_OFFER_ID = 'g1:apac:5:co_nonexistent-uuid';

  it('should return credential offer', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      preAuthorizedCode: 'pre-auth-code-123',
      status: 'pending',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_ID),
      },
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as {
      credential_issuer: string;
      credential_configuration_ids: string[];
      grants: object;
    };

    expect(response.status).toBe(200);
    expect(data.credential_issuer).toBe('did:web:authrim.com');
    expect(data.credential_configuration_ids).toContain('AuthrimIdentityCredential');
    expect(data.grants).toBeDefined();
  });

  it('should include pre-authorized code in grants', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      preAuthorizedCode: 'pre-auth-code-456',
      status: 'pending',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_ID),
      },
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as {
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          'pre-authorized_code': string;
        };
      };
    };

    expect(data.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']).toBeDefined();
    expect(
      data.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code']
    ).toBe('pre-auth-code-456');
  });

  it('should include tx_code when PIN is required', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      preAuthorizedCode: 'pre-auth-code-789',
      txCode: '123456',
      status: 'pending',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_ID),
      },
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as {
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          tx_code: {
            input_mode: string;
            length: number;
          };
        };
      };
    };

    const preAuthGrant = data.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
    expect(preAuthGrant.tx_code).toBeDefined();
    expect(preAuthGrant.tx_code.input_mode).toBe('numeric');
    expect(preAuthGrant.tx_code.length).toBe(6);
  });

  it('should return 400 when offer ID is missing', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should return 404 when offer not found', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
        })
      ),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(NOT_FOUND_OFFER_ID),
      },
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    // RFC compliance: not_found is not standard, use invalid_request with 404 status
    expect(data.error).toBe('invalid_request');
  });

  it('should return 400 when offer is expired', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      preAuthorizedCode: 'pre-auth-code-123',
      status: 'pending',
      expiresAt: Date.now() - 100000, // Expired
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_ID),
      },
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
    expect(data.error_description).toContain('invalid');
  });

  it('should return 400 when offer is already claimed', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      preAuthorizedCode: 'pre-auth-code-123',
      status: 'claimed',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_ID),
      },
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
    expect(data.error_description).toContain('invalid');
  });

  it('should return 500 for invalid offer ID format', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('invalid-format-offer-id'),
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(500);
    expect(data.error).toBe('server_error');
    // ErrorFactory returns standardized message for internal errors
    expect(data.error_description).toBeDefined();
  });
});

describe('Credential Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeCoreMocks.allocateIndex.mockResolvedValue({
      listId: 'status-list-1',
      listInternalId: 'status-list-internal-1',
      index: 42,
    });
    routeCoreMocks.createCredential.mockResolvedValue(undefined);
    // Reset mock to default invalid response (no token provided tests should fail auth)
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: false,
      error: 'Invalid access token',
    });
    mockValidateProofOfPossession.mockResolvedValue({ valid: true });
  });

  it('should reject request without access token', async () => {
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    // AR_ERROR_CODES.TOKEN_INVALID uses status 400 and rfcError: invalid_grant
    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_grant');
    // Token errors use masked security level, so detailed message is not exposed
    expect(data.error_description).toBeDefined();
  });

  it('should reject invalid access token', async () => {
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer invalid-token'),
        json: vi.fn().mockResolvedValue({
          format: 'dc+sd-jwt',
          vct: 'https://authrim.com/credentials/identity/v1',
        }),
      },
    });

    // validateAccessToken returns null for invalid tokens
    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    // AR_ERROR_CODES.TOKEN_INVALID uses status 400 and rfcError: invalid_grant
    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_grant');
    // Token errors use masked security level, so detailed message is not exposed
    expect(data.error_description).toBeDefined();
  });

  it('should reject unsupported credential format', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      vct: 'https://authrim.com/credentials/identity/v1',
      claims: {},
    });

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          format: 'jwt_vc', // Unsupported format
        }),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('unsupported_credential_format');
    expect(data.error_description).toBeDefined();
  });

  it('should reject valid token results that are missing required subject claims', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      tenantId: 'tenant-1',
      claims: {},
    });
    const parseBody = vi.fn().mockResolvedValue({
      format: 'dc+sd-jwt',
    });

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: parseBody,
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_grant');
    expect(parseBody).not.toHaveBeenCalled();
  });

  it('should reject proof requests when no c_nonce is stored for the user', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      claims: {},
    });
    const kvGet = vi.fn().mockResolvedValue(null);
    const kvDelete = vi.fn().mockResolvedValue(undefined);

    const c = createMockContext({
      env: {
        AUTHRIM_CONFIG: {
          get: kvGet,
          delete: kvDelete,
        } as unknown as KVNamespace,
      },
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          format: 'dc+sd-jwt',
          proof: {
            proof_type: 'jwt',
            jwt: 'proof.jwt',
          },
        }),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_proof');
    expect(kvGet).toHaveBeenCalledWith('cnonce:user-123');
    expect(mockValidateProofOfPossession).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('should reject invalid proof of possession without consuming the stored c_nonce', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      claims: {},
    });
    mockValidateProofOfPossession.mockResolvedValue({
      valid: false,
      error: 'Invalid nonce',
    });
    const kvGet = vi.fn().mockResolvedValue('stored-c-nonce');
    const kvDelete = vi.fn().mockResolvedValue(undefined);

    const c = createMockContext({
      env: {
        AUTHRIM_CONFIG: {
          get: kvGet,
          delete: kvDelete,
        } as unknown as KVNamespace,
      },
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          format: 'dc+sd-jwt',
          proof: {
            proof_type: 'jwt',
            jwt: 'proof.jwt',
          },
        }),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_proof');
    expect(mockValidateProofOfPossession).toHaveBeenCalledWith(
      c.env,
      { proof_type: 'jwt', jwt: 'proof.jwt' },
      'stored-c-nonce',
      'did:web:authrim.com'
    );
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('should issue a credential, rotate c_nonce, and store issuance metadata', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      vct: 'https://authrim.com/credentials/identity/v1',
      claims: {
        given_name: 'Alice',
        email: 'alice@example.com',
      },
    });
    mockValidateProofOfPossession.mockResolvedValue({
      valid: true,
      holderPublicKey: { kty: 'EC', crv: 'P-256', x: 'holder-x' },
    });
    const kvGet = vi.fn().mockResolvedValue('stored-c-nonce');
    const kvPut = vi.fn().mockResolvedValue(undefined);
    const kvDelete = vi.fn().mockResolvedValue(undefined);

    const c = createMockContext({
      env: {
        AUTHRIM_CONFIG: {
          get: kvGet,
          put: kvPut,
          delete: kvDelete,
        } as unknown as KVNamespace,
      },
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          format: 'dc+sd-jwt',
          proof: {
            proof_type: 'jwt',
            jwt: 'proof.jwt',
          },
        }),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as {
      credential: string;
      c_nonce: string;
      c_nonce_expires_in: number;
    };

    expect(response.status).toBe(200);
    expect(data).toEqual({
      credential: 'header.payload.signature~disclosure1~disclosure2~',
      c_nonce: 'mock-c-nonce-12345',
      c_nonce_expires_in: 300,
    });
    expect(mockValidateProofOfPossession).toHaveBeenCalledWith(
      c.env,
      { proof_type: 'jwt', jwt: 'proof.jwt' },
      'stored-c-nonce',
      'did:web:authrim.com'
    );
    expect(kvDelete).toHaveBeenCalledWith('cnonce:user-123');
    expect(kvPut).toHaveBeenCalledWith('cnonce:user-123', 'mock-c-nonce-12345', {
      expirationTtl: 300,
    });
    expect(routeCoreMocks.allocateIndex).toHaveBeenCalledWith('tenant-1', 'revocation');
    expect(routeCoreMocks.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        user_id: 'user-123',
        credential_type: 'https://authrim.com/credentials/identity/v1',
        format: 'dc+sd-jwt',
        status: 'active',
        status_list_id: 'status-list-1',
        status_list_internal_id: 'status-list-internal-1',
        status_list_index: 42,
        holder_binding: { kty: 'EC', crv: 'P-256', x: 'holder-x' },
      })
    );
  });
});

describe('Deferred Credential Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to default valid response
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      vct: 'https://authrim.com/credentials/identity/v1',
      claims: {},
    });
  });

  it('should reject request without access token', async () => {
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await deferredCredentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    // AR_ERROR_CODES.TOKEN_INVALID uses status 400 and rfcError: invalid_grant
    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_grant');
    // Token errors use masked security level, so detailed message is not exposed
    expect(data.error_description).toBeDefined();
  });

  it('should reject invalid access token', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: false,
      error: 'Token validation failed',
    });

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer invalid-token'),
        json: vi.fn().mockResolvedValue({
          transaction_id: 'tx-123',
        }),
      },
    });

    const response = await deferredCredentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    // AR_ERROR_CODES.TOKEN_INVALID uses status 400 and rfcError: invalid_grant
    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_grant');
    // Token errors use masked security level, so detailed message is not exposed
    expect(data.error_description).toBeDefined();
  });

  it('should reject request without transaction_id', async () => {
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({}),
      },
    });

    const response = await deferredCredentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should return 404 when deferred credential not found', async () => {
    // Set mock to return null (credential not found)
    setMockDeferredCredential(null);

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          transaction_id: 'non-existent-tx',
        }),
      },
    });

    const response = await deferredCredentialRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    // AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND uses status 404
    expect(response.status).toBe(404);
    expect(data.error).toBe('invalid_request');
    expect(data.error_description).toBeDefined();
  });

  it('should return issuance_pending when credential not ready', async () => {
    // Set mock to return a deferred credential with 'pending' claims
    setMockDeferredCredential({
      id: 'tx-123',
      tenant_id: 'tenant-1',
      user_id: 'user-123',
      credential_type: 'https://authrim.com/credentials/identity/v1',
      format: 'dc+sd-jwt',
      claims: 'pending', // Not valid JSON = not ready
      status: 'deferred',
    });

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          transaction_id: 'tx-123',
        }),
      },
    });

    const response = await deferredCredentialRoute(c);
    const data = (await response.json()) as {
      error: string;
      error_description: string;
    };

    // AR_ERROR_CODES.VC_ISSUANCE_PENDING uses status 200 (not an error, just a status)
    // OpenID4VCI spec: issuance_pending indicates the credential is not yet ready
    expect(response.status).toBe(200);
    expect(data.error).toBe('issuance_pending');
    // Note: interval field is optional per OpenID4VCI spec
    expect(data.error_description).toBeDefined();
  });

  it('should issue credential when ready', async () => {
    // Set mock to return a ready deferred credential
    setMockDeferredCredential({
      id: 'tx-123',
      tenant_id: 'tenant-1',
      user_id: 'user-123',
      credential_type: 'https://authrim.com/credentials/identity/v1',
      format: 'dc+sd-jwt',
      claims: JSON.stringify({
        given_name: 'John',
        family_name: 'Doe',
        email: 'john@example.com',
      }),
      status: 'deferred',
    });

    const mockKVPut = vi.fn().mockResolvedValue(undefined);

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          transaction_id: 'tx-123',
        }),
      },
      env: {
        AUTHRIM_CONFIG: {
          put: mockKVPut,
        } as unknown as KVNamespace,
      },
    });

    const response = await deferredCredentialRoute(c);
    const data = (await response.json()) as {
      credential: string;
      c_nonce: string;
      c_nonce_expires_in: number;
    };

    expect(response.status).toBe(200);
    expect(data.credential).toBe('header.payload.signature~disclosure1~disclosure2~');
    expect(data.c_nonce).toBeDefined();
    expect(data.c_nonce_expires_in).toBeDefined();
  });
});
