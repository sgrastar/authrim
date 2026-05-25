/**
 * ID Generation Utilities Tests
 *
 * Tests for generateUserId, isValidUserId, and related functions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// Direct import from TypeScript source with explicit .ts extension
// Note: The .ts extension is required for vitest to correctly resolve the module
import {
  generateUserId,
  isValidUserId,
  getUserIdFormatFromSettings,
  generateUserIdFromSettings,
  DEFAULT_USER_ID_FORMAT,
  type UserIdFormat,
} from '../id.ts';

describe('ID Generation Utilities', () => {
  // Note: generateId tests are in repositories/base.test.ts
  // as generateId is exported from repositories/base.ts

  describe('generateUserId', () => {
    it('should generate NanoID by default', () => {
      const id = generateUserId();

      // NanoID default length is 21 characters
      expect(id).toHaveLength(21);
      // NanoID uses URL-safe characters
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    });

    it('should generate NanoID when format is "nanoid"', () => {
      const id = generateUserId('nanoid');

      expect(id).toHaveLength(21);
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    });

    it('should generate UUID v4 when format is "uuid"', () => {
      const id = generateUserId('uuid');

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should generate unique NanoIDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateUserId('nanoid'));
      }

      expect(ids.size).toBe(100);
    });

    it('should generate unique UUIDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateUserId('uuid'));
      }

      expect(ids.size).toBe(100);
    });

    it('should fallback to nanoid for unknown format', () => {
      const id = generateUserId('unknown' as UserIdFormat);

      // Should fallback to NanoID
      expect(id).toHaveLength(21);
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    });
  });

  describe('isValidUserId', () => {
    it('should validate UUID v4 format', () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(isValidUserId(validUuid, 'uuid')).toBe(true);
    });

    it('should reject invalid UUID format', () => {
      expect(isValidUserId('not-a-uuid', 'uuid')).toBe(false);
      expect(isValidUserId('550e8400-e29b-51d4-a716-446655440000', 'uuid')).toBe(false); // Wrong version
    });

    it('should validate NanoID format', () => {
      const validNanoid = 'V1StGXR8_Z5jdHi6B-myT';
      expect(isValidUserId(validNanoid, 'nanoid')).toBe(true);
    });

    it('should reject invalid NanoID format', () => {
      expect(isValidUserId('too-short', 'nanoid')).toBe(false);
      expect(isValidUserId('invalid!chars!@#$%^&*()', 'nanoid')).toBe(false);
    });

    it('should accept either format when no format specified', () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';
      const validNanoid = 'V1StGXR8_Z5jdHi6B-myT';

      expect(isValidUserId(validUuid)).toBe(true);
      expect(isValidUserId(validNanoid)).toBe(true);
    });

    it('should reject null and undefined', () => {
      expect(isValidUserId(null as unknown as string)).toBe(false);
      expect(isValidUserId(undefined as unknown as string)).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidUserId('')).toBe(false);
    });
  });

  describe('DEFAULT_USER_ID_FORMAT', () => {
    it('should be "nanoid"', () => {
      expect(DEFAULT_USER_ID_FORMAT).toBe('nanoid');
    });
  });

  describe('getUserIdFormatFromSettings', () => {
    it('should return default format when KV is undefined', async () => {
      const format = await getUserIdFormatFromSettings(undefined, 'default');
      expect(format).toBe(DEFAULT_USER_ID_FORMAT);
    });

    it('should reject a missing tenant ID', async () => {
      await expect(getUserIdFormatFromSettings(undefined, '')).rejects.toThrow(
        'getUserIdFormatFromSettings requires tenantId'
      );
    });

    it('should return nanoid when setting is "nanoid"', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'tenant.user_id_format': 'nanoid' })),
      };

      const format = await getUserIdFormatFromSettings(mockKv, 'default');
      expect(format).toBe('nanoid');
      expect(mockKv.get).toHaveBeenCalledWith('settings:tenant:default:tenant');
    });

    it('should return uuid when setting is "uuid"', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'tenant.user_id_format': 'uuid' })),
      };

      const format = await getUserIdFormatFromSettings(mockKv, 'default');
      expect(format).toBe('uuid');
    });

    it('should return default when setting is not found', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(null),
      };

      const format = await getUserIdFormatFromSettings(mockKv, 'default');
      expect(format).toBe(DEFAULT_USER_ID_FORMAT);
    });

    it('should return default when JSON is invalid', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue('invalid-json'),
      };

      const format = await getUserIdFormatFromSettings(mockKv, 'default');
      expect(format).toBe(DEFAULT_USER_ID_FORMAT);
    });

    it('should return default when setting value is invalid', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'tenant.user_id_format': 'invalid' })),
      };

      const format = await getUserIdFormatFromSettings(mockKv, 'default');
      expect(format).toBe(DEFAULT_USER_ID_FORMAT);
    });

    it('should use the provided tenant ID', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'tenant.user_id_format': 'uuid' })),
      };

      await getUserIdFormatFromSettings(mockKv, 'custom-tenant');
      expect(mockKv.get).toHaveBeenCalledWith('settings:tenant:custom-tenant:tenant');
    });
  });

  describe('generateUserIdFromSettings', () => {
    it('should generate NanoID when KV is undefined', async () => {
      const id = await generateUserIdFromSettings(undefined, 'default');

      expect(id).toHaveLength(21);
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    });

    it('should reject a missing tenant ID', async () => {
      await expect(generateUserIdFromSettings(undefined, '')).rejects.toThrow(
        'getUserIdFormatFromSettings requires tenantId'
      );
    });

    it('should generate NanoID when setting is "nanoid"', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'tenant.user_id_format': 'nanoid' })),
      };

      const id = await generateUserIdFromSettings(mockKv, 'default');

      expect(id).toHaveLength(21);
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    });

    it('should generate UUID when setting is "uuid"', async () => {
      const mockKv = {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'tenant.user_id_format': 'uuid' })),
      };

      const id = await generateUserIdFromSettings(mockKv, 'default');

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });
});
