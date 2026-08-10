import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env, VPRequestState } from '../../../types';
import {
  attributeVerifyResponse,
  getAttributes,
  initiateAttributeVerification,
} from '../attribute-verify';

const mocks = vi.hoisted(() => ({
  adminQueryOne: vi.fn(),
  coreQueryOne: vi.fn(),
  introspectToken: vi.fn(),
  protectedContext: vi.fn(),
  resolveMapping: vi.fn(),
  executeServerFlow: vi.fn(),
  executeRuntimeMapping: vi.fn(),
  getNewStore: vi.fn(),
  getStoreById: vi.fn(),
  verifyVPToken: vi.fn(),
  linkVerificationToUser: vi.fn(),
  getUserVerifiedAttributes: vi.fn(),
  invalidateStaleForUser: vi.fn(),
  invalidateUntrustedForUser: vi.fn(),
  findVerificationsByUser: vi.fn(),
  invalidateVerification: vi.fn(),
  sha256Base64url: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({ queryOne: mocks.adminQueryOne })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({
      queryOne: mocks.coreQueryOne,
    })),
    resolveRuntimeIdentityMappingBinding: mocks.resolveMapping,
    introspectTokenFromContext: mocks.introspectToken,
    getActiveAccessTokenProtectedResourceContext: mocks.protectedContext,
    executeServerFlow: mocks.executeServerFlow,
    AttributeVerificationRepository: class {
      invalidateStaleForUser = mocks.invalidateStaleForUser;
      invalidateUntrustedForUser = mocks.invalidateUntrustedForUser;
      findByUser = mocks.findVerificationsByUser;
      invalidateVerification = mocks.invalidateVerification;
    },
    UserVerifiedAttributeRepository: class {},
  };
});

vi.mock('@authrim/ar-lib-field-mapping/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-field-mapping/runtime')>();
  return { ...actual, executeRuntimeMapping: mocks.executeRuntimeMapping };
});

vi.mock('../../../utils/vp-request-sharding', () => ({
  getVPRequestStoreForNewRequest: mocks.getNewStore,
  getVPRequestStoreById: mocks.getStoreById,
}));

vi.mock('../../services/vp-verifier', () => ({ verifyVPToken: mocks.verifyVPToken }));
vi.mock('../../services/attribute-mapper', () => ({
  linkVerificationToUser: mocks.linkVerificationToUser,
  getUserVerifiedAttributes: mocks.getUserVerifiedAttributes,
}));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: vi.fn().mockReturnValue('https://vc.example.com'),
  getRequestVerifierIdentifier: vi.fn().mockReturnValue('did:web:vc.example.com'),
}));
vi.mock('../../../utils/crypto', () => ({
  sha256Base64url: mocks.sha256Base64url,
}));

const REQUEST_ID = 'g1:apac:3:vp_550e8400-e29b-41d4-a716-446655440000';

const publishedProfile = {
  profile_id: 'profile-1',
  version_id: 'profile-version-1',
  verification_flow_version_id: 'flow-version-1',
  credential_configuration_id: 'IdentityCredential',
  verification_mapping_set_id: 'mapping-set-1',
  verification_mapping_version_id: 'mapping-version-1',
  verification_mapping_snapshot_hash: 'snapshot-1',
  claim_allowlist_json: JSON.stringify(['age_over_18']),
  maximum_attribute_age_seconds: 3600,
};

const mappingBinding = {
  mappingSnapshotHash: 'snapshot-1',
  destinationNamespace: 'authrim.verified_attribute',
  edges: [
    {
      sourceRef: { side: 'source', namespace: 'vc', path: 'claims.age_over_18' },
    },
  ],
  transforms: [],
  validationRules: [],
  fieldMappingSet: {},
  catalog: {
    entries: [
      {
        namespace: 'authrim.verified_attribute',
        path: 'age_over_18',
        allowedValues: ['true', 'false'],
      },
    ],
  },
};

const validVerificationResult = {
  verified: true,
  disclosedClaims: { claims: { age_over_18: true } },
  haipCompliant: true,
  issuerDid: 'did:web:issuer.example.com',
  credentialType: 'IdentityCredential',
  credentialExpiresAt: Date.now() + 3_600_000,
  statusCheckedAt: Date.now(),
  statusFreshUntil: Date.now() + 300_000,
  errors: [],
  warnings: [],
};

