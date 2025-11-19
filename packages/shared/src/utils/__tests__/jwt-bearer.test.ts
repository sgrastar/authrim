/**
 * JWT Bearer Flow Utilities Tests (RFC 7523)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import {
  validateJWTBearerAssertion,
  parseTrustedIssuers,
  type TrustedIssuer,
} from '../jwt-bearer';

describe('JWT Bearer Flow Utilities', () => {
  let publicKey: JWK;
  let privateKey: any;
  const issuer = 'https://service.example.com';
  const audience = 'https://auth.example.com';

  beforeAll(async () => {
    // Generate key pair for testing
    const keyPair = await generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    });

    publicKey = await exportJWK(keyPair.publicKey);
    publicKey.kid = 'test-key-1';
    publicKey.alg = 'RS256';

    privateKey = keyPair.privateKey;
  });

  describe('validateJWTBearerAssertion', () => {
    it('should validate a valid JWT assertion', async () => {
      const subject = 'service-account@example.com';

      // Create a valid JWT assertion
      const assertion = await new SignJWT({
        iss: issuer,
        sub: subject,
        aud: audience,
        scope: 'openid profile',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      // Create trusted issuer configuration
      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(true);
      expect(result.claims).toBeDefined();
      expect(result.claims?.iss).toBe(issuer);
      expect(result.claims?.sub).toBe(subject);
      expect(result.claims?.aud).toBe(audience);
    });

    it('should reject assertion from untrusted issuer', async () => {
      const untrustedIssuer = 'https://untrusted.example.com';

      const assertion = await new SignJWT({
        iss: untrustedIssuer,
        sub: 'service@example.com',
        aud: audience,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      // No trusted issuers configured
      const trustedIssuers = new Map<string, TrustedIssuer>();

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_grant');
      expect(result.error_description).toContain('not trusted');
    });

    it('should reject assertion with wrong audience', async () => {
      const wrongAudience = 'https://wrong-audience.example.com';

      const assertion = await new SignJWT({
        iss: issuer,
        sub: 'service@example.com',
        aud: wrongAudience, // Wrong audience
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_grant');
      expect(result.error_description).toContain('Audience does not match');
    });

    it('should reject assertion with disallowed subject', async () => {
      const subject = 'unauthorized-service@example.com';

      const assertion = await new SignJWT({
        iss: issuer,
        sub: subject,
        aud: audience,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
        allowed_subjects: ['allowed-service@example.com'], // subject not in this list
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_grant');
      expect(result.error_description).toContain('not allowed');
    });

    it('should accept assertion with allowed subject', async () => {
      const subject = 'allowed-service@example.com';

      const assertion = await new SignJWT({
        iss: issuer,
        sub: subject,
        aud: audience,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
        allowed_subjects: ['allowed-service@example.com'],
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe(subject);
    });

    it('should reject expired assertion', async () => {
      const assertion = await new SignJWT({
        iss: issuer,
        sub: 'service@example.com',
        aud: audience,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('-1h') // Expired 1 hour ago
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_grant');
    });

    it('should reject assertion with missing required claims', async () => {
      // Missing 'sub' claim
      const assertion = await new SignJWT({
        iss: issuer,
        aud: audience,
        // sub is missing
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_grant');
      expect(result.error_description).toContain('missing required claims');
    });

    it('should validate assertion with scope claim', async () => {
      const assertion = await new SignJWT({
        iss: issuer,
        sub: 'service@example.com',
        aud: audience,
        scope: 'openid profile email',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(true);
      expect(result.claims?.scope).toBe('openid profile email');
    });

    it('should reject assertion with disallowed scope', async () => {
      const assertion = await new SignJWT({
        iss: issuer,
        sub: 'service@example.com',
        aud: audience,
        scope: 'admin delete_users', // Disallowed scopes
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
        allowed_scopes: ['openid', 'profile', 'email'], // 'admin' and 'delete_users' not allowed
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_scope');
    });

    it('should handle assertion with array audience', async () => {
      const audiences = [audience, 'https://another-audience.example.com'];

      const assertion = await new SignJWT({
        iss: issuer,
        sub: 'service@example.com',
        aud: audiences,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const trustedIssuers = new Map<string, TrustedIssuer>();
      trustedIssuers.set(issuer, {
        issuer,
        jwks: { keys: [publicKey] },
      });

      const result = await validateJWTBearerAssertion(assertion, audience, trustedIssuers);

      expect(result.valid).toBe(true);
    });
  });

  describe('parseTrustedIssuers', () => {
    it('should parse trusted issuers from environment variable', () => {
      const envVar = 'https://service1.example.com:https://service1.example.com/jwks,https://service2.example.com:https://service2.example.com/jwks';

      const result = parseTrustedIssuers(envVar);

      expect(result.size).toBe(2);
      expect(result.has('https://service1.example.com')).toBe(true);
      expect(result.has('https://service2.example.com')).toBe(true);

      const issuer1 = result.get('https://service1.example.com');
      expect(issuer1?.jwks_uri).toBe('https://service1.example.com/jwks');
    });

    it('should handle empty environment variable', () => {
      const result = parseTrustedIssuers(undefined);
      expect(result.size).toBe(0);
    });

    it('should handle single issuer', () => {
      const envVar = 'https://service.example.com:https://service.example.com/jwks';

      const result = parseTrustedIssuers(envVar);

      expect(result.size).toBe(1);
      expect(result.has('https://service.example.com')).toBe(true);
    });
  });
});
