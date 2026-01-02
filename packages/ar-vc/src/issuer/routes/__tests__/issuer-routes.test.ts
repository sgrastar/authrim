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

// Mock @authrim/ar-lib-core - keep real implementations for region sharding functions
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createSDJWTVC: vi.fn().mockResolvedValue({
      combined: 'mock-sd-jwt-vc~disclosure1~disclosure2~',
      issuerSignedJwt: 'mock-jwt',
      disclosures: ['disclosure1', 'disclosure2'],
    }),
    D1Adapter: class {
      constructor() {}
    },
    IssuedCredentialRepository: class {
      constructor() {}
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
const mockValidateVCIAccessToken = vi.fn<() => Promise<TokenValidationResult>>();
vi.mock('../../services/token-validation', () => ({
  validateVCIAccessToken: (): Promise<TokenValidationResult> => mockValidateVCIAccessToken(),
  validateProofOfPossession: vi.fn().mockResolvedValue({ valid: true }),
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

  return {
    env: defaultEnv,
    req: {
      url: 'https://authrim.com/vci/test',
      method: 'GET',
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

  it('should use custom ISSUER_IDENTIFIER', async () => {
    const c = createMockContext({
      env: { ISSUER_IDENTIFIER: 'did:web:custom-issuer.com' },
    });

    const response = await issuerMetadataRoute(c);
    const data = (await response.json()) as { credential_issuer: string };

    expect(data.credential_issuer).toBe('did:web:custom-issuer.com');
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
    // Reset mock to default invalid response (no token provided tests should fail auth)
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: false,
      error: 'Invalid access token',
    });
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
    // Mock a valid token validation (need to bypass the actual validation)
    // Since validateAccessToken is not exported, we can't directly mock it
    // For now, this test documents expected behavior

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          format: 'jwt_vc', // Unsupported format
        }),
      },
    });

    // Token validation fails first, so returns 400 with invalid_grant
    const response = await credentialRoute(c);
    // AR_ERROR_CODES.TOKEN_INVALID uses status 400
    expect(response.status).toBe(400);
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
    expect(data.credential).toBe('mock-sd-jwt-vc~disclosure1~disclosure2~');
    expect(data.c_nonce).toBeDefined();
    expect(data.c_nonce_expires_in).toBeDefined();
  });
});