function validTokenResult(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    claims: {
      sub: 'user-1',
      tenant_id: 'tenant-1',
      aud: 'svc://op-vc/attribute-elevation',
      scope: 'openid vc.attribute',
      ...overrides,
    },
  };
}

function pendingRequest(overrides: Partial<VPRequestState> = {}): VPRequestState {
  return {
    id: REQUEST_ID,
    tenantId: 'tenant-1',
    clientId: 'did:web:vc.example.com',
    nonce: 'nonce-1',
    responseUri: 'https://vc.example.com/vp/attribute-response',
    responseMode: 'direct_post',
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    userId: 'user-1',
    credentialProfileId: 'profile-1',
    credentialProfileVersionId: 'profile-version-1',
    verificationFlowVersionId: 'flow-version-1',
    verificationMappingVersionId: 'mapping-version-1',
    verificationMappingSnapshotHash: 'snapshot-1',
    maximumAttributeAgeSeconds: 3600,
    ...overrides,
  };
}

type RequestStub = { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>> };
type FlowTestState = { presentationVerified: boolean; attributeResult?: unknown };
type FlowTestHandler = (input: {
  step: { config?: Record<string, unknown> };
  state: FlowTestState;
}) => unknown;

function createRequestStub(
  handler?: (request: Request) => Promise<Response> | Response
): RequestStub {
  return {
    fetch: vi.fn(async (request: Request) => {
      if (handler) return await handler(request);
      const path = new URL(request.url).pathname;
      if (path === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          request: pendingRequest(),
        });
      }
      if (path === '/complete') return Response.json({ completed: true });
      if (path === '/fail') return Response.json({ failed: true });
      if (path === '/create' || path === '/release') return Response.json({ success: true });
      return new Response(null, { status: 404 });
    }),
  };
}

function useRequestState(requestState: VPRequestState): RequestStub {
  const stub = createRequestStub(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/reserve') {
      return Response.json({
        reserved: true,
        reservationId: 'reservation-1',
        request: requestState,
      });
    }
    if (path === '/complete') return Response.json({ completed: true });
    return Response.json({ released: true });
  });
  mocks.getStoreById.mockReturnValue({ stub });
  return stub;
}

function createContext(
  options: {
    authorization?: string | null;
    contentType?: string;
    json?: unknown;
    form?: Record<string, unknown>;
    env?: Partial<Env>;
  } = {}
): Context<{ Bindings: Env }> {
  const authorization =
    options.authorization === undefined ? 'Bearer access-token' : options.authorization;
  const contentType = options.contentType ?? 'application/json';
  const env = {
    VP_REQUEST_EXPIRY_SECONDS: '300',
    HAIP_POLICY_VERSION: 'draft-06',
    VC_EVIDENCE_HMAC_SECRET: '0123456789abcdef0123456789abcdef',
    VC_ATTRIBUTE_ELEVATION_AUDIENCE: 'svc://op-vc/attribute-elevation',
    ...options.env,
  } as Env;
  return {
    env,
    req: {
      raw: new Request('https://vc.example.com/vp/attributes', { method: 'POST' }),
      header: vi.fn((name: string) => {
        if (name.toLowerCase() === 'authorization') return authorization ?? undefined;
        if (name.toLowerCase() === 'content-type') return contentType;
        return undefined;
      }),
      json: vi.fn().mockResolvedValue(options.json ?? {}),
      parseBody: vi.fn().mockResolvedValue(options.form ?? {}),
    },
    json: vi.fn((data: unknown, status?: number) => Response.json(data, { status: status ?? 200 })),
    header: vi.fn(),
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)),
  } as unknown as Context<{ Bindings: Env }>;
}

async function paths(stub: RequestStub): Promise<string[]> {
  return stub.fetch.mock.calls.map(([request]) => new URL(request.url).pathname);
}

