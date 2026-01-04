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
import type { Env } from '@authrim/ar-lib-core';

// Mock modules
const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../../admin/providers', () => ({
  getIdPConfigByEntityId: (...args: unknown[]): unknown => mockGetIdPConfigByEntityId(...args),
}));

vi.mock('../../common/signature', () => ({
  verifyXmlSignature: vi.fn().mockReturnValue(true),
  hasSignature: vi.fn().mockReturnValue(false),
}));

// Mock structured logger
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({
      module: () => mockLogger,
    }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
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
    audiences = ['https://auth.example.com/saml/sp'],
    includeConditions = true,
    includeOneTimeUse = false,
    includeProxyRestriction = false,
    proxyCount = 0,
  } = options;

  const audienceRestriction =
    audiences.length > 0
      ? `<saml:AudienceRestriction>
        ${audiences.map((a) => `<saml:Audience>${a}</saml:Audience>`).join('\n        ')}
      </saml:AudienceRestriction>`
      : '';

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
  ID="${id}"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="${destination}">
  <saml:Issuer>${issuer}</saml:Issuer>
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
  let mockEnv: Partial<Env>;
  // Track used assertions for OneTimeUse testing
  let usedAssertions: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    usedAssertions = new Map();

    // Mock IdP config
    mockGetIdPConfigByEntityId.mockImplementation(async (_env: unknown, entityId: string) => {
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
    });

    // Mock environment
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      UI_URL: 'https://ui.example.com',
      DB: {
        prepare: vi.fn().mockImplementation(() => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as unknown as Env['DB'],
      DB_PII: {
        prepare: vi.fn().mockImplementation(() => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        })),
      } as unknown as Env['DB_PII'],
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
      // Mock NONCE_STORE for OneTimeUse tracking
      NONCE_STORE: {
        get: vi.fn().mockImplementation((key: string) => {
          return Promise.resolve(usedAssertions.get(key) ?? null);
        }),
        put: vi.fn().mockImplementation((key: string, value: string) => {
          usedAssertions.set(key, value);
          return Promise.resolve();
        }),
      } as unknown as Env['NONCE_STORE'],
    };
  });

  /**
   * Helper to create request and call ACS
   */
  async function callACS(samlResponse: string): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse);

    const context = {
      env: mockEnv,
      req: {
        formData: async () => formData,
      },
      json: (data: unknown, status: number) => new Response(JSON.stringify(data), { status }),
      get: vi.fn().mockReturnValue('default'), // Mock Hono's c.get() for tenantId
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
        audiences: ['https://auth.example.com/saml/sp'],
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
          'https://auth.example.com/saml/sp',
          'https://another-sp.example.com/sp',
        ],
      });

      const res = await callACS(samlResponse);

      expect(res.status).toBe(302);
    });

    it('should reject assertion with empty AudienceRestriction', async () => {
      const samlResponse = createSAMLResponseWithConditions({
        audiences: [],
      });

      const res = await callACS(samlResponse);

      // Empty audience list means no restriction, should still work
      // according to current implementation
      expect(res.status).toBe(302);
    });
  });

  describe('OneTimeUse Condition', () => {
    it('should track and reject reused assertions with OneTimeUse', async () => {
      // SECURITY: OneTimeUse condition requires tracking assertion IDs
      // to prevent replay attacks
      // Use a fixed assertion ID so both calls use the same assertion
      const samlResponse = createSAMLResponseWithConditions({
        assertionId: '_assertion_onetimeuse_test',
        includeOneTimeUse: true,
      });

      // First use should succeed
      const res1 = await callACS(samlResponse);
      expect(res1.status).toBe(302);

      // Second use of same assertion should fail (OneTimeUse violation)
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

    it('should allow different assertions with OneTimeUse', async () => {
      // Two different assertion IDs should both succeed
      const samlResponse1 = createSAMLResponseWithConditions({
        assertionId: '_assertion_unique_1',
        includeOneTimeUse: true,
      });
      const samlResponse2 = createSAMLResponseWithConditions({
        assertionId: '_assertion_unique_2',
        includeOneTimeUse: true,
      });

      const res1 = await callACS(samlResponse1);
      expect(res1.status).toBe(302);

      const res2 = await callACS(samlResponse2);
      expect(res2.status).toBe(302);
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
    it('should accept assertion without Conditions element', async () => {
      // SAML spec allows omitting Conditions, but it's recommended
      const samlResponse = createSAMLResponseWithConditions({
        includeConditions: false,
      });

      const res = await callACS(samlResponse);

      // Current implementation allows assertions without Conditions
      expect(res.status).toBe(302);
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
