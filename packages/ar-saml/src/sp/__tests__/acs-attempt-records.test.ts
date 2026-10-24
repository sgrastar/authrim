/**
 * A failed SAML sign-in is recorded against the Flow interaction its start checked.
 *
 * The start keeps the interaction in the stored request's context; the ACS reads it back when the
 * response consumes that request, and schedules the failure record at each refusal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPolicyConstrainedRegionShardConfig, type Env } from '@authrim/ar-lib-core';

type SamlTestEnv = Partial<Env> & {
  TDB_TEST_CORE?: D1Database;
  TDB_TEST_PII?: D1Database;
  SAML_STRICT_INRESPONSETO?: string;
};

const { mockSchedule, mockUsageKey, mockUsagePolicy, mockAccountLookup } = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
  mockUsageKey: vi.fn(),
  mockUsagePolicy: vi.fn(),
  mockAccountLookup: vi.fn(),
}));

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

const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../../admin/providers', () => ({
  getIdPUsageKeyByEntityId: (...args: unknown[]): unknown => mockUsageKey(...args),
  getIdPConfigByEntityId: async (...args: unknown[]): Promise<unknown> => {
    const config: unknown = await mockGetIdPConfigByEntityId(...args);
    return config
      ? { ...(config as Record<string, unknown>), identityMapping: { fieldMappingSetId: 'set-1' } }
      : config;
  },
}));

vi.mock('../../common/signature', () => ({
  verifyXmlSignature: vi.fn().mockReturnValue(true),
  verifyXmlSignatureAndGetReferences: vi.fn((xml: string) => [
    { uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml },
  ]),
  hasSignature: vi.fn((xml: string) => xml.includes('<ds:Signature')),
}));

function mappingBinding() {
  const entry = (id: string, namespace: string, path: string, targetType: string) => ({
    id,
    namespace,
    path,
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    targetType,
  });
  return {
    id: 'activation-1',
    tenantId: 'default',
    fieldMappingSetId: 'set-1',
    fieldMappingVersionId: 'set-1-v1',
    catalog: {
      identity: {
        id: 'catalog-1',
        version: '1',
        contentHash: 'catalog-1',
        compatibilityRange: '^0.3.0',
      },
      entries: [
        entry('field.saml.subject.nameId', 'saml.subject', 'nameId', 'source'),
        entry('field.profile.email', 'authrim.profile', 'email', 'canonical'),
      ],
    },
    edges: [
      {
        id: 'edge.nameId.email',
        sourceRef: { side: 'source', namespace: 'saml.subject', path: 'nameId' },
        targetRef: { side: 'destination', namespace: 'authrim.profile', path: 'email' },
        edgeKind: 'direct',
      },
    ],
    transforms: [],
    validationRules: [],
    fieldMappingSet: { id: 'set-1-v1', rules: [] },
  };
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    ...actual,
    getLogger: () => ({ module: () => logger }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    scheduleSignInAttemptFailureRecord: mockSchedule,
    readExternalProviderUsagePolicy: mockUsagePolicy,
    resolveTenantUserStoreSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveUserStoreRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveAccountDataContextByIdentifier: mockAccountLookup,
    CanonicalRuntimeUserStore: class {
      async findById() {
        return {
          id: 'user-001',
          email: 'user@example.com',
          email_verified: 1,
          active: true,
          lifecycle_state: 'active',
        };
      }
      async findByEmail() {
        return null;
      }
    },
    resolveRuntimeIdentityMappingBinding: vi.fn().mockResolvedValue(mappingBinding()),
  };
});

import { handleSPACS } from '../acs';
import { buildSAMLRequestBindingCookie } from '../request-browser-binding';

const REQUEST_ID = `_${'a'.repeat(32)}`;

function samlResponse(inResponseTo?: string): string {
  const id = '_response_1';
  const now = new Date();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}"
  Destination="https://auth.example.com/saml/sp/acs"
  ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}>
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <ds:Signature><ds:SignedInfo><ds:Reference URI="#${id}"/></ds:SignedInfo></ds:Signature>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="_assertion_1" Version="2.0" IssueInstant="${now.toISOString()}">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData Recipient="https://auth.example.com/saml/sp/acs"
          NotOnOrAfter="${new Date(now.getTime() + 300000).toISOString()}"
          ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${new Date(now.getTime() - 60000).toISOString()}"
      NotOnOrAfter="${new Date(now.getTime() + 300000).toISOString()}">
      <saml:AudienceRestriction>
        <saml:Audience>https://auth.example.com/saml/sp/metadata</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${now.toISOString()}">
      <saml:AuthnContext>
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef>
      </saml:AuthnContext>
    </saml:AuthnStatement>
  </saml:Assertion>
</samlp:Response>`;
  return btoa(xml);
}

function d1(): D1Database {
  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
    batch: vi
      .fn()
      .mockImplementation(async (statements: unknown[]) =>
        statements.map(() => ({ success: true, meta: { changes: 1 } }))
      ),
  } as unknown as D1Database;
}

describe('SAML ACS records failed sign-ins against the start interaction', () => {
  let mockEnv: SamlTestEnv;
  // What the request store holds for the consumed AuthnRequest, and whether its assertion is new.
  let storedContext: Record<string, unknown> | undefined;
  let assertionStore: 'new' | 'replayed' | 'error' | 'throws';

  beforeEach(() => {
    vi.clearAllMocks();
    storedContext = { attemptInteractionId: 'int-1' };
    assertionStore = 'new';
    mockUsageKey.mockResolvedValue(null);
    mockUsagePolicy.mockResolvedValue({ loginEnabled: true, signupEnabled: true });
    mockAccountLookup.mockImplementation(async () => {
      const adapter = (linkedIdentity: boolean) => ({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn(async (sql: string) =>
          linkedIdentity && sql.includes('FROM linked_identities')
            ? { id: 'li-1', user_id: 'user-001', provider_user_id: 'saml-user@example.com' }
            : null
        ),
        execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        transaction: vi.fn(),
        batch: vi.fn().mockResolvedValue([]),
        isHealthy: vi.fn().mockResolvedValue(true),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn().mockResolvedValue(undefined),
      });
      return { coreDb: adapter(false), piiDb: adapter(true) };
    });
    mockGetIdPConfigByEntityId.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      attributeMapping: { email: 'email' },
    });
    const storeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/consume/')) {
        return Response.json({
          requestId: REQUEST_ID,
          relayState: 'https://ui.example.com/',
          ...(storedContext ? { context: storedContext } : {}),
        });
      }
      if (url.includes('/assertion/consume')) {
        if (assertionStore === 'throws') throw new Error('store unreachable');
        if (assertionStore === 'error') return new Response('boom', { status: 500 });
        return assertionStore === 'new'
          ? Response.json({ success: true })
          : Response.json({ success: false }, { status: 409 });
      }
      return Response.json({ success: true });
    });
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      UI_URL: 'https://ui.example.com',
      SAML_STRICT_INRESPONSETO: 'false',
      AUTHRIM_CONFIG: {
        get: vi.fn(async (key: string) =>
          key.startsWith('region_shard_config:') ? TEST_REGION_CONFIG : null
        ),
      } as unknown as KVNamespace,
      TDB_TEST_CORE: d1(),
      TDB_TEST_PII: d1(),
      SAML_REQUEST_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-store-id'),
        get: vi.fn().mockReturnValue({ fetch: storeFetch }),
      } as unknown as Env['SAML_REQUEST_STORE'],
      SESSION_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-session-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
        }),
      } as unknown as Env['SESSION_STORE'],
      NONCE_STORE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      } as unknown as Env['NONCE_STORE'],
    };
    mockEnv.DB_ADMIN = mockEnv.TDB_TEST_CORE as Env['DB_ADMIN'];
  });

  async function callACS(inResponseTo: string | undefined = REQUEST_ID): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse(inResponseTo));
    const cookie = inResponseTo ? buildSAMLRequestBindingCookie(inResponseTo, 300) : undefined;
    const context = {
      env: mockEnv,
      req: {
        formData: async () => formData,
        header: vi.fn((name: string) => (name.toLowerCase() === 'cookie' ? cookie : undefined)),
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn().mockReturnValue('tenant-a'),
      executionCtx: { waitUntil: vi.fn() },
    };
    return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
  }

  function scheduledFailures(): Array<Record<string, unknown>> {
    return mockSchedule.mock.calls.map((call) => call[1] as Record<string, unknown>);
  }

  it('records nothing for a sign-in that succeeds', async () => {
    const res = await callACS();

    expect(res.status).toBe(302);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('records method_disabled when the tenant turned sign-in off for the IdP', async () => {
    mockUsageKey.mockResolvedValue('idp-key-1');
    mockUsagePolicy.mockResolvedValue({ loginEnabled: false, signupEnabled: true });

    const res = await callACS();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(scheduledFailures()[0]).toMatchObject({
      tenantId: 'tenant-a',
      interactionId: 'int-1',
      method: 'saml',
      reasonCode: 'method_disabled',
    });
  });

  it('records service_unavailable when the IdP usage settings cannot be read', async () => {
    mockUsageKey.mockRejectedValue(new Error('kv down'));

    const res = await callACS();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(scheduledFailures()).toEqual([
      expect.objectContaining({ interactionId: 'int-1', reasonCode: 'service_unavailable' }),
    ]);
  });

  it('records replay_detected when the assertion was already used', async () => {
    assertionStore = 'replayed';

    const res = await callACS();

    expect(res.status).toBe(400);
    expect(scheduledFailures()).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        interactionId: 'int-1',
        method: 'saml',
        reasonCode: 'replay_detected',
      }),
    ]);
  });

  it.each([
    ['answers with an error', 'error'],
    ['cannot be reached', 'throws'],
  ] as const)(
    'records service_unavailable, not a replay, when the assertion store %s',
    async (_label, mode) => {
      assertionStore = mode;

      const res = await callACS();

      expect(res.status).toBe(400);
      expect(scheduledFailures()).toEqual([
        expect.objectContaining({
          tenantId: 'tenant-a',
          interactionId: 'int-1',
          method: 'saml',
          reasonCode: 'service_unavailable',
        }),
      ]);
    }
  );

  it('records signup_disabled when the account would have to be created and sign-up is off', async () => {
    mockUsageKey.mockResolvedValue('idp-key-1');
    mockUsagePolicy.mockResolvedValue({ loginEnabled: true, signupEnabled: false });
    mockAccountLookup.mockRejectedValue(new Error('account_data_route_not_found'));

    const res = await callACS();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(scheduledFailures()).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        interactionId: 'int-1',
        method: 'saml',
        reasonCode: 'signup_disabled',
      }),
    ]);
  });

  it('records service_unavailable for an unexpected failure after the account lookup', async () => {
    mockAccountLookup.mockRejectedValue(new Error('database exploded'));

    const res = await callACS();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(scheduledFailures()).toEqual([
      expect.objectContaining({ interactionId: 'int-1', reasonCode: 'service_unavailable' }),
    ]);
  });

  it('records with no interaction when the stored request carried none', async () => {
    storedContext = undefined;
    assertionStore = 'replayed';

    await callACS();

    expect(scheduledFailures()).toHaveLength(1);
    expect(scheduledFailures()[0]?.interactionId).toBeFalsy();
  });

  it('has no interaction to record against for an IdP-initiated response', async () => {
    assertionStore = 'replayed';

    const res = await callACS('');

    expect(res.status).toBe(400);
    // The real scheduler ignores a missing id; the ACS must not make one up.
    for (const failure of scheduledFailures()) {
      expect(failure.interactionId).toBeFalsy();
    }
  });
});