describe('attribute verification initiation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.protectedContext.mockReturnValue(null);
    mocks.introspectToken.mockResolvedValue(validTokenResult());
    mocks.adminQueryOne.mockResolvedValue(publishedProfile);
    mocks.coreQueryOne.mockImplementation(async (sql: string) =>
      sql.includes('credential_configurations')
        ? { vct: 'IdentityCredential', is_active: 1 }
        : { runtime_snapshot_json: '{}' }
    );
    mocks.resolveMapping.mockResolvedValue(mappingBinding);
    const stub = createRequestStub();
    mocks.getNewStore.mockResolvedValue({ stub, requestId: REQUEST_ID });
  });

  it('requires a bearer token', async () => {
    const response = await initiateAttributeVerification(createContext({ authorization: null }));
    expect(response.status).toBe(401);
    expect(mocks.introspectToken).not.toHaveBeenCalled();
  });

  it('rejects a token with invalid signature, tenant, audience, or scope', async () => {
    for (const result of [
      { valid: false },
      validTokenResult({ tenant_id: 'tenant-other' }),
      validTokenResult({ aud: 'svc://other' }),
      validTokenResult({ scope: 'openid' }),
    ]) {
      mocks.introspectToken.mockResolvedValueOnce(result);
      const response = await initiateAttributeVerification(
        createContext({ json: { credential_profile_id: 'profile-1' } })
      );
      expect(response.status).toBe(401);
    }
  });

  it('requires an explicitly selected credential profile', async () => {
    const response = await initiateAttributeVerification(createContext());
    expect(response.status).toBe(400);
    expect(mocks.adminQueryOne).not.toHaveBeenCalled();
  });

  it('rejects unpublished profiles', async () => {
    mocks.adminQueryOne.mockResolvedValue(null);
    const response = await initiateAttributeVerification(
      createContext({ json: { credential_profile_id: 'profile-1' } })
    );
    expect(response.status).toBe(400);
  });

  it.each([[null], [{ vct: 'IdentityCredential', is_active: 0 }]])(
    'rejects a missing or inactive credential configuration %#',
    async (configuration) => {
      mocks.coreQueryOne.mockResolvedValue(configuration);
      const response = await initiateAttributeVerification(
        createContext({ json: { credential_profile_id: 'profile-1' } })
      );
      expect(response.status).toBe(409);
    }
  );

  it.each([[null], [{ ...mappingBinding, mappingSnapshotHash: 'changed' }]])(
    'rejects an unavailable or changed mapping snapshot %#',
    async (mapping) => {
      mocks.resolveMapping.mockResolvedValue(mapping);
      const response = await initiateAttributeVerification(
        createContext({ json: { credential_profile_id: 'profile-1' } })
      );
      expect(response.status).toBe(409);
    }
  );

  it('returns a server error without an authorization request when persistence fails', async () => {
    const stub = createRequestStub(async () => new Response(null, { status: 503 }));
    mocks.getNewStore.mockResolvedValue({ stub, requestId: REQUEST_ID });
    const response = await initiateAttributeVerification(
      createContext({ json: { credential_profile_id: 'profile-1' } })
    );
    expect(response.status).toBe(500);
  });

  it('creates a profile-bound request with only allowlisted disclosure fields', async () => {
    const stub = createRequestStub();
    mocks.getNewStore.mockResolvedValue({ stub, requestId: REQUEST_ID });
    const response = await initiateAttributeVerification(
      createContext({ json: { credential_profile_id: 'profile-1' } })
    );
    const data = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ request_id: REQUEST_ID, state: REQUEST_ID, expires_in: 300 });
    expect(String(data.authorization_request)).toContain('openid4vp://?');
    const stored = (await stub.fetch.mock.calls[0]?.[0].clone().json()) as VPRequestState;
    expect(stored).toMatchObject({
      userId: 'user-1',
      credentialProfileId: 'profile-1',
      credentialProfileVersionId: 'profile-version-1',
      verificationFlowVersionId: 'flow-version-1',
      verificationMappingVersionId: 'mapping-version-1',
    });
    expect(JSON.stringify(stored.presentationDefinition)).toContain('$.age_over_18');
  });

  it('masks malformed persisted profile data as a server error', async () => {
    mocks.adminQueryOne.mockResolvedValue({ ...publishedProfile, claim_allowlist_json: '{' });
    const response = await initiateAttributeVerification(
      createContext({ json: { credential_profile_id: 'profile-1' } })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
  });
});

