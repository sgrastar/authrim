/**
 * Issuer Routes Tests
 *
 * Tests for OpenID4VCI issuer endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { issuerMetadataRoute, vciAuthorizationServerMetadataRoute } from '../metadata';
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
  updateStatusIfCurrent: vi.fn(),
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
      updateStatusIfCurrent = routeCoreMocks.updateStatusIfCurrent;
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

  it('should publish Final credential configurations with scopes and array-form claims', async () => {
    const c = createMockContext();
    const response = await issuerMetadataRoute(c);
    const data = (await response.json()) as {
      authorization_servers: string[];
      credential_configurations_supported: Record<
        string,
        {
          format: string;
          scope: string;
          vct: string;
          cryptographic_binding_methods_supported: string[];
          credential_signing_alg_values_supported: string[];
          proof_types_supported: { jwt: { proof_signing_alg_values_supported: string[] } };
          credential_metadata: {
            display: Array<{ name: string; locale: string }>;
            claims: Array<{ path: string[]; mandatory?: boolean }>;
          };
          claims?: unknown;
          display?: unknown;
        }
      >;
    };

    expect(data.authorization_servers).toEqual(['https://authrim.com/vci']);
    expect(Object.keys(data.credential_configurations_supported).sort()).toEqual([
      'AuthrimAdminCredential',
      'AuthrimAgeVerification',
      'AuthrimIdentityCredential',
    ]);

    for (const configuration of Object.values(data.credential_configurations_supported)) {
      expect(configuration.format).toBe('dc+sd-jwt');
      expect(configuration.scope).toMatch(/^authrim_/);
      expect(configuration.cryptographic_binding_methods_supported).toEqual(['jwk']);
      expect(configuration.credential_signing_alg_values_supported).toEqual(['ES256']);
      expect(configuration.proof_types_supported).toEqual({
        jwt: { proof_signing_alg_values_supported: ['ES256'] },
      });
      // Final moved display and claims under credential_metadata
      expect(configuration.claims).toBeUndefined();
      expect(configuration.display).toBeUndefined();
      expect(configuration.credential_metadata.display.length).toBeGreaterThan(0);
    }

    const identityCred = data.credential_configurations_supported.AuthrimIdentityCredential;
    expect(identityCred.vct).toBe('https://authrim.com/credentials/identity/v1');
    expect(identityCred.credential_metadata.claims.map((claim) => claim.path)).toEqual([
      ['given_name'],
      ['family_name'],
      ['email'],
      ['birthdate'],
    ]);

    const ageCred = data.credential_configurations_supported.AuthrimAgeVerification;
    expect(ageCred.vct).toBe('https://authrim.com/credentials/age-verification/v1');
    expect(ageCred.credential_metadata.claims).toContainEqual(
      expect.objectContaining({ path: ['age_over_18'], mandatory: true })
    );

    const adminCred = data.credential_configurations_supported.AuthrimAdminCredential;
    expect(adminCred.vct).toBe('https://authrim.com/credentials/admin/v1');
    expect(adminCred.scope).toBe('authrim_admin_credential');
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

describe('VCI Authorization Server Metadata Route', () => {
  it('describes a pre-authorized-only AS at <issuer>/vci', async () => {
    const c = createMockContext({
      req: { url: 'https://tenant1.example.com/.well-known/oauth-authorization-server/vci' },
    });
    const response = await vciAuthorizationServerMetadataRoute(c);

    expect(await response.json()).toEqual({
      issuer: 'https://tenant1.example.com/vci',
      token_endpoint: 'https://tenant1.example.com/vci/token',
      grant_types_supported: ['urn:ietf:params:oauth:grant-type:pre-authorized_code'],
      token_endpoint_auth_methods_supported: ['none'],
      'pre-authorized_grant_anonymous_access_supported': true,
    });
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

  it('should return 404 when offer ID is missing', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe('not_found');
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
    expect(data.error).toBe('not_found');
  });

  it('should return 404 when offer is expired', async () => {
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

    // Expired and consumed offers are indistinguishable from unknown ones
    expect(response.status).toBe(404);
    expect(data.error).toBe('not_found');
  });

  it('should return 404 when offer is already consumed', async () => {
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

    // Expired and consumed offers are indistinguishable from unknown ones
    expect(response.status).toBe(404);
    expect(data.error).toBe('not_found');
  });

  it('should return 404 for invalid offer ID format', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('invalid-format-offer-id'),
      },
    });

    const response = await credentialOfferRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(404);
    expect(data.error).toBe('not_found');
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
    routeCoreMocks.createCredential.mockResolvedValue({ id: 'credential-1' });
    routeCoreMocks.updateStatusIfCurrent.mockResolvedValue(true);
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
    const data = (await response.json()) as { error: string };

    // RFC 6750 §3: invalid_token with a Bearer challenge
    expect(response.status).toBe(401);
    expect(data.error).toBe('invalid_token');
    expect(c.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="invalid_token"');
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

    // RFC 6750 §3: invalid_token with a Bearer challenge
    expect(response.status).toBe(401);
    expect(data.error).toBe('invalid_token');
    expect(c.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="invalid_token"');
  });

  it.each([
    [
      'an unknown credential configuration',
      { credential_configuration_id: 'jwt_vc', proofs: { jwt: ['proof.jwt'] } },
      'unknown_credential_configuration',
    ],
    [
      'a credential_identifier (none are issued)',
      { credential_identifier: 'credential-1', proofs: { jwt: ['proof.jwt'] } },
      'invalid_credential_request',
    ],
    [
      'a missing credential_configuration_id',
      { proofs: { jwt: ['proof.jwt'] } },
      'invalid_credential_request',
    ],
    [
      'a configuration the access token does not authorize',
      { credential_configuration_id: 'AuthrimAgeVerification', proofs: { jwt: ['proof.jwt'] } },
      'invalid_credential_request',
    ],
    [
      'the pre-Final single proof parameter',
      {
        credential_configuration_id: 'AuthrimIdentityCredential',
        proof: { proof_type: 'jwt', jwt: 'proof.jwt' },
        proofs: { jwt: ['proof.jwt'] },
      },
      'invalid_credential_request',
    ],
    [
      'more than one proof',
      {
        credential_configuration_id: 'AuthrimIdentityCredential',
        proofs: { jwt: ['proof-1.jwt', 'proof-2.jwt'] },
      },
      'invalid_proof',
    ],
  ])('should reject %s', async (_label, body, expectedError) => {
    mockValidateVCIAccessToken.mockResolvedValue({
      valid: true,
      userId: 'user-123',
      tenantId: 'tenant-1',
      credentialConfigurationId: 'AuthrimIdentityCredential',
      jti: 'token-jti',
    });

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('Bearer valid-token'),
        json: vi.fn().mockResolvedValue(body),
      },
    });

    const response = await credentialRoute(c);
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe(expectedError);
    expect(mockValidateProofOfPossession).not.toHaveBeenCalled();
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

    expect(response.status).toBe(401);
    expect(data.error).toBe('invalid_token');
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
      holderPublicKey: { kty: 'EC', crv: 'P-256', x: 'holder-x', y: 'holder-y' },
    });
    const nonceStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/nonce/reserve') {
          return Response.json({ reserved: true, reservationId: 'nonce-reservation' });
        }
        if (path === '/nonce/complete') return Response.json({ completed: true });
        if (path === '/issuance/claim') return Response.json({ claimed: true });
        if (path === '/issuance/complete') return Response.json({ completed: true });
        if (path === '/get') {
          return Response.json({
            userId: 'user-123',
            credentialConfigurationId: 'AuthrimIdentityCredential',
            claims: { given_name: 'Alice', email: 'alice@example.com' },
            subjectKind: 'end_user',
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
      credentials: Array<{ credential: string }>;
    };

    expect(response.status).toBe(200);
    expect(data).toEqual({
      credentials: [{ credential: 'header.payload.signature~disclosure1~disclosure2~' }],
    });
    const keyManager = (
      c.env.KEY_MANAGER as unknown as {
        get: () => { signSDJWTIssuerRpc: ReturnType<typeof vi.fn> };
      }
    ).get();
    // The credential iss is the https Credential Issuer, not a did:web fallback
    expect(keyManager.signSDJWTIssuerRpc).toHaveBeenCalledWith(
      expect.objectContaining({ iss: 'https://authrim.com' })
    );
    expect(mockValidateProofOfPossession).toHaveBeenCalledWith(
      c.env,
      { proof_type: 'jwt', jwt: 'proof.jwt' },
      PROOF_NONCE,
      'https://authrim.com'
    );
    // nonce reserve + offer read + issuance claim + nonce complete + issuance complete
    expect(nonceStub.fetch).toHaveBeenCalledTimes(5);
    expect(routeCoreMocks.allocateIndex).toHaveBeenCalledWith('tenant-1', 'revocation');
    expect(routeCoreMocks.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        user_id: 'user-123',
        credential_type: 'https://authrim.com/credentials/identity/v1',
        format: 'dc+sd-jwt',
        status: 'pending',
        status_list_id: 'status-list-1',
        status_list_internal_id: 'status-list-internal-1',
        status_list_index: 42,
        holder_binding: { kty: 'EC', crv: 'P-256', x: 'holder-x', y: 'holder-y' },
      })
    );
    expect(routeCoreMocks.updateStatusIfCurrent).toHaveBeenCalledWith(
      'tenant-1',
      'credential-1',
      'pending',
      'active'
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

    // RFC 6750 §3: invalid_token with a Bearer challenge
    expect(response.status).toBe(401);
    expect(data.error).toBe('invalid_token');
    expect(c.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="invalid_token"');
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

    // RFC 6750 §3: invalid_token with a Bearer challenge
    expect(response.status).toBe(401);
    expect(data.error).toBe('invalid_token');
    expect(c.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="invalid_token"');
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
    expect(data.error).toBe('invalid_credential_request');
  });

  it('should return invalid_transaction_id when deferred credential not found', async () => {
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

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_transaction_id');
  });

  it('should return 202 with the transaction_id when credential not ready', async () => {
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
    const data = (await response.json()) as { transaction_id: string; interval: number };

    // Final §9.2: a pending deferred credential is a 202 repeating the transaction_id
    expect(response.status).toBe(202);
    expect(data).toEqual({ transaction_id: 'tx-123', interval: 5 });
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
      credentials: Array<{ credential: string }>;
    };

    expect(response.status).toBe(200);
    expect(data.credentials).toEqual([
      { credential: 'header.payload.signature~disclosure1~disclosure2~' },
    ]);
  });
});
