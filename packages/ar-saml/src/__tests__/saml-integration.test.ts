/**
 * SAML 2.0 Integration Tests
 * Tests HTTP-level behavior for SAML ACS and SLO endpoints
 *
 * Covers:
 * - ACS (Assertion Consumer Service) endpoint
 *   - Missing SAMLResponse handling
 *   - Invalid signature handling
 *   - Time condition validation (NotBefore/NotOnOrAfter)
 *   - Audience restriction validation
 *   - Destination validation
 * - SLO (Single Logout) endpoint
 *   - LogoutRequest processing
 *   - LogoutResponse processing
 *   - Time validation
 *   - Signature verification
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

type SamlTestEnv = Partial<Env> & {
  TDB_TEST_CORE?: D1Database;
  TDB_TEST_PII?: D1Database;
};
import { handleSPACS } from '../sp/acs';
import { handleSPSLO } from '../sp/slo';
import { handleSPMetadata } from '../sp/metadata';
import { handleIdPMetadata } from '../idp/metadata';
import { handleIdPSLO } from '../idp/slo';
import { getSAMLMetadataSigningCertificates } from '../common/saml-signing-keys';

const {
  mockValidateCustomClaimWrite,
  mockPersistCustomClaimWrite,
  mockSyncUserLifecycleState,
  mockResolveAccountDataContextByIdentifier,
  mockRuntimeUsersById,
  mockRuntimeUsersByEmail,
  mockRuntimeSyncUser,
  mockRuntimeDeleteUser,
  mockGetSigningKey,
  mockGetSigningCertificate,
  mockGetSPConfig,
  mockSessionStoreFetch,
  mockCreateAuditLog,
  mockResolveRuntimeIdentityMappingBinding,
  mockProvisionAuthAccount,
  mockPublishExternalIdpRoute,
  mockProvisionedAccounts,
} = vi.hoisted(() => ({
  mockValidateCustomClaimWrite: vi.fn().mockResolvedValue({ ok: true }),
  mockPersistCustomClaimWrite: vi.fn().mockResolvedValue(undefined),
  mockSyncUserLifecycleState: vi.fn().mockResolvedValue({
    lifecycleState: 'active',
    missingRequiredFields: [],
  }),
  mockResolveAccountDataContextByIdentifier: vi.fn(),
  mockRuntimeUsersById: new Map<string, any>(),
  mockRuntimeUsersByEmail: new Map<string, any>(),
  mockRuntimeSyncUser: vi.fn(),
  mockRuntimeDeleteUser: vi.fn(),
  mockGetSigningKey: vi.fn().mockResolvedValue({
    kid: 'mock-kid',
    privateKeyPem: 'mock-key',
  }),
  mockGetSigningCertificate: vi.fn().mockResolvedValue('mock-cert'),
  mockGetSPConfig: vi.fn(),
  mockSessionStoreFetch: vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
  mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
  mockResolveRuntimeIdentityMappingBinding: vi.fn(),
  mockProvisionAuthAccount: vi.fn(),
  mockPublishExternalIdpRoute: vi.fn(),
  mockProvisionedAccounts: new Map<string, { accountId: string; userId: string }>(),
}));

// Mock modules
const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../admin/providers', () => ({
  getIdPConfigByEntityId: async (...args: any[]) => {
    const config = await mockGetIdPConfigByEntityId(...args);
    return config
      ? {
          ...config,
          identityMapping: config.identityMapping ?? {
            fieldMappingSetId: 'test-saml-inbound',
          },
        }
      : config;
  },
  getSPConfig: (...args: any[]) => mockGetSPConfig(...args),
}));

vi.mock('../common/signature', () => ({
  verifyXmlSignature: vi.fn(),
  verifyRedirectBindingSignature: vi.fn().mockResolvedValue(true),
  hasSignature: vi.fn((xml: string) => xml.includes('<ds:Signature')),
  signXml: vi.fn((xml: string) => xml), // Pass through
}));

vi.mock('../common/key-utils', () => ({
  DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT: {
    countryName: '',
    stateOrProvinceName: '',
    localityName: '',
    organizationName: 'Authrim',
    organizationalUnitName: '',
    commonName: 'Authrim SAML Signing',
  },
  getSigningKey: (...args: any[]) => mockGetSigningKey(...args),
  getSigningCertificate: (...args: any[]) => mockGetSigningCertificate(...args),
}));

// Mock structured logger and event publisher
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const { vi } = await import('vitest');
  return {
    ...actual,
    getLogger: () => ({
      module: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    validateCustomClaimWrite: mockValidateCustomClaimWrite,
    persistCustomClaimWrite: mockPersistCustomClaimWrite,
    syncUserLifecycleState: mockSyncUserLifecycleState,
    createAuditLog: mockCreateAuditLog,
    resolveAccountDataContextByIdentifier: mockResolveAccountDataContextByIdentifier,
    resolveRuntimeIdentityMappingBinding: mockResolveRuntimeIdentityMappingBinding,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        return mockRuntimeUsersById.get(userId) ?? null;
      }

      async findByEmail(email: string) {
        return mockRuntimeUsersByEmail.get(email.toLowerCase()) ?? null;
      }

      async syncUser(input: any) {
        mockRuntimeSyncUser(input);
        const user = {
          id: input.userId,
          email: input.email,
          name: input.name ?? null,
          active: input.active,
          lifecycle_state: input.active ? 'active' : 'deleted',
          email_verified: input.emailVerified,
        };
        mockRuntimeUsersById.set(input.userId, user);
        if (input.email) {
          mockRuntimeUsersByEmail.set(String(input.email).toLowerCase(), user);
        }
        return user;
      }

      async deleteUser(userId: string) {
        mockRuntimeDeleteUser(userId);
        const current = mockRuntimeUsersById.get(userId);
        if (current) {
          mockRuntimeUsersById.set(userId, {
            ...current,
            active: false,
            lifecycle_state: 'deleted',
          });
        }
        return true;
      }
    },
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: SamlTestEnv) => ({
      schemaDb: env.TDB_TEST_CORE,
      nonPiiDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII ?? null,
    })),
    // Mock getSessionStoreForNewSession to avoid crypto dependency issues in tests
    getSessionStoreForNewSession: vi.fn().mockResolvedValue({
      stub: {
        fetch: mockSessionStoreFetch,
      },
      sessionId: 'mock-session-id-12345',
    }),
  };
});

function createMockAdapter(
  options: {
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
    execute?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
  } = {}
) {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn(
      async (sql: string, params: unknown[]) => options.queryOne?.(sql, params) ?? null
    ),
    execute: vi.fn(
      async (sql: string, params: unknown[]) =>
        options.execute?.(sql, params) ?? { rowsAffected: 1, insertId: undefined }
    ),
    transaction: vi.fn(async (fn: any) => fn()),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createTestSAMLInboundMappingBinding() {
  const catalog = {
    identity: {
      id: 'test-saml-inbound-catalog',
      version: '1',
      contentHash: 'test-saml-inbound-catalog',
      compatibilityRange: '^0.3.0',
    },
    entries: [
      fieldCatalogEntry('field.saml.subject.nameId', 'saml.subject', 'nameId', 'source'),
      fieldCatalogEntry('field.saml.attribute.email', 'saml.attribute', 'email', 'source'),
      fieldCatalogEntry(
        'field.saml.attribute.displayName',
        'saml.attribute',
        'displayName',
        'source'
      ),
      fieldCatalogEntry(
        'field.saml.attribute.department',
        'saml.attribute',
        'department',
        'source'
      ),
      fieldCatalogEntry('field.profile.email', 'authrim.profile', 'email', 'canonical'),
      fieldCatalogEntry('field.profile.name', 'authrim.profile', 'name', 'canonical'),
      fieldCatalogEntry(
        'field.customClaims.department',
        'authrim.custom_claims',
        'department',
        'custom'
      ),
    ],
  };
  return {
    id: 'test-saml-inbound-activation',
    tenantId: 'default',
    fieldMappingSetId: 'test-saml-inbound',
    fieldMappingVersionId: 'test-saml-inbound-v1',
    catalog,
    edges: [
      mappingEdge('edge.nameId.email', 'saml.subject', 'nameId', 'authrim.profile', 'email'),
      mappingEdge('edge.attribute.email', 'saml.attribute', 'email', 'authrim.profile', 'email'),
      mappingEdge(
        'edge.displayName.name',
        'saml.attribute',
        'displayName',
        'authrim.profile',
        'name'
      ),
      mappingEdge(
        'edge.department.customClaim',
        'saml.attribute',
        'department',
        'authrim.custom_claims',
        'department'
      ),
    ],
    transforms: [],
    validationRules: [],
    fieldMappingSet: {
      id: 'test-saml-inbound-v1',
      rules: [],
    },
  };
}

function createTestSAMLInboundNoEmailMappingBinding() {
  return {
    ...createTestSAMLInboundMappingBinding(),
    edges: [],
  };
}

function fieldCatalogEntry(id: string, namespace: string, path: string, targetType: string) {
  return {
    id,
    namespace,
    path,
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    targetType,
  };
}

function mappingEdge(
  id: string,
  sourceNamespace: string,
  sourcePath: string,
  targetNamespace: string,
  targetPath: string
) {
  return {
    id,
    sourceRef: { side: 'source', namespace: sourceNamespace, path: sourcePath },
    targetRef: { side: 'destination', namespace: targetNamespace, path: targetPath },
    edgeKind: 'direct',
  };
}

// Helper to create base64-encoded SAML Response
function createMockSAMLResponse(
  options: {
    issuer?: string;
    statusCode?: string;
    destination?: string;
    nameId?: string;
    nameIdFormat?: string;
    notBefore?: string;
    notOnOrAfter?: string;
    audience?: string;
    inResponseTo?: string;
    authnContextClassRef?: string;
    attributes?: Array<{ name: string; value: string; friendlyName?: string }>;
    signatureReferenceUri?: string;
    includeUnsignedReferenceToResponse?: boolean;
    assertionIssuer?: string;
  } = {}
): string {
  const {
    issuer = 'https://idp.example.com',
    statusCode = 'urn:oasis:names:tc:SAML:2.0:status:Success',
    destination = 'https://auth.example.com/saml/sp/acs',
    nameId = 'user@example.com',
    nameIdFormat = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    notBefore = new Date(Date.now() - 60000).toISOString(),
    notOnOrAfter = new Date(Date.now() + 300000).toISOString(),
    audience = 'https://auth.example.com/saml/sp/metadata',
    inResponseTo = undefined,
    authnContextClassRef = 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
    attributes = [],
    signatureReferenceUri = undefined,
    includeUnsignedReferenceToResponse = false,
    assertionIssuer = issuer,
  } = options;
  const uniqueId = `${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`;
  const responseId = `_${uniqueId}`;
  const assertionId = `_assertion_${uniqueId}`;
  const signatureReference = signatureReferenceUri ?? `#${responseId}`;

  // SubjectConfirmation NotOnOrAfter for bearer assertion (same as Conditions NotOnOrAfter)
  const subjectConfirmationNotOnOrAfter = notOnOrAfter;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="${responseId}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="${destination}"
  ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}>
  <saml:Issuer>${issuer}</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo>
      <ds:Reference URI="${signatureReference}"/>
    </ds:SignedInfo>
  </ds:Signature>
  ${includeUnsignedReferenceToResponse ? `<ds:Reference URI="#${responseId}"/>` : ''}
  <samlp:Status>
    <samlp:StatusCode Value="${statusCode}"/>
  </samlp:Status>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>${assertionIssuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="${nameIdFormat}">${nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData
          Recipient="${destination}"
          NotOnOrAfter="${subjectConfirmationNotOnOrAfter}"
          ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml:AudienceRestriction>
        <saml:Audience>${audience}</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${new Date().toISOString()}">
      <saml:AuthnContext>
        <saml:AuthnContextClassRef>${authnContextClassRef}</saml:AuthnContextClassRef>
      </saml:AuthnContext>
    </saml:AuthnStatement>
    ${
      attributes.length > 0
        ? `<saml:AttributeStatement>
${attributes
  .map(
    (attribute) => `      <saml:Attribute Name="${attribute.name}"${
      attribute.friendlyName ? ` FriendlyName="${attribute.friendlyName}"` : ''
    }>
        <saml:AttributeValue>${attribute.value}</saml:AttributeValue>
      </saml:Attribute>`
  )
  .join('\n')}
    </saml:AttributeStatement>`
        : ''
    }
  </saml:Assertion>
</samlp:Response>`;

  return btoa(xml);
}

function createMockEncryptedAssertionSAMLResponse(
  options: {
    issuer?: string;
    destination?: string;
  } = {}
): string {
  const {
    issuer = 'https://idp.example.com',
    destination = 'https://auth.example.com/saml/sp/acs',
  } = options;
  const uniqueId = `${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`;
  const responseId = `_${uniqueId}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="${responseId}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="${destination}">
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
  <saml:EncryptedAssertion>
    <xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Element">
      <xenc:CipherData>
        <xenc:CipherValue>ciphertext</xenc:CipherValue>
      </xenc:CipherData>
    </xenc:EncryptedData>
  </saml:EncryptedAssertion>
</samlp:Response>`;

  return btoa(xml);
}

// Helper to create base64-encoded SAML LogoutRequest
function createMockLogoutRequest(
  options: {
    issuer?: string;
    destination?: string;
    nameId?: string;
    issueInstant?: string;
  } = {}
): string {
  const {
    issuer = 'https://idp.example.com',
    destination = 'https://auth.example.com/saml/sp/slo',
    nameId = 'user@example.com',
    issueInstant = new Date().toISOString(),
  } = options;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_logout_${Date.now()}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  Destination="${destination}">
  <saml:Issuer>${issuer}</saml:Issuer>
  <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
</samlp:LogoutRequest>`;

  return btoa(xml);
}

// Helper to create base64-encoded SAML LogoutResponse
function createMockLogoutResponse(
  options: {
    issuer?: string;
    statusCode?: string;
    inResponseTo?: string;
  } = {}
): string {
  const {
    issuer = 'https://idp.example.com',
    statusCode = 'urn:oasis:names:tc:SAML:2.0:status:Success',
    inResponseTo = '_request_123',
  } = options;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_response_${Date.now()}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  InResponseTo="${inResponseTo}">
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="${statusCode}"/>
  </samlp:Status>
</samlp:LogoutResponse>`;

  return btoa(xml);
}

describe('SAML Integration', () => {
  let app: Hono;
  let mockEnv: SamlTestEnv;
  let mockUsers: Map<string, any>;
  let mockChallengeStore: Map<string, any>;
  let mockNonceStore: Map<string, string>;
  let mockStateStore: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCustomClaimWrite.mockReset().mockResolvedValue({ ok: true });
    mockPersistCustomClaimWrite.mockReset().mockResolvedValue(undefined);
    mockSyncUserLifecycleState.mockReset().mockResolvedValue({
      lifecycleState: 'active',
      missingRequiredFields: [],
    });
    mockRuntimeUsersById.clear();
    mockRuntimeUsersByEmail.clear();
    mockProvisionedAccounts.clear();
    mockRuntimeSyncUser.mockReset();
    mockRuntimeDeleteUser.mockReset();
    mockCreateAuditLog.mockReset().mockResolvedValue(undefined);
    mockGetSigningKey.mockReset().mockResolvedValue({
      kid: 'mock-kid',
      privateKeyPem: 'mock-key',
    });
    mockGetSigningCertificate.mockReset().mockResolvedValue('mock-cert');
    mockSessionStoreFetch
      .mockReset()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    mockResolveRuntimeIdentityMappingBinding
      .mockReset()
      .mockResolvedValue(createTestSAMLInboundMappingBinding());
    mockGetSPConfig
      .mockReset()
      .mockImplementation(async (_env: unknown, _tenantId: string, entityId: string) => {
        if (entityId === 'https://sp.example.com/saml') {
          return {
            entityId: 'https://sp.example.com/saml',
            acsUrl: 'https://sp.example.com/saml/acs',
            sloUrl: 'https://sp.example.com/saml/slo',
            certificate: 'mock-sp-certificate',
            signingKeyPolicy: {},
            allowedBindings: ['post', 'redirect'],
          };
        }
        return null;
      });
    mockUsers = new Map();
    mockChallengeStore = new Map();
    mockNonceStore = new Map();
    mockStateStore = new Map();
    mockStateStore.set(
      'saml:logout-request:tenant:default:id:_request_123',
      JSON.stringify({
        version: 1,
        tenantId: 'default',
        spEntityId: 'https://idp.example.com',
        requestId: '_request_123',
        relayState: 'https://app.example.com/logged-out',
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 120000,
      })
    );

    // Seed test user
    mockUsers.set('user-001', {
      id: 'user-001',
      email: 'user@example.com',
      name: 'Test User',
    });
    mockRuntimeUsersById.set('user-001', {
      id: 'user-001',
      email: 'user@example.com',
      name: 'Test User',
      active: true,
      lifecycle_state: 'active',
      email_verified: true,
    });
    mockRuntimeUsersByEmail.set('user@example.com', mockRuntimeUsersById.get('user-001'));

    // Mock IdP config
    mockGetIdPConfigByEntityId.mockImplementation(
      async (_env: any, _tenantId: string, entityId: string) => {
        if (entityId === 'https://idp.example.com') {
          return {
            entityId: 'https://idp.example.com',
            ssoUrl: 'https://idp.example.com/sso',
            sloUrl: 'https://idp.example.com/slo',
            certificate: 'mock-certificate',
            logoutRequestSignaturePolicy: 'optional',
            attributeMapping: {
              email: 'email',
              name: 'displayName',
            },
          };
        }
        return null;
      }
    );
    mockResolveAccountDataContextByIdentifier
      .mockReset()
      .mockImplementation(async (env: SamlTestEnv, input: Record<string, any>) => {
        let routed: { accountId: string; userId: string } | undefined;
        if (input.indexKind === 'email_exact') {
          const user = mockRuntimeUsersByEmail.get(String(input.identifier).toLowerCase());
          if (user) {
            routed = { accountId: `account:${user.id}`, userId: user.id };
          }
        } else if (input.indexKind === 'external_subject') {
          const identifier = input.identifier as { issuer: string; subject: string };
          routed = mockProvisionedAccounts.get(`${identifier.issuer}\u0000${identifier.subject}`);
        }
        if (!routed) {
          throw new Error('account_data_route_not_found');
        }
        return {
          accountId: routed.accountId,
          legacyUserId: routed.userId,
          coreDb: env.TDB_TEST_CORE,
          piiDb: env.TDB_TEST_PII,
        };
      });
    mockProvisionAuthAccount.mockReset().mockImplementation(async (input: Record<string, any>) => {
      const accountId = `account:${input.candidateUserId}`;
      const externalSubject = input.externalSubject as { issuer: string; subject: string };
      mockProvisionedAccounts.set(`${externalSubject.issuer}\u0000${externalSubject.subject}`, {
        accountId,
        userId: input.candidateUserId,
      });
      return {
        status: 201,
        operationId: input.operationId,
        accountId,
        userId: input.candidateUserId,
      };
    });
    mockPublishExternalIdpRoute
      .mockReset()
      .mockImplementation(async (input: Record<string, any>) => ({
        status: 201,
        operationId: input.operationId,
        accountId: input.accountId,
      }));

    // Mock environment
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      UI_URL: 'https://ui.example.com',
      SAML_ACCOUNT_PROVISIONER: {
        provisionAuthAccount: mockProvisionAuthAccount,
        publishExternalIdpRoute: mockPublishExternalIdpRoute,
      } as any,
      TDB_TEST_CORE: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            // PII/Non-PII separation: users_core (non-PII)
            if (sql.includes('FROM users_core WHERE id')) {
              return { id: 'user-001', email_verified: 1 };
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any,
      TDB_TEST_PII: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('FROM linked_identities')) {
              return {
                id: 'linked-identity-001',
                user_id: 'user-001',
                provider_user_id: 'saml-user@example.com',
              };
            }
            // PII/Non-PII separation: users_pii (PII)
            if (sql.includes('SELECT id FROM users_pii WHERE')) {
              return { id: 'user-001' };
            }
            if (sql.includes('SELECT email FROM users_pii WHERE id')) {
              return { email: 'user@example.com' };
            }
            if (sql.includes('SELECT email, name FROM users_pii WHERE id')) {
              return { email: 'user@example.com', name: 'Test User' };
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any,
      SAML_REQUEST_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
        }),
      } as any,
      SESSION_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-session-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
        }),
      } as any,
      CHALLENGE_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-challenge-store-id'),
        get: vi.fn().mockReturnValue({
          storeChallengeRpc: vi.fn((request: any) => {
            mockChallengeStore.set(request.id, request);
            return Promise.resolve({ success: true });
          }),
        }),
      } as any,
      NONCE_STORE: {
        get: vi.fn((key: string) => Promise.resolve(mockNonceStore.get(key) ?? null)),
        put: vi.fn((key: string, value: string) => {
          mockNonceStore.set(key, value);
          return Promise.resolve();
        }),
      } as any,
      STATE_STORE: {
        get: vi.fn((key: string) => Promise.resolve(mockStateStore.get(key) ?? null)),
        put: vi.fn((key: string, value: string) => {
          mockStateStore.set(key, value);
          return Promise.resolve();
        }),
        delete: vi.fn((key: string) => {
          mockStateStore.delete(key);
          return Promise.resolve();
        }),
      } as any,
    };
    mockEnv.DB_ADMIN = mockEnv.TDB_TEST_CORE as Env['DB_ADMIN'];

    // Create Hono app
    app = new Hono();
    app.post('/saml/sp/acs', (c) => {
      Object.assign(c, { env: mockEnv });
      return handleSPACS(c as any);
    });
    app.get('/saml/sp/metadata', (c) => {
      Object.assign(c, { env: mockEnv });
      return handleSPMetadata(c as any);
    });
    app.get('/saml/idp/metadata', (c) => {
      Object.assign(c, { env: mockEnv });
      return handleIdPMetadata(c as any);
    });
    app.post('/saml/sp/slo', (c) => {
      Object.assign(c, { env: mockEnv });
      return handleSPSLO(c as any);
    });
    app.get('/saml/sp/slo', (c) => {
      Object.assign(c, { env: mockEnv });
      return handleSPSLO(c as any);
    });
    app.post('/saml/idp/slo', (c) => {
      Object.assign(c, { env: mockEnv });
      return handleIdPSLO(c as any);
    });
  });

  /**
   * Helper to call ACS handler directly (for success path tests)
   * This bypasses Hono to ensure mocks are properly applied
   */
  async function callACSDirectly(
    samlResponse: string,
    relayState?: string,
    options: { tenantId?: string; headerTenantId?: string } = {}
  ): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse);
    if (relayState) {
      formData.append('RelayState', relayState);
    }

    // Create minimal Hono-like context with all required properties
    const context = {
      env: mockEnv,
      req: {
        url: 'https://auth.example.com/saml/sp/acs',
        formData: async () => formData,
        header: vi.fn((name: string) =>
          name === 'X-Tenant-Id' ? options.headerTenantId : undefined
        ),
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn((key: string) =>
        key === 'tenantId' ? (options.tenantId ?? 'default') : undefined
      ),
      executionCtx: {
        waitUntil: vi.fn(),
      },
    };

    return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
  }

  async function callMetadataDirectly(
    handler: typeof handleSPMetadata | typeof handleIdPMetadata,
    options: {
      tenantId?: string;
      headerTenantId?: string;
      env?: Partial<Env>;
    } = {}
  ): Promise<Response> {
    const context = {
      env: {
        ...mockEnv,
        ...options.env,
      },
      req: {
        header: vi.fn((name: string) =>
          name === 'X-Tenant-Id' ? options.headerTenantId : undefined
        ),
      },
      get: vi.fn((key: string) => (key === 'tenantId' ? options.tenantId : undefined)),
    };

    return handler(context as unknown as Parameters<typeof handler>[0]);
  }

  async function callIdPSLODirectly(
    samlResponse: string,
    options: { tenantId?: string; headerTenantId?: string } = {}
  ): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse);

    const context = {
      env: mockEnv,
      req: {
        method: 'POST',
        formData: async () => formData,
        header: vi.fn((name: string) =>
          name === 'X-Tenant-Id' ? options.headerTenantId : undefined
        ),
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn((key: string) =>
        key === 'tenantId' ? (options.tenantId ?? 'default') : undefined
      ),
      executionCtx: {
        waitUntil: vi.fn(),
      },
    };

    return handleIdPSLO(context as unknown as Parameters<typeof handleIdPSLO>[0]);
  }

  describe('POST /saml/sp/acs - Assertion Consumer Service', () => {
    it('should reject request without SAMLResponse', async () => {
      const formData = new FormData();
      // No SAMLResponse

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('missing');
    });

    it('should reject response from unknown IdP', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValue(null);

      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          issuer: 'https://unknown-idp.example.com',
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.SAML_RESPONSE_INVALID uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject response with failed SAML status', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      // Should return error (500 due to parsing error)
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject response with invalid Destination', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          destination: 'https://wrong-destination.com/acs',
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject when Assertion Issuer differs from Response Issuer', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          issuer: 'https://idp.example.com',
          assertionIssuer: 'https://attacker.example.com',
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should fail closed for EncryptedAssertion until SP decryption is implemented', async () => {
      const formData = new FormData();
      formData.append('SAMLResponse', createMockEncryptedAssertionSAMLResponse());

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject response with expired assertion (NotOnOrAfter)', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          notOnOrAfter: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject response with not-yet-valid assertion (NotBefore)', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          notBefore: new Date(Date.now() + 600000).toISOString(), // 10 minutes in future
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject response with invalid Audience', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockSAMLResponse({
          audience: 'https://wrong-audience.example.com/sp',
        })
      );

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject strict InResponseTo when the stored request is only present in another tenant', async () => {
      const tenantBStoreFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      const tenantAStoreFetch = vi
        .fn()
        .mockResolvedValue(new Response('Not found', { status: 404 }));
      const idFromName = vi.fn((name: string) => name);

      (mockEnv as Partial<Env> & { SAML_STRICT_INRESPONSETO: string }).SAML_STRICT_INRESPONSETO =
        'true';
      mockEnv.SAML_REQUEST_STORE = {
        idFromName,
        get: vi.fn((id: string) => ({
          fetch: id.includes('tenant:tenant-b:') ? tenantBStoreFetch : tenantAStoreFetch,
        })),
      } as unknown as Env['SAML_REQUEST_STORE'];

      const res = await callACSDirectly(
        createMockSAMLResponse({
          inResponseTo: '_tenant_b_request',
        }),
        undefined,
        { tenantId: 'tenant-a' }
      );

      expect(res.status).toBe(400);
      expect(idFromName).toHaveBeenCalledWith(
        'tenant:tenant-a:saml:sp:idp:https%3A%2F%2Fidp.example.com'
      );
      expect(idFromName).not.toHaveBeenCalledWith(expect.stringContaining('tenant:tenant-b:'));
      expect(tenantAStoreFetch).toHaveBeenCalledWith(
        'https://saml-request-store/consume/_tenant_b_request',
        { method: 'POST' }
      );
      expect(tenantBStoreFetch).not.toHaveBeenCalled();
    });

    it('should reject strict InResponseTo when tenant-a has the request but tenant-b context does not', async () => {
      const tenantAStoreFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      const tenantBStoreFetch = vi
        .fn()
        .mockResolvedValue(new Response('Not found', { status: 404 }));
      const idFromName = vi.fn((name: string) => name);

      (mockEnv as Partial<Env> & { SAML_STRICT_INRESPONSETO: string }).SAML_STRICT_INRESPONSETO =
        'true';
      mockEnv.SAML_REQUEST_STORE = {
        idFromName,
        get: vi.fn((id: string) => ({
          fetch: id.includes('tenant:tenant-a:') ? tenantAStoreFetch : tenantBStoreFetch,
        })),
      } as unknown as Env['SAML_REQUEST_STORE'];

      const res = await callACSDirectly(
        createMockSAMLResponse({
          inResponseTo: '_shared_request',
        }),
        undefined,
        { tenantId: 'tenant-b' }
      );

      expect(res.status).toBe(400);
      expect(idFromName).toHaveBeenCalledWith(
        'tenant:tenant-b:saml:sp:idp:https%3A%2F%2Fidp.example.com'
      );
      expect(idFromName).not.toHaveBeenCalledWith(expect.stringContaining('tenant:tenant-a:'));
      expect(tenantBStoreFetch).toHaveBeenCalledWith(
        'https://saml-request-store/consume/_shared_request',
        { method: 'POST' }
      );
      expect(tenantAStoreFetch).not.toHaveBeenCalled();
    });

    it('should redirect on successful SAML Response', async () => {
      // Use direct handler call to ensure mocks are properly applied
      const res = await callACSDirectly(
        createMockSAMLResponse(),
        'https://auth.example.com/dashboard'
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://auth.example.com/dashboard');
      expect(res.headers.get('Set-Cookie')).toContain('authrim_session=');
      expect(mockSessionStoreFetch).toHaveBeenCalledWith(
        'https://session-store/session',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"tenantId":"default"'),
        })
      );
    });

    it('should reject when verified signature references do not cover the processed Response or Assertion', async () => {
      const res = await callACSDirectly(
        createMockSAMLResponse({
          signatureReferenceUri: '#_signed-but-not-processed',
          includeUnsignedReferenceToResponse: true,
        }),
        'https://auth.example.com/dashboard'
      );

      expect(res.status).toBe(400);
      expect(mockSessionStoreFetch).not.toHaveBeenCalled();
    });

    it('should reject a SAML Response when AuthnContext is not allowed by IdP policy', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        certificate: 'mock-certificate',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
        allowedBindings: ['post', 'redirect'],
        authnContextPolicy: {
          mode: 'require_any',
          allowedClassRefs: ['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'],
        },
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
        }),
        'https://app.example.com/dashboard'
      );

      expect(res.status).toBe(400);
      expect(mockSessionStoreFetch).not.toHaveBeenCalled();
    });

    it('should redirect to default URL when no RelayState', async () => {
      // Use direct handler call to ensure mocks are properly applied
      const res = await callACSDirectly(createMockSAMLResponse());

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toMatch(
        /^https:\/\/ui\.example\.com\/callback\?handoff_token=/
      );
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    });

    it('should redirect to Login UI callback with an OIDC-style one-time handoff artifact', async () => {
      const res = await callACSDirectly(createMockSAMLResponse(), 'https://ui.example.com/');
      const handoffLocation = res.headers.get('Location');

      expect(res.status).toBe(302);
      expect(handoffLocation).toMatch(/^https:\/\/ui\.example\.com\/callback\?handoff_token=/);
      const locationUrl = new URL(handoffLocation!);
      const token = locationUrl.searchParams.get('handoff_token');
      const state = locationUrl.searchParams.get('state');
      const challenge = mockChallengeStore.get(`handoff:${token}`);
      expect(challenge).toBeDefined();
      expect(challenge.challenge).toBe('mock-session-id-12345');
      expect(challenge.metadata).toEqual(
        expect.objectContaining({
          aud: 'saml_sp_cookie_handoff',
          state,
          origin: 'https://ui.example.com',
          return_url: 'https://ui.example.com/',
        })
      );
    });

    it('should reject JIT provisioning when required custom claims are missing', async () => {
      mockValidateCustomClaimWrite.mockResolvedValueOnce({
        ok: false,
        error: 'Department is required',
        missingRequiredFields: [
          {
            fieldKey: 'department',
            label: 'Department',
            fieldType: 'string',
          },
        ],
      });

      mockEnv.TDB_TEST_PII = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT id FROM users_pii WHERE')) {
              return null;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any;
      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'new-user@example.com',
        })
      );

      expect(res.status).toBe(400);
      expect(mockValidateCustomClaimWrite).toHaveBeenCalled();
      const body = (await res.json()) as {
        error: string;
        error_description?: string;
        missing_required_fields?: Array<{
          field_key: string;
          label: string;
          field_type: string;
        }>;
      };
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('invalid');
      expect(body.missing_required_fields).toEqual([
        {
          field_key: 'department',
          label: 'Department',
          field_type: 'string',
        },
      ]);
    });

    it('should map SAML attributes into custom claims during JIT provisioning', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        attributeMapping: {
          email: 'email',
          name: 'displayName',
          department: 'custom_claims.department',
        },
      });

      mockEnv.TDB_TEST_PII = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT id FROM users_pii WHERE')) {
              return null;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any;

      await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'new-user@example.com',
          attributes: [{ name: 'department', value: 'Engineering' }],
        })
      );

      expect(mockValidateCustomClaimWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          submitted: {
            department: 'Engineering',
          },
        })
      );
      expect(mockPersistCustomClaimWrite).toHaveBeenCalled();
      expect(mockSyncUserLifecycleState).toHaveBeenCalled();
    });

    it('should reject JIT provisioning without email unless synthetic email fallback is enabled', async () => {
      mockEnv.TDB_TEST_PII = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT id FROM users_pii WHERE')) {
              return null;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any;
      mockResolveRuntimeIdentityMappingBinding.mockResolvedValueOnce(
        createTestSAMLInboundNoEmailMappingBinding()
      );

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-123',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        })
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'invalid_request',
      });
    });

    it('should allow synthetic email fallback only when explicitly enabled', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        allowSyntheticEmailFallback: true,
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
      });
      mockResolveRuntimeIdentityMappingBinding.mockResolvedValueOnce(
        createTestSAMLInboundNoEmailMappingBinding()
      );
      mockEnv.TDB_TEST_PII = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT id FROM users_pii WHERE')) {
              return null;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any;

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-123',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        })
      );

      expect(res.status).toBe(302);
      expect(mockPersistCustomClaimWrite).toHaveBeenCalled();
      expect(mockSyncUserLifecycleState).toHaveBeenCalled();
    });

    it('should derive synthetic email fallback without embedding raw NameID', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        allowSyntheticEmailFallback: true,
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
      });
      mockResolveRuntimeIdentityMappingBinding.mockResolvedValueOnce(
        createTestSAMLInboundNoEmailMappingBinding()
      );
      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'person@example.com',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        })
      );

      expect(res.status).toBe(302);
      const provisioningInput = mockProvisionAuthAccount.mock.calls[0]?.[0];
      expect(provisioningInput).toEqual(
        expect.objectContaining({
          flow: 'saml',
          email: expect.stringMatching(/^saml-[0-9a-f]{32}@saml\.local$/),
          runtimeUser: expect.objectContaining({
            emailVerified: true,
            sensitiveValues: expect.objectContaining({
              email: expect.stringMatching(/^saml-[0-9a-f]{32}@saml\.local$/),
            }),
          }),
        })
      );
      expect(provisioningInput.email).not.toContain('person');
      expect(provisioningInput.email).not.toContain('example.com');
    });

    it('should resolve existing SAML linked identity before email or JIT provisioning', async () => {
      const nameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
      const providerUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-123')}`;
      mockRuntimeUsersById.set('linked-user-001', {
        id: 'linked-user-001',
        email: 'linked@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      });
      const coreAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('SELECT id, email_verified FROM users_core WHERE id')) {
            expect(params).toEqual(['linked-user-001', 'default']);
            return { id: 'linked-user-001', email_verified: 1 };
          }
          return null;
        },
      });
      const piiAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?')) {
            expect(params).toEqual(['default', 'https://idp.example.com', providerUserKey]);
            return { id: 'saml-link-001', user_id: 'linked-user-001' };
          }
          return null;
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-123',
          nameIdFormat,
        })
      );

      expect(res.status).toBe(302);
      expect(mockValidateCustomClaimWrite).not.toHaveBeenCalled();
      expect(piiAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE linked_identities SET last_used_at'),
        expect.arrayContaining(['default', 'saml-link-001'])
      );
    });

    it('should create a SAML linked identity when verified email matches a provisioned user', async () => {
      const nameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
      const providerUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-456')}`;
      const scimUser = {
        id: 'scim-user-001',
        email: 'scim@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      };
      mockRuntimeUsersById.set('scim-user-001', scimUser);
      mockRuntimeUsersByEmail.set('scim@example.com', scimUser);
      const coreAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('SELECT id, email_verified FROM users_core WHERE id')) {
            expect(params).toEqual(['scim-user-001', 'default']);
            return { id: 'scim-user-001', email_verified: 1 };
          }
          return null;
        },
      });
      const piiAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?')) {
            expect(params).toEqual(['default', 'https://idp.example.com', providerUserKey]);
            return null;
          }
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            expect(params).toEqual(['default', 'scim@example.com']);
            return { id: 'scim-user-001' };
          }
          return null;
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-456',
          nameIdFormat,
          attributes: [{ name: 'email', value: 'scim@example.com' }],
        })
      );

      expect(res.status).toBe(302);
      expect(coreAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users_core'),
        expect.anything()
      );
      expect(piiAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO linked_identities'),
        expect.arrayContaining([
          'default',
          'scim-user-001',
          'https://idp.example.com',
          providerUserKey,
          'scim@example.com',
        ])
      );
    });

    it('should fail closed when email matches but SAML email linking is disabled', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        jitEmailLinkingPolicy: 'jit_create_only',
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
      });
      const coreAdapter = createMockAdapter();
      const scimUser = {
        id: 'scim-user-001',
        email: 'scim@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      };
      mockRuntimeUsersById.set('scim-user-001', scimUser);
      mockRuntimeUsersByEmail.set('scim@example.com', scimUser);
      const piiAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            return { id: 'scim-user-001' };
          }
          return null;
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-789',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          attributes: [{ name: 'email', value: 'scim@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(piiAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO linked_identities'),
        expect.anything()
      );
      const failureAudit = mockCreateAuditLog.mock.calls.find(
        ([, entry]) => entry.action === 'saml.identity_resolution.failed'
      )?.[1];
      expect(failureAudit).toBeTruthy();
      const auditMetadata = JSON.parse(failureAudit.metadata);
      expect(auditMetadata).toEqual(
        expect.objectContaining({
          protocol: 'saml',
          failure_reason: 'email_linking_disabled',
          policy: 'jit_create_only',
        })
      );
      expect(failureAudit.metadata).not.toContain('persistent-subject-789');
      expect(failureAudit.metadata).not.toContain('scim@example.com');
      expect(failureAudit.metadata).not.toContain('provider_user_key');
    });

    it('should fail closed when email matches a local user with unverified email', async () => {
      const scimUser = {
        id: 'scim-user-002',
        email: 'unverified@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: false,
      };
      mockRuntimeUsersById.set('scim-user-002', scimUser);
      mockRuntimeUsersByEmail.set('unverified@example.com', scimUser);
      const coreAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('SELECT id, email_verified FROM users_core WHERE id')) {
            return { id: 'scim-user-002', email_verified: 0 };
          }
          return null;
        },
      });
      const piiAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            return { id: 'scim-user-002' };
          }
          return null;
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-unverified',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          attributes: [{ name: 'email', value: 'unverified@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(piiAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO linked_identities'),
        expect.anything()
      );
    });

    it('should fail closed when an existing SAML link email conflicts with another user', async () => {
      const nameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
      const providerUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-conflict')}`;
      mockRuntimeUsersById.set('linked-user-001', {
        id: 'linked-user-001',
        email: 'linked@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      });
      mockRuntimeUsersByEmail.set('other-user@example.com', {
        id: 'different-user-001',
        email: 'other-user@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      });
      const coreAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('SELECT id, email_verified FROM users_core WHERE id')) {
            return { id: 'linked-user-001', email_verified: 1 };
          }
          return null;
        },
      });
      const piiAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('SELECT id, user_id, provider_user_id FROM linked_identities')) {
            expect(params).toEqual(['default', 'https://idp.example.com', providerUserKey]);
            return { id: 'saml-link-001', user_id: 'linked-user-001' };
          }
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            return { id: 'different-user-001' };
          }
          return null;
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-conflict',
          nameIdFormat,
          attributes: [{ name: 'email', value: 'other-user@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(mockValidateCustomClaimWrite).not.toHaveBeenCalled();
      expect(piiAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE linked_identities'),
        expect.anything()
      );
    });

    it('should fail closed when email match user has another subject for the same IdP', async () => {
      const nameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
      const providerUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-new-link')}`;
      const previousProviderUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-old-link')}`;
      const scimUser = {
        id: 'scim-user-003',
        email: 'scim-user-003@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      };
      mockRuntimeUsersById.set('scim-user-003', scimUser);
      mockRuntimeUsersByEmail.set('scim-user-003@example.com', scimUser);
      const coreAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('SELECT id, email_verified FROM users_core WHERE id')) {
            return { id: 'scim-user-003', email_verified: 1 };
          }
          return null;
        },
      });
      const piiAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?')) {
            expect(params).toEqual(['default', 'https://idp.example.com', providerUserKey]);
            return null;
          }
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            return { id: 'scim-user-003' };
          }
          if (sql.includes('WHERE tenant_id = ? AND user_id = ? AND provider_id = ?')) {
            expect(params).toEqual(['default', 'scim-user-003', 'https://idp.example.com']);
            return {
              id: 'existing-provider-link',
              user_id: 'scim-user-003',
              provider_user_id: previousProviderUserKey,
            };
          }
          return null;
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-new-link',
          nameIdFormat,
          attributes: [{ name: 'email', value: 'scim-user-003@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(piiAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO linked_identities'),
        expect.anything()
      );
    });

    it('should fail closed when linked identity insert races with another user', async () => {
      const nameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
      const providerUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-race')}`;
      let lookupCount = 0;
      const scimUser = {
        id: 'scim-user-004',
        email: 'scim-user-004@example.com',
        active: true,
        lifecycle_state: 'active',
        email_verified: true,
      };
      mockRuntimeUsersById.set('scim-user-004', scimUser);
      mockRuntimeUsersByEmail.set('scim-user-004@example.com', scimUser);
      const coreAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('SELECT id, email_verified FROM users_core WHERE id')) {
            return { id: 'scim-user-004', email_verified: 1 };
          }
          return null;
        },
      });
      const piiAdapter = createMockAdapter({
        queryOne: (sql) => {
          if (sql.includes('WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?')) {
            lookupCount += 1;
            return lookupCount === 1
              ? null
              : {
                  id: 'raced-provider-link',
                  user_id: 'different-user-004',
                  provider_user_id: providerUserKey,
                };
          }
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            return { id: 'scim-user-004' };
          }
          return null;
        },
        execute: (sql) => {
          if (sql.includes('INSERT INTO linked_identities')) {
            throw new Error('UNIQUE constraint failed: linked_identities');
          }
          return { rowsAffected: 1, insertId: undefined };
        },
      });
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-race',
          nameIdFormat,
          attributes: [{ name: 'email', value: 'scim-user-004@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(lookupCount).toBe(2);
    });

    it('should not directly delete a Control Plane account when lifecycle sync fails', async () => {
      mockSyncUserLifecycleState.mockRejectedValueOnce(new Error('lifecycle sync failed'));

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-sync-fail',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          attributes: [{ name: 'email', value: 'sync-fail@example.com' }],
        })
      );

      expect(res.status).toBe(500);
      expect(mockProvisionAuthAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'sync-fail@example.com',
          flow: 'saml',
        })
      );
      expect(mockRuntimeDeleteUser).not.toHaveBeenCalled();
    });

    it('should reject new SAML users when JIT and linking are disabled for the IdP', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        jitEmailLinkingPolicy: 'disabled',
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
      });
      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-disabled',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          attributes: [{ name: 'email', value: 'new-disabled@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(mockValidateCustomClaimWrite).not.toHaveBeenCalled();
      expect(mockProvisionAuthAccount).not.toHaveBeenCalled();
    });

    it('should fail closed when stored IdP JIT linking policy is invalid', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        jitEmailLinkingPolicy: 'unsafe_email_takeover',
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
      } as any);
      const coreAdapter = createMockAdapter();
      const piiAdapter = createMockAdapter();
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-invalid-policy',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          attributes: [{ name: 'email', value: 'invalid-policy@example.com' }],
        })
      );

      expect(res.status).toBe(400);
      expect(mockValidateCustomClaimWrite).not.toHaveBeenCalled();
      expect(coreAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users_core'),
        expect.anything()
      );
      const failureAudit = mockCreateAuditLog.mock.calls.find(
        ([, entry]) => entry.action === 'saml.identity_resolution.failed'
      )?.[1];
      expect(failureAudit).toBeTruthy();
      expect(JSON.parse(failureAudit.metadata)).toMatchObject({
        protocol: 'saml',
        failure_reason: 'jit_policy_invalid',
        policy: 'invalid',
      });
      expect(failureAudit.metadata).not.toContain('unsafe_email_takeover');
      expect(failureAudit.metadata).not.toContain('invalid-policy@example.com');
      expect(failureAudit.metadata).not.toContain('persistent-subject-invalid-policy');
    });

    it('should create a SAML linked identity for newly JIT-provisioned users', async () => {
      const nameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
      const providerUserKey = `saml:${encodeURIComponent(nameIdFormat)}:${encodeURIComponent('persistent-subject-new')}`;

      const res = await callACSDirectly(
        createMockSAMLResponse({
          nameId: 'persistent-subject-new',
          nameIdFormat,
          attributes: [{ name: 'email', value: 'new-user@example.com' }],
        })
      );

      expect(res.status).toBe(302);
      expect(mockProvisionAuthAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new-user@example.com',
          flow: 'saml',
          runtimeUser: expect.objectContaining({
            emailVerified: true,
            sourceRef: 'auth:saml',
          }),
        })
      );
      expect(mockPublishExternalIdpRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          providerId: 'https://idp.example.com',
          providerUserId: providerUserKey,
        })
      );
      expect(mockSyncUserLifecycleState).toHaveBeenCalled();
    });
  });

  describe('Metadata endpoints', () => {
    it('should return SP metadata XML', async () => {
      const req = new Request('http://localhost/saml/sp/metadata');

      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/samlmetadata+xml');
      expect(res.headers.get('ETag')).toMatch(/^W\/"saml-metadata-[a-z0-9]+"$/);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      const body = await res.text();
      expect(body).toContain('<md:EntityDescriptor');
      expect(body).toContain('xml:lang="en"');
      expect(body).toContain('https://auth.example.com/saml/sp');
    });

    it('should return IdP metadata XML', async () => {
      const req = new Request('http://localhost/saml/idp/metadata');

      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/samlmetadata+xml');
      expect(res.headers.get('ETag')).toMatch(/^W\/"saml-metadata-[a-z0-9]+"$/);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      const body = await res.text();
      expect(body).toContain('<md:EntityDescriptor');
      expect(body).toContain('xml:lang="en"');
      expect(body).toContain('https://auth.example.com/saml/idp');
    });

    it('should return 304 when metadata If-None-Match matches the current ETag', async () => {
      const firstRes = await app.fetch(new Request('http://localhost/saml/sp/metadata'));
      const etag = firstRes.headers.get('ETag');

      const secondRes = await app.fetch(
        new Request('http://localhost/saml/sp/metadata', {
          headers: {
            'If-None-Match': etag ?? '',
          },
        })
      );

      expect(etag).toMatch(/^W\/"saml-metadata-[a-z0-9]+"$/);
      expect(secondRes.status).toBe(304);
      expect(secondRes.headers.get('ETag')).toBe(etag);
    });

    it('should reject metadata when public X-Tenant-Id conflicts with resolved tenant context', async () => {
      await expect(
        callMetadataDirectly(handleIdPMetadata, {
          tenantId: 'tenant-a',
          headerTenantId: 'tenant-b',
        })
      ).rejects.toThrow('SAML tenant header conflicts with resolved tenant context');
      await expect(
        callMetadataDirectly(handleSPMetadata, {
          tenantId: 'tenant-a',
          headerTenantId: 'tenant-b',
        })
      ).rejects.toThrow('SAML tenant header conflicts with resolved tenant context');

      expect(mockGetSigningKey).not.toHaveBeenCalled();
      expect(mockGetSigningCertificate).not.toHaveBeenCalled();
    });

    it('should not use public X-Tenant-Id to select metadata signing keys', async () => {
      const res = await callMetadataDirectly(handleSPMetadata, {
        headerTenantId: 'tenant-b',
        env: {
          DEFAULT_TENANT_ID: 'tenant-default',
        },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('https://auth.example.com/saml/sp');
      expect(mockGetSigningKey).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-default',
        expect.objectContaining({
          keyRef: 'tenant:tenant-default:saml:sp:signing',
        })
      );
      expect(mockGetSigningCertificate).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-default',
        expect.objectContaining({
          keyRef: 'tenant:tenant-default:saml:sp:signing',
        })
      );
      expect(mockGetSigningKey).not.toHaveBeenCalledWith(
        expect.anything(),
        'tenant-b',
        expect.anything()
      );
      expect(mockGetSigningCertificate).not.toHaveBeenCalledWith(
        expect.anything(),
        'tenant-b',
        expect.anything()
      );
    });

    it('should fail closed for IdP and SP metadata when BASE_DOMAIN is set without request context', async () => {
      await expect(
        callMetadataDirectly(handleIdPMetadata, {
          env: {
            BASE_DOMAIN: 'auth.example.com',
            DEFAULT_TENANT_ID: 'tenant-default',
          },
        })
      ).rejects.toThrow('multi-tenant runtime requires request context resolution');
      await expect(
        callMetadataDirectly(handleSPMetadata, {
          env: {
            BASE_DOMAIN: 'auth.example.com',
            DEFAULT_TENANT_ID: 'tenant-default',
          },
        })
      ).rejects.toThrow('multi-tenant runtime requires request context resolution');

      expect(mockGetSigningKey).not.toHaveBeenCalled();
      expect(mockGetSigningCertificate).not.toHaveBeenCalled();
    });

    it.each([
      ['next', 'tenant:tenant-b:saml:idp:next:signing'],
      ['backup', 'tenant:tenant-b:saml:idp:backup:signing'],
    ] as const)(
      'should reject metadata certificate publication when %s keyRef belongs to another tenant',
      async (slot, keyRef) => {
        await expect(
          getSAMLMetadataSigningCertificates(mockEnv as Env, {
            tenantId: 'tenant-a',
            role: 'idp',
            policy: {
              metadataCertificatePublication:
                slot === 'next' ? 'active_next' : 'active_next_backup',
              [slot]: {
                slot,
                keyRef,
              },
            },
          })
        ).rejects.toThrow('SAML signing key reference must be tenant-scoped');
      }
    );
  });

  describe('POST /saml/sp/slo - Single Logout (POST Binding)', () => {
    it('should reject request without SAMLRequest or SAMLResponse', async () => {
      const formData = new FormData();

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('missing');
    });

    it('should reject LogoutRequest from unknown IdP', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValue(null);

      const formData = new FormData();
      formData.append(
        'SAMLRequest',
        createMockLogoutRequest({
          issuer: 'https://unknown-idp.example.com',
        })
      );

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.SAML_RESPONSE_INVALID uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject expired LogoutRequest', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLRequest',
        createMockLogoutRequest({
          issueInstant: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
        })
      );

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      // Should return error due to expired request
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject LogoutRequest with invalid Destination', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLRequest',
        createMockLogoutRequest({
          destination: 'https://wrong-destination.com/slo',
        })
      );

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject unsigned LogoutRequest when IdP signature policy is omitted', async () => {
      mockGetIdPConfigByEntityId.mockResolvedValueOnce({
        entityId: 'https://idp.example.com',
        ssoUrl: 'https://idp.example.com/sso',
        sloUrl: 'https://idp.example.com/slo',
        certificate: 'mock-certificate',
        attributeMapping: {
          email: 'email',
          name: 'displayName',
        },
      });

      const formData = new FormData();
      formData.append('SAMLRequest', createMockLogoutRequest());

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(mockSessionStoreFetch).not.toHaveBeenCalled();
    });

    it('should process valid LogoutRequest and send LogoutResponse', async () => {
      const formData = new FormData();
      formData.append('SAMLRequest', createMockLogoutRequest());

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      // Should return HTML with auto-submit form containing LogoutResponse
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0'); // Cookie cleared

      const html = await res.text();
      expect(html).toContain('SAMLResponse');
      expect(html).toContain('form');
    });

    it('should resolve user lookup from the account route without a static PII binding', async () => {
      const runtimePiiAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            expect(params).toEqual(['default', 'user@example.com']);
            return { id: 'user-001' };
          }
          return null;
        },
      });

      mockEnv.TDB_TEST_PII = undefined;
      mockResolveAccountDataContextByIdentifier.mockResolvedValueOnce({
        coreDb: mockEnv.TDB_TEST_CORE,
        piiDb: runtimePiiAdapter,
      });

      const formData = new FormData();
      formData.append('SAMLRequest', createMockLogoutRequest());

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      expect(mockResolveAccountDataContextByIdentifier).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({ tenantId: 'default', indexKind: 'email_exact' })
      );
      expect(runtimePiiAdapter.queryOne).toHaveBeenCalled();
    });

    it('should process LogoutResponse and redirect', async () => {
      const formData = new FormData();
      formData.append('SAMLResponse', createMockLogoutResponse());
      formData.append('RelayState', '_request_123');

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://app.example.com/logged-out');
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0'); // Cookie cleared
    });

    it('should reject LogoutResponse when InResponseTo does not match stored SP LogoutRequest', async () => {
      const formData = new FormData();
      formData.append(
        'SAMLResponse',
        createMockLogoutResponse({
          inResponseTo: '_unknown_request',
        })
      );

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('POST /saml/idp/slo - Single Logout (POST Binding)', () => {
    it('should isolate outbound LogoutResponse correlation by tenant for the same requestId', async () => {
      const requestId = '_shared_logout_request';
      const tenantAKey = `saml:logout-request:tenant:tenant-a:id:${requestId}`;
      const tenantBKey = `saml:logout-request:tenant:tenant-b:id:${requestId}`;
      const stateStoreGet = vi.fn(async (key: string) => {
        if (key === tenantAKey) {
          return JSON.stringify({
            version: 1,
            tenantId: 'tenant-a',
            spEntityId: 'https://sp.example.com/saml',
            requestId,
            issuedAt: Date.now() - 1000,
            expiresAt: Date.now() + 120000,
          });
        }
        return null;
      });
      const stateStoreDelete = vi.fn();

      mockEnv.STATE_STORE = {
        get: stateStoreGet,
        delete: stateStoreDelete,
        put: vi.fn(),
      } as unknown as Env['STATE_STORE'];

      const response = await callIdPSLODirectly(
        createMockLogoutResponse({
          issuer: 'https://sp.example.com/saml',
          inResponseTo: requestId,
        }),
        { tenantId: 'tenant-b' }
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'invalid_request',
        error_code: 'AR130003',
      });
      expect(stateStoreGet).toHaveBeenCalledWith(tenantBKey);
      expect(stateStoreGet).not.toHaveBeenCalledWith(tenantAKey);
      expect(stateStoreDelete).not.toHaveBeenCalled();
    });
  });

  describe('GET /saml/sp/slo - Single Logout (Redirect Binding)', () => {
    it('should reject request without SAMLRequest or SAMLResponse', async () => {
      const req = new Request('http://localhost/saml/sp/slo');

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('missing');
    });

    // Note: HTTP-Redirect binding tests require DEFLATE compression which is complex to test.
    // The POST binding tests above provide comprehensive coverage of the SLO logic.
    // HTTP-Redirect binding parsing uses the same validation logic as POST binding.
  });

  describe('SAML Error Response Format', () => {
    it('should return consistent error format for ACS errors', async () => {
      const formData = new FormData();
      // Empty form to trigger error

      const req = new Request('http://localhost/saml/sp/acs', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body).toHaveProperty('error');
    });

    it('should return consistent error format for SLO errors', async () => {
      const formData = new FormData();
      // Empty form to trigger error

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body).toHaveProperty('error');
    });
  });

  describe('RelayState Handling', () => {
    it('should preserve RelayState in ACS redirect', async () => {
      const relayState = 'https://auth.example.com/original-page?param=value';

      // Use direct handler call to ensure mocks are properly applied
      const res = await callACSDirectly(createMockSAMLResponse(), relayState);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(relayState);
    });

    it('should reject ACS RelayState that exceeds the SAML binding limit', async () => {
      const res = await callACSDirectly(createMockSAMLResponse(), 'x'.repeat(81));

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'invalid_request',
      });
    });

    it('should preserve RelayState in SLO response', async () => {
      const relayState = 'https://app.example.com/post-logout';

      const formData = new FormData();
      formData.append('SAMLRequest', createMockLogoutRequest());
      formData.append('RelayState', relayState);

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      const html = await res.text();
      expect(html).toContain('RelayState');
      expect(html).toContain(relayState);
    });
  });
});