describe('attribute verification response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.protectedContext.mockReturnValue(null);
    mocks.introspectToken.mockResolvedValue(validTokenResult());
    mocks.verifyVPToken.mockResolvedValue(validVerificationResult);
    mocks.resolveMapping.mockResolvedValue(mappingBinding);
    mocks.executeRuntimeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: {
            side: 'destination',
            namespace: 'authrim.verified_attribute',
            path: 'age_over_18',
          },
          value: true,
        },
      ],
    });
    mocks.coreQueryOne.mockResolvedValue({ runtime_snapshot_json: '{}' });
    mocks.linkVerificationToUser.mockResolvedValue({
      success: true,
      verificationId: 'verification-1',
      attributes: [{ name: 'age_over_18', value: 'true' }],
    });
    mocks.executeServerFlow.mockImplementation(
      async (input: {
        handlers: {
          credential_presentation: FlowTestHandler;
          verified_attribute: FlowTestHandler;
        };
        state: FlowTestState;
      }) => {
        const { handlers, state } = input;
        await handlers.credential_presentation({
          step: { config: { credential_profile_ref: 'profile-1' } },
          state,
        });
        await handlers.verified_attribute({
          step: { config: { credential_profile_ref: { id: 'profile-1' } } },
          state,
        });
      }
    );
    const stub = createRequestStub();
    mocks.getStoreById.mockReturnValue({ stub });
    mocks.sha256Base64url.mockResolvedValue('vp-fingerprint');
  });

  it('rejects an inactive token before reading presentation state', async () => {
    mocks.introspectToken.mockResolvedValue({ valid: false });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(401);
    expect(mocks.getStoreById).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: REQUEST_ID }, 'vp_token'],
    [{ vp_token: 'vp' }, 'state'],
  ])('requires %s before reserving state', async (json, _field) => {
    const response = await attributeVerifyResponse(createContext({ json }));
    expect(response.status).toBe(400);
    expect(mocks.getStoreById).not.toHaveBeenCalled();
  });

  it('parses form responses and rejects malformed presentation metadata safely', async () => {
    const response = await attributeVerifyResponse(
      createContext({
        contentType: 'application/x-www-form-urlencoded',
        form: { vp_token: 'vp', state: REQUEST_ID, presentation_submission: '{' },
      })
    );
    expect(response.status).toBe(500);
    expect(mocks.getStoreById).not.toHaveBeenCalled();
  });

  it.each([
    [new Response(null, { status: 409 })],
    [Response.json({ reserved: false })],
    [Response.json({ reserved: true, reservationId: 'reservation-1' })],
  ])('rejects replayed, expired, or incomplete state reservations %#', async (reserveResponse) => {
    const stub = createRequestStub(async () => reserveResponse);
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(400);
  });

  it('rejects login-oriented VP state and releases its reservation', async () => {
    const stub = createRequestStub(async (request) => {
      if (new URL(request.url).pathname === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          request: pendingRequest({ userId: undefined }),
        });
      }
      return Response.json({ released: true });
    });
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(400);
    expect(await paths(stub)).toEqual(['/reserve', '/release']);
  });

  it.each([[{ userId: 'other-user' }], [{ tenantId: 'tenant-other' }]])(
    'prevents cross-subject or cross-tenant attribute writes %#',
    async (overrides) => {
      const stub = createRequestStub(async (request) => {
        if (new URL(request.url).pathname === '/reserve') {
          return Response.json({
            reserved: true,
            reservationId: 'reservation-1',
            request: pendingRequest(overrides),
          });
        }
        return Response.json({ released: true });
      });
      mocks.getStoreById.mockReturnValue({ stub });
      const response = await attributeVerifyResponse(
        createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
      );
      expect(response.status).toBe(403);
      expect(await paths(stub)).toEqual(['/reserve', '/release']);
    }
  );

  it('records a terminal verification failure without persisting attributes', async () => {
    mocks.verifyVPToken.mockResolvedValue({
      verified: false,
      errors: ['holder binding failed'],
      warnings: ['status endpoint slow'],
    });
    const stub = createRequestStub();
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_presentation' });
    expect(await paths(stub)).toEqual(['/reserve', '/fail']);
    expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
  });

  it('releases state if the failure transition cannot be committed', async () => {
    mocks.verifyVPToken.mockResolvedValue({ verified: false, errors: ['invalid'], warnings: [] });
    const stub = createRequestStub(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          request: pendingRequest(),
        });
      }
      if (path === '/fail') return new Response(null, { status: 503 });
      return Response.json({ released: true });
    });
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(await paths(stub)).toEqual(['/reserve', '/fail', '/release']);
  });

  it('rechecks authorization immediately before persistence', async () => {
    mocks.introspectToken
      .mockResolvedValueOnce(validTokenResult())
      .mockResolvedValueOnce({ valid: false });
    const stub = createRequestStub();
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
    expect(await paths(stub)).toEqual(['/reserve', '/release']);
  });

  it.each([
    [pendingRequest({ verificationFlowVersionId: undefined })],
    [pendingRequest({ credentialProfileId: undefined })],
  ])('rejects state that is not bound to a published flow/profile %#', async (requestState) => {
    const stub = createRequestStub(async (request) => {
      if (new URL(request.url).pathname === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          request: requestState,
        });
      }
      return Response.json({ released: true });
    });
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(await paths(stub)).toContain('/release');
  });

  it('rejects a deleted verification flow version', async () => {
    mocks.coreQueryOne.mockResolvedValue(null);
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
  });

  it.each([
    [pendingRequest({ credentialProfileVersionId: undefined })],
    [pendingRequest({ verificationMappingVersionId: undefined })],
    [pendingRequest({ verificationMappingSnapshotHash: undefined })],
    [pendingRequest({ maximumAttributeAgeSeconds: undefined })],
  ])(
    'rejects incomplete profile evidence before mapping or persistence %#',
    async (requestState) => {
      const stub = useRequestState(requestState);
      const response = await attributeVerifyResponse(
        createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
      );
      expect(response.status).toBe(500);
      expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
      expect(await paths(stub)).toContain('/release');
    }
  );

  it.each([[null], [{ ...mappingBinding, mappingSnapshotHash: 'changed' }]])(
    'rejects a deleted or replaced mapping snapshot during verification %#',
    async (mapping) => {
      mocks.resolveMapping.mockResolvedValue(mapping);
      const stub = useRequestState(pendingRequest());
      const response = await attributeVerifyResponse(
        createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
      );
      expect(response.status).toBe(500);
      expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
      expect(await paths(stub)).toContain('/release');
    }
  );

  it('rejects a mapping execution failure without committing raw claims', async () => {
    mocks.executeRuntimeMapping.mockReturnValue({ status: 'failed', values: [] });
    const stub = useRequestState(pendingRequest());
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
    expect(await paths(stub)).toContain('/release');
  });

  it('rejects mapping output outside the verified-attribute catalog', async () => {
    mocks.executeRuntimeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'source', namespace: 'vc', path: 'age_over_18' },
          value: true,
        },
        {
          sourceRef: { side: 'destination', namespace: 'other', path: 'age_over_18' },
          value: true,
        },
        {
          sourceRef: {
            side: 'destination',
            namespace: 'authrim.verified_attribute',
            path: 'age_over_18',
          },
          value: 'not-an-allowed-value',
        },
      ],
    });
    const stub = useRequestState(pendingRequest());
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
    expect(await paths(stub)).toContain('/release');
  });

  it('requires a deployment-managed evidence signing secret', async () => {
    const stub = useRequestState(pendingRequest());
    const response = await attributeVerifyResponse(
      createContext({
        json: { vp_token: 'vp', state: REQUEST_ID },
        env: { VC_EVIDENCE_HMAC_SECRET: '' },
      })
    );
    expect(response.status).toBe(500);
    expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
    expect(await paths(stub)).toContain('/release');
  });

  it('rejects evidence whose credential or status freshness has already expired', async () => {
    mocks.verifyVPToken.mockResolvedValue({
      ...validVerificationResult,
      credentialExpiresAt: Date.now() - 1,
      statusFreshUntil: Date.now() - 1,
    });
    const stub = useRequestState(pendingRequest());
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(mocks.linkVerificationToUser).not.toHaveBeenCalled();
    expect(await paths(stub)).toContain('/release');
  });

  it('accepts a catalog-enumerated string from a direct disclosed claim', async () => {
    mocks.resolveMapping.mockResolvedValue({
      ...mappingBinding,
      edges: [{ sourceRef: { side: 'source', namespace: 'vc', path: 'age_band' } }],
      catalog: {
        entries: [
          {
            namespace: 'authrim.verified_attribute',
            path: 'age_band',
            allowedValues: ['adult'],
          },
        ],
      },
    });
    mocks.verifyVPToken.mockResolvedValue({
      ...validVerificationResult,
      disclosedClaims: { age_band: 'adult' },
    });
    mocks.executeRuntimeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: {
            side: 'destination',
            namespace: 'authrim.verified_attribute',
            path: 'age_band',
          },
          value: 'adult',
        },
      ],
    });
    mocks.linkVerificationToUser.mockResolvedValue({
      success: true,
      attributes: [{ name: 'age_band', value: 'adult' }],
    });
    useRequestState(pendingRequest());
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(200);
    expect(mocks.linkVerificationToUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'user-1',
      expect.objectContaining({
        attributes: [{ name: 'age_band', value: 'adult', originalClaim: 'age_band' }],
      })
    );
  });

  it('persists only mapped attributes and commits the state transition', async () => {
    const stub = createRequestStub();
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      request_id: REQUEST_ID,
      attributes_verified: ['age_over_18'],
      haip_compliant: true,
    });
    expect(mocks.linkVerificationToUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ verified: true }),
      'user-1',
      expect.objectContaining({
        attributes: [{ name: 'age_over_18', value: 'true', originalClaim: 'age_over_18' }],
        mappingSnapshotHash: 'snapshot-1',
      })
    );
    expect(await paths(stub)).toEqual(['/reserve', '/complete']);
  });

  it('releases state if completion loses the reservation race', async () => {
    const stub = createRequestStub(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/reserve') {
        return Response.json({
          reserved: true,
          reservationId: 'reservation-1',
          request: pendingRequest(),
        });
      }
      if (path === '/complete') return Response.json({ completed: false });
      return Response.json({ released: true });
    });
    mocks.getStoreById.mockReturnValue({ stub });
    const response = await attributeVerifyResponse(
      createContext({ json: { vp_token: 'vp', state: REQUEST_ID } })
    );
    expect(response.status).toBe(500);
    expect(await paths(stub)).toEqual(['/reserve', '/complete', '/release']);
  });
});

