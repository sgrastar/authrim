import { describe, it, expect, vi } from 'vitest';
import {
  encryptValue,
  decryptValue,
  isEncrypted,
  parseEncryptedValue,
  PIIEncryptionService,
} from '../pii-encryption';
import {
  EncryptionConfigManager,
  EncryptionKeyMissingError,
  EncryptionKeyInvalidError,
  PII_ENCRYPTION_KEY_LENGTH,
  DEFAULT_ENCRYPTION_CONFIG,
  type EncryptionAlgorithm,
} from '../encryption-config';
import type { Env } from '../../types/env';

// Test encryption key (32 bytes = 64 hex characters)
const TEST_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const TEST_KEY_V2 = 'f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4e5f6a7b8c9d0e1f2';

describe('PII Encryption', () => {
  describe('isEncrypted', () => {
    it('should return true for encrypted values', () => {
      expect(isEncrypted('enc:v1:gcm:somebase64data')).toBe(true);
    });

    it('should return false for plaintext values', () => {
      expect(isEncrypted('test@example.com')).toBe(false);
      expect(isEncrypted('John Doe')).toBe(false);
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
    });

    it('should return false for malformed encrypted values', () => {
      expect(isEncrypted('enc:v1:gcm')).toBe(false);
      expect(isEncrypted('enc:v2:cbc:anotherbase64data')).toBe(false);
      expect(isEncrypted('enc:gcm:data')).toBe(false);
      expect(isEncrypted('encrypted:v1:gcm:data')).toBe(false);
    });
  });

  describe('parseEncryptedValue', () => {
    it('should parse valid encrypted value', () => {
      const result = parseEncryptedValue('enc:v1:gcm:somebase64data');
      expect(result).toEqual({
        keyVersion: 1,
        algorithm: 'gcm',
        payload: 'somebase64data',
      });
    });

    it('should return null for invalid format', () => {
      expect(parseEncryptedValue('plain text')).toBeNull();
      expect(parseEncryptedValue('enc:v2:cbc:anotherbase64data')).toBeNull();
      expect(parseEncryptedValue('enc:v1:unknown:data')).toBeNull();
    });
  });

  describe('encryptValue / decryptValue - AES-256-GCM', () => {
    it('should encrypt and decrypt a value correctly', async () => {
      const plaintext = 'test@example.com';
      const algorithm: EncryptionAlgorithm = 'AES-256-GCM';

      const { encrypted } = await encryptValue(plaintext, TEST_KEY, algorithm, 1);
      expect(isEncrypted(encrypted)).toBe(true);
      expect(encrypted).toMatch(/^enc:v1:gcm:/);

      const {
        decrypted,
        wasEncrypted,
        algorithm: detectedAlgo,
      } = await decryptValue(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
      expect(wasEncrypted).toBe(true);
      expect(detectedAlgo).toBe('AES-256-GCM');
    });

    it('should handle empty string', async () => {
      const { encrypted } = await encryptValue('', TEST_KEY, 'AES-256-GCM', 1);
      expect(encrypted).toBe('');
    });

    it('should handle unicode characters', async () => {
      const plaintext = 'こんにちは世界 🌍 émojis';
      const { encrypted } = await encryptValue(plaintext, TEST_KEY, 'AES-256-GCM', 1);
      const { decrypted } = await decryptValue(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      const plaintext = 'same value';
      const { encrypted: encrypted1 } = await encryptValue(plaintext, TEST_KEY, 'AES-256-GCM', 1);
      const { encrypted: encrypted2 } = await encryptValue(plaintext, TEST_KEY, 'AES-256-GCM', 1);

      // Different ciphertext due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both decrypt to same value
      const { decrypted: decrypted1 } = await decryptValue(encrypted1, TEST_KEY);
      const { decrypted: decrypted2 } = await decryptValue(encrypted2, TEST_KEY);
      expect(decrypted1).toBe(plaintext);
      expect(decrypted2).toBe(plaintext);
    });
  });

  describe('encryptValue - NONE algorithm', () => {
    it('should return plaintext when algorithm is NONE', async () => {
      const plaintext = 'not encrypted';
      const { encrypted, algorithm } = await encryptValue(plaintext, TEST_KEY, 'NONE', 1);
      expect(encrypted).toBe(plaintext);
      expect(algorithm).toBe('NONE');
    });
  });

  describe('decryptValue - plaintext passthrough', () => {
    it('should return plaintext if not encrypted', async () => {
      const plaintext = 'just a regular email@example.com';
      const { decrypted, wasEncrypted } = await decryptValue(plaintext, TEST_KEY);
      expect(decrypted).toBe(plaintext);
      expect(wasEncrypted).toBe(false);
    });

    it('should handle null and undefined', async () => {
      const { decrypted: decryptedNull, wasEncrypted: wasNull } = await decryptValue(
        null,
        TEST_KEY
      );
      expect(decryptedNull).toBeNull();
      expect(wasNull).toBe(false);

      const { decrypted: decryptedUndef, wasEncrypted: wasUndef } = await decryptValue(
        undefined,
        TEST_KEY
      );
      expect(decryptedUndef).toBeUndefined();
      expect(wasUndef).toBe(false);
    });

    it('should fail closed for removed encrypted formats', async () => {
      await expect(decryptValue('enc:v2:cbc:anotherbase64data', TEST_KEY)).rejects.toThrow(
        'Unsupported encrypted value format'
      );
    });
  });

  describe('decryption with wrong key', () => {
    it('should throw error when using wrong key', async () => {
      const { encrypted } = await encryptValue('secret', TEST_KEY, 'AES-256-GCM', 1);

      await expect(decryptValue(encrypted, TEST_KEY_V2)).rejects.toThrow('Decryption failed');
    });
  });

  describe('key version tracking', () => {
    it('should preserve key version in encrypted format', async () => {
      const { encrypted: v1Encrypted } = await encryptValue('data', TEST_KEY, 'AES-256-GCM', 1);
      const { encrypted: v99Encrypted } = await encryptValue('data', TEST_KEY, 'AES-256-GCM', 99);

      expect(v1Encrypted).toMatch(/^enc:v1:gcm:/);
      expect(v99Encrypted).toMatch(/^enc:v99:gcm:/);

      const v1Result = await decryptValue(v1Encrypted, TEST_KEY);
      const v99Result = await decryptValue(v99Encrypted, TEST_KEY);

      expect(v1Result.keyVersion).toBe(1);
      expect(v99Result.keyVersion).toBe(99);
    });
  });
});

describe('EncryptionConfigManager', () => {
  describe('default configuration', () => {
    it('should return default config when key is provided', async () => {
      // With key provided, default enabled=true works
      const manager = new EncryptionConfigManager({ PII_ENCRYPTION_KEY: TEST_KEY });

      expect(await manager.isEncryptionEnabled()).toBe(true);
      expect(await manager.getAlgorithm()).toBe('AES-256-GCM');
      expect(await manager.getEncryptionFields()).toEqual([
        'email',
        'phone_number',
        'name',
        'given_name',
        'family_name',
      ]);
      expect(await manager.getKeyVersion()).toBe(1);
    });

    it('should verify DEFAULT_ENCRYPTION_CONFIG has encryption enabled', () => {
      expect(DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_ENABLED).toBe(true);
      expect(DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_ALGORITHM).toBe('AES-256-GCM');
    });
  });

  // Issue 2: Fail-fast when enabled but key missing
  describe('fail-fast validation (Issue 2)', () => {
    it('should throw EncryptionKeyMissingError when enabled but key not set', () => {
      expect(() => new EncryptionConfigManager({})).toThrow(EncryptionKeyMissingError);
      expect(() => new EncryptionConfigManager({})).toThrow(
        'PII encryption is enabled but PII_ENCRYPTION_KEY is not set'
      );
    });

    it('should throw when explicitly enabled without key', () => {
      expect(
        () =>
          new EncryptionConfigManager({
            ENABLE_PII_ENCRYPTION: 'true',
          })
      ).toThrow(EncryptionKeyMissingError);
    });

    it('should NOT throw when encryption is disabled', () => {
      // Explicitly disabled - no key needed
      expect(
        () =>
          new EncryptionConfigManager({
            ENABLE_PII_ENCRYPTION: 'false',
          })
      ).not.toThrow();
    });

    it('should NOT throw when key is provided', () => {
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: TEST_KEY,
          })
      ).not.toThrow();
    });
  });

  // Key length and format validation
  describe('key format validation', () => {
    it('should throw EncryptionKeyInvalidError when key is too short', () => {
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: 'abc123', // Too short
          })
      ).toThrow(EncryptionKeyInvalidError);
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: 'abc123',
          })
      ).toThrow(`must be exactly ${PII_ENCRYPTION_KEY_LENGTH} hex characters`);
    });

    it('should throw EncryptionKeyInvalidError when key is too long', () => {
      const tooLongKey = TEST_KEY + 'abcd'; // 68 characters
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: tooLongKey,
          })
      ).toThrow(EncryptionKeyInvalidError);
    });

    it('should throw EncryptionKeyInvalidError when key contains non-hex characters', () => {
      // 64 characters but contains 'g' and 'z' which are not valid hex
      const invalidHexKey = 'g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1bz';
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: invalidHexKey,
          })
      ).toThrow(EncryptionKeyInvalidError);
    });

    it('should accept valid 64-character hex key (lowercase)', () => {
      const lowercaseKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
      expect(() => new EncryptionConfigManager({ PII_ENCRYPTION_KEY: lowercaseKey })).not.toThrow();
    });

    it('should accept valid 64-character hex key (uppercase)', () => {
      const uppercaseKey = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2';
      expect(() => new EncryptionConfigManager({ PII_ENCRYPTION_KEY: uppercaseKey })).not.toThrow();
    });

    it('should accept valid 64-character hex key (mixed case)', () => {
      const mixedCaseKey = 'A1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0C1d2E3f4A5b6C7d8E9f0A1b2';
      expect(() => new EncryptionConfigManager({ PII_ENCRYPTION_KEY: mixedCaseKey })).not.toThrow();
    });

    it('should NOT validate key when encryption is disabled', () => {
      // Invalid key but encryption is disabled - should not throw
      expect(
        () =>
          new EncryptionConfigManager({
            ENABLE_PII_ENCRYPTION: 'false',
            PII_ENCRYPTION_KEY: 'invalid',
          })
      ).not.toThrow();
    });

    it('should include helpful message with openssl command', () => {
      try {
        new EncryptionConfigManager({ PII_ENCRYPTION_KEY: 'short' });
      } catch (e) {
        expect((e as Error).message).toContain('openssl rand -hex 32');
      }
    });

    // Weak key detection tests
    it('should reject all-zeros key (zero entropy)', () => {
      const allZerosKey = '0000000000000000000000000000000000000000000000000000000000000000';
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: allZerosKey,
          })
      ).toThrow(EncryptionKeyInvalidError);
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: allZerosKey,
          })
      ).toThrow('all identical characters');
    });

    it('should reject all-same-character key', () => {
      const allSameKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: allSameKey,
          })
      ).toThrow(EncryptionKeyInvalidError);
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: allSameKey,
          })
      ).toThrow('all identical characters');
    });

    it('should reject repeating pattern key', () => {
      const repeatingKey = '0123456701234567012345670123456701234567012345670123456701234567';
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: repeatingKey,
          })
      ).toThrow(EncryptionKeyInvalidError);
      expect(
        () =>
          new EncryptionConfigManager({
            PII_ENCRYPTION_KEY: repeatingKey,
          })
      ).toThrow('repeating pattern');
    });
  });

  describe('environment variable override', () => {
    it('should fall back to GCM when the removed CBC algorithm is configured', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false', // Explicitly disable
        PII_ENCRYPTION_ALGORITHM: 'AES-256-CBC',
        PII_ENCRYPTION_FIELDS: 'email,phone_number',
        PII_ENCRYPTION_KEY_VERSION: '5',
      };
      const manager = new EncryptionConfigManager(env);

      expect(await manager.isEncryptionEnabled()).toBe(false);
      expect(await manager.getAlgorithm()).toBe('AES-256-GCM');
      expect(await manager.getEncryptionFields()).toEqual(['email', 'phone_number']);
      expect(await manager.getKeyVersion()).toBe(5);
    });

    it('should handle "true" and "1" as true for enabled flag', async () => {
      const envTrue: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_KEY: TEST_KEY,
      };
      const envOne: Partial<Env> = { ENABLE_PII_ENCRYPTION: '1', PII_ENCRYPTION_KEY: TEST_KEY };

      expect(await new EncryptionConfigManager(envTrue).isEncryptionEnabled()).toBe(true);
      expect(await new EncryptionConfigManager(envOne).isEncryptionEnabled()).toBe(true);
    });

    it('should use default for invalid values', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false', // Disable to avoid key requirement
        PII_ENCRYPTION_ALGORITHM: 'INVALID_ALGO',
        PII_ENCRYPTION_FIELDS: 'invalid_field_only',
      };
      const manager = new EncryptionConfigManager(env);

      expect(await manager.getAlgorithm()).toBe('AES-256-GCM'); // Falls back to default
      expect(await manager.getEncryptionFields()).toEqual(
        DEFAULT_ENCRYPTION_CONFIG.PII_ENCRYPTION_FIELDS
      ); // Falls back to default
    });
  });

  // Issue 5: Support "none" for empty field list
  describe('empty field list with "none" keyword (Issue 5)', () => {
    it('should allow explicitly setting empty field list with "none"', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false',
        PII_ENCRYPTION_FIELDS: 'none',
      };
      const manager = new EncryptionConfigManager(env);

      expect(await manager.getEncryptionFields()).toEqual([]);
    });

    it('should handle "NONE" (uppercase) for empty field list', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false',
        PII_ENCRYPTION_FIELDS: 'NONE',
      };
      const manager = new EncryptionConfigManager(env);

      expect(await manager.getEncryptionFields()).toEqual([]);
    });

    it('should handle " none " (with spaces) for empty field list', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false',
        PII_ENCRYPTION_FIELDS: '  none  ',
      };
      const manager = new EncryptionConfigManager(env);

      expect(await manager.getEncryptionFields()).toEqual([]);
    });
  });

  describe('shouldEncryptField', () => {
    it('should return true for configured fields when enabled', async () => {
      const manager = new EncryptionConfigManager({ PII_ENCRYPTION_KEY: TEST_KEY });

      // Default is enabled with key provided
      expect(await manager.shouldEncryptField('email')).toBe(true);
      expect(await manager.shouldEncryptField('phone_number')).toBe(true);
      expect(await manager.shouldEncryptField('name')).toBe(true);
    });

    it('should return false for non-configured fields', async () => {
      const manager = new EncryptionConfigManager({ PII_ENCRYPTION_KEY: TEST_KEY });

      expect(await manager.shouldEncryptField('id')).toBe(false);
      expect(await manager.shouldEncryptField('unknown_field')).toBe(false);
    });

    it('should return false when encryption is explicitly disabled', async () => {
      const manager = new EncryptionConfigManager({
        ENABLE_PII_ENCRYPTION: 'false',
      });
      expect(await manager.shouldEncryptField('email')).toBe(false);
    });

    it('should return false when algorithm is NONE', async () => {
      const manager = new EncryptionConfigManager({
        PII_ENCRYPTION_KEY: TEST_KEY,
        PII_ENCRYPTION_ALGORITHM: 'NONE',
      });
      expect(await manager.shouldEncryptField('email')).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return current configuration status', () => {
      const manager = new EncryptionConfigManager({
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_ALGORITHM: 'AES-256-GCM',
        PII_ENCRYPTION_FIELDS: 'email,name',
        PII_ENCRYPTION_KEY_VERSION: '3',
      });

      const status = manager.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.algorithm).toBe('AES-256-GCM');
      expect(status.fields).toEqual(['email', 'name']);
      expect(status.keyVersion).toBe(3);
    });
  });

  describe('getAllConfig', () => {
    it('should return complete configuration', async () => {
      const manager = new EncryptionConfigManager({ PII_ENCRYPTION_KEY: TEST_KEY });
      const config = await manager.getAllConfig();

      expect(config.PII_ENCRYPTION_ENABLED).toBe(true);
      expect(config.PII_ENCRYPTION_ALGORITHM).toBe('AES-256-GCM');
      expect(config.PII_ENCRYPTION_FIELDS).toEqual([
        'email',
        'phone_number',
        'name',
        'given_name',
        'family_name',
      ]);
      expect(config.PII_ENCRYPTION_KEY_VERSION).toBe(1);
    });
  });
});

