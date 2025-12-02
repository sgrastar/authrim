/**
 * SD-JWT Tests
 *
 * Tests for Selective Disclosure JWT implementation
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { importPKCS8, importSPKI, exportJWK, generateKeyPair } from 'jose';
import {
  createDisclosure,
  decodeDisclosure,
  createSDJWT,
  createSDJWTIDToken,
  parseSDJWT,
  verifySDJWT,
  createPresentation,
  isSDJWT,
  getJWTFromSDJWT,
  SD_JWT_SEPARATOR,
  type SDJWTDisclosure,
  type SDJWT,
  type SDJWTCreateOptions,
} from '../sd-jwt';

describe('SD-JWT', () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  const kid = 'test-key-1';

  beforeAll(async () => {
    // Generate test keypair
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey as CryptoKey;
    publicKey = keyPair.publicKey as CryptoKey;
  });

  describe('createDisclosure', () => {
    test('should create disclosure with correct format', async () => {
      const disclosure = await createDisclosure('email', 'test@example.com');

      expect(disclosure.claimName).toBe('email');
      expect(disclosure.claimValue).toBe('test@example.com');
      expect(disclosure.salt).toBeDefined();
      expect(disclosure.salt.length).toBeGreaterThan(0);
      expect(disclosure.encoded).toBeDefined();
      expect(disclosure.hash).toBeDefined();
    });

    test('should create unique salts for each disclosure', async () => {
      const disclosure1 = await createDisclosure('email', 'test@example.com');
      const disclosure2 = await createDisclosure('email', 'test@example.com');

      expect(disclosure1.salt).not.toBe(disclosure2.salt);
      expect(disclosure1.hash).not.toBe(disclosure2.hash);
    });

    test('should handle complex claim values', async () => {
      const address = {
        street_address: '123 Main St',
        locality: 'Anytown',
        region: 'CA',
        postal_code: '12345',
        country: 'US',
      };
      const disclosure = await createDisclosure('address', address);

      expect(disclosure.claimName).toBe('address');
      expect(disclosure.claimValue).toEqual(address);
    });

    test('should handle array claim values', async () => {
      const disclosure = await createDisclosure('roles', ['admin', 'user']);

      expect(disclosure.claimValue).toEqual(['admin', 'user']);
    });
  });

  describe('decodeDisclosure', () => {
    test('should decode valid disclosure', async () => {
      const original = await createDisclosure('name', 'John Doe');
      const decoded = await decodeDisclosure(original.encoded);

      expect(decoded).not.toBeNull();
      expect(decoded!.claimName).toBe('name');
      expect(decoded!.claimValue).toBe('John Doe');
      expect(decoded!.hash).toBe(original.hash);
    });

    test('should return null for invalid base64', async () => {
      const decoded = await decodeDisclosure('not-valid-base64!!!');

      expect(decoded).toBeNull();
    });

    test('should return null for invalid array format', async () => {
      // Create base64-encoded array with wrong length
      const invalidArray = JSON.stringify(['salt', 'claim']); // missing value
      const encoded = Buffer.from(invalidArray).toString('base64url');
      const decoded = await decodeDisclosure(encoded);

      expect(decoded).toBeNull();
    });

    test('should return null for non-string claim name', async () => {
      const invalidArray = JSON.stringify(['salt', 123, 'value']); // claim name is number
      const encoded = Buffer.from(invalidArray).toString('base64url');
      const decoded = await decodeDisclosure(encoded);

      expect(decoded).toBeNull();
    });
  });

  describe('createSDJWT', () => {
    test('should create SD-JWT with selective disclosure claims', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        aud: 'client123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        email: 'user@example.com',
        phone_number: '+1234567890',
      };

      const options: SDJWTCreateOptions = {
        selectiveDisclosureClaims: ['email', 'phone_number'],
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, options);

      expect(sdJwt.jwt).toBeDefined();
      expect(sdJwt.disclosures.length).toBe(2);
      expect(sdJwt.combined).toContain(SD_JWT_SEPARATOR);

      // Check disclosure claims
      const disclosureNames = sdJwt.disclosures.map((d) => d.claimName);
      expect(disclosureNames).toContain('email');
      expect(disclosureNames).toContain('phone_number');
    });

    test('should include _sd array in JWT payload', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      const parsed = await parseSDJWT(sdJwt.combined);
      expect(parsed).not.toBeNull();

      // Decode JWT payload (without verification)
      const [, payloadPart] = sdJwt.jwt.split('.');
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

      expect(payload._sd).toBeDefined();
      expect(Array.isArray(payload._sd)).toBe(true);
      expect(payload._sd_alg).toBe('sha-256');
      // email should NOT be in payload (it's in disclosure)
      expect(payload.email).toBeUndefined();
    });

    test('should not add _sd array when no selective claims', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        aud: 'client123',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: [],
      });

      const [, payloadPart] = sdJwt.jwt.split('.');
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

      expect(payload._sd).toBeUndefined();
      expect(payload._sd_alg).toBe('sha-256');
    });

    test('should add holder binding when provided', async () => {
      const holderKeyPair = await generateKeyPair('RS256');
      const holderJwk = await exportJWK(holderKeyPair.publicKey);

      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: [],
        holderBinding: holderJwk,
      });

      const [, payloadPart] = sdJwt.jwt.split('.');
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

      expect(payload.cnf).toBeDefined();
      expect(payload.cnf.jwk).toEqual(holderJwk);
    });

    test('should set sd+jwt type in header', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: [],
      });

      const [headerPart] = sdJwt.jwt.split('.');
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());

      expect(header.typ).toBe('sd+jwt');
      expect(header.alg).toBe('RS256');
      expect(header.kid).toBe(kid);
    });
  });

  describe('createSDJWTIDToken', () => {
    test('should never make required OIDC claims selective', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        aud: 'client123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce: 'abc123',
        email: 'user@example.com',
        phone_number: '+1234567890',
      };

      // Try to make iss, sub, aud selective (should be ignored)
      const sdJwt = await createSDJWTIDToken(claims, privateKey, kid, [
        'iss',
        'sub',
        'aud',
        'nonce',
        'email',
        'phone_number',
      ]);

      // Only email and phone_number should be selective
      const disclosureNames = sdJwt.disclosures.map((d) => d.claimName);
      expect(disclosureNames).not.toContain('iss');
      expect(disclosureNames).not.toContain('sub');
      expect(disclosureNames).not.toContain('aud');
      expect(disclosureNames).not.toContain('nonce');
      expect(disclosureNames).toContain('email');
      expect(disclosureNames).toContain('phone_number');
    });

    test('should use default selective claims', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        aud: 'client123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        email: 'user@example.com',
        address: { locality: 'Tokyo' },
        birthdate: '1990-01-01',
      };

      const sdJwt = await createSDJWTIDToken(claims, privateKey, kid);

      // Default selective claims: email, phone_number, address, birthdate
      const disclosureNames = sdJwt.disclosures.map((d) => d.claimName);
      expect(disclosureNames).toContain('email');
      expect(disclosureNames).toContain('address');
      expect(disclosureNames).toContain('birthdate');
    });
  });

  describe('parseSDJWT', () => {
    test('should parse valid SD-JWT', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
        phone_number: '+1234567890',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email', 'phone_number'],
      });

      const parsed = await parseSDJWT(sdJwt.combined);

      expect(parsed).not.toBeNull();
      expect(parsed!.jwt).toBe(sdJwt.jwt);
      expect(parsed!.disclosures.length).toBe(2);
    });

    test('should return null for invalid format', async () => {
      const parsed = await parseSDJWT('not-an-sd-jwt');

      expect(parsed).toBeNull();
    });

    test('should handle SD-JWT with trailing separator', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      // Combined string should end with ~
      expect(sdJwt.combined.endsWith(SD_JWT_SEPARATOR)).toBe(true);

      const parsed = await parseSDJWT(sdJwt.combined);
      expect(parsed).not.toBeNull();
      expect(parsed!.disclosures.length).toBe(1);
    });
  });

  describe('verifySDJWT', () => {
    test('should verify valid SD-JWT and extract disclosed claims', async () => {
      const issuer = 'https://issuer.example.com';
      const audience = 'client123';
      const claims = {
        iss: issuer,
        sub: 'user123',
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        email: 'user@example.com',
        phone_number: '+1234567890',
        name: 'John Doe',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email', 'phone_number'],
      });

      const verified = await verifySDJWT(sdJwt.combined, publicKey, issuer, audience);

      expect(verified.disclosedClaims.iss).toBe(issuer);
      expect(verified.disclosedClaims.sub).toBe('user123');
      expect(verified.disclosedClaims.email).toBe('user@example.com');
      expect(verified.disclosedClaims.phone_number).toBe('+1234567890');
      expect(verified.disclosedClaims.name).toBe('John Doe');
      expect(verified.undisclosedCount).toBe(0);
    });

    test('should count undisclosed claims correctly', async () => {
      const issuer = 'https://issuer.example.com';
      const audience = 'client123';
      const claims = {
        iss: issuer,
        sub: 'user123',
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        email: 'user@example.com',
        phone_number: '+1234567890',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email', 'phone_number'],
      });

      // Create presentation with only email
      const presentation = createPresentation(sdJwt, ['email']);

      const verified = await verifySDJWT(presentation, publicKey, issuer, audience);

      expect(verified.disclosedClaims.email).toBe('user@example.com');
      expect(verified.disclosedClaims.phone_number).toBeUndefined();
      expect(verified.undisclosedCount).toBe(1);
    });

    test('should throw on invalid signature', async () => {
      const issuer = 'https://issuer.example.com';
      const audience = 'client123';
      const claims = {
        iss: issuer,
        sub: 'user123',
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: [],
      });

      // Generate different keypair
      const otherKeyPair = await generateKeyPair('RS256');
      const otherPublicKey = otherKeyPair.publicKey as CryptoKey;

      await expect(verifySDJWT(sdJwt.combined, otherPublicKey, issuer, audience)).rejects.toThrow();
    });

    test('should throw on invalid disclosure hash', async () => {
      const issuer = 'https://issuer.example.com';
      const audience = 'client123';
      const claims = {
        iss: issuer,
        sub: 'user123',
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      // Create a fake disclosure and append it (with proper separator)
      // The combined format is: JWT~disclosure1~...~
      // We need to add another disclosure before the trailing empty part
      const fakeDisclosure = await createDisclosure('fake', 'value');
      // Insert fake disclosure: JWT~realDisclosure~fakeDisclosure~
      const tamperedCombined =
        sdJwt.combined.slice(0, -1) + SD_JWT_SEPARATOR + fakeDisclosure.encoded + SD_JWT_SEPARATOR;

      await expect(verifySDJWT(tamperedCombined, publicKey, issuer, audience)).rejects.toThrow(
        'Invalid disclosure'
      );
    });

    test('should throw on invalid SD-JWT format', async () => {
      await expect(verifySDJWT('invalid', publicKey, 'issuer', 'audience')).rejects.toThrow(
        'Invalid SD-JWT format'
      );
    });
  });

  describe('createPresentation', () => {
    test('should create presentation with selected disclosures', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
        phone_number: '+1234567890',
        address: { locality: 'Tokyo' },
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email', 'phone_number', 'address'],
      });

      // Present only email
      const presentation = createPresentation(sdJwt, ['email']);

      const parsed = await parseSDJWT(presentation);
      expect(parsed).not.toBeNull();
      expect(parsed!.jwt).toBe(sdJwt.jwt);
      expect(parsed!.disclosures.length).toBe(1);
      expect(parsed!.disclosures[0].claimName).toBe('email');
    });

    test('should create presentation with multiple selected disclosures', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
        phone_number: '+1234567890',
        address: { locality: 'Tokyo' },
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email', 'phone_number', 'address'],
      });

      const presentation = createPresentation(sdJwt, ['email', 'address']);

      const parsed = await parseSDJWT(presentation);
      expect(parsed!.disclosures.length).toBe(2);
      const names = parsed!.disclosures.map((d) => d.claimName);
      expect(names).toContain('email');
      expect(names).toContain('address');
      expect(names).not.toContain('phone_number');
    });

    test('should create presentation with no disclosures', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      const presentation = createPresentation(sdJwt, []);

      const parsed = await parseSDJWT(presentation);
      expect(parsed!.disclosures.length).toBe(0);
    });
  });

  describe('isSDJWT', () => {
    test('should return true for SD-JWT with separator', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      expect(isSDJWT(sdJwt.combined)).toBe(true);
    });

    test('should return true for JWT with _sd claim', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      // Test JWT part only (no disclosures)
      expect(isSDJWT(sdJwt.jwt)).toBe(true);
    });

    test('should return false for regular JWT', async () => {
      // Create a regular JWT using jose
      const { SignJWT } = await import('jose');
      const jwt = await new SignJWT({ iss: 'https://issuer.example.com', sub: 'user123' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .sign(privateKey);

      expect(isSDJWT(jwt)).toBe(false);
    });

    test('should return false for invalid token', () => {
      expect(isSDJWT('not-a-jwt')).toBe(false);
    });
  });

  describe('getJWTFromSDJWT', () => {
    test('should extract JWT from SD-JWT', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      const jwt = getJWTFromSDJWT(sdJwt.combined);

      expect(jwt).toBe(sdJwt.jwt);
      expect(jwt).not.toContain(SD_JWT_SEPARATOR);
    });

    test('should return same string for regular JWT', async () => {
      const { SignJWT } = await import('jose');
      const jwt = await new SignJWT({ iss: 'https://issuer.example.com' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .sign(privateKey);

      const result = getJWTFromSDJWT(jwt);

      expect(result).toBe(jwt);
    });
  });

  describe('SD-JWT Format Compliance', () => {
    test('combined format should be JWT~disclosure1~disclosure2~...~', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
        phone_number: '+1234567890',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email', 'phone_number'],
      });

      const parts = sdJwt.combined.split(SD_JWT_SEPARATOR);

      // Format: JWT ~ disclosure1 ~ disclosure2 ~ (empty)
      expect(parts.length).toBe(4); // JWT + 2 disclosures + trailing empty
      expect(parts[0]).toBe(sdJwt.jwt);
      expect(parts[parts.length - 1]).toBe(''); // Trailing separator
    });

    test('_sd hashes should be sorted', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        a_claim: 'value1',
        z_claim: 'value2',
        m_claim: 'value3',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['a_claim', 'z_claim', 'm_claim'],
      });

      const [, payloadPart] = sdJwt.jwt.split('.');
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

      const sdHashes = payload._sd;
      const sortedHashes = [...sdHashes].sort();

      expect(sdHashes).toEqual(sortedHashes);
    });
  });

  describe('RFC 9901 Compliance', () => {
    test('should reject reserved claim name "_sd" in disclosure', async () => {
      await expect(createDisclosure('_sd', 'value')).rejects.toThrow(
        'Claim name "_sd" is reserved and cannot be used in disclosures (RFC 9901)'
      );
    });

    test('should reject reserved claim name "..." in disclosure', async () => {
      await expect(createDisclosure('...', 'value')).rejects.toThrow(
        'Claim name "..." is reserved and cannot be used in disclosures (RFC 9901)'
      );
    });

    test('should return null when decoding disclosure with reserved claim name', async () => {
      // Manually create an encoded disclosure with reserved claim name
      const reservedDisclosure = JSON.stringify(['salt123', '_sd', 'value']);
      const encoded = Buffer.from(reservedDisclosure).toString('base64url');

      const decoded = await decodeDisclosure(encoded);
      expect(decoded).toBeNull();
    });

    test('should use sha-256 as default hash algorithm', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      const [, payloadPart] = sdJwt.jwt.split('.');
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

      expect(payload._sd_alg).toBe('sha-256');
    });

    test('should set typ header to sd+jwt', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: [],
      });

      const [headerPart] = sdJwt.jwt.split('.');
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());

      expect(header.typ).toBe('sd+jwt');
    });

    test('should use 128-bit salt (16 bytes)', async () => {
      const disclosure = await createDisclosure('test', 'value');

      // Salt should be base64url encoded 16 bytes
      // 16 bytes = 128 bits, base64url encoded = ~22 characters
      expect(disclosure.salt.length).toBeGreaterThanOrEqual(21);
      expect(disclosure.salt.length).toBeLessThanOrEqual(24);
    });

    test('should end combined format with tilde separator', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      expect(sdJwt.combined.endsWith('~')).toBe(true);
    });

    test('presentation should also end with tilde separator', async () => {
      const claims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        email: 'user@example.com',
      };

      const sdJwt = await createSDJWT(claims, privateKey, kid, {
        selectiveDisclosureClaims: ['email'],
      });

      const presentation = createPresentation(sdJwt, ['email']);
      expect(presentation.endsWith('~')).toBe(true);

      const emptyPresentation = createPresentation(sdJwt, []);
      expect(emptyPresentation.endsWith('~')).toBe(true);
    });
  });
});