describe('verified attribute reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.protectedContext.mockReturnValue(null);
    mocks.introspectToken.mockResolvedValue(validTokenResult());
    mocks.findVerificationsByUser.mockResolvedValue({ items: [] });
    mocks.getUserVerifiedAttributes.mockResolvedValue([]);
    mocks.resolveMapping.mockResolvedValue(mappingBinding);
  });

  it('requires a bearer token', async () => {
    const response = await getAttributes(createContext({ authorization: null }));
    expect(response.status).toBe(401);
  });

  it('rejects an invalid token before querying user evidence', async () => {
    mocks.introspectToken.mockResolvedValue({ valid: false });
    const response = await getAttributes(createContext());
    expect(response.status).toBe(401);
    expect(mocks.invalidateStaleForUser).not.toHaveBeenCalled();
  });

  it('invalidates stale, untrusted, and mapping-changed evidence before returning attributes', async () => {
    mocks.findVerificationsByUser.mockResolvedValue({
      items: [
        { id: 'already-invalid', invalidated_at: Date.now() },
        { id: 'legacy', invalidated_at: null, credential_profile_id: null },
        {
          id: 'changed',
          invalidated_at: null,
          credential_profile_id: 'profile-1',
          mapping_version_id: 'mapping-version-1',
          mapping_snapshot_hash: 'old-snapshot',
        },
        {
          id: 'current',
          invalidated_at: null,
          credential_profile_id: 'profile-1',
          mapping_version_id: 'mapping-version-1',
          mapping_snapshot_hash: 'snapshot-1',
        },
      ],
    });
    mocks.getUserVerifiedAttributes.mockResolvedValue([
      { name: 'age_over_18', value: 'true', expiresAt: Date.now() + 60_000 },
    ]);

    const response = await getAttributes(createContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user_id: 'user-1' });
    expect(mocks.invalidateStaleForUser).toHaveBeenCalledWith(
      'tenant-1',
      'user-1',
      expect.any(Number)
    );
    expect(mocks.invalidateUntrustedForUser).toHaveBeenCalled();
    expect(mocks.invalidateVerification).toHaveBeenCalledWith(
      'tenant-1',
      'changed',
      'mapping_policy_changed'
    );
    expect(mocks.invalidateVerification).toHaveBeenCalledTimes(1);
  });

  it('fails closed when evidence storage is unavailable', async () => {
    mocks.findVerificationsByUser.mockRejectedValue(new Error('database unavailable'));
    const response = await getAttributes(createContext());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
  });
});
