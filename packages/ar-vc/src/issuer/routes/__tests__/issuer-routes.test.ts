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
import { vciNonceRoute } from '../nonce';
import type { Context } from 'hono';
import { buildPolicyConstrainedRegionShardConfig } from '@authrim/ar-lib-core';
import type { Env } from '../../../types';

const TEST_REGION_CONFIG = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'test-residency',
    residencyPartition: 'default',
    policyGeneration: 1,
    allowedRegions: ['apac'],
    jurisdiction: null,
  },
  totalShards: 1,
  now: 1,
  updatedBy: 'test',
});

function createTestConfigKv(): KVNamespace {
  return {
    get: vi.fn(async (key: string) =>
      key.startsWith('region_shard_config:') ? TEST_REGION_CONFIG : null
    ),
  } as unknown as KVNamespace;
}

// Mock jose
vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue({} as CryptoKey),
}));

// Shared mock data for IssuedCredentialRepository
let mockDeferredCredential: unknown = null;
const routeCoreMocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  allocateIndex: vi.fn(),
  resolveTenantMetadataContext: vi.fn(),
}));

// Mock @authrim/ar-lib-core - keep real implementations for region sharding functions
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createSDJWTVCWithSigner: vi.fn(
      async (
        _claims: Record<string, unknown>,
        issuer: string,
        signer: (payload: Record<string, unknown>) => Promise<string>,
        options: { vct: string }
      ) => {
        const issuerJwt = await signer({
          iss: issuer,
          vct: options.vct,
          iat: Math.floor(Date.now() / 1000),
          _sd_alg: 'sha-256',
        });
        return {
          combined: `${issuerJwt}~disclosure1~disclosure2~`,
          issuerSignedJwt: issuerJwt,
          disclosures: ['disclosure1', 'disclosure2'],
        };
      }
    ),
    loadFeatureConfig: vi.fn().mockResolvedValue({ enabled: false }),
    resolveTenantMetadataContext: routeCoreMocks.resolveTenantMetadataContext,
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
  credentialConfigurationId?: string;
  jti?: string;
  offerId?: string;
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
  mockDecodeVCIProofNonce: vi.fn(),
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
  decodeVCIProofNonce: tokenValidationMocks.mockDecodeVCIProofNonce,
}));

// Mock crypto utilities
vi.mock('../../../utils/crypto', () => ({
  generateSecureNonce: vi.fn().mockResolvedValue('mock-c-nonce-12345'),
  sha256Base64url: vi.fn(async (value: string) => `digest-${value.length}`),
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
    signSDJWTIssuerRpc: vi.fn().mockResolvedValue({ token: 'header.payload.signature' }),
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
    AUTHRIM_CONFIG: createTestConfigKv(),
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
    header: vi.fn(),
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
      nonce_endpoint: string;
      deferred_credential_endpoint: string;
      credential_configurations_supported: Record<string, object>;
    };

    expect(response.status).toBe(200);
    expect(data.credential_issuer).toBe('https://authrim.com');
    expect(data.credential_endpoint).toContain('/vci/credential');
    expect(data.nonce_endpoint).toContain('/vci/nonce');
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

    expect(data.credential_issuer).toBe('https://tenant1.example.com');
  });
});

describe('VCI Nonce Route', () => {
  it('stores only the nonce digest in the routed coordinator', async () => {
    let storedBody: Record<string, unknown> | undefined;
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        storedBody = (await request.json()) as Record<string, unknown>;
        return Response.json({ created: true }, { status: 201 });
      }),
    };
    const c = createMockContext({
      env: {
        AUTHRIM_CONFIG: createTestConfigKv(),
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'nonce-do' }),
          get: vi.fn().mockReturnValue(stub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vciNonceRoute(c);
    const data = (await response.json()) as { c_nonce: string };

    expect(response.status).toBe(200);
    expect(data.c_nonce).toMatch(/^g\d+:[a-z0-9-]+:\d+:cn_.+\.[A-Za-z0-9_-]+$/);
    expect(storedBody?.nonceHash).toBe(`digest-${data.c_nonce.length}`);
    expect(JSON.stringify(storedBody)).not.toContain(data.c_nonce);
  });
});

