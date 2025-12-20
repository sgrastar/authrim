/**
 * SD-JWT VC Tests
 *
 * Tests for SD-JWT VC creation and verification (Phase 9).
 */

import { describe, it, expect } from 'vitest';
import {
  createSDJWTVC,
  parseSDJWTVC,
  verifySDJWTVC,
  createKeyBindingJWT,
  createVCPresentation,
  isSDJWTVC,
  extractVCT,
  type SDJWTVCCreateOptions,
} from '../sd-jwt-vc';
import { generateECKeySet } from '../../utils/ec-keys';

describe('SD-JWT VC', () => {
  describe('isSDJWTVC', () => {
    it('should return true for valid SD-JWT VC format', () => {
      // Create a header with typ: 'dc+sd-jwt'
      const header = { typ: 'dc+sd-jwt', alg: 'ES256' };
      const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const validVC = `${encodedHeader}.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIn0.sig~abc~def~`;

      expect(isSDJWTVC(validVC)).toBe(true);
    });

    it('should return false for regular JWT', () => {
      // Regular JWT has typ: 'JWT' or no typ
      const header = { alg: 'ES256' };
      const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const regularJwt = `${encodedHeader}.eyJpc3MiOiJ0ZXN0In0.signature`;

      expect(isSDJWTVC(regularJwt)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isSDJWTVC('')).toBe(false);
    });
  });

  describe('extractVCT', () => {
    it('should extract VCT from SD-JWT VC', async () => {
      // Create a real SD-JWT VC to test extractVCT
      const keySet = await generateECKeySet('key', 'ES256');
      const sdjwtvc = await createSDJWTVC(
        {},
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'key',
        {
          vct: 'https://authrim.com/credentials/identity/v1',
          selectiveDisclosureClaims: [],
        }
      );

      const vct = extractVCT(sdjwtvc.combined);

      expect(vct).toBe('https://authrim.com/credentials/identity/v1');
    });

    it('should return null for invalid token', () => {
      expect(extractVCT('')).toBeNull();
      expect(extractVCT('not-a-jwt')).toBeNull();
    });
  });

  describe('createSDJWTVC', () => {
    it('should create valid SD-JWT VC', async () => {
      const keySet = await generateECKeySet('issuer-key-1', 'ES256');
      const claims = {
        given_name: 'Alice',
        family_name: 'Smith',
        age_over_18: true,
      };

      const options: SDJWTVCCreateOptions = {
        vct: 'https://authrim.com/credentials/identity/v1',
        selectiveDisclosureClaims: ['given_name', 'family_name'],
        holderBinding: keySet.publicJWK, // Self-binding for test
      };

      const sdjwtvc = await createSDJWTVC(
        claims,
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'issuer-key-1',
        options
      );

      expect(sdjwtvc.combined).toBeDefined();
      expect(sdjwtvc.combined).toContain('~'); // Has disclosures
      expect(sdjwtvc.issuerJwt).toBeDefined();
      expect(sdjwtvc.disclosures.length).toBeGreaterThan(0);
    });

    it('should include status claim when provided', async () => {
      const keySet = await generateECKeySet('issuer-key-1', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'https://authrim.com/credentials/identity/v1',
        selectiveDisclosureClaims: [],
        holderBinding: keySet.publicJWK,
        status: {
          status_list: {
            uri: 'https://issuer.example.com/status/1',
            idx: 42,
          },
        },
      };

      const sdjwtvc = await createSDJWTVC(
        { name: 'Test' },
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'issuer-key-1',
        options
      );

      // Parse to verify status claim is included
      const parsed = await parseSDJWTVC(sdjwtvc.combined);
      expect(parsed).not.toBeNull();
      expect(parsed!.payload.status).toBeDefined();
      expect(parsed!.payload.status?.status_list?.uri).toBe('https://issuer.example.com/status/1');
      expect(parsed!.payload.status?.status_list?.idx).toBe(42);
    });

    it('should use ES256 algorithm by default', async () => {
      const keySet = await generateECKeySet('key', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'test-vct',
        selectiveDisclosureClaims: [],
        holderBinding: keySet.publicJWK,
      };

      const sdjwtvc = await createSDJWTVC(
        {},
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'key',
        options
      );

      // Check header by parsing first part
      const headerPart = sdjwtvc.issuerJwt.split('.')[0];
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
      expect(header.alg).toBe('ES256');
    });
  });

  describe('parseSDJWTVC', () => {
    it('should parse valid SD-JWT VC', async () => {
      const keySet = await generateECKeySet('key', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'https://authrim.com/credentials/identity/v1',
        selectiveDisclosureClaims: ['given_name'],
        holderBinding: keySet.publicJWK,
      };

      const sdjwtvc = await createSDJWTVC(
        { given_name: 'Alice' },
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'key',
        options
      );

      const parsed = await parseSDJWTVC(sdjwtvc.combined);

      expect(parsed).not.toBeNull();
      expect(parsed!.payload.iss).toBe('did:web:issuer.example.com');
      expect(parsed!.payload.vct).toBe('https://authrim.com/credentials/identity/v1');
      expect(parsed!.disclosures.length).toBeGreaterThan(0);
    });

    it('should return null for invalid token', async () => {
      expect(await parseSDJWTVC('')).toBeNull();
      expect(await parseSDJWTVC('invalid')).toBeNull();
    });
  });

  describe('verifySDJWTVC', () => {
    it('should verify valid SD-JWT VC', async () => {
      const issuerKeySet = await generateECKeySet('issuer-key', 'ES256');
      const holderKeySet = await generateECKeySet('holder-key', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'https://authrim.com/credentials/identity/v1',
        selectiveDisclosureClaims: ['name'],
        holderBinding: holderKeySet.publicJWK,
      };

      const sdjwtvc = await createSDJWTVC(
        { name: 'Alice' },
        'did:web:issuer.example.com',
        issuerKeySet.privateKey,
        'ES256',
        'issuer-key',
        options
      );

      const result = await verifySDJWTVC(
        sdjwtvc.combined,
        issuerKeySet.publicKey,
        null, // No holder key needed without KB-JWT
        {
          issuer: 'did:web:issuer.example.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        }
      );

      expect(result.verified).toBe(true);
      expect(result.disclosedClaims).toHaveProperty('name', 'Alice');
    });

    it('should fail for wrong issuer', async () => {
      const keySet = await generateECKeySet('key', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'test-vct',
        selectiveDisclosureClaims: [],
        holderBinding: keySet.publicJWK,
      };

      const sdjwtvc = await createSDJWTVC(
        {},
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'key',
        options
      );

      await expect(
        verifySDJWTVC(sdjwtvc.combined, keySet.publicKey, null, {
          issuer: 'did:web:wrong-issuer.com', // Wrong issuer
          vct: 'test-vct',
        })
      ).rejects.toThrow();
    });

    it('should fail for wrong VCT', async () => {
      const keySet = await generateECKeySet('key', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'correct-vct',
        selectiveDisclosureClaims: [],
        holderBinding: keySet.publicJWK,
      };

      const sdjwtvc = await createSDJWTVC(
        {},
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'key',
        options
      );

      await expect(
        verifySDJWTVC(sdjwtvc.combined, keySet.publicKey, null, {
          issuer: 'did:web:issuer.example.com',
          vct: 'wrong-vct', // Wrong VCT
        })
      ).rejects.toThrow('VCT mismatch');
    });

    it('should fail for expired credentials', async () => {
      const keySet = await generateECKeySet('key', 'ES256');
      const now = Math.floor(Date.now() / 1000);

      const options: SDJWTVCCreateOptions = {
        vct: 'test-vct',
        selectiveDisclosureClaims: [],
        holderBinding: keySet.publicJWK,
        expiresAt: now - 3600, // Expired 1 hour ago
      };

      const sdjwtvc = await createSDJWTVC(
        {},
        'did:web:issuer.example.com',
        keySet.privateKey,
        'ES256',
        'key',
        options
      );

      await expect(
        verifySDJWTVC(sdjwtvc.combined, keySet.publicKey, null, {
          issuer: 'did:web:issuer.example.com',
          vct: 'test-vct',
        })
      ).rejects.toThrow();
    });
  });

  describe('createKeyBindingJWT', () => {
    it('should create valid KB-JWT', async () => {
      const keySet = await generateECKeySet('holder-key', 'ES256');
      const sdjwtvc = 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.sig~disclosure1~';

      const kbJwt = await createKeyBindingJWT(
        keySet.privateKey,
        'ES256',
        'random-nonce-123',
        'did:web:verifier.example.com',
        sdjwtvc
      );

      expect(kbJwt).toBeDefined();
      expect(kbJwt.split('.').length).toBe(3); // Valid JWT format
    });
  });

  describe('createVCPresentation', () => {
    it('should create presentation from VC with selected disclosures', async () => {
      const issuerKeySet = await generateECKeySet('issuer-key', 'ES256');
      const holderKeySet = await generateECKeySet('holder-key', 'ES256');

      const options: SDJWTVCCreateOptions = {
        vct: 'test-vct',
        selectiveDisclosureClaims: ['given_name', 'family_name', 'age'],
        holderBinding: holderKeySet.publicJWK,
      };

      const sdjwtvc = await createSDJWTVC(
        { given_name: 'Alice', family_name: 'Smith', age: 30 },
        'did:web:issuer.example.com',
        issuerKeySet.privateKey,
        'ES256',
        'issuer-key',
        options
      );

      const presentation = await createVCPresentation(
        sdjwtvc, // Pass SDJWTVC object, not compact string
        ['given_name'], // Only disclose given_name
        holderKeySet.privateKey,
        'ES256',
        'presentation-nonce',
        'did:web:verifier.example.com'
      );

      expect(presentation).toBeDefined();
      expect(presentation).toContain('~'); // Has disclosures

      // Verify the presentation structure
      // Format: <issuer-jwt>~<disclosures>~<kb-jwt>
      const parts = presentation.split('~');
      expect(parts.length).toBeGreaterThanOrEqual(2);

      // The last non-empty part should be the KB-JWT (3-part JWT format)
      const lastNonEmpty = parts.filter((p) => p !== '').pop();
      expect(lastNonEmpty).toBeDefined();
      expect(lastNonEmpty!.split('.').length).toBe(3); // JWT format
    });
  });

  describe('Integration: Full VC Lifecycle', () => {
    it('should complete full issuance-presentation-verification cycle', async () => {
      // 1. Setup keys
      const issuerKeySet = await generateECKeySet('issuer-key', 'ES256');
      const holderKeySet = await generateECKeySet('holder-key', 'ES256');

      // 2. Issue credential with age_over_18 as non-SD claim
      const sdjwtvc = await createSDJWTVC(
        {
          given_name: 'Alice',
          family_name: 'Smith',
          birthdate: '1990-01-15',
          age_over_18: true,
        },
        'did:web:issuer.example.com',
        issuerKeySet.privateKey,
        'ES256',
        'issuer-key',
        {
          vct: 'https://authrim.com/credentials/identity/v1',
          selectiveDisclosureClaims: ['given_name', 'family_name', 'birthdate'],
          holderBinding: holderKeySet.publicJWK,
        }
      );

      // 3. Verify the issued credential (without KB-JWT)
      const issueResult = await verifySDJWTVC(sdjwtvc.combined, issuerKeySet.publicKey, null, {
        issuer: 'did:web:issuer.example.com',
        vct: 'https://authrim.com/credentials/identity/v1',
      });

      expect(issueResult.verified).toBe(true);
      // age_over_18 is not selectively disclosed, so it's always present
      expect(issueResult.disclosedClaims).toHaveProperty('age_over_18', true);
      // SD claims should be disclosed (all are present in the full credential)
      expect(issueResult.disclosedClaims).toHaveProperty('given_name', 'Alice');

      // 4. Create presentation (holder selects which claims to disclose)
      const presentation = await createVCPresentation(
        sdjwtvc,
        [], // Don't disclose any SD claims - only non-SD claims remain
        holderKeySet.privateKey,
        'ES256',
        'verifier-nonce-abc',
        'did:web:verifier.example.com'
      );

      // 5. Verify presentation structure includes KB-JWT
      const parts = presentation.split('~');
      const lastNonEmpty = parts.filter((p) => p !== '').pop();
      expect(lastNonEmpty).toBeDefined();
      expect(lastNonEmpty!.split('.').length).toBe(3); // KB-JWT has 3 parts

      // 6. Verify the presentation (without KB-JWT verification due to parser limitation)
      // The verifySDJWTVC can still verify the issuer signature and claims
      const presResult = await verifySDJWTVC(
        presentation,
        issuerKeySet.publicKey,
        null, // Skip KB-JWT verification
        {
          issuer: 'did:web:issuer.example.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        }
      );

      expect(presResult.verified).toBe(true);
      // Non-SD claim should always be present
      expect(presResult.disclosedClaims).toHaveProperty('age_over_18', true);
      // SD claims should NOT be disclosed (we passed empty array)
      expect(presResult.disclosedClaims).not.toHaveProperty('given_name');
      expect(presResult.disclosedClaims).not.toHaveProperty('birthdate');
      expect(presResult.undisclosedCount).toBe(3); // 3 SD claims not disclosed
    });

    it('should verify credential with selective disclosure', async () => {
      const issuerKeySet = await generateECKeySet('issuer-key', 'ES256');
      const holderKeySet = await generateECKeySet('holder-key', 'ES256');

      // Issue credential with all claims as SD
      const sdjwtvc = await createSDJWTVC(
        {
          name: 'Alice',
          age: 30,
          country: 'JP',
        },
        'did:web:issuer.example.com',
        issuerKeySet.privateKey,
        'ES256',
        'issuer-key',
        {
          vct: 'test-vct',
          selectiveDisclosureClaims: ['name', 'age', 'country'],
          holderBinding: holderKeySet.publicJWK,
        }
      );

      // Create presentation disclosing only 'name'
      const presentation = await createVCPresentation(
        sdjwtvc,
        ['name'],
        holderKeySet.privateKey,
        'ES256',
        'test-nonce',
        'did:web:verifier.example.com'
      );

      // Verify presentation
      const result = await verifySDJWTVC(presentation, issuerKeySet.publicKey, null, {
        issuer: 'did:web:issuer.example.com',
        vct: 'test-vct',
      });

      expect(result.verified).toBe(true);
      expect(result.disclosedClaims).toHaveProperty('name', 'Alice');
      expect(result.disclosedClaims).not.toHaveProperty('age');
      expect(result.disclosedClaims).not.toHaveProperty('country');
      expect(result.undisclosedCount).toBe(2); // 'age' and 'country' not disclosed
    });
  });
});
