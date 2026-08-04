/**
 * SubjectConfirmation Validation Tests
 *
 * Tests based on SAML 2.0 Core Specification Section 2.4.1:
 * - SubjectConfirmation element
 * - SubjectConfirmationData element
 *
 * Security-critical validations:
 * - Method attribute (must be bearer for most SSO scenarios)
 * - Recipient attribute (must match ACS URL)
 * - NotOnOrAfter attribute (must not be expired)
 * - InResponseTo attribute (must match request ID for SP-initiated SSO)
 *
 * @see https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPolicyConstrainedRegionShardConfig, type Env } from '@authrim/ar-lib-core';

type SamlTestEnv = Partial<Env> & {
  TDB_TEST_CORE?: D1Database;
  TDB_TEST_PII?: D1Database;
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

// Helper to create SAML Response with configurable SubjectConfirmation
function createSAMLResponseWithSubjectConfirmation(options: {
  id?: string;
  issuer?: string;
  destination?: string;
  statusCode?: string;
  nameId?: string;
  subjectConfirmationMethod?: string;
  recipient?: string;
  notOnOrAfter?: string;
  inResponseTo?: string;
  includeSubjectConfirmation?: boolean;
  includeSubjectConfirmationData?: boolean;
  notBefore?: string;
  conditionsNotOnOrAfter?: string;
  audience?: string;
}): string {
  const {
    id = '_response_' + Date.now(),
    issuer = 'https://idp.example.com',
    destination = 'https://auth.example.com/saml/sp/acs',
    statusCode = 'urn:oasis:names:tc:SAML:2.0:status:Success',
    nameId = 'user@example.com',
    subjectConfirmationMethod = 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
    recipient = 'https://auth.example.com/saml/sp/acs',
    notOnOrAfter = new Date(Date.now() + 300000).toISOString(), // 5 minutes from now
    inResponseTo,
    includeSubjectConfirmation = true,
    includeSubjectConfirmationData = true,
    notBefore = new Date(Date.now() - 60000).toISOString(),
    conditionsNotOnOrAfter = new Date(Date.now() + 300000).toISOString(),
    audience = 'https://auth.example.com/saml/sp/metadata',
  } = options;

  const subjectConfirmationData = includeSubjectConfirmationData
    ? `<saml:SubjectConfirmationData
        ${recipient ? `Recipient="${recipient}"` : ''}
        ${notOnOrAfter ? `NotOnOrAfter="${notOnOrAfter}"` : ''}
        ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}
      />`
    : '';

  const subjectConfirmation = includeSubjectConfirmation
    ? `<saml:SubjectConfirmation Method="${subjectConfirmationMethod}">
        ${subjectConfirmationData}
      </saml:SubjectConfirmation>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="${id}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="${destination}"
  ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}>
  <saml:Issuer>${issuer}</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo>
      <ds:Reference URI="#${id}"/>
    </ds:SignedInfo>
  </ds:Signature>
  <samlp:Status>
    <samlp:StatusCode Value="${statusCode}"/>
  </samlp:Status>
  <saml:Assertion ID="_assertion_${Date.now()}" Version="2.0" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
      ${subjectConfirmation}
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${conditionsNotOnOrAfter}">
      <saml:AudienceRestriction>
        <saml:Audience>${audience}</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${new Date().toISOString()}">
      <saml:AuthnContext>
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef>
      </saml:AuthnContext>
    </saml:AuthnStatement>
  </saml:Assertion>
</samlp:Response>`;

  return btoa(xml);
}

describe('SubjectConfirmation Validation - SAML 2.0 Core Section 2.4.1', () => {
  let mockEnv: SamlTestEnv;

  beforeEach(() => {
    vi.clearAllMocks();

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
              name: 'displayName',
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
        idFromName: vi.fn().mockReturnValue('mock-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
        }),
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
  async function callACS(samlResponse: string): Promise<Response> {
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
      get: vi.fn().mockReturnValue('default'), // Mock Hono's c.get() for tenantId
      executionCtx: {
        waitUntil: vi.fn(), // Mock waitUntil for async operations
      },
    };

    return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
  }

  describe('SubjectConfirmation Method Validation', () => {
    it('should accept bearer SubjectConfirmation method', async () => {
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
      });

      const res = await callACS(samlResponse);

      // Should succeed (302 redirect)
      expect(res.status).toBe(302);
    });

    it('should reject holder-of-key SubjectConfirmation method for browser SSO', async () => {
      // SECURITY: holder-of-key requires proof of key possession, not suitable for browser SSO
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject sender-vouches SubjectConfirmation method', async () => {
      // SECURITY: sender-vouches is for SOAP/backend scenarios, not browser SSO
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:sender-vouches',
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject unknown SubjectConfirmation method', async () => {
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        subjectConfirmationMethod: 'urn:unknown:method',
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('SubjectConfirmationData Recipient Validation', () => {
    it('should reject when Recipient does not match ACS URL', async () => {
      // SECURITY: Recipient MUST match the URL of the SP that receives the assertion
      // This prevents an attacker from redirecting assertions to a malicious endpoint
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        recipient: 'https://attacker.example.com/acs',
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject when Recipient is missing for bearer assertions', async () => {
      // SAML 2.0 Profiles spec requires Recipient for Bearer subject confirmation
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="_resp"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="https://auth.example.com/saml/sp/acs">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo>
      <ds:Reference URI="#_resp"/>
    </ds:SignedInfo>
  </ds:Signature>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
  <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${new Date(Date.now() + 300000).toISOString()}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${new Date(Date.now() - 60000).toISOString()}" NotOnOrAfter="${new Date(Date.now() + 300000).toISOString()}">
      <saml:AudienceRestriction>
        <saml:Audience>https://auth.example.com/saml/sp</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${new Date().toISOString()}">
      <saml:AuthnContext>
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef>
      </saml:AuthnContext>
    </saml:AuthnStatement>
  </saml:Assertion>
</samlp:Response>`;

      const res = await callACS(btoa(xml));

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('SubjectConfirmationData NotOnOrAfter Validation', () => {
    it('should reject when SubjectConfirmationData NotOnOrAfter has expired', async () => {
      // SECURITY: Prevents replay attacks with old assertions
      // Note: Clock skew is 60 seconds, so use 2 minutes ago to ensure rejection
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        notOnOrAfter: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject when SubjectConfirmationData NotOnOrAfter is missing for bearer', async () => {
      // SAML 2.0 Profiles spec requires NotOnOrAfter for Bearer subject confirmation
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        notOnOrAfter: '', // Empty = not present
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should accept when SubjectConfirmationData NotOnOrAfter is in the future', async () => {
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        notOnOrAfter: new Date(Date.now() + 300000).toISOString(), // 5 minutes from now
      });

      const res = await callACS(samlResponse);

      // Should succeed (302 redirect)
      expect(res.status).toBe(302);
    });
  });

  describe('SubjectConfirmationData InResponseTo Validation', () => {
    it('should accept when InResponseTo is not present (IdP-initiated SSO)', async () => {
      // IdP-initiated SSO doesn't have InResponseTo because there was no AuthnRequest
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        inResponseTo: undefined,
      });

      const res = await callACS(samlResponse);

      // Should succeed (302 redirect)
      expect(res.status).toBe(302);
    });

    it('should reject when InResponseTo does not match stored request (strict mode)', async () => {
      // Enable strict mode via AUTHRIM_CONFIG KV
      mockEnv.AUTHRIM_CONFIG = {
        get: vi.fn().mockResolvedValue('true'),
      } as unknown as Env['AUTHRIM_CONFIG'];

      // Mock SAML_REQUEST_STORE to return 404 for non-existent request
      mockEnv.SAML_REQUEST_STORE = {
        idFromName: vi.fn().mockReturnValue('mock-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })),
        }),
      } as unknown as Env['SAML_REQUEST_STORE'];

      // In strict mode, InResponseTo MUST match a stored AuthnRequest ID
      // This prevents assertion theft/injection attacks
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        inResponseTo: '_nonexistent_request_id',
      });

      const res = await callACS(samlResponse);

      // Strict mode: InResponseTo validation failure should return error
      expect(res.status).toBe(400);
    });

    it('should reject when InResponseTo does not match stored request', async () => {
      mockEnv.AUTHRIM_CONFIG = {
        get: vi.fn().mockResolvedValue('false'),
      } as unknown as Env['AUTHRIM_CONFIG'];

      // Mock SAML_REQUEST_STORE to return 404 for non-existent request
      mockEnv.SAML_REQUEST_STORE = {
        idFromName: vi.fn().mockReturnValue('mock-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })),
        }),
      } as unknown as Env['SAML_REQUEST_STORE'];

      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        inResponseTo: '_nonexistent_request_id',
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(400);
    });
  });

  describe('SubjectConfirmation Presence', () => {
    it('should reject assertion without SubjectConfirmation', async () => {
      // SAML 2.0 Profiles 4.1.4.2: Bearer assertion MUST contain SubjectConfirmation
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        includeSubjectConfirmation: false,
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject bearer assertion without SubjectConfirmationData', async () => {
      // SAML 2.0 Profiles 4.1.4.2: Bearer assertion MUST contain SubjectConfirmationData
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        includeSubjectConfirmationData: false,
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Clock Skew Handling', () => {
    it('should accept assertion within clock skew tolerance', async () => {
      // Default clock skew is typically 60 seconds (DEFAULTS.CLOCK_SKEW_SECONDS)
      // SubjectConfirmationData expired 30 seconds ago should still be accepted
      // Because: now > (now - 30sec) + 60sec => now > now + 30sec => FALSE (not expired)
      const samlResponse = createSAMLResponseWithSubjectConfirmation({
        notOnOrAfter: new Date(Date.now() - 30000).toISOString(), // 30 seconds ago
      });

      const res = await callACS(samlResponse);

      // With 60-second clock skew tolerance, assertions expired less than 60 seconds ago
      // are still accepted to handle clock drift between IdP and SP
      expect(res.status).toBe(302);
    });
  });
});
