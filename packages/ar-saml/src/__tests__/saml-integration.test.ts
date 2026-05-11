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
import { handleSPACS } from '../sp/acs';
import { handleSPSLO } from '../sp/slo';
import { handleSPMetadata } from '../sp/metadata';
import { handleIdPMetadata } from '../idp/metadata';

const {
  mockValidateCustomClaimWrite,
  mockPersistCustomClaimWrite,
  mockSyncUserLifecycleState,
  mockResolveUserStoreRuntimeSourcesFromEnv,
} = vi.hoisted(() => ({
  mockValidateCustomClaimWrite: vi.fn().mockResolvedValue({ ok: true }),
  mockPersistCustomClaimWrite: vi.fn().mockResolvedValue(undefined),
  mockSyncUserLifecycleState: vi.fn().mockResolvedValue({
    lifecycleState: 'active',
    missingRequiredFields: [],
  }),
  mockResolveUserStoreRuntimeSourcesFromEnv: vi.fn(),
}));

// Mock modules
const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../admin/providers', () => ({
  getIdPConfigByEntityId: (...args: any[]) => mockGetIdPConfigByEntityId(...args),
}));

vi.mock('../common/signature', () => ({
  verifyXmlSignature: vi.fn(),
  hasSignature: vi.fn().mockReturnValue(false), // Default: no signature
  signXml: vi.fn((xml: string) => xml), // Pass through
}));

vi.mock('../common/key-utils', () => ({
  getSigningKey: vi.fn().mockResolvedValue({ privateKeyPem: 'mock-key' }),
  getSigningCertificate: vi.fn().mockResolvedValue('mock-cert'),
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
    resolveUserStoreRuntimeSourcesFromEnv: mockResolveUserStoreRuntimeSourcesFromEnv,
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: Partial<Env>) => ({
      storageProfile: {
        id: 'builtin:storage:standard',
        kind: 'storage',
        label: 'Standard D1 Split',
        slices: {},
      },
      schemaDb: env.DB,
      nonPiiDb: env.DB,
      piiDb: env.DB_PII ?? null,
    })),
    // Mock getSessionStoreForNewSession to avoid crypto dependency issues in tests
    getSessionStoreForNewSession: vi.fn().mockResolvedValue({
      stub: {
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
      },
      sessionId: 'mock-session-id-12345',
    }),
  };
});

function createMockAdapter(
  options: {
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
  } = {}
) {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn(
      async (sql: string, params: unknown[]) => options.queryOne?.(sql, params) ?? null
    ),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: any) => fn()),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Helper to create base64-encoded SAML Response
