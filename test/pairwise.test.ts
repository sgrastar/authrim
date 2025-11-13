/**
 * Pairwise Subject Identifier Tests
 * OIDC Core 8.1
 */

import { describe, it, expect } from 'vitest';
import {
  generatePairwiseSubject,
  extractSectorIdentifier,
  validateSectorIdentifierConsistency,
  determineEffectiveSectorIdentifier,
  generateSubjectIdentifier,
} from '../src/utils/pairwise';

describe('Pairwise Subject Identifier Utilities', () => {
  describe('generatePairwiseSubject', () => {
    it('should generate a base64url-encoded hash', async () => {
      const localAccountId = 'user123';
      const sectorIdentifier = 'example.com';
      const salt = 'secret_salt';

      const subject = await generatePairwiseSubject(localAccountId, sectorIdentifier, salt);

      // Should be a base64url string (no +, /, or =)
      expect(subject).toBeTypeOf('string');
      expect(subject.length).toBeGreaterThan(0);
      expect(subject).not.toMatch(/[+/=]/);
    });

    it('should produce consistent subjects for same inputs', async () => {
      const localAccountId = 'user123';
      const sectorIdentifier = 'example.com';
      const salt = 'secret_salt';

      const subject1 = await generatePairwiseSubject(localAccountId, sectorIdentifier, salt);
      const subject2 = await generatePairwiseSubject(localAccountId, sectorIdentifier, salt);

      expect(subject1).toBe(subject2);
    });

    it('should produce different subjects for different sector identifiers', async () => {
      const localAccountId = 'user123';
      const salt = 'secret_salt';

      const subject1 = await generatePairwiseSubject(localAccountId, 'example.com', salt);
      const subject2 = await generatePairwiseSubject(localAccountId, 'other.com', salt);

      expect(subject1).not.toBe(subject2);
    });

    it('should produce different subjects for different local account IDs', async () => {
      const sectorIdentifier = 'example.com';
      const salt = 'secret_salt';

      const subject1 = await generatePairwiseSubject('user1', sectorIdentifier, salt);
      const subject2 = await generatePairwiseSubject('user2', sectorIdentifier, salt);

      expect(subject1).not.toBe(subject2);
    });

    it('should produce different subjects with different salts', async () => {
      const localAccountId = 'user123';
      const sectorIdentifier = 'example.com';

      const subject1 = await generatePairwiseSubject(localAccountId, sectorIdentifier, 'salt1');
      const subject2 = await generatePairwiseSubject(localAccountId, sectorIdentifier, 'salt2');

      expect(subject1).not.toBe(subject2);
    });
  });

  describe('extractSectorIdentifier', () => {
    it('should extract host from HTTPS URL', () => {
      const uri = 'https://example.com/callback';
      const sector = extractSectorIdentifier(uri);

      expect(sector).toBe('example.com');
    });

    it('should extract host with port', () => {
      const uri = 'https://example.com:8080/callback';
      const sector = extractSectorIdentifier(uri);

      expect(sector).toBe('example.com:8080');
    });

    it('should extract localhost', () => {
      const uri = 'http://localhost:3000/callback';
      const sector = extractSectorIdentifier(uri);

      expect(sector).toBe('localhost:3000');
    });

    it('should throw for invalid URL', () => {
      expect(() => extractSectorIdentifier('not-a-url')).toThrow('Invalid redirect_uri');
    });

    it('should handle URLs with query parameters', () => {
      const uri = 'https://example.com/callback?param=value';
      const sector = extractSectorIdentifier(uri);

      expect(sector).toBe('example.com');
    });
  });

  describe('validateSectorIdentifierConsistency', () => {
    it('should return true for single redirect URI', () => {
      const uris = ['https://example.com/callback'];
      const result = validateSectorIdentifierConsistency(uris);

      expect(result).toBe(true);
    });

    it('should return true for multiple URIs with same host', () => {
      const uris = [
        'https://example.com/callback',
        'https://example.com/auth',
        'https://example.com/redirect',
      ];
      const result = validateSectorIdentifierConsistency(uris);

      expect(result).toBe(true);
    });

    it('should return false for URIs with different hosts', () => {
      const uris = ['https://example.com/callback', 'https://other.com/callback'];
      const result = validateSectorIdentifierConsistency(uris);

      expect(result).toBe(false);
    });

    it('should return false for empty array', () => {
      const result = validateSectorIdentifierConsistency([]);

      expect(result).toBe(false);
    });

    it('should consider port as part of host', () => {
      const uris = ['https://example.com:8080/callback', 'https://example.com:9090/callback'];
      const result = validateSectorIdentifierConsistency(uris);

      expect(result).toBe(false);
    });
  });

  describe('determineEffectiveSectorIdentifier', () => {
    it('should use sector_identifier_uri when provided', () => {
      const redirectUris = [
        'https://app1.example.com/callback',
        'https://app2.example.com/callback',
      ];
      const sectorIdentifierUri = 'https://example.com/sector';

      const sector = determineEffectiveSectorIdentifier(redirectUris, sectorIdentifierUri);

      expect(sector).toBe('example.com');
    });

    it('should use redirect_uri host when sector_identifier_uri is not provided', () => {
      const redirectUris = ['https://example.com/callback'];

      const sector = determineEffectiveSectorIdentifier(redirectUris);

      expect(sector).toBe('example.com');
    });

    it('should throw for empty redirect URIs', () => {
      expect(() => determineEffectiveSectorIdentifier([])).toThrow('No redirect URIs registered');
    });
  });

  describe('generateSubjectIdentifier', () => {
    it('should return local account ID for public subject type', async () => {
      const localAccountId = 'user123';
      const subject = await generateSubjectIdentifier(localAccountId, 'public');

      expect(subject).toBe(localAccountId);
    });

    it('should generate pairwise subject for pairwise type', async () => {
      const localAccountId = 'user123';
      const subject = await generateSubjectIdentifier(
        localAccountId,
        'pairwise',
        'example.com',
        'secret_salt'
      );

      expect(subject).not.toBe(localAccountId);
      expect(subject.length).toBeGreaterThan(0);
      expect(subject).not.toMatch(/[+/=]/);
    });

    it('should throw for pairwise without sector identifier', async () => {
      await expect(
        generateSubjectIdentifier('user123', 'pairwise', undefined, 'salt')
      ).rejects.toThrow('Sector identifier is required');
    });

    it('should throw for pairwise without salt', async () => {
      await expect(
        generateSubjectIdentifier('user123', 'pairwise', 'example.com', undefined)
      ).rejects.toThrow('Salt is required');
    });
  });
});
