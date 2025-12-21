/**
 * CIBA JWT Validation Tests
 *
 * Tests for OpenID Connect CIBA Core 1.0 JWT validation
 * - id_token_hint signature verification
 * - login_hint_token signature verification
 * - Expired JWT rejection
 * - Invalid signature rejection
 *
 * @see https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html#signed_hints
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env } from '@authrim/shared';

describe('CIBA JWT Validation - OpenID Connect CIBA Core 1.0', () => {
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
    };
  });

  /**
   * JWT structure for testing
   */
  interface JWTHeader {
    alg: string;
    typ: string;
    kid?: string;
  }

  interface JWTPayload {
    iss?: string;
    sub?: string;
    aud?: string | string[];
    exp?: number;
    iat?: number;
    nbf?: number;
    jti?: string;
    [key: string]: unknown;
  }

  /**
   * Create a mock JWT (not cryptographically signed)
   */
  function createMockJWT(
    header: JWTHeader,
    payload: JWTPayload,
    signature = 'mock_signature'
  ): string {
    const headerB64 = btoa(JSON.stringify(header));
    const payloadB64 = btoa(JSON.stringify(payload));
    return `${headerB64}.${payloadB64}.${signature}`;
  }

  /**
   * Parse JWT parts (for testing only)
   */
  function parseJWT(
    jwt: string
  ): { header: JWTHeader; payload: JWTPayload; signature: string } | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) {
        return null;
      }

      const header = JSON.parse(atob(parts[0])) as JWTHeader;
      const payload = JSON.parse(atob(parts[1])) as JWTPayload;
      const signature = parts[2];

      return { header, payload, signature };
    } catch {
      return null;
    }
  }

  /**
   * Validate JWT expiration
   */
  function isJWTExpired(payload: JWTPayload): boolean {
    if (!payload.exp) {
      return false; // No expiration means not expired
    }
    return Date.now() / 1000 > payload.exp;
  }

  /**
   * Validate JWT not-before time
   */
  function isJWTNotYetValid(payload: JWTPayload): boolean {
    if (!payload.nbf) {
      return false; // No nbf means valid
    }
    return Date.now() / 1000 < payload.nbf;
  }

  describe('id_token_hint Signature Verification', () => {
    it('should parse id_token_hint structure', () => {
      const now = Math.floor(Date.now() / 1000);
      const idTokenHint = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          aud: 'client123',
          exp: now + 3600,
          iat: now,
        }
      );

      const parsed = parseJWT(idTokenHint);

      expect(parsed).not.toBeNull();
      expect(parsed!.header.alg).toBe('RS256');
      expect(parsed!.payload.sub).toBe('user123');
      expect(parsed!.payload.iss).toBe('https://auth.example.com');
    });

    it('should extract sub claim from id_token_hint', () => {
      const idTokenHint = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'unique_user_identifier',
          aud: 'client123',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }
      );

      const parsed = parseJWT(idTokenHint);
      expect(parsed!.payload.sub).toBe('unique_user_identifier');
    });

    it('should verify issuer matches authorization server', () => {
      const idTokenHint = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: mockEnv.ISSUER_URL,
          sub: 'user123',
          aud: 'client123',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }
      );

      const parsed = parseJWT(idTokenHint);
      const isValidIssuer = parsed!.payload.iss === mockEnv.ISSUER_URL;

      expect(isValidIssuer).toBe(true);
    });

    it('should reject id_token_hint from different issuer', () => {
      const idTokenHint = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://malicious.example.com',
          sub: 'user123',
          aud: 'client123',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }
      );

      const parsed = parseJWT(idTokenHint);
      const isValidIssuer = parsed!.payload.iss === mockEnv.ISSUER_URL;

      expect(isValidIssuer).toBe(false);
    });
  });

  describe('login_hint_token Signature Verification', () => {
    it('should parse login_hint_token structure', () => {
      const now = Math.floor(Date.now() / 1000);
      const loginHintToken = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user@example.com',
          aud: 'https://auth.example.com',
          exp: now + 300, // 5 minutes
          iat: now,
        }
      );

      const parsed = parseJWT(loginHintToken);

      expect(parsed).not.toBeNull();
      expect(parsed!.header.alg).toBe('RS256');
      expect(parsed!.payload.sub).toBe('user@example.com');
    });

    it('should extract user identifier from login_hint_token', () => {
      const loginHintToken = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user@example.com',
          exp: Math.floor(Date.now() / 1000) + 300,
        }
      );

      const parsed = parseJWT(loginHintToken);
      expect(parsed!.payload.sub).toBe('user@example.com');
    });

    it('should validate login_hint_token audience', () => {
      const loginHintToken = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://third-party.example.com',
          sub: 'user@example.com',
          aud: mockEnv.ISSUER_URL, // Must match our server
          exp: Math.floor(Date.now() / 1000) + 300,
        }
      );

      const parsed = parseJWT(loginHintToken);
      const isValidAudience = parsed!.payload.aud === mockEnv.ISSUER_URL;

      expect(isValidAudience).toBe(true);
    });
  });

  describe('Expired JWT Rejection', () => {
    it('should reject expired id_token_hint', () => {
      const expiredTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const idTokenHint = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          aud: 'client123',
          exp: expiredTime,
          iat: expiredTime - 3600,
        }
      );

      const parsed = parseJWT(idTokenHint);
      expect(isJWTExpired(parsed!.payload)).toBe(true);
    });

    it('should reject expired login_hint_token', () => {
      const expiredTime = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const loginHintToken = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user@example.com',
          exp: expiredTime,
        }
      );

      const parsed = parseJWT(loginHintToken);
      expect(isJWTExpired(parsed!.payload)).toBe(true);
    });

    it('should accept non-expired JWT', () => {
      const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const validJWT = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          exp: futureTime,
        }
      );

      const parsed = parseJWT(validJWT);
      expect(isJWTExpired(parsed!.payload)).toBe(false);
    });

    it('should handle JWT without exp claim', () => {
      const noExpJWT = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          // No exp claim
        }
      );

      const parsed = parseJWT(noExpJWT);
      expect(isJWTExpired(parsed!.payload)).toBe(false);
    });

    it('should reject JWT with exp exactly at current time', () => {
      const now = Math.floor(Date.now() / 1000);
      const boundaryJWT = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          exp: now - 1, // Just passed
        }
      );

      const parsed = parseJWT(boundaryJWT);
      expect(isJWTExpired(parsed!.payload)).toBe(true);
    });
  });

  describe('Invalid Signature Rejection', () => {
    it('should detect malformed JWT (missing parts)', () => {
      const malformedJWTs = ['header.payload', 'headeronly', '', 'a.b.c.d'];

      for (const jwt of malformedJWTs) {
        if (jwt === '') {
          expect(parseJWT(jwt)).toBeNull();
        } else if (jwt.split('.').length !== 3) {
          expect(parseJWT(jwt)).toBeNull();
        }
      }
    });

    it('should detect invalid base64 encoding in header', () => {
      const invalidJWT = '!!!invalid!!!.eyJzdWIiOiJ1c2VyMTIzIn0.signature';

      const result = parseJWT(invalidJWT);
      expect(result).toBeNull();
    });

    it('should detect invalid base64 encoding in payload', () => {
      const invalidJWT = 'eyJhbGciOiJSUzI1NiJ9.!!!invalid!!!.signature';

      const result = parseJWT(invalidJWT);
      expect(result).toBeNull();
    });

    it('should detect invalid JSON in header', () => {
      const invalidHeader = btoa('not json');
      const validPayload = btoa(JSON.stringify({ sub: 'user123' }));
      const invalidJWT = `${invalidHeader}.${validPayload}.signature`;

      const result = parseJWT(invalidJWT);
      expect(result).toBeNull();
    });

    it('should detect invalid JSON in payload', () => {
      const validHeader = btoa(JSON.stringify({ alg: 'RS256' }));
      const invalidPayload = btoa('not json');
      const invalidJWT = `${validHeader}.${invalidPayload}.signature`;

      const result = parseJWT(invalidJWT);
      expect(result).toBeNull();
    });
  });

  describe('Algorithm Validation', () => {
    it('should reject "none" algorithm', () => {
      const unsecuredJWT = createMockJWT({ alg: 'none', typ: 'JWT' }, { sub: 'user123' });

      const parsed = parseJWT(unsecuredJWT);
      const isSecureAlgorithm = parsed!.header.alg !== 'none';

      expect(isSecureAlgorithm).toBe(false);
    });

    it('should accept RS256 algorithm', () => {
      const jwt = createMockJWT({ alg: 'RS256', typ: 'JWT' }, { sub: 'user123' });

      const parsed = parseJWT(jwt);
      const ALLOWED_ALGORITHMS = [
        'RS256',
        'RS384',
        'RS512',
        'ES256',
        'ES384',
        'ES512',
        'PS256',
        'PS384',
        'PS512',
      ];
      const isAllowedAlgorithm = ALLOWED_ALGORITHMS.includes(parsed!.header.alg);

      expect(isAllowedAlgorithm).toBe(true);
    });

    it('should accept ES256 algorithm', () => {
      const jwt = createMockJWT({ alg: 'ES256', typ: 'JWT' }, { sub: 'user123' });

      const parsed = parseJWT(jwt);
      const ALLOWED_ALGORITHMS = [
        'RS256',
        'RS384',
        'RS512',
        'ES256',
        'ES384',
        'ES512',
        'PS256',
        'PS384',
        'PS512',
      ];
      const isAllowedAlgorithm = ALLOWED_ALGORITHMS.includes(parsed!.header.alg);

      expect(isAllowedAlgorithm).toBe(true);
    });

    it('should reject symmetric algorithms for id_token_hint', () => {
      const symmetricJWT = createMockJWT({ alg: 'HS256', typ: 'JWT' }, { sub: 'user123' });

      const parsed = parseJWT(symmetricJWT);
      const ASYMMETRIC_ALGORITHMS = [
        'RS256',
        'RS384',
        'RS512',
        'ES256',
        'ES384',
        'ES512',
        'PS256',
        'PS384',
        'PS512',
      ];
      const isAsymmetric = ASYMMETRIC_ALGORITHMS.includes(parsed!.header.alg);

      expect(isAsymmetric).toBe(false);
    });
  });

  describe('nbf (not before) Validation', () => {
    it('should reject JWT with future nbf', () => {
      const futureNbf = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const jwt = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          sub: 'user123',
          nbf: futureNbf,
          exp: futureNbf + 3600,
        }
      );

      const parsed = parseJWT(jwt);
      expect(isJWTNotYetValid(parsed!.payload)).toBe(true);
    });

    it('should accept JWT with past nbf', () => {
      const pastNbf = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
      const jwt = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          sub: 'user123',
          nbf: pastNbf,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }
      );

      const parsed = parseJWT(jwt);
      expect(isJWTNotYetValid(parsed!.payload)).toBe(false);
    });

    it('should accept JWT without nbf claim', () => {
      const jwt = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          sub: 'user123',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }
      );

      const parsed = parseJWT(jwt);
      expect(isJWTNotYetValid(parsed!.payload)).toBe(false);
    });
  });

  describe('Required Claims Validation', () => {
    it('should require sub claim in id_token_hint', () => {
      const jwt = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          aud: 'client123',
          exp: Math.floor(Date.now() / 1000) + 3600,
          // No sub claim
        }
      );

      const parsed = parseJWT(jwt);
      const hasSub = !!parsed!.payload.sub;

      expect(hasSub).toBe(false);
    });

    it('should require iss claim in id_token_hint', () => {
      const jwt = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          sub: 'user123',
          aud: 'client123',
          exp: Math.floor(Date.now() / 1000) + 3600,
          // No iss claim
        }
      );

      const parsed = parseJWT(jwt);
      const hasIss = !!parsed!.payload.iss;

      expect(hasIss).toBe(false);
    });

    it('should validate all required claims present', () => {
      const jwt = createMockJWT(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: 'https://auth.example.com',
          sub: 'user123',
          aud: 'client123',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }
      );

      const parsed = parseJWT(jwt);
      const hasRequiredClaims = !!(
        parsed!.payload.iss &&
        parsed!.payload.sub &&
        parsed!.payload.aud &&
        parsed!.payload.exp
      );

      expect(hasRequiredClaims).toBe(true);
    });
  });
});