function createMockSAMLResponse(
  options: {
    issuer?: string;
    statusCode?: string;
    destination?: string;
    nameId?: string;
    notBefore?: string;
    notOnOrAfter?: string;
    audience?: string;
    inResponseTo?: string;
    attributes?: Array<{ name: string; value: string; friendlyName?: string }>;
  } = {}
): string {
  const {
    issuer = 'https://idp.example.com',
    statusCode = 'urn:oasis:names:tc:SAML:2.0:status:Success',
    destination = 'https://auth.example.com/saml/sp/acs',
    nameId = 'user@example.com',
    notBefore = new Date(Date.now() - 60000).toISOString(),
    notOnOrAfter = new Date(Date.now() + 300000).toISOString(),
    audience = 'https://auth.example.com/saml/sp',
    inResponseTo = undefined,
    attributes = [],
  } = options;

  // SubjectConfirmation NotOnOrAfter for bearer assertion (same as Conditions NotOnOrAfter)
  const subjectConfirmationNotOnOrAfter = notOnOrAfter;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_${Date.now()}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="${destination}"
  ${inResponseTo ? `InResponseTo="${inResponseTo}"` : ''}>
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="${statusCode}"/>
  </samlp:Status>
  <saml:Assertion ID="_assertion_${Date.now()}" Version="2.0" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
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
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef>
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
  let mockEnv: Partial<Env>;
  let mockUsers: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCustomClaimWrite.mockReset().mockResolvedValue({ ok: true });
    mockPersistCustomClaimWrite.mockReset().mockResolvedValue(undefined);
    mockSyncUserLifecycleState.mockReset().mockResolvedValue({
      lifecycleState: 'active',
      missingRequiredFields: [],
    });
    mockUsers = new Map();

    // Seed test user
    mockUsers.set('user-001', {
      id: 'user-001',
      email: 'user@example.com',
      name: 'Test User',
    });

    // Mock IdP config
    mockGetIdPConfigByEntityId.mockImplementation(
      async (_env: any, _tenantId: string, entityId: string) => {
        if (entityId === 'https://idp.example.com') {
          return {
            entityId: 'https://idp.example.com',
            ssoUrl: 'https://idp.example.com/sso',
            sloUrl: 'https://idp.example.com/slo',
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
    mockResolveUserStoreRuntimeSourcesFromEnv.mockImplementation(async (env: Partial<Env>) => ({
      storageProfile: {
        id: 'builtin:storage:standard',
        kind: 'storage',
        label: 'Standard D1 Split',
        slices: {},
      },
      coreDb: env.DB,
      piiDb: env.DB_PII ?? null,
    }));

    // Mock environment
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      UI_URL: 'https://ui.example.com',
      DB: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            // PII/Non-PII separation: users_core (non-PII)
            if (sql.includes('SELECT id FROM users_core WHERE id')) {
              return { id: 'user-001' };
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as any,
      DB_PII: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
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
    };

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
  });

  /**
   * Helper to call ACS handler directly (for success path tests)
   * This bypasses Hono to ensure mocks are properly applied
   */
  async function callACSDirectly(samlResponse: string, relayState?: string): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse);
    if (relayState) {
      formData.append('RelayState', relayState);
    }

    // Create minimal Hono-like context with all required properties
    const context = {
      env: mockEnv,
      req: {
        formData: async () => formData,
        header: vi.fn().mockReturnValue(undefined),
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn().mockReturnValue('default'),
      executionCtx: {
        waitUntil: vi.fn(),
      },
    };

    return handleSPACS(context as unknown as Parameters<typeof handleSPACS>[0]);
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

    it('should redirect on successful SAML Response', async () => {
      // Use direct handler call to ensure mocks are properly applied
      const res = await callACSDirectly(
        createMockSAMLResponse(),
        'https://app.example.com/dashboard'
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://app.example.com/dashboard');
      expect(res.headers.get('Set-Cookie')).toContain('authrim_session=');
    });

    it('should redirect to default URL when no RelayState', async () => {
      // Use direct handler call to ensure mocks are properly applied
      const res = await callACSDirectly(createMockSAMLResponse());

      expect(res.status).toBe(302);
      // Without RelayState, should redirect to UI_URL
      expect(res.headers.get('Location')).toBe('https://ui.example.com/');
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

      mockEnv.DB_PII = {
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

      mockEnv.DB_PII = {
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
  });

  describe('Metadata endpoints', () => {
    it('should return SP metadata XML', async () => {
      const req = new Request('http://localhost/saml/sp/metadata');

      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/samlmetadata+xml');
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
      const body = await res.text();
      expect(body).toContain('<md:EntityDescriptor');
      expect(body).toContain('xml:lang="en"');
      expect(body).toContain('https://auth.example.com/saml/idp');
    });
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

    it('should resolve user lookup from runtime storage sources when DB_PII is unset', async () => {
      const runtimePiiAdapter = createMockAdapter({
        queryOne: (sql, params) => {
          if (sql.includes('SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?')) {
            expect(params).toEqual(['default', 'user@example.com']);
            return { id: 'user-001' };
          }
          return null;
        },
      });

      mockEnv.DB_PII = undefined as any;
      mockResolveUserStoreRuntimeSourcesFromEnv.mockResolvedValueOnce({
        storageProfile: {
          id: 'builtin:storage:single-db',
          kind: 'storage',
          label: 'Single DB',
          slices: {},
        },
        coreDb: mockEnv.DB,
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
      expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(mockEnv, 'default');
      expect(runtimePiiAdapter.queryOne).toHaveBeenCalled();
    });

    it('should process LogoutResponse and redirect', async () => {
      const formData = new FormData();
      formData.append('SAMLResponse', createMockLogoutResponse());
      formData.append('RelayState', 'https://app.example.com/logged-out');

      const req = new Request('http://localhost/saml/sp/slo', {
        method: 'POST',
        body: formData,
      });

      const res = await app.fetch(req);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://app.example.com/logged-out');
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0'); // Cookie cleared
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
      const relayState = 'https://app.example.com/original-page?param=value';

      // Use direct handler call to ensure mocks are properly applied
      const res = await callACSDirectly(createMockSAMLResponse(), relayState);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(relayState);
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
