import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';
/**
 * Error and fallback paths of the SAML ACS: failure-record errors, undecodable and mismatched
 * responses, re-authentication refusal, mapping errors, and the non-blocking event/audit catches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPolicyConstrainedRegionShardConfig, type Env } from '@authrim/ar-lib-core';

const {
  mockSchedule,
  mockLogger,
  mockPublish,
  mockAudit,
  mockUIConfig,
  mockReauthPolicy,
  mockBinding,
} = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
  mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockPublish: vi.fn(),
  mockAudit: vi.fn(),
  mockUIConfig: vi.fn(),
  mockReauthPolicy: vi.fn(),
  mockBinding: vi.fn(),
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
  getIdPUsageKeyByEntityId: vi.fn().mockResolvedValue(null),
  getIdPConfigByEntityId: async (...args: unknown[]): Promise<unknown> => {
    const config: unknown = await mockGetIdPConfigByEntityId(...args);
    return config
      ? { ...(config as Record<string, unknown>), identityMapping: { fieldMappingSetId: 'set-1' } }
      : config;
  },
}));

// A signed reference may be swapped per test; by default it is the whole document, as signed.
const signed = vi.hoisted(() => ({ override: null as null | ((xml: string) => string) }));
vi.mock('../../common/signature', () => ({
  verifyXmlSignature: vi.fn().mockReturnValue(true),
  verifyXmlSignatureAndGetReferences: vi.fn((xml: string) => [
    { uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml: signed.override?.(xml) ?? xml },
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
  return withExplicitMappingGraphs(
    {
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
    },
    true
  );
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({ module: () => mockLogger }),
    publishEvent: mockPublish,
    createAuditLog: mockAudit,
    getUIConfig: mockUIConfig,
    scheduleSignInAttemptFailureRecord: mockSchedule,
    readExternalProviderReauthPolicy: mockReauthPolicy,
    readExternalProviderUsagePolicy: vi.fn().mockResolvedValue({
      loginEnabled: true,
      signupEnabled: true,
    }),
    resolveTenantUserStoreSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveUserStoreRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveAccountDataContextByIdentifier: vi.fn(async () => {
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
    }),
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
    resolveRuntimeIdentityMappingBinding: mockBinding,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    resolveSignInFlowProfileRefs: vi.fn(),
    readAuthenticationProfile: vi.fn(),
  };
});

import { handleSPACS } from '../acs';
import { buildSAMLRequestBindingCookie } from '../request-browser-binding';

const REQUEST_ID = `_${'a'.repeat(32)}`;

function samlResponse(inResponseTo?: string, status = 'Success'): string {
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
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${status}"/></samlp:Status>
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

describe('SAML ACS error paths', () => {
  let mockEnv: Partial<Env> & {
    TDB_TEST_CORE?: D1Database;
    TDB_TEST_PII?: D1Database;
    SAML_STRICT_INRESPONSETO?: string;
  };
  let storedContext: Record<string, unknown> | undefined;
  let storedRelayState: string;
  const pending: Promise<unknown>[] = [];

  afterEach(async () => {
    signed.override = null;
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    storedContext = undefined;
    storedRelayState = 'https://ui.example.com/';
    mockPublish.mockResolvedValue(undefined);
    mockAudit.mockResolvedValue(undefined);
    mockUIConfig.mockResolvedValue(null);
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: false });
    mockBinding.mockResolvedValue(mappingBinding());
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
          relayState: storedRelayState,
          ...(storedContext ? { context: storedContext } : {}),
        });
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
    mockEnv.DB_ADMIN = mockEnv.TDB_TEST_CORE;
  });

  async function callACS(
    options: { encoded?: string; headers?: Record<string, string>; inResponseTo?: string } = {}
  ): Promise<Response> {
    const inResponseTo = options.inResponseTo ?? REQUEST_ID;
    const formData = new FormData();
    formData.append('SAMLResponse', options.encoded ?? samlResponse(inResponseTo));
    const cookie = buildSAMLRequestBindingCookie(inResponseTo, 300);
    const headers: Record<string, string> = { cookie, ...options.headers };
    const context = {
      env: mockEnv,
      req: {
        formData: async () => formData,
        header: vi.fn((name: string) => headers[name.toLowerCase()]),
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn().mockReturnValue('tenant-a'),
      executionCtx: {
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          pending.push(promise);
        }),
      },
    };
    return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
  }

  async function errorBody(res: Response): Promise<Record<string, unknown>> {
    return await res.json<Record<string, unknown>>();
  }

  it('logs only the error type when a failed-attempt record cannot be written', async () => {
    mockSchedule.mockImplementation((deps: { onError: (e: unknown) => void }) => {
      deps.onError(new TypeError('secret detail'));
      deps.onError('not an error');
    });

    const res = await callACS({ encoded: btoa('<not-a-response/>') });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockLogger.warn).toHaveBeenCalledWith('Failed to record a failed sign-in attempt', {
      errorType: 'TypeError',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith('Failed to record a failed sign-in attempt', {
      errorType: 'unknown',
    });
  });

  it('refuses an undecodable SAMLResponse as a server error and records it', async () => {
    const res = await callACS({ encoded: '***not base64***' });

    expect(res.status).toBe(500);
    expect(mockLogger.error).toHaveBeenCalledWith('ACS Error', {}, expect.any(Error));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({
      tenantId: 'tenant-a',
      method: 'saml',
      reasonCode: 'service_unavailable',
    });
    expect(mockPublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'auth.saml.failed', tenantId: 'tenant-a' })
    );
  });

  it('refuses a verified Response whose Issuer is not the routed IdP', async () => {
    signed.override = (xml) =>
      xml.replaceAll(
        '<saml:Issuer>https://idp.example.com</saml:Issuer>',
        '<saml:Issuer>https://evil.example.com</saml:Issuer>'
      );

    const res = await callACS();

    expect(res.status).toBe(400);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Signature verification failed',
      {},
      expect.objectContaining({
        message: 'Verified SAML Response Issuer does not match the routed IdP',
      })
    );
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('refuses a re-authentication the IdP did not show as a new login', async () => {
    storedContext = {
      spReauthentication: {
        authorizationChallengeId: 'reauth_1',
        requestedAt: Date.now() + 3_600_000,
        providerId: 'idp-1',
        providerIds: ['saml:idp-1', 'idp-1'],
      },
    };
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });

    const res = await callACS();

    expect(res.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SAML re-authentication was not shown to be a new login',
      { issuer: 'https://idp.example.com', authnInstantPresent: true }
    );
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({
      reasonCode: 'assurance_not_met',
      userId: 'user-001',
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('maps an unusable Field Mapping Set to a format error with the mapping reason', async () => {
    mockBinding.mockResolvedValue(null);

    const res = await callACS();

    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body).toMatchObject({ error_code: 'AR130002' });
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'provisioning_failed' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('logs and swallows failures of the non-blocking events and the login audit', async () => {
    mockPublish.mockRejectedValue(new Error('bus down'));
    mockAudit.mockRejectedValue(new Error('audit down'));

    const res = await callACS();
    await Promise.allSettled(pending.splice(0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://ui.example.com/');
    const messages = mockLogger.error.mock.calls.map((call: unknown[]) => call[0]);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Failed to publish auth.saml.succeeded event',
        'Failed to publish session.user.created event',
        'Failed to create audit log for SAML login',
      ])
    );
  });

  it.each([
    [
      'CF-Connecting-IP',
      { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' },
      '1.1.1.1',
    ],
    ['X-Forwarded-For (first hop)', { 'x-forwarded-for': ' 2.2.2.2 , 3.3.3.3' }, '2.2.2.2'],
    ['X-Real-IP', { 'x-real-ip': '4.4.4.4' }, '4.4.4.4'],
    ['unknown', {}, 'unknown'],
  ])('audits the sign-in with the client address from %s', async (_label, headers, expected) => {
    const res = await callACS({ headers: { 'user-agent': 'UA/1', ...headers } });

    expect(res.status).toBe(302);
    expect(mockAudit).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        action: 'user.login',
        ipAddress: expected,
        userAgent: 'UA/1',
        userId: 'user-001',
      })
    );
  });

  it('returns to the UI base URL, else to the issuer, when no return URL was kept', async () => {
    storedRelayState = '';
    mockUIConfig.mockResolvedValue({ baseUrl: 'https://login.example.com' });
    const withUi = await callACS();
    expect(withUi.headers.get('location')).toBe('https://login.example.com/');
    expect(mockUIConfig).toHaveBeenCalledWith(mockEnv, 'tenant-a');

    mockUIConfig.mockResolvedValue(null);
    const withoutUi = await callACS();
    expect(withoutUi.status).toBe(302);
    expect(withoutUi.headers.get('location')).toMatch(/^https:\/\/auth\.example\.com\/$/u);
  });

  it('audits an identity resolution failure and survives the audit failing', async () => {
    mockGetIdPConfigByEntityId.mockResolvedValue({
      entityId: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'mock-certificate',
      attributeMapping: { email: 'email' },
      jitEmailLinkingPolicy: 'bogus',
    });
    mockAudit.mockRejectedValue(new Error('audit down'));

    const res = await callACS({
      headers: { 'cf-connecting-ip': '9.9.9.9', 'user-agent': 'UA/2' },
    });
    await Promise.allSettled(pending.splice(0));

    expect(res.status).toBe(400);
    expect(mockAudit).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        action: 'saml.identity_resolution.failed',
        userId: 'saml-sp',
        resourceId: 'https://idp.example.com',
        ipAddress: '9.9.9.9',
        userAgent: 'UA/2',
        severity: 'warning',
      })
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to create SAML identity resolution failure audit',
      { reason: 'jit_policy_invalid' },
      expect.any(Error)
    );
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'provisioning_failed' });
  });
});
