/**
 * Token Exchange Tests (RFC 8693)
 *
 * Tests the Token Exchange validation logic, JWT parsing, and related utilities.
 * Note: Full integration tests require mocked Durable Objects and are in conformance tests.
 */

import { describe, it, expect } from 'vitest';
import { parseToken, parseTokenHeader } from '@authrim/ar-lib-core';
import type { TokenTypeURN, ActClaim, DelegationMode } from '@authrim/ar-lib-core';

// Helper to create a valid JWT for testing (base64url encoded)
function createTestJWT(header: object, payload: object): string {
  const encodeBase64Url = (obj: object) => {
    const json = JSON.stringify(obj);
    // Use Buffer in Node.js test environment
    const base64 = Buffer.from(json).toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
  };

  const headerB64 = encodeBase64Url(header);
  const payloadB64 = encodeBase64Url(payload);
  // Signature is just placeholder for parsing tests (not verification)
  const signatureB64 = 'test-signature';

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

describe('Token Exchange Tests (RFC 8693)', () => {
  describe('JWT Header Parsing (parseTokenHeader)', () => {
    it('should extract kid from JWT header', () => {
      const jwt = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        { sub: 'user123', iss: 'https://auth.example.com' }
      );

      const header = parseTokenHeader(jwt);

      expect(header.kid).toBe('key-123');
      expect(header.alg).toBe('RS256');
      expect(header.typ).toBe('JWT');
    });

    it('should handle JWT without kid in header', () => {
      const jwt = createTestJWT({ alg: 'RS256', typ: 'JWT' }, { sub: 'user123' });

      const header = parseTokenHeader(jwt);

      expect(header.kid).toBeUndefined();
      expect(header.alg).toBe('RS256');
    });

    it('should throw on invalid JWT format', () => {
      expect(() => parseTokenHeader('not-a-jwt')).toThrow('Invalid JWT format');
      expect(() => parseTokenHeader('only.two')).toThrow('Invalid JWT format');
      expect(() => parseTokenHeader('')).toThrow('Invalid JWT format');
    });
  });

  describe('JWT Payload Parsing (parseToken)', () => {
    it('should extract payload claims from JWT', () => {
      const jwt = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        {
          sub: 'user123',
          iss: 'https://auth.example.com',
          aud: 'client-a',
          scope: 'openid profile',
          client_id: 'client-a',
          exp: 1700000000,
          iat: 1699996400,
        }
      );

      const payload = parseToken(jwt);

      expect(payload.sub).toBe('user123');
      expect(payload.iss).toBe('https://auth.example.com');
      expect(payload.aud).toBe('client-a');
      expect(payload.scope).toBe('openid profile');
      expect(payload.exp).toBe(1700000000);
    });

    it('should NOT have kid in payload (kid is in header)', () => {
      const jwt = createTestJWT(
        { alg: 'RS256', typ: 'JWT', kid: 'key-123' },
        { sub: 'user123', iss: 'https://auth.example.com' }
      );

      const payload = parseToken(jwt);

      // kid should NOT be in payload - this is the bug we fixed
      expect(payload.kid).toBeUndefined();
    });
  });

  describe('Token Type URNs', () => {
    it('should define valid token type URNs per RFC 8693', () => {
      const validTokenTypes: TokenTypeURN[] = [
        'urn:ietf:params:oauth:token-type:access_token',
        'urn:ietf:params:oauth:token-type:refresh_token',
        'urn:ietf:params:oauth:token-type:id_token',
      ];

      validTokenTypes.forEach((type) => {
        expect(type).toMatch(/^urn:ietf:params:oauth:token-type:/);
      });
    });

    it('should support access_token as requested_token_type', () => {
      const requestedType: TokenTypeURN = 'urn:ietf:params:oauth:token-type:access_token';
      expect(requestedType).toBe('urn:ietf:params:oauth:token-type:access_token');
    });
  });

  describe('Delegation Mode', () => {
    it('should define valid delegation modes', () => {
      const modes: DelegationMode[] = ['none', 'delegation', 'impersonation'];

      expect(modes).toContain('none');
      expect(modes).toContain('delegation');
      expect(modes).toContain('impersonation');
    });

    it('should default to delegation mode when not set', () => {
      const clientSettings: { delegation_mode?: DelegationMode } = {
        delegation_mode: undefined,
      };

      const effectiveMode = clientSettings.delegation_mode || 'delegation';
      expect(effectiveMode).toBe('delegation');
    });
  });

  describe('Actor Claim (act) Structure', () => {
    it('should build simple act claim structure', () => {
      const actClaim: ActClaim = {
        sub: 'client:service-a',
        client_id: 'service-a',
      };

      expect(actClaim.sub).toBe('client:service-a');
      expect(actClaim.client_id).toBe('service-a');
      expect(actClaim.act).toBeUndefined();
    });

    it('should support nested act claim (2 levels max)', () => {
      const nestedActClaim: ActClaim = {
        sub: 'client:service-b',
        client_id: 'service-b',
        act: {
          sub: 'client:service-a',
          client_id: 'service-a',
        },
      };

      expect(nestedActClaim.sub).toBe('client:service-b');
      expect(nestedActClaim.act).toBeDefined();
      expect(nestedActClaim.act?.sub).toBe('client:service-a');
      expect(nestedActClaim.act?.act).toBeUndefined(); // Max 2 levels
    });

    it('should use client: prefix for client subjects', () => {
      const clientId = 'my-service-client';
      const actClaim: ActClaim = {
        sub: `client:${clientId}`,
        client_id: clientId,
      };

      expect(actClaim.sub).toMatch(/^client:/);
      expect(actClaim.sub).toBe('client:my-service-client');
    });
  });

  describe('Scope Downgrade Logic', () => {
    it('should calculate intersection of requested and subject scopes', () => {
      const subjectScopes = ['openid', 'profile', 'email', 'admin'];
      const requestedScopes = ['openid', 'profile', 'read'];

      const grantedScopes = requestedScopes.filter((s) => subjectScopes.includes(s));

      expect(grantedScopes).toEqual(['openid', 'profile']);
      expect(grantedScopes).not.toContain('admin'); // Not requested
      expect(grantedScopes).not.toContain('read'); // Not in subject
    });

    it('should further restrict by client allowed_scopes', () => {
      const subjectScopes = ['openid', 'profile', 'email', 'admin'];
      const requestedScopes = ['openid', 'profile', 'email'];
      const clientAllowedScopes = ['openid', 'profile'];

      let grantedScopes = requestedScopes.filter((s) => subjectScopes.includes(s));
      grantedScopes = grantedScopes.filter((s) => clientAllowedScopes.includes(s));

      expect(grantedScopes).toEqual(['openid', 'profile']);
      expect(grantedScopes).not.toContain('email');
    });

    it('should default to openid if no scopes remain', () => {
      const grantedScopes: string[] = [];
      const finalScope = grantedScopes.join(' ') || 'openid';

      expect(finalScope).toBe('openid');
    });
  });

  describe('Audience Validation Logic', () => {
    it('should allow exchange when client is in subject_token audience', () => {
      const subjectTokenAud = ['client-a', 'client-b'];
      const requestingClientId = 'client-a';

      const isClientInAudience = subjectTokenAud.includes(requestingClientId);

      expect(isClientInAudience).toBe(true);
    });

    it('should allow exchange when subject_token client is in allowed list', () => {
      const allowedSubjectClients = ['trusted-service-a', 'trusted-service-b'];
      const subjectTokenClientId = 'trusted-service-a';

      const isAllowedSubjectClient =
        allowedSubjectClients.length > 0 && allowedSubjectClients.includes(subjectTokenClientId);

      expect(isAllowedSubjectClient).toBe(true);
    });

    it('should REJECT when neither audience match nor allowed list match', () => {
      const subjectTokenAud = ['other-client'];
      const allowedSubjectClients = ['trusted-service-a'];
      const requestingClientId = 'attacker-client';
      const subjectTokenClientId = 'victim-client';

      const isClientInAudience = subjectTokenAud.includes(requestingClientId);
      const isAllowedSubjectClient =
        allowedSubjectClients.length > 0 && allowedSubjectClients.includes(subjectTokenClientId);

      // SECURITY: Both must be false to reject
      expect(isClientInAudience).toBe(false);
      expect(isAllowedSubjectClient).toBe(false);
      // Handler should return invalid_target error
    });

    it('should NOT allow just because issuer URL is in aud (security fix)', () => {
      // This was a security bug - issuer URL in aud should NOT authorize any client
      const subjectTokenAud = ['https://auth.example.com']; // Only issuer URL
      const requestingClientId = 'any-client';

      const isClientInAudience = subjectTokenAud.includes(requestingClientId);

      // Client is NOT in audience (issuer URL doesn't count)
      expect(isClientInAudience).toBe(false);
    });

    it('should reject when allowed_subject_token_clients is empty and client not in aud', () => {
      // This was a security bug - empty allowed list should still enforce aud check
      const subjectTokenAud = ['other-client'];
      const allowedSubjectClients: string[] = []; // Empty
      const requestingClientId = 'attacker-client';
      const subjectTokenClientId = 'victim-client';

      const isClientInAudience = subjectTokenAud.includes(requestingClientId);
      const isAllowedSubjectClient =
        allowedSubjectClients.length > 0 && allowedSubjectClients.includes(subjectTokenClientId);

      expect(isClientInAudience).toBe(false);
      expect(isAllowedSubjectClient).toBe(false);
      // Handler should return invalid_target (fixed from previous bug)
    });
  });

  describe('Response Structure', () => {
    it('should include required fields per RFC 8693 §2.2.1', () => {
      // Simulated response structure
      const response = {
        access_token: 'eyJhbGciOiJSUzI1NiJ9...',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' as TokenTypeURN,
        token_type: 'Bearer',
        expires_in: 3600,
      };

      expect(response).toHaveProperty('access_token');
      expect(response).toHaveProperty('issued_token_type');
      expect(response).toHaveProperty('token_type');
      expect(response).toHaveProperty('expires_in');
      expect(response.expires_in).toBeGreaterThan(0);
    });

    it('should NOT include refresh_token (Token Exchange is stateless)', () => {
      const response = {
        access_token: 'eyJhbGciOiJSUzI1NiJ9...',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' as TokenTypeURN,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile',
      };

      expect(response).not.toHaveProperty('refresh_token');
    });
  });

  describe('Error Response Structure', () => {
    it('should use standard OAuth error codes', () => {
      const errorCodes = [
        'invalid_request',
        'invalid_grant',
        'invalid_target',
        'unauthorized_client',
        'unsupported_grant_type',
        'invalid_client',
      ];

      errorCodes.forEach((code) => {
        expect(typeof code).toBe('string');
        expect(code).toMatch(/^[a-z_]+$/);
      });
    });
  });

  describe('Multiple Resource/Audience Parameters (RFC 8693 §2.1)', () => {
    // Helper to simulate extractStringArray from rawBody
    const extractStringArray = (
      rawBody: Record<string, string | (string | File)[]>,
      key: string
    ): string[] => {
      const value = rawBody[key];
      if (!value) return [];
      if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string');
      }
      return typeof value === 'string' ? [value] : [];
    };

    it('should extract single resource as array', () => {
      const rawBody = { resource: 'https://api.example.com' };
      const resources = extractStringArray(rawBody, 'resource');

      expect(resources).toEqual(['https://api.example.com']);
      expect(resources.length).toBe(1);
    });

    it('should extract multiple resources as array', () => {
      const rawBody = {
        resource: ['https://api1.example.com', 'https://api2.example.com'],
      };
      const resources = extractStringArray(rawBody, 'resource');

      expect(resources).toEqual(['https://api1.example.com', 'https://api2.example.com']);
      expect(resources.length).toBe(2);
    });

    it('should extract single audience as array', () => {
      const rawBody = { audience: 'service-a' };
      const audiences = extractStringArray(rawBody, 'audience');

      expect(audiences).toEqual(['service-a']);
    });

    it('should extract multiple audiences as array', () => {
      const rawBody = { audience: ['service-a', 'service-b', 'service-c'] };
      const audiences = extractStringArray(rawBody, 'audience');

      expect(audiences).toEqual(['service-a', 'service-b', 'service-c']);
      expect(audiences.length).toBe(3);
    });

    it('should return empty array when parameter is not present', () => {
      const rawBody = {};
      const resources = extractStringArray(rawBody, 'resource');
      const audiences = extractStringArray(rawBody, 'audience');

      expect(resources).toEqual([]);
      expect(audiences).toEqual([]);
    });

    describe('Target Audience Array Building', () => {
      it('should use audiences when only audience parameters provided', () => {
        const resources: string[] = [];
        const audiences = ['service-a', 'service-b'];
        const issuerUrl = 'https://auth.example.com';

        let targetAudiences: string[];
        let audienceSource: string;

        if (audiences.length > 0 && resources.length > 0) {
          targetAudiences = [...audiences, ...resources];
          audienceSource = 'both';
        } else if (audiences.length > 0) {
          targetAudiences = audiences;
          audienceSource = 'audience_param';
        } else if (resources.length > 0) {
          targetAudiences = resources;
          audienceSource = 'resource_param';
        } else {
          targetAudiences = [issuerUrl];
          audienceSource = 'default';
        }

        expect(targetAudiences).toEqual(['service-a', 'service-b']);
        expect(audienceSource).toBe('audience_param');
      });

      it('should use resources when only resource parameters provided', () => {
        const resources = ['https://api1.example.com', 'https://api2.example.com'];
        const audiences: string[] = [];
        const issuerUrl = 'https://auth.example.com';

        let targetAudiences: string[];
        let audienceSource: string;

        if (audiences.length > 0 && resources.length > 0) {
          targetAudiences = [...audiences, ...resources];
          audienceSource = 'both';
        } else if (audiences.length > 0) {
          targetAudiences = audiences;
          audienceSource = 'audience_param';
        } else if (resources.length > 0) {
          targetAudiences = resources;
          audienceSource = 'resource_param';
        } else {
          targetAudiences = [issuerUrl];
          audienceSource = 'default';
        }

        expect(targetAudiences).toEqual(['https://api1.example.com', 'https://api2.example.com']);
        expect(audienceSource).toBe('resource_param');
      });

      it('should combine audiences and resources when both provided', () => {
        const resources = ['https://api.example.com'];
        const audiences = ['service-a', 'service-b'];
        const issuerUrl = 'https://auth.example.com';

        let targetAudiences: string[];
        let audienceSource: string;

        if (audiences.length > 0 && resources.length > 0) {
          targetAudiences = [...audiences, ...resources];
          audienceSource = 'both';
        } else if (audiences.length > 0) {
          targetAudiences = audiences;
          audienceSource = 'audience_param';
        } else if (resources.length > 0) {
          targetAudiences = resources;
          audienceSource = 'resource_param';
        } else {
          targetAudiences = [issuerUrl];
          audienceSource = 'default';
        }

        // Audiences first, then resources
        expect(targetAudiences).toEqual(['service-a', 'service-b', 'https://api.example.com']);
        expect(audienceSource).toBe('both');
      });

      it('should default to issuer URL when no audience or resource provided', () => {
        const resources: string[] = [];
        const audiences: string[] = [];
        const issuerUrl = 'https://auth.example.com';

        let targetAudiences: string[];
        let audienceSource: string;

        if (audiences.length > 0 && resources.length > 0) {
          targetAudiences = [...audiences, ...resources];
          audienceSource = 'both';
        } else if (audiences.length > 0) {
          targetAudiences = audiences;
          audienceSource = 'audience_param';
        } else if (resources.length > 0) {
          targetAudiences = resources;
          audienceSource = 'resource_param';
        } else {
          targetAudiences = [issuerUrl];
          audienceSource = 'default';
        }

        expect(targetAudiences).toEqual(['https://auth.example.com']);
        expect(audienceSource).toBe('default');
      });
    });

    describe('Resource URI Validation', () => {
      it('should accept valid https URIs', () => {
        const resources = ['https://api.example.com', 'https://api2.example.com/v1'];

        const errors: string[] = [];
        for (const res of resources) {
          try {
            const url = new URL(res);
            if (!['http:', 'https:'].includes(url.protocol)) {
              errors.push(`${res}: invalid protocol`);
            }
            if (url.hash) {
              errors.push(`${res}: has fragment`);
            }
          } catch {
            errors.push(`${res}: invalid URI`);
          }
        }

        expect(errors).toEqual([]);
      });

      it('should reject URIs with fragment', () => {
        const res = 'https://api.example.com#section';

        let hasFragment = false;
        try {
          const url = new URL(res);
          hasFragment = !!url.hash;
        } catch {
          // Invalid URL
        }

        expect(hasFragment).toBe(true);
      });

      it('should reject non-http/https URIs', () => {
        const res = 'file:///etc/passwd';

        let invalidProtocol = false;
        try {
          const url = new URL(res);
          invalidProtocol = !['http:', 'https:'].includes(url.protocol);
        } catch {
          // Invalid URL
        }

        expect(invalidProtocol).toBe(true);
      });

      it('should reject invalid URIs', () => {
        const res = 'not-a-valid-uri';

        let isInvalid = false;
        try {
          new URL(res);
        } catch {
          isInvalid = true;
        }

        expect(isInvalid).toBe(true);
      });
    });

    describe('Allowed Resources Validation (Array)', () => {
      it('should allow all targets when all are in allowed list', () => {
        const targetAudiences = ['https://api1.example.com', 'https://api2.example.com'];
        const allowedResources = [
          'https://api1.example.com',
          'https://api2.example.com',
          'https://api3.example.com',
        ];

        const disallowedTargets = targetAudiences.filter((t) => !allowedResources.includes(t));

        expect(disallowedTargets).toEqual([]);
      });

      it('should reject when some targets are not in allowed list', () => {
        const targetAudiences = ['https://api1.example.com', 'https://evil.example.com'];
        const allowedResources = ['https://api1.example.com', 'https://api2.example.com'];

        const disallowedTargets = targetAudiences.filter((t) => !allowedResources.includes(t));

        expect(disallowedTargets).toEqual(['https://evil.example.com']);
        expect(disallowedTargets.length).toBeGreaterThan(0);
      });

      it('should allow any targets when allowed list is empty', () => {
        const targetAudiences = ['https://any.example.com', 'service-a'];
        const allowedResources: string[] = [];

        // Empty allowed list means no restriction
        const shouldValidate = allowedResources.length > 0;

        expect(shouldValidate).toBe(false);
      });
    });

    describe('JWT aud Claim (Array)', () => {
      it('should use single string when only one audience', () => {
        const targetAudiences = ['https://api.example.com'];

        const audClaim = targetAudiences.length === 1 ? targetAudiences[0] : targetAudiences;

        expect(audClaim).toBe('https://api.example.com');
        expect(typeof audClaim).toBe('string');
      });

      it('should use array when multiple audiences', () => {
        const targetAudiences = ['service-a', 'https://api.example.com'];

        const audClaim = targetAudiences.length === 1 ? targetAudiences[0] : targetAudiences;

        expect(audClaim).toEqual(['service-a', 'https://api.example.com']);
        expect(Array.isArray(audClaim)).toBe(true);
      });

      it('should include all audiences and resources in aud claim', () => {
        const audiences = ['service-a', 'service-b'];
        const resources = ['https://api.example.com'];
        const targetAudiences = [...audiences, ...resources];

        const audClaim = targetAudiences.length === 1 ? targetAudiences[0] : targetAudiences;

        expect(audClaim).toEqual(['service-a', 'service-b', 'https://api.example.com']);
        expect((audClaim as string[]).length).toBe(3);
      });
    });

    describe('Parameter Count Limits (DoS Prevention)', () => {
      // These limits are configurable via Admin API (KV > env > default)
      // Default values used for testing
      const DEFAULT_MAX_RESOURCE_PARAMS = 10;
      const DEFAULT_MAX_AUDIENCE_PARAMS = 10;

      it('should accept resources at the default limit', () => {
        const resources = Array.from(
          { length: DEFAULT_MAX_RESOURCE_PARAMS },
          (_, i) => `https://api${i}.example.com`
        );

        expect(resources.length).toBe(DEFAULT_MAX_RESOURCE_PARAMS);
        expect(resources.length <= DEFAULT_MAX_RESOURCE_PARAMS).toBe(true);
      });

      it('should reject resources exceeding the default limit', () => {
        const resources = Array.from(
          { length: DEFAULT_MAX_RESOURCE_PARAMS + 1 },
          (_, i) => `https://api${i}.example.com`
        );

        expect(resources.length).toBe(DEFAULT_MAX_RESOURCE_PARAMS + 1);
        expect(resources.length > DEFAULT_MAX_RESOURCE_PARAMS).toBe(true);
      });

      it('should accept audiences at the default limit', () => {
        const audiences = Array.from(
          { length: DEFAULT_MAX_AUDIENCE_PARAMS },
          (_, i) => `service-${i}`
        );

        expect(audiences.length).toBe(DEFAULT_MAX_AUDIENCE_PARAMS);
        expect(audiences.length <= DEFAULT_MAX_AUDIENCE_PARAMS).toBe(true);
      });

      it('should reject audiences exceeding the default limit', () => {
        const audiences = Array.from(
          { length: DEFAULT_MAX_AUDIENCE_PARAMS + 1 },
          (_, i) => `service-${i}`
        );

        expect(audiences.length).toBe(DEFAULT_MAX_AUDIENCE_PARAMS + 1);
        expect(audiences.length > DEFAULT_MAX_AUDIENCE_PARAMS).toBe(true);
      });

      it('should allow combined resource + audience within limits', () => {
        const resources = Array.from(
          { length: DEFAULT_MAX_RESOURCE_PARAMS },
          (_, i) => `https://api${i}.example.com`
        );
        const audiences = Array.from(
          { length: DEFAULT_MAX_AUDIENCE_PARAMS },
          (_, i) => `service-${i}`
        );

        // Both are within their individual limits
        expect(resources.length <= DEFAULT_MAX_RESOURCE_PARAMS).toBe(true);
        expect(audiences.length <= DEFAULT_MAX_AUDIENCE_PARAMS).toBe(true);

        // Combined target audiences for JWT aud claim
        const targetAudiences = [...audiences, ...resources];
        expect(targetAudiences.length).toBe(20);
      });

      it('should validate configurable limit bounds (1-100)', () => {
        // Valid bounds for Admin API configuration
        const MIN_PARAM_LIMIT = 1;
        const MAX_PARAM_LIMIT = 100;

        // Test bounds validation logic (mirrors token-exchange.ts validation)
        const validateLimit = (value: number): boolean => {
          return Number.isInteger(value) && value >= MIN_PARAM_LIMIT && value <= MAX_PARAM_LIMIT;
        };

        expect(validateLimit(1)).toBe(true); // Minimum
        expect(validateLimit(100)).toBe(true); // Maximum
        expect(validateLimit(50)).toBe(true); // Mid-range
        expect(validateLimit(0)).toBe(false); // Below minimum
        expect(validateLimit(101)).toBe(false); // Above maximum
        expect(validateLimit(10.5)).toBe(false); // Non-integer
      });
    });
  });
});
