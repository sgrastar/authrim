/**
 * Verifier Routes Tests
 *
 * Tests for OpenID4VP verifier endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifierMetadataRoute } from '../metadata';
import { vpAuthorizeRoute } from '../authorize';
import { vpResponseRoute } from '../response';
import { vpRequestStatusRoute } from '../request-status';
import { vpRequestObjectRoute } from '../request-object';
import { initiateAttributeVerification } from '../attribute-verify';
import type { Context } from 'hono';
import { buildPolicyConstrainedRegionShardConfig } from '@authrim/ar-lib-core';
import type { Env, VPRequestState } from '../../../types';

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
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
}

const verifierCoreMocks = vi.hoisted(() => ({
  findClient: vi.fn(),
  introspectToken: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue({}),
    ClientRepository: class {
      findByClientId = verifierCoreMocks.findClient;
    },
    AttributeVerificationRepository: class {
      createVerification = vi.fn().mockResolvedValue(undefined);
    },
    introspectTokenFromContext: verifierCoreMocks.introspectToken,
  };
});

describe('Attribute elevation authentication boundary', () => {
  it('rejects a decoded-looking but unverified bearer token before profile or DO access', async () => {
    verifierCoreMocks.introspectToken.mockResolvedValueOnce({
      valid: false,
      error: { error: 'invalid_token', error_description: 'Invalid signature' },
    });
    const c = createMockContext({
      req: {
        method: 'POST',
        header: vi.fn((name: string) =>
          name === 'Authorization' ? 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.' : undefined
        ),
        json: vi.fn().mockResolvedValue({ credential_profile_id: 'profile-1' }),
      },
    });
    const response = await initiateAttributeVerification(c);
    expect(response.status).toBe(401);
    expect(verifierCoreMocks.introspectToken).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(c.env.VP_REQUEST_STORE.get).not.toHaveBeenCalled();
  });
});

// Mock vp-verifier service
vi.mock('../../services/vp-verifier', () => ({
  verifyVPToken: vi.fn(),
}));

// Mock crypto utilities
vi.mock('../../../utils/crypto', () => ({
  generateSecureNonce: vi.fn().mockResolvedValue('mock-nonce-12345'),
  sha256Base64url: vi.fn(async (value: string) => `hash:${value}`),
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
      parseBody: () => Promise<Record<string, unknown>>;
    }>;
  }> = {}
): Context<{ Bindings: Env }> => {
  const mockStub = {
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
  };

  const defaultEnv: Env = {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
    AUTHRIM_CONFIG: createTestConfigKv(),
    VP_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
      get: vi.fn().mockReturnValue(mockStub),
    } as unknown as DurableObjectNamespace,
    CREDENTIAL_OFFER_STORE: {} as DurableObjectNamespace,
    KEY_MANAGER: {} as DurableObjectNamespace,
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

  const url = overrides.req?.url || 'https://authrim.com/vp/test';
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
      parseBody: vi.fn().mockResolvedValue({}),
      ...overrides.req,
    },
    json: vi.fn((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    header: vi.fn(),
    // Mock get method for getLogger and tenant context
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)),
  } as unknown as Context<{ Bindings: Env }>;
};

describe('Verifier Metadata Route', () => {
  it('should return verifier metadata', async () => {
    const c = createMockContext();
    const response = await verifierMetadataRoute(c);
    const data = (await response.json()) as {
      verifier_identifier: string;
      vp_formats_supported: object;
      dcql_supported: boolean;
    };

    expect(response.status).toBe(200);
    expect(data.verifier_identifier).toBe('did:web:authrim.com');
    expect(data.vp_formats_supported).toBeDefined();
    expect(data.vp_formats_supported).toHaveProperty('dc+sd-jwt');
    expect(data.vp_formats_supported).toHaveProperty('mso_mdoc');
    expect(data.dcql_supported).toBe(true);
    expect(
      (data as { client_id_schemes_supported?: string[] }).client_id_schemes_supported
    ).toEqual(['pre-registered']);
  });

  it('uses the request host as verifier identifier even when VERIFIER_IDENTIFIER is configured', async () => {
    const c = createMockContext({
      env: { VERIFIER_IDENTIFIER: 'did:web:custom-verifier.com' },
      req: { url: 'https://tenant1.example.com/.well-known/openid-credential-verifier' },
    });

    const response = await verifierMetadataRoute(c);
    const data = (await response.json()) as { verifier_identifier: string };

    expect(data.verifier_identifier).toBe('did:web:tenant1.example.com');
  });
});

describe('VP Request Object Route', () => {
  it('returns the stored wallet request without the status capability', async () => {
    const id = 'g1:apac:3:vp_550e8400-e29b-41d4-a716-446655440000';
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(
        Response.json({
          id,
          tenantId: 'tenant-1',
          clientId: 'client-1',
          nonce: 'nonce-1',
          responseUri: 'https://authrim.com/vp/response',
          responseMode: 'direct_post',
          presentationDefinition: { id: 'pd-1', input_descriptors: [] },
          status: 'pending',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        })
      ),
    };
    const c = createMockContext({
      req: { param: vi.fn().mockReturnValue(id) },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpRequestObjectRoute(c);
    const data = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      client_id: 'client-1',
      client_id_scheme: 'pre-registered',
      nonce: 'nonce-1',
      state: id,
      response_uri: 'https://authrim.com/vp/response',
    });
    expect(data).not.toHaveProperty('status_token');
    expect(data).not.toHaveProperty('verifiedClaims');
  });

  it('does not return terminal or expired requests to wallets', async () => {
    const id = 'g1:apac:3:vp_550e8400-e29b-41d4-a716-446655440000';
    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          Response.json({ id, status: 'verified', expiresAt: Date.now() + 60_000 })
        ),
    };
    const c = createMockContext({
      req: { param: vi.fn().mockReturnValue(id) },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });
    expect((await vpRequestObjectRoute(c)).status).toBe(404);
  });
});

describe('VP Authorize Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifierCoreMocks.findClient.mockResolvedValue({ client_id: 'client-1' });
  });

  it('rejects an unknown pre-registered client before creating state', async () => {
    verifierCoreMocks.findClient.mockResolvedValue(null);
    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          client_id: 'unknown-client',
          client_id_scheme: 'pre-registered',
          presentation_definition: { id: 'pd-1', input_descriptors: [] },
        }),
      },
    });

    const response = await vpAuthorizeRoute(c);
    const data = (await response.json()) as { error: string };
    expect(response.status).toBe(401);
    expect(data.error).toBe('invalid_client');
  });

  it('should create VP authorization request', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    };

    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          tenant_id: 'tenant-1',
          client_id: 'client-1',
          presentation_definition: {
            id: 'pd-1',
            input_descriptors: [],
          },
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpAuthorizeRoute(c);
    const data = (await response.json()) as {
      request_id: string;
      request_uri: string;
      status_token: string;
      nonce: string;
      expires_in: number;
    };

    expect(response.status).toBe(200);
    expect(data.request_id).toBeDefined();
    expect(data.request_uri).toContain('/vp/request/');
    expect(data.status_token).toBe('mock-nonce-12345');
    expect(data.nonce).toBe('mock-nonce-12345');
    expect(data.expires_in).toBe(300);
    expect(mockStub.fetch).toHaveBeenCalled();
    const storedRequest = (await (mockStub.fetch.mock.calls[0][0] as Request).clone().json()) as {
      statusTokenHash?: string;
    };
    expect(storedRequest.statusTokenHash).toBeDefined();
    expect(storedRequest.statusTokenHash).not.toBe(data.status_token);
  });

  it('should accept request without tenant_id and use context tenant', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    };

    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          client_id: 'client-1',
          presentation_definition: {
            id: 'pd-1',
            input_descriptors: [],
          },
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpAuthorizeRoute(c);

    expect(response.status).toBe(200);
    expect(mockStub.fetch).toHaveBeenCalledWith(expect.any(Request));
  });

  it('should reject mismatched tenant_id', async () => {
    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          tenant_id: 'tenant-other',
          client_id: 'client-1',
          presentation_definition: {
            id: 'pd-1',
            input_descriptors: [],
          },
        }),
      },
    });

    const response = await vpAuthorizeRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
  });

  it('should reject request without client_id', async () => {
    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          tenant_id: 'tenant-1',
        }),
      },
    });

    const response = await vpAuthorizeRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should reject request without presentation definition', async () => {
    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          tenant_id: 'tenant-1',
          client_id: 'client-1',
        }),
      },
    });

    const response = await vpAuthorizeRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should accept DCQL query instead of presentation definition', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    };

    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          tenant_id: 'tenant-1',
          client_id: 'client-1',
          dcql_query: {
            credentials: [{ id: 'cred-1', format: 'dc+sd-jwt' }],
          },
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpAuthorizeRoute(c);
    expect(response.status).toBe(200);
  });
});

describe('VP Response Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Region-sharded VP request ID format: g{gen}:{region}:{shard}:vp_{uuid}
  const VALID_REQUEST_ID = 'g1:apac:3:vp_550e8400-e29b-41d4-a716-446655440000';

  it('should verify VP token and return success', async () => {
    const { verifyVPToken } = await import('../../services/vp-verifier');
    (verifyVPToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      verified: true,
      disclosedClaims: { given_name: 'John', family_name: 'Doe' },
      haipCompliant: true,
      issuerDid: 'did:web:issuer.com',
      credentialType: 'IdentityCredential',
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      format: 'dc+sd-jwt',
      errors: [],
      warnings: [],
    });

    const vpRequest: VPRequestState = {
      id: VALID_REQUEST_ID,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      nonce: 'nonce-123',
      responseUri: 'https://authrim.com/vp/response',
      responseMode: 'direct_post',
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ reserved: true, reservationId: 'reservation-1', request: vpRequest })
        )
        .mockResolvedValue(Response.json({ completed: true })),
    };

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('application/json'),
        json: vi.fn().mockResolvedValue({
          vp_token: 'valid-vp-token',
          state: VALID_REQUEST_ID,
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpResponseRoute(c);
    const data = (await response.json()) as {
      success: boolean;
      verified_claim_names: string[];
      haip_compliant: boolean;
    };

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.verified_claim_names).toEqual(['given_name', 'family_name']);
    expect(data).not.toHaveProperty('disclosed_claims');
    expect(data.haip_compliant).toBe(true);
  });

  it('should reject request without vp_token', async () => {
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('application/json'),
        json: vi.fn().mockResolvedValue({
          state: VALID_REQUEST_ID,
        }),
      },
    });

    const response = await vpResponseRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should reject request without state', async () => {
    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('application/json'),
        json: vi.fn().mockResolvedValue({
          vp_token: 'some-token',
        }),
      },
    });

    const response = await vpResponseRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should reject expired request', async () => {
    const _vpRequest: VPRequestState = {
      id: VALID_REQUEST_ID,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      nonce: 'nonce-123',
      responseUri: 'https://authrim.com/vp/response',
      responseMode: 'direct_post',
      status: 'pending',
      createdAt: Date.now() - 400000,
      expiresAt: Date.now() - 100000, // Already expired
    };

    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(Response.json({ reserved: false, reason: 'expired' }))
        .mockResolvedValue(Response.json({ completed: true })),
    };

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('application/json'),
        json: vi.fn().mockResolvedValue({
          vp_token: 'some-token',
          state: VALID_REQUEST_ID,
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpResponseRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
    expect(data.error_description).toContain('invalid');
  });

  it('should handle form-urlencoded content type', async () => {
    const { verifyVPToken } = await import('../../services/vp-verifier');
    (verifyVPToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      verified: true,
      disclosedClaims: { given_name: 'John' },
      haipCompliant: true,
      errors: [],
      warnings: [],
    });

    const vpRequest: VPRequestState = {
      id: VALID_REQUEST_ID,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      nonce: 'nonce-123',
      responseUri: 'https://authrim.com/vp/response',
      responseMode: 'direct_post',
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ reserved: true, reservationId: 'reservation-1', request: vpRequest })
        )
        .mockResolvedValue(Response.json({ completed: true })),
    };

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('application/x-www-form-urlencoded'),
        parseBody: vi.fn().mockResolvedValue({
          vp_token: 'form-vp-token',
          state: VALID_REQUEST_ID,
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpResponseRoute(c);
    expect(response.status).toBe(200);
  });

  it('should return verification errors when verification fails', async () => {
    const { verifyVPToken } = await import('../../services/vp-verifier');
    (verifyVPToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      verified: false,
      haipCompliant: false,
      errors: ['Invalid signature', 'Issuer not trusted'],
      warnings: ['Nearing expiration'],
    });

    const vpRequest: VPRequestState = {
      id: VALID_REQUEST_ID,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      nonce: 'nonce-123',
      responseUri: 'https://authrim.com/vp/response',
      responseMode: 'direct_post',
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ reserved: true, reservationId: 'reservation-1', request: vpRequest })
        )
        .mockResolvedValue(Response.json({ failed: true })),
    };

    const c = createMockContext({
      req: {
        header: vi.fn().mockReturnValue('application/json'),
        json: vi.fn().mockResolvedValue({
          vp_token: 'invalid-vp-token',
          state: VALID_REQUEST_ID,
        }),
      },
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpResponseRoute(c);
    const data = (await response.json()) as {
      error: string;
      error_description: string;
    };

    expect(response.status).toBe(400);
    // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses invalid_request
    // (invalid_presentation is OpenID4VP-specific but not used in current implementation)
    expect(data.error).toBe('invalid_request');
    // Standardized message is returned instead of specific error details
    expect(data.error_description).toContain('invalid');
    // Note: warnings field is not included in standard error response
  });
});

describe('VP Request Status Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Region-sharded VP request ID format: g{gen}:{region}:{shard}:vp_{uuid}
  const VALID_REQUEST_ID = 'g1:apac:3:vp_550e8400-e29b-41d4-a716-446655440000';
  const NOT_FOUND_REQUEST_ID = 'g1:apac:5:vp_nonexistent-uuid';
  const statusRequest = (id: string) => ({
    param: vi.fn().mockReturnValue(id),
    header: vi.fn((name: string) =>
      name === 'Authorization' ? 'Bearer status-capability' : undefined
    ),
  });

  it('should return pending request status', async () => {
    const vpRequest = {
      id: VALID_REQUEST_ID,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(vpRequest))),
    };

    const c = createMockContext({
      req: statusRequest(VALID_REQUEST_ID),
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as {
      request_id: string;
      status: string;
      created_at: string;
      expires_at: string;
    };

    expect(response.status).toBe(200);
    expect(data.request_id).toBe(VALID_REQUEST_ID);
    expect(data.status).toBe('pending');
    expect(data.created_at).toBeDefined();
    expect(data.expires_at).toBeDefined();
  });

  it('should return verified status with claim names but never values', async () => {
    const vpRequest = {
      id: VALID_REQUEST_ID,
      status: 'verified',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
      verifiedClaimNames: ['given_name', 'family_name'],
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(vpRequest))),
    };

    const c = createMockContext({
      req: statusRequest(VALID_REQUEST_ID),
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as {
      request_id: string;
      status: string;
      verified_claim_names: string[];
    };

    expect(response.status).toBe(200);
    expect(data.status).toBe('verified');
    expect(data.verified_claim_names).toEqual(['given_name', 'family_name']);
    expect(data).not.toHaveProperty('verified_claims');
  });

  it('should return failed status with error', async () => {
    const vpRequest = {
      id: VALID_REQUEST_ID,
      status: 'failed',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
      errorCode: 'verification_failed',
      errorDescription: 'Invalid signature',
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(vpRequest))),
    };

    const c = createMockContext({
      req: statusRequest(VALID_REQUEST_ID),
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as {
      request_id: string;
      status: string;
      error: string;
      error_description: string;
    };

    expect(response.status).toBe(200);
    expect(data.status).toBe('failed');
    expect(data.error).toBe('verification_failed');
    expect(data.error_description).toBe('Invalid signature');
  });

  it('should return 404 for non-existent request', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
        })
      ),
    };

    const c = createMockContext({
      req: statusRequest(NOT_FOUND_REQUEST_ID),
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(404);
    // RFC compliance: not_found is not standard, use invalid_request with 404 status
    expect(data.error).toBe('invalid_request');
  });

  it('should detect and return expired status', async () => {
    const vpRequest = {
      id: VALID_REQUEST_ID,
      status: 'pending',
      createdAt: Date.now() - 400000,
      expiresAt: Date.now() - 100000, // Already expired
    };

    const mockStub = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(vpRequest)))
        .mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    };

    const c = createMockContext({
      req: statusRequest(VALID_REQUEST_ID),
      env: {
        VP_REQUEST_STORE: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
          get: vi.fn().mockReturnValue(mockStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as { request_id: string; status: string };

    expect(response.status).toBe(200);
    expect(data.status).toBe('expired');
  });

  it('should return 400 when request ID is missing', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
    expect(data.error_description).toContain('required');
  });

  it('should reject status polling without its bearer capability', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_REQUEST_ID),
        header: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await vpRequestStatusRoute(c);
    expect(response.status).toBe(400);
  });

  it('should return 500 for invalid request ID format', async () => {
    const c = createMockContext({
      req: statusRequest('invalid-format-request-id'),
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(500);
    expect(data.error).toBe('server_error');
    // ErrorFactory returns standardized message for internal errors
    expect(data.error_description).toBeDefined();
  });
});
