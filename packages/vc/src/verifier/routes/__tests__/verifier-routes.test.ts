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
import type { Context } from 'hono';
import type { Env, VPRequestState } from '../../../types';

// Mock vp-verifier service
vi.mock('../../services/vp-verifier', () => ({
  verifyVPToken: vi.fn(),
}));

// Mock crypto utilities
vi.mock('../../../utils/crypto', () => ({
  generateSecureNonce: vi.fn().mockResolvedValue('mock-nonce-12345'),
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
    } as unknown as D1Database,
    AUTHRIM_CONFIG: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
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

  return {
    env: defaultEnv,
    req: {
      url: 'https://authrim.com/vp/test',
      method: 'GET',
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
  });

  it('should use custom VERIFIER_IDENTIFIER', async () => {
    const c = createMockContext({
      env: { VERIFIER_IDENTIFIER: 'did:web:custom-verifier.com' },
    });

    const response = await verifierMetadataRoute(c);
    const data = (await response.json()) as { verifier_identifier: string };

    expect(data.verifier_identifier).toBe('did:web:custom-verifier.com');
  });
});

describe('VP Authorize Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      nonce: string;
      expires_in: number;
    };

    expect(response.status).toBe(200);
    expect(data.request_id).toBeDefined();
    expect(data.request_uri).toContain('/vp/request/');
    expect(data.nonce).toBe('mock-nonce-12345');
    expect(data.expires_in).toBe(300);
    expect(mockStub.fetch).toHaveBeenCalled();
  });

  it('should reject request without tenant_id', async () => {
    const c = createMockContext({
      req: {
        json: vi.fn().mockResolvedValue({
          client_id: 'client-1',
        }),
      },
    });

    const response = await vpAuthorizeRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_request');
    expect(data.error_description).toContain('tenant_id');
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
    expect(data.error_description).toContain('client_id');
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
    expect(data.error_description).toContain('presentation_definition');
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
        .mockResolvedValueOnce(new Response(JSON.stringify(vpRequest))) // /get
        .mockResolvedValue(new Response(JSON.stringify({ success: true }))), // /update
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
      disclosed_claims: object;
      haip_compliant: boolean;
    };

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.disclosed_claims).toEqual({ given_name: 'John', family_name: 'Doe' });
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
    expect(data.error_description).toContain('vp_token');
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
    expect(data.error_description).toContain('state');
  });

  it('should reject expired request', async () => {
    const vpRequest: VPRequestState = {
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
        .mockResolvedValueOnce(new Response(JSON.stringify(vpRequest)))
        .mockResolvedValue(new Response(JSON.stringify({ success: true }))),
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
    expect(data.error_description).toContain('expired');
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
        .mockResolvedValueOnce(new Response(JSON.stringify(vpRequest)))
        .mockResolvedValue(new Response(JSON.stringify({ success: true }))),
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
        .mockResolvedValueOnce(new Response(JSON.stringify(vpRequest)))
        .mockResolvedValue(new Response(JSON.stringify({ success: true }))),
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
      warnings: string[];
    };

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_presentation');
    expect(data.error_description).toContain('Invalid signature');
    expect(data.warnings).toContain('Nearing expiration');
  });
});

describe('VP Request Status Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Region-sharded VP request ID format: g{gen}:{region}:{shard}:vp_{uuid}
  const VALID_REQUEST_ID = 'g1:apac:3:vp_550e8400-e29b-41d4-a716-446655440000';
  const NOT_FOUND_REQUEST_ID = 'g1:apac:5:vp_nonexistent-uuid';

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
      req: {
        param: vi.fn().mockReturnValue(VALID_REQUEST_ID),
      },
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

  it('should return verified status with claims', async () => {
    const vpRequest = {
      id: VALID_REQUEST_ID,
      status: 'verified',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
      verifiedClaims: { given_name: 'John', family_name: 'Doe' },
    };

    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(vpRequest))),
    };

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(VALID_REQUEST_ID),
      },
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
      verified_claims: object;
    };

    expect(response.status).toBe(200);
    expect(data.status).toBe('verified');
    expect(data.verified_claims).toEqual({ given_name: 'John', family_name: 'Doe' });
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
      req: {
        param: vi.fn().mockReturnValue(VALID_REQUEST_ID),
      },
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
      req: {
        param: vi.fn().mockReturnValue(NOT_FOUND_REQUEST_ID),
      },
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
    expect(data.error).toBe('not_found');
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
      req: {
        param: vi.fn().mockReturnValue(VALID_REQUEST_ID),
      },
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
    expect(data.error_description).toContain('Request ID');
  });

  it('should return 500 for invalid request ID format', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('invalid-format-request-id'),
      },
    });

    const response = await vpRequestStatusRoute(c);
    const data = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(500);
    expect(data.error).toBe('server_error');
    expect(data.error_description).toContain('Invalid region-sharded');
  });
});
