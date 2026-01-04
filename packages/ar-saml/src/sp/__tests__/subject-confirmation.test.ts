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
    audience = 'https://auth.example.com/saml/sp',
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
  ID="${id}"
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
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock IdP config
    mockGetIdPConfigByEntityId.mockImplementation(async (_env: unknown, entityId: string) => {
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
    };
  });

  /**
   * Helper to create request and call ACS
   */
  async function callACS(samlResponse: string): Promise<Response> {
    const formData = new FormData();
    formData.append('SAMLResponse', samlResponse);

    // Create minimal Hono-like context
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
  ID="_resp"
  Version="2.0"
  IssueInstant="${new Date().toISOString()}"
  Destination="https://auth.example.com/saml/sp/acs">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
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

    // Note: InResponseTo matching is already implemented in acs.ts
    // In non-strict mode, it logs a warning and continues for IdP-initiated SSO compatibility
    // In strict mode, it rejects the request
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

    it('should accept when InResponseTo does not match (non-strict mode for IdP-initiated SSO)', async () => {
      // Non-strict mode: InResponseTo validation failure logs warning but continues
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

      // Non-strict mode: should succeed (302 redirect)
      expect(res.status).toBe(302);
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