describe('Credential Offer Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeCoreMocks.resolveTenantMetadataContext.mockImplementation(
      async (env: Env, tenantId: string) => ({
        tenantId,
        coreDb: env.DB,
      })
    );
  });

  // Region-sharded offer ID format: g{gen}:{region}:{shard}:co_{uuid}
  const VALID_OFFER_ID = 'g1:apac:3:co_550e8400-e29b-41d4-a716-446655440000';
  const VALID_OFFER_REFERENCE = `${VALID_OFFER_ID}.offer-secret-abcdefghijklmnopqrstuvwxyz`;
  const NOT_FOUND_OFFER_ID =
    'g1:apac:5:co_nonexistent-uuid.offer-secret-abcdefghijklmnopqrstuvwxyz';

  it('should return credential offer', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      txCodeRequired: false,
      status: 'pending',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_REFERENCE),
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
    expect(data.credential_issuer).toBe('https://authrim.com');
    expect(data.credential_configuration_ids).toContain('AuthrimIdentityCredential');
    expect(data.grants).toBeDefined();
  });

  it('should include pre-authorized code in grants', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      txCodeRequired: false,
      status: 'pending',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_REFERENCE),
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
    ).toBe(VALID_OFFER_REFERENCE);
  });

  it('should include tx_code when PIN is required', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      txCodeRequired: true,
      status: 'pending',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_REFERENCE),
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
      txCodeRequired: false,
      status: 'pending',
      expiresAt: Date.now() - 100000, // Expired
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_REFERENCE),
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

  it('should return 400 when offer is already consumed', async () => {
    const offer = {
      id: VALID_OFFER_ID,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      txCodeRequired: false,
      status: 'consumed',
      expiresAt: Date.now() + 600000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(offer))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_OFFER_REFERENCE),
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

    expect(response.status).toBe(404);
    expect(data.error).toBe('invalid_request');
    // ErrorFactory returns standardized message for internal errors
    expect(data.error_description).toBeDefined();
  });
});

describe('Credential Route', () => {
  const PROOF_NONCE =
    'g1:apac:3:cn_550e8400-e29b-41d4-a716-446655440000.abcdefghijklmnopqrstuvwxyzABCDEF';

  beforeEach(() => {
    vi.clearAllMocks();
    routeCoreMocks.resolveTenantMetadataContext.mockImplementation(
      async (env: Env, tenantId: string) => ({
        tenantId,
        coreDb: env.DB,
      })
    );
    routeCoreMocks.allocateIndex.mockResolvedValue({
      listId: 'status-list-1',
      listInternalId: 'status-list-internal-1',
      index: 42,
    });
    routeCoreMocks.createCredential.mockResolvedValue(undefined);
    tokenValidationMocks.mockDecodeVCIProofNonce.mockReturnValue(PROOF_NONCE);
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

  it('should reject a proof that does not carry a routable nonce', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      credentialConfigurationId: 'AuthrimIdentityCredential',
      jti: 'token-jti',
      offerId: 'g1:apac:3:co_offer-123',
      claims: {},
    });
    tokenValidationMocks.mockDecodeVCIProofNonce.mockReturnValue(null);

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          credential_configuration_id: 'AuthrimIdentityCredential',
          proofs: { jwt: ['proof.jwt'] },
        }),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_nonce');
    expect(mockValidateProofOfPossession).not.toHaveBeenCalled();
  });

  it('should reject an invalid proof before reserving its nonce', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      credentialConfigurationId: 'AuthrimIdentityCredential',
      jti: 'token-jti',
      claims: {},
    });
    mockValidateProofOfPossession.mockResolvedValue({
      valid: false,
      error: 'Invalid nonce',
    });
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          credential_configuration_id: 'AuthrimIdentityCredential',
          proofs: { jwt: ['proof.jwt'] },
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
      PROOF_NONCE,
      'https://authrim.com'
    );
  });

  it('should reserve one proof nonce and issue the final credentials array', async () => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      credentialConfigurationId: 'AuthrimIdentityCredential',
      jti: 'token-jti',
      offerId: 'g1:apac:3:co_offer-123',
    });
    mockValidateProofOfPossession.mockResolvedValue({
      valid: true,
      holderPublicKey: { kty: 'EC', crv: 'P-256', x: 'holder-x' },
    });
    const nonceStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/nonce/reserve') {
          return Response.json({ reserved: true, reservationId: 'nonce-reservation' });
        }
        if (path === '/nonce/complete') return Response.json({ completed: true });
        if (path === '/get') {
          return Response.json({
            userId: 'user-123',
            credentialConfigurationId: 'AuthrimIdentityCredential',
            claims: { given_name: 'Alice', email: 'alice@example.com' },
            status: 'consumed',
            expiresAt: Date.now() + 60_000,
          });
        }
        return Response.json({ released: true });
      }),
    };

    const c = createMockContext({
      env: {
        CREDENTIAL_OFFER_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'nonce-do-id' }),
          get: vi.fn().mockReturnValue(nonceStub),
        } as unknown as DurableObjectNamespace,
      },
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue({
          credential_configuration_id: 'AuthrimIdentityCredential',
          proofs: { jwt: ['proof.jwt'] },
        }),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as {
      credentials: string[];
    };

    expect(response.status).toBe(200);
    expect(data).toEqual({
      credentials: ['header.payload.signature~disclosure1~disclosure2~'],
    });
    expect(mockValidateProofOfPossession).toHaveBeenCalledWith(
      c.env,
      { proof_type: 'jwt', jwt: 'proof.jwt' },
      PROOF_NONCE,
      'https://authrim.com'
    );
    expect(nonceStub.fetch).toHaveBeenCalledTimes(3);
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
    routeCoreMocks.resolveTenantMetadataContext.mockImplementation(
      async (env: Env, tenantId: string) => ({
        tenantId,
        coreDb: env.DB,
      })
    );
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
      credentials: string[];
    };

    expect(response.status).toBe(200);
    expect(data.credentials).toEqual(['header.payload.signature~disclosure1~disclosure2~']);
  });
});
