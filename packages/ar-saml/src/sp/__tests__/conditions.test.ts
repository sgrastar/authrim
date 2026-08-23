/**
 * Conditions Validation Tests
 *
 * Tests based on SAML 2.0 Core Specification Section 2.5:
 * - Conditions element and its child elements
 *
 * Key validations:
 * - NotBefore/NotOnOrAfter time bounds
 * - AudienceRestriction (required for browser SSO)
 * - OneTimeUse condition (replay attack prevention)
 * - ProxyRestriction condition
 *
 * @see https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPolicyConstrainedRegionShardConfig, type Env } from '@authrim/ar-lib-core';

type SamlTestEnv = Partial<Env> & {
  TDB_TEST_CORE?: D1Database;
  TDB_TEST_PII?: D1Database;
  SAML_STRICT_INRESPONSETO?: string;
};

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

// Mock modules
const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../../admin/providers', () => ({
  getIdPConfigByEntityId: async (...args: unknown[]): Promise<unknown> => {
    const config = await mockGetIdPConfigByEntityId(...args);
    return config
      ? {
          ...(config as Record<string, unknown>),
          identityMapping: {
            fieldMappingSetId: 'test-saml-inbound',
          },
        }
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

// Mock structured logger
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createTestSAMLInboundMappingBinding() {
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
    id: 'test-saml-inbound-activation',
    tenantId: 'default',
    fieldMappingSetId: 'test-saml-inbound',
    fieldMappingVersionId: 'test-saml-inbound-v1',
    catalog: {
      identity: {
        id: 'test-saml-inbound-catalog',
        version: '1',
        contentHash: 'test-saml-inbound-catalog',
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
    fieldMappingSet: { id: 'test-saml-inbound-v1', rules: [] },
  };
}
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({
      module: () => mockLogger,
    }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    resolveTenantUserStoreSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE ?? env.DB,
      piiDb: env.TDB_TEST_PII ?? env.DB_PII ?? env.TDB_TEST_CORE ?? env.DB,
    })),
    resolveUserStoreRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE ?? env.DB,
      piiDb: env.TDB_TEST_PII ?? env.DB_PII ?? env.TDB_TEST_CORE ?? env.DB,
    })),
    resolveAccountDataContextByIdentifier: vi.fn(async () => {
      const adapter = (linkedIdentity: boolean) => ({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn(async (sql: string) =>
          linkedIdentity && sql.includes('FROM linked_identities')
            ? {
                id: 'linked-identity-1',
                user_id: 'user-001',
                provider_user_id: 'saml-user@example.com',
              }
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
    resolveRuntimeIdentityMappingBinding: vi
      .fn()
      .mockResolvedValue(createTestSAMLInboundMappingBinding()),
  };
});

// Import after mocks
import { handleSPACS } from '../acs';

// Helper to create SAML Response with configurable Conditions
function createSAMLResponseWithConditions(options: {
  id?: string;
  assertionId?: string;
  issuer?: string;
  destination?: string;
  nameId?: string;
  notBefore?: string | null;
  notOnOrAfter?: string | null;
  audiences?: string[];
  audienceRestrictions?: string[][];
  includeConditions?: boolean;
  includeOneTimeUse?: boolean;
  includeProxyRestriction?: boolean;
  proxyCount?: number;
}): string {
  const {
    id = '_response_' + Date.now(),
    assertionId = '_assertion_' + Date.now() + '_' + Math.random().toString(36).slice(2),
    issuer = 'https://idp.example.com',
    destination = 'https://auth.example.com/saml/sp/acs',
    nameId = 'user@example.com',
    notBefore = new Date(Date.now() - 60000).toISOString(),
    notOnOrAfter = new Date(Date.now() + 300000).toISOString(),
    audiences = ['https://auth.example.com/saml/sp/metadata'],
    audienceRestrictions = [audiences],
    includeConditions = true,
    includeOneTimeUse = false,
    includeProxyRestriction = false,
    proxyCount = 0,
  } = options;

  const audienceRestriction = audienceRestrictions
    .filter((restriction) => restriction.length > 0)
    .map(
      (restriction) => `<saml:AudienceRestriction>
        ${restriction.map((audience) => `<saml:Audience>${audience}</saml:Audience>`).join('\n        ')}
      </saml:AudienceRestriction>`
    )
    .join('\n');

  const oneTimeUse = includeOneTimeUse ? '<saml:OneTimeUse/>' : '';
  const proxyRestriction = includeProxyRestriction
    ? `<saml:ProxyRestriction Count="${proxyCount}"/>`
    : '';

  const conditions = includeConditions
    ? `<saml:Conditions
        ${notBefore !== null ? `NotBefore="${notBefore}"` : ''}
        ${notOnOrAfter !== null ? `NotOnOrAfter="${notOnOrAfter}"` : ''}>
        ${audienceRestriction}
        ${oneTimeUse}
        ${proxyRestriction}
      </saml:Conditions>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="${id}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="${destination}">
  <saml:Issuer>${issuer}</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo>
      <ds:Reference URI="#${id}"/>
    </ds:SignedInfo>
  </ds:Signature>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData
          Recipient="${destination}"
          NotOnOrAfter="${new Date(Date.now() + 300000).toISOString()}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    ${conditions}
    <saml:AuthnStatement AuthnInstant="${new Date().toISOString()}">
      <saml:AuthnContext>
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef>
      </saml:AuthnContext>
    </saml:AuthnStatement>
  </saml:Assertion>
</samlp:Response>`;

  return btoa(xml);
}

describe('Conditions Validation - SAML 2.0 Core Section 2.5', () => {
  let mockEnv: SamlTestEnv;
  // Model the tenant/IdP-scoped SAMLRequestStore atomic assertion consume operation.
  let usedAssertions: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    usedAssertions = new Set();

    // Mock IdP config
    mockGetIdPConfigByEntityId.mockImplementation(
      async (_env: unknown, _tenantId: string, entityId: string) => {
        if (entityId === 'https://idp.example.com') {
          return {
            entityId: 'https://idp.example.com',
            ssoUrl: 'https://idp.example.com/sso',
            certificate: 'mock-certificate',
            attributeMapping: {
              email: 'email',
            },
          };
        }
        return null;
      }
    );

    // Mock environment
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      UI_URL: 'https://ui.example.com',
      SAML_STRICT_INRESPONSETO: 'false',
      AUTHRIM_CONFIG: createTestConfigKv(),
      TDB_TEST_CORE: {
        prepare: vi.fn().mockImplementation(function () {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true }),
          };
        }),
        batch: vi
          .fn()
          .mockImplementation(async (statements: unknown[]) =>
            statements.map(() => ({ success: true, meta: { changes: 1 } }))
          ),
      } as unknown as D1Database,
      TDB_TEST_PII: {
        prepare: vi.fn().mockImplementation(function (sql: string) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(
              sql.includes('FROM linked_identities')
                ? {
                    id: 'linked-identity-1',
                    user_id: 'user-001',
                    provider_user_id: 'saml-user@example.com',
                  }
                : null
            ),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true }),
          };
        }),
        batch: vi
          .fn()
          .mockImplementation(async (statements: unknown[]) =>
            statements.map(() => ({ success: true, meta: { changes: 1 } }))
          ),
      } as unknown as D1Database,
      SAML_REQUEST_STORE: {
        idFromName: vi.fn().mockImplementation((name: string) => name),
        get: vi.fn().mockImplementation((storeId: string) => ({
          fetch: vi
            .fn()
            .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
              const body = JSON.parse(String(init?.body)) as {
                assertionId: string;
                expiresAt?: number;
              };
              if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) {
                return new Response(JSON.stringify({ error: 'missing_expiration' }), {
                  status: 400,
                });
              }
              const key = `${storeId}:${body.assertionId}`;
              if (usedAssertions.has(key)) {
                return new Response(JSON.stringify({ success: false }), { status: 409 });
              }
              usedAssertions.add(key);
              return new Response(JSON.stringify({ success: true }), { status: 200 });
            }),
        })),
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

  /**
   * Helper to create request and call ACS
   */
  async function callACS(
    samlResponse: string,
    options: { tenantId?: string } = {}
  ): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse);

    // Create minimal Hono-like context with all required properties
    const context = {
      env: mockEnv,
      req: {
        formData: async () => formData,
        header: vi.fn().mockReturnValue(undefined), // Mock header() for IP/UA extraction
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn((key: string) =>
        key === 'tenantId' ? (options.tenantId ?? 'tenant-a') : undefined
      ),
      executionCtx: {
        waitUntil: vi.fn(), // Mock waitUntil for async operations
      },
    };

    return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
  }

  describe('Time Bound Validation (NotBefore/NotOnOrAfter)', () => {
    it('should accept assertion within valid time window', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        notOnOrAfter: new Date(Date.now() + 300000).toISOString(), // 5 minutes from now
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });

    it('should reject assertion where current time is before NotBefore', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: new Date(Date.now() + 600000).toISOString(), // 10 minutes in future
        notOnOrAfter: new Date(Date.now() + 900000).toISOString(), // 15 minutes from now
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject assertion where current time is after NotOnOrAfter', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: new Date(Date.now() - 900000).toISOString(), // 15 minutes ago
        notOnOrAfter: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should accept assertion at boundary of NotBefore (with clock skew)', async () => {
      // Current time == NotBefore should be valid (boundary case)
      const now = new Date();
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: now.toISOString(),
        notOnOrAfter: new Date(now.getTime() + 300000).toISOString(),
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });

    it('should handle clock skew for NotBefore', async () => {
      // With 60-second clock skew, an assertion that started "30 seconds in the future"
      // should still be accepted
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: new Date(Date.now() + 30000).toISOString(), // 30 seconds from now
        notOnOrAfter: new Date(Date.now() + 300000).toISOString(),
      });

      const res = await callACS(samlResponse);

      // With default 60-second clock skew, this should pass
      expect(res.status).toBe(302);
    });

    it('should handle clock skew for NotOnOrAfter', async () => {
      // With 60-second clock skew, an assertion that expired "30 seconds ago"
      // should still be accepted
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: new Date(Date.now() - 300000).toISOString(),
        notOnOrAfter: new Date(Date.now() - 30000).toISOString(), // 30 seconds ago
      });

      const res = await callACS(samlResponse);

      // With default 60-second clock skew, this should pass
      expect(res.status).toBe(302);
    });
  });

  describe('AudienceRestriction Validation', () => {
    it('should accept assertion with matching Audience', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audiences: ['https://auth.example.com/saml/sp/metadata'],
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });

    it('should reject assertion with non-matching Audience', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audiences: ['https://other-sp.example.com/sp'],
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should accept assertion when our SP is in multi-Audience list', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audiences: [
          'https://other-sp.example.com/sp',
          'https://auth.example.com/saml/sp/metadata',
          'https://another-sp.example.com/sp',
        ],
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });

    it('should require every AudienceRestriction to allow our SP', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audienceRestrictions: [
          ['https://auth.example.com/saml/sp/metadata'],
          ['https://other-sp.example.com/sp'],
        ],
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject assertion with empty AudienceRestriction', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audiences: [],
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject Audience nested outside a direct AudienceRestriction child', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audiences: ['https://auth.example.com/saml/sp/metadata'],
      });
      const xml = atob(samlResponse)
        .replace('<saml:AudienceRestriction>', '<wrapper><saml:AudienceRestriction>')
        .replace('</saml:AudienceRestriction>', '</saml:AudienceRestriction></wrapper>');

      const res = await callACS(btoa(xml));

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Bearer Assertion Replay Tracking', () => {
    it('should track and reject reused bearer assertions', async () => {
      // SAML Web Browser SSO requires replay tracking for bearer assertion IDs.
      // Use a fixed assertion ID so both calls use the same assertion
      const samlResponse = createSAMLResponseWithConditions({
        assertionId: '_assertion_onetimeuse_test',
      });

      // First use should succeed
      const res1 = await callACS(samlResponse);
      expect(res1.status).toBe(302);

      // Second use of same assertion should fail.
      const res2 = await callACS(samlResponse);
      expect(res2.status).toBe(400);
    });

    it('should accept assertion with OneTimeUse on first use', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        includeOneTimeUse: true,
      });

      const res = await callACS(samlResponse);

      // Should succeed on first use
      expect(res.status).toBe(302);
    });

    it('should allow different bearer assertions', async () => {
      // Two different assertion IDs should both succeed
      const samlResponse1 = createSAMLResponseWithConditions({
        assertionId: '_assertion_unique_1',
      });
      const samlResponse2 = createSAMLResponseWithConditions({
        assertionId: '_assertion_unique_2',
      });

      const res1 = await callACS(samlResponse1);
      expect(res1.status).toBe(302);

      const res2 = await callACS(samlResponse2);
      expect(res2.status).toBe(302);
    });

    it('should scope bearer replay tracking by tenant and IdP issuer', async () => {
      const assertionId = '_assertion_scoped_onetimeuse';
      const issuer = 'https://idp.example.com';
      const samlResponse = createSAMLResponseWithConditions({
        assertionId,
        issuer,
      });

      const res1 = await callACS(samlResponse, { tenantId: 'tenant-a' });
      expect(res1.status).toBe(302);

      const res2 = await callACS(samlResponse, { tenantId: 'tenant-b' });
      expect(res2.status).toBe(302);

      const res3 = await callACS(samlResponse, { tenantId: 'tenant-a' });
      expect(res3.status).toBe(400);

      expect([...usedAssertions]).toEqual(
        expect.arrayContaining([
          `tenant:tenant-a:saml:sp:idp:${encodeURIComponent(issuer)}:${assertionId}`,
          `tenant:tenant-b:saml:sp:idp:${encodeURIComponent(issuer)}:${assertionId}`,
        ])
      );
    });

    it('atomically permits only one of two concurrent uses of the same assertion', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        assertionId: '_assertion_concurrent_replay',
      });

      const responses = await Promise.all([callACS(samlResponse), callACS(samlResponse)]);

      expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    });
  });

  describe('ProxyRestriction Condition', () => {
    it('should accept assertion with ProxyRestriction (informational for simple SP)', async () => {
      // ProxyRestriction limits how many times an assertion can be proxied
      // For a simple SP (not acting as proxy IdP), this condition is informational
      const samlResponse = createSAMLResponseWithConditions({
        includeProxyRestriction: true,
        proxyCount: 0, // No proxying allowed
      });

      const res = await callACS(samlResponse);

      // Simple SP should accept and log the restriction, not enforce it
      expect(res.status).toBe(302);
    });

    it('should parse ProxyRestriction Count attribute', async () => {
      // ProxyRestriction with higher count (more relaxed)
      const samlResponse = createSAMLResponseWithConditions({
        includeProxyRestriction: true,
        proxyCount: 5,
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });
  });

  describe('Conditions Element Presence', () => {
    it('should reject assertion without Conditions element', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        includeConditions: false,
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should accept Conditions without NotBefore', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: null,
        notOnOrAfter: new Date(Date.now() + 300000).toISOString(),
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });

    it('should accept Conditions without NotOnOrAfter', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        notBefore: new Date(Date.now() - 60000).toISOString(),
        notOnOrAfter: null,
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });
  });
});