describe('PIIEncryptionService', () => {
  let configManager: EncryptionConfigManager;

  describe('encryptField / decryptField', () => {
    it('should encrypt and decrypt fields when enabled', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_ALGORITHM: 'AES-256-GCM',
        PII_ENCRYPTION_FIELDS: 'email',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      const encrypted = await service.encryptField('email', 'test@example.com');
      expect(isEncrypted(encrypted as string)).toBe(true);

      const decrypted = await service.decryptField(encrypted);
      expect(decrypted).toBe('test@example.com');
    });

    it('should not encrypt fields not in the configured list', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_FIELDS: 'email',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      const result = await service.encryptField('name', 'John Doe');
      expect(result).toBe('John Doe');
      expect(isEncrypted(result as string)).toBe(false);
    });

    it('should not encrypt when disabled', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      const result = await service.encryptField('email', 'test@example.com');
      expect(result).toBe('test@example.com');
    });

    it('should not double-encrypt already encrypted values', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_FIELDS: 'email',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      const encrypted = await service.encryptField('email', 'test@example.com');
      const doubleEncrypted = await service.encryptField('email', encrypted);

      expect(encrypted).toBe(doubleEncrypted);
    });
  });

  describe('encryptFields / decryptFields', () => {
    it('should encrypt multiple fields', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_FIELDS: 'email,phone_number,name',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      const data = {
        email: 'test@example.com',
        phone_number: '+1-555-1234',
        name: 'John Doe',
        id: '12345', // Not in encryption fields
      };

      const encrypted = await service.encryptFields(data, ['email', 'phone_number', 'name']);

      expect(isEncrypted(encrypted.email as string)).toBe(true);
      expect(isEncrypted(encrypted.phone_number as string)).toBe(true);
      expect(isEncrypted(encrypted.name as string)).toBe(true);
      expect(encrypted.id).toBe('12345'); // Unchanged

      const decrypted = await service.decryptFields(encrypted, ['email', 'phone_number', 'name']);

      expect(decrypted.email).toBe('test@example.com');
      expect(decrypted.phone_number).toBe('+1-555-1234');
      expect(decrypted.name).toBe('John Doe');
      expect(decrypted.id).toBe('12345');
    });
  });

  describe('isAvailable', () => {
    it('should return false when encryption is disabled', async () => {
      const env: Partial<Env> = {
        ENABLE_PII_ENCRYPTION: 'false',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      expect(await service.isAvailable()).toBe(false);
    });

    it('should return true when key configured and enabled', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      expect(await service.isAvailable()).toBe(true);
    });
  });

  // Issue 6: Test key missing scenarios in PIIEncryptionService
  describe('key missing scenarios (Issue 6)', () => {
    it('should not encrypt when service has no key', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY, // ConfigManager needs key
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_FIELDS: 'email',
      };

      configManager = new EncryptionConfigManager(env);
      // But service is created WITHOUT the key
      const service = new PIIEncryptionService(configManager, undefined);

      const result = await service.encryptField('email', 'test@example.com');
      // Should not encrypt because service has no key
      expect(result).toBe('test@example.com');
    });

    it('should warn when encryption is enabled but service key is missing', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_FIELDS: 'email',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, undefined);

      await service.encryptField('email', 'test@example.com');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('PII_ENCRYPTION_KEY not configured')
      );

      consoleSpy.mockRestore();
    });

    it('should return false for isAvailable when service has no key', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, undefined);

      expect(await service.isAvailable()).toBe(false);
    });
  });

  describe('reEncryptField', () => {
    it('should re-encrypt with a new key version', async () => {
      const env: Partial<Env> = {
        PII_ENCRYPTION_KEY: TEST_KEY,
        ENABLE_PII_ENCRYPTION: 'true',
        PII_ENCRYPTION_ALGORITHM: 'AES-256-GCM',
        PII_ENCRYPTION_FIELDS: 'email',
      };

      configManager = new EncryptionConfigManager(env);
      const service = new PIIEncryptionService(configManager, TEST_KEY);

      // First encrypt with GCM
      const gcmEncrypted = await service.encryptField('email', 'test@example.com');
      expect((gcmEncrypted as string).includes(':gcm:')).toBe(true);

      const reEncrypted = await service.reEncryptField(gcmEncrypted, 'AES-256-GCM', 2);
      expect((reEncrypted as string).includes(':gcm:')).toBe(true);
      expect((reEncrypted as string).includes(':v2:')).toBe(true);

      // Verify decryption still works
      const decrypted = await service.decryptField(reEncrypted);
      expect(decrypted).toBe('test@example.com');
    });
  });
});
