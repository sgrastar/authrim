import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  normalizeKey,
  SECRET_FIELD_NORMALIZED_BLACKLIST,
  sanitizeEventDetails,
  writeEventDetails,
  readEventDetails,
  writePIIValues,
  sanitizeErrorMessage,
  generateAAD,
  calculateRetentionUntil,
  decryptPIIValues,
  logAuditAsync,
  DETAILS_INLINE_LIMIT_BYTES,
  PII_VALUES_INLINE_LIMIT_BYTES,
  ERROR_MESSAGE_MAX_LENGTH,
} from '../utils';
import type { TenantPIIConfig } from '../types';

/**
 * Audit Utility Tests
 *
 * Tests for audit logging utilities including:
 * - Base64 encoding/decoding with chunking
 * - Key normalization and blacklist matching
 * - Event details sanitization and evacuation
 * - PII values handling
 * - Error message sanitization
 * - AAD generation for encryption
 * - Retention calculation
 */

describe('Audit Utils', () => {
  // ==========================================================================
  // Base64 Utilities
  // ==========================================================================

  describe('arrayBufferToBase64', () => {
    it('should encode small ArrayBuffer correctly', () => {
      const data = new TextEncoder().encode('Hello, World!');
      const base64 = arrayBufferToBase64(data.buffer);

      expect(base64).toBe('SGVsbG8sIFdvcmxkIQ==');
    });

    it('should encode empty ArrayBuffer', () => {
      const data = new Uint8Array(0);
      const base64 = arrayBufferToBase64(data.buffer);

      expect(base64).toBe('');
    });

    it('should encode binary data correctly', () => {
      // Binary data with values 0-255
      const data = new Uint8Array([0, 127, 128, 255]);
      const base64 = arrayBufferToBase64(data.buffer);

      expect(base64).toBe('AH+A/w==');
    });

    it('should handle large data without RangeError', () => {
      // Create 100KB of data (larger than typical call stack limits)
      const size = 100 * 1024;
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }

      // Should not throw RangeError
      expect(() => arrayBufferToBase64(data.buffer)).not.toThrow();

      const base64 = arrayBufferToBase64(data.buffer);
      expect(base64.length).toBeGreaterThan(0);
    });
  });

  describe('base64ToArrayBuffer', () => {
    it('should decode Base64 correctly', () => {
      const base64 = 'SGVsbG8sIFdvcmxkIQ==';
      const buffer = base64ToArrayBuffer(base64);
      const decoded = new TextDecoder().decode(buffer);

      expect(decoded).toBe('Hello, World!');
    });

    it('should decode empty Base64', () => {
      const buffer = base64ToArrayBuffer('');
      expect(new Uint8Array(buffer).length).toBe(0);
    });

    it('should be inverse of arrayBufferToBase64', () => {
      const original = new TextEncoder().encode('日本語テスト');
      const base64 = arrayBufferToBase64(original.buffer);
      const decoded = base64ToArrayBuffer(base64);

      expect(new Uint8Array(decoded)).toEqual(original);
    });
  });

  // ==========================================================================
  // Key Normalization
  // ==========================================================================

  describe('normalizeKey', () => {
    it('should convert to lowercase', () => {
      expect(normalizeKey('ACCESS_TOKEN')).toBe('accesstoken');
      expect(normalizeKey('AccessToken')).toBe('accesstoken');
    });

    it('should remove hyphens', () => {
      expect(normalizeKey('access-token')).toBe('accesstoken');
      expect(normalizeKey('x-api-key')).toBe('xapikey');
    });

    it('should remove underscores', () => {
      expect(normalizeKey('access_token')).toBe('accesstoken');
      expect(normalizeKey('client_secret')).toBe('clientsecret');
    });

    it('should handle mixed formats', () => {
      expect(normalizeKey('Access-Token_Value')).toBe('accesstokenvalue');
      expect(normalizeKey('X-API_KEY')).toBe('xapikey');
    });

    it('should return empty string for empty input', () => {
      expect(normalizeKey('')).toBe('');
    });
  });

  describe('SECRET_FIELD_NORMALIZED_BLACKLIST', () => {
    it('should contain common secret fields', () => {
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('authorization')).toBe(true);
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('password')).toBe(true);
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('accesstoken')).toBe(true);
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('clientsecret')).toBe(true);
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('jwt')).toBe(true);
    });

    it('should use normalized keys (lowercase, no hyphens/underscores)', () => {
      // All keys should be lowercase with no hyphens or underscores
      for (const key of SECRET_FIELD_NORMALIZED_BLACKLIST) {
        expect(key).toBe(key.toLowerCase());
        expect(key).not.toContain('-');
        expect(key).not.toContain('_');
      }
    });

    it('should not contain non-secret words', () => {
      // "secretary" should not be blocked
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('secretary')).toBe(false);
      expect(SECRET_FIELD_NORMALIZED_BLACKLIST.has('tokenizer')).toBe(false);
    });
  });

  // ==========================================================================
  // Event Details Sanitization
  // ==========================================================================

  describe('sanitizeEventDetails', () => {
    const defaultPiiConfig: TenantPIIConfig = {
      piiFields: {
        email: true,
        name: true,
        phone: true,
        ip_address: false,
        user_agent: false,
        device_fingerprint: false,
        address: false,
        birthdate: false,
        government_id: true,
      },
      eventLogDetailLevel: 'standard',
      eventLogRetentionDays: 90,
      piiLogRetentionDays: 365,
    };

    it('should remove PII fields from details', () => {
      const details = {
        action: 'login',
        email: 'user@example.com',
        name: 'John Doe',
        ip_address: '192.168.1.1', // Not PII in config
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      expect(sanitized.action).toBe('login');
      expect(sanitized.email).toBeUndefined();
      expect(sanitized.name).toBeUndefined();
      expect(sanitized.ip_address).toBe('192.168.1.1');
    });

    it('should remove secret fields from blacklist', () => {
      const details = {
        action: 'auth',
        access_token: 'secret-token',
        Authorization: 'Bearer xyz',
        password: 'secret123',
        clientId: 'client-1',
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      expect(sanitized.action).toBe('auth');
      expect(sanitized.access_token).toBeUndefined();
      expect(sanitized.Authorization).toBeUndefined();
      expect(sanitized.password).toBeUndefined();
      expect(sanitized.clientId).toBe('client-1');
    });

    it('should handle various naming conventions for secrets', () => {
      const details = {
        'access-token': 'token1',
        ACCESS_TOKEN: 'token2',
        accessToken: 'token3',
        client_secret: 'secret1',
        'x-api-key': 'key1',
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      expect(sanitized['access-token']).toBeUndefined();
      expect(sanitized.ACCESS_TOKEN).toBeUndefined();
      expect(sanitized.accessToken).toBeUndefined();
      expect(sanitized.client_secret).toBeUndefined();
      expect(sanitized['x-api-key']).toBeUndefined();
    });

    it('should remove query string from request_path', () => {
      const details = {
        request_path: '/oauth/token?client_id=abc&secret=xyz',
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      expect(sanitized.request_path).toBe('/oauth/token');
    });

    it('should handle camelCase requestPath', () => {
      const details = {
        requestPath: '/api/users?email=test@example.com',
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      expect(sanitized.requestPath).toBe('/api/users');
    });

    it('should not remove "secretary" or similar words', () => {
      const details = {
        secretary_name: 'Jane',
        tokenizer: 'gpt-4',
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      // These should NOT be removed (not in blacklist)
      expect(sanitized.secretary_name).toBe('Jane');
      expect(sanitized.tokenizer).toBe('gpt-4');
    });

    it('should preserve non-PII fields', () => {
      const details = {
        action: 'create',
        resourceId: 'res-123',
        durationMs: 150,
        statusCode: 200,
      };

      const sanitized = sanitizeEventDetails(details, defaultPiiConfig);

      expect(sanitized).toEqual(details);
    });
  });

  // ==========================================================================
  // Event Details Write/Read with R2
  // ==========================================================================

  describe('writeEventDetails', () => {
    let mockR2Bucket: {
      put: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockR2Bucket = {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
      };
    });

    it('should store inline if <= 2KB', async () => {
      const details = { action: 'test', value: 'small' };

      const result = await writeEventDetails(
        details,
        mockR2Bucket as unknown as R2Bucket,
        'tenant-1',
        'entry-123'
      );

      expect(result.detailsJson).toBe(JSON.stringify(details));
      expect(result.detailsR2Key).toBeNull();
      expect(mockR2Bucket.put).not.toHaveBeenCalled();
    });

    it('should evacuate to R2 if > 2KB', async () => {
      // Create large details (> 2KB)
      const largeValue = 'x'.repeat(3000);
      const details = { data: largeValue };

      const result = await writeEventDetails(
        details,
        mockR2Bucket as unknown as R2Bucket,
        'tenant-1',
        'entry-123'
      );

      expect(result.detailsJson).toBeNull();
      expect(result.detailsR2Key).toMatch(
        /^event-details\/tenant-1\/\d{4}-\d{2}-\d{2}\/entry-123\.json$/
      );
      expect(mockR2Bucket.put).toHaveBeenCalledTimes(1);
    });

    it('should use byte length, not character length (Unicode)', async () => {
      // Japanese characters use 3 bytes each in UTF-8
      // Create string that appears < 2KB by char count but > 2KB by byte count
      const japaneseText = 'あ'.repeat(700); // 700 chars * 3 bytes = 2100 bytes

      const result = await writeEventDetails(
        { text: japaneseText },
        mockR2Bucket as unknown as R2Bucket,
        'tenant-1',
        'entry-123'
      );

      // Should evacuate to R2 because byte count > 2KB
      expect(result.detailsR2Key).not.toBeNull();
    });
  });

  describe('readEventDetails', () => {
    let mockR2Bucket: {
      put: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockR2Bucket = {
        put: vi.fn(),
        get: vi.fn(),
      };
    });

    it('should read from inline JSON', async () => {
      const details = { action: 'test', value: 123 };

      const result = await readEventDetails(
        JSON.stringify(details),
        null,
        mockR2Bucket as unknown as R2Bucket
      );

      expect(result).toEqual(details);
      expect(mockR2Bucket.get).not.toHaveBeenCalled();
    });

    it('should read from R2', async () => {
      const details = { action: 'from-r2', data: 'large' };
      mockR2Bucket.get.mockResolvedValue({
        text: vi.fn().mockResolvedValue(JSON.stringify(details)),
      });

      const result = await readEventDetails(
        null,
        'event-details/tenant-1/2024-01-01/entry-123.json',
        mockR2Bucket as unknown as R2Bucket
      );

      expect(result).toEqual(details);
      expect(mockR2Bucket.get).toHaveBeenCalledWith(
        'event-details/tenant-1/2024-01-01/entry-123.json'
      );
    });

    it('should return null if R2 object not found', async () => {
      mockR2Bucket.get.mockResolvedValue(null);

      const result = await readEventDetails(
        null,
        'nonexistent-key',
        mockR2Bucket as unknown as R2Bucket
      );

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      const result = await readEventDetails(
        'invalid json {',
        null,
        mockR2Bucket as unknown as R2Bucket
      );

      expect(result).toBeNull();
    });

    it('should return null if both inline and R2 key are null', async () => {
      const result = await readEventDetails(null, null, mockR2Bucket as unknown as R2Bucket);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // PII Values Write
  // ==========================================================================

  describe('writePIIValues', () => {
    let mockR2Bucket: {
      put: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockR2Bucket = {
        put: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('should store inline if <= 4KB', async () => {
      const encryptedJson = JSON.stringify({ ciphertext: 'small', iv: 'abc', keyId: 'key-1' });

      const result = await writePIIValues(
        encryptedJson,
        mockR2Bucket as unknown as R2Bucket,
        'tenant-1',
        'entry-123'
      );

      expect(result.valuesEncrypted).toBe(encryptedJson);
      expect(result.valuesR2Key).toBeNull();
      expect(mockR2Bucket.put).not.toHaveBeenCalled();
    });

    it('should evacuate to R2 if > 4KB', async () => {
      // Create large encrypted data (> 4KB)
      const largeCiphertext = 'x'.repeat(5000);
      const encryptedJson = JSON.stringify({
        ciphertext: largeCiphertext,
        iv: 'abc',
        keyId: 'key-1',
      });

      const result = await writePIIValues(
        encryptedJson,
        mockR2Bucket as unknown as R2Bucket,
        'tenant-1',
        'entry-123'
      );

      expect(result.valuesEncrypted).toBeNull();
      expect(result.valuesR2Key).toMatch(
        /^pii-values\/tenant-1\/\d{4}-\d{2}-\d{2}\/entry-123\.json$/
      );
      expect(mockR2Bucket.put).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Error Message Sanitization
  // ==========================================================================

  describe('sanitizeErrorMessage', () => {
    it('should redact Bearer tokens', () => {
      const message = 'Error: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature failed';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('should redact JWTs', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Rq8IjqQTvxn2tVc6YA8ZHw';
      const message = `Token validation failed: ${jwt}`;
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('[JWT_REDACTED]');
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('should redact password values', () => {
      const message = 'Login failed for user with password=secret123';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).not.toContain('secret123');
    });

    it('should redact secret values', () => {
      const message = 'Invalid secret: mySecretValue';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('secret=[REDACTED]');
    });

    it('should redact token values', () => {
      const message = 'token=abc123def456 is expired';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('token=[REDACTED]');
    });

    it('should redact api_key values', () => {
      const message = 'api_key=sk-12345 is invalid';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('api_key=[REDACTED]');
    });

    it('should redact authorization header', () => {
      const message = 'authorization: Basic dXNlcjpwYXNz failed';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('authorization=[REDACTED]');
    });

    it('should truncate long messages', () => {
      const longMessage = 'Error: ' + 'x'.repeat(2000);
      const sanitized = sanitizeErrorMessage(longMessage);

      expect(sanitized.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_LENGTH + 15); // 15 for "... [TRUNCATED]"
      expect(sanitized).toContain('[TRUNCATED]');
    });

    it('should not truncate short messages', () => {
      const shortMessage = 'Simple error';
      const sanitized = sanitizeErrorMessage(shortMessage);

      expect(sanitized).toBe(shortMessage);
    });

    it('should handle multiple secrets in one message', () => {
      const message = 'password=abc123 token=xyz789 secret=sss';
      const sanitized = sanitizeErrorMessage(message);

      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).toContain('token=[REDACTED]');
      expect(sanitized).toContain('secret=[REDACTED]');
      expect(sanitized).not.toContain('abc123');
      expect(sanitized).not.toContain('xyz789');
      expect(sanitized).not.toContain('sss');
    });
  });

  // ==========================================================================
  // AAD Generation
  // ==========================================================================

  describe('generateAAD', () => {
    it('should generate AAD from tenant and fields', () => {
      const aad = generateAAD('tenant-1', ['email', 'name']);
      const decoded = new TextDecoder().decode(aad);

      expect(decoded).toBe('tenant-1:email,name');
    });

    it('should sort affected fields for deterministic AAD', () => {
      const aad1 = generateAAD('tenant-1', ['name', 'email', 'phone']);
      const aad2 = generateAAD('tenant-1', ['email', 'phone', 'name']);

      expect(new TextDecoder().decode(aad1)).toBe('tenant-1:email,name,phone');
      expect(aad1).toEqual(aad2);
    });

    it('should handle empty fields array', () => {
      const aad = generateAAD('tenant-1', []);
      const decoded = new TextDecoder().decode(aad);

      expect(decoded).toBe('tenant-1:');
    });

    it('should handle single field', () => {
      const aad = generateAAD('tenant-1', ['email']);
      const decoded = new TextDecoder().decode(aad);

      expect(decoded).toBe('tenant-1:email');
    });
  });

  // ==========================================================================
  // Retention Calculation
  // ==========================================================================

  describe('calculateRetentionUntil', () => {
    it('should calculate retention expiry correctly', () => {
      const baseDate = new Date('2024-01-15T12:00:00Z');
      const expiryMs = calculateRetentionUntil(90, baseDate);
      const expiryDate = new Date(expiryMs);

      expect(expiryDate.getFullYear()).toBe(2024);
      expect(expiryDate.getMonth()).toBe(3); // April (0-indexed)
      expect(expiryDate.getDate()).toBe(14);
    });

    it('should use current date if not specified', () => {
      const now = Date.now();
      const expiryMs = calculateRetentionUntil(30);

      // Should be approximately 30 days from now
      const expectedMs = now + 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expiryMs - expectedMs)).toBeLessThan(1000);
    });

    it('should handle year boundaries', () => {
      const baseDate = new Date('2024-12-15T12:00:00Z');
      const expiryMs = calculateRetentionUntil(30, baseDate);
      const expiryDate = new Date(expiryMs);

      expect(expiryDate.getFullYear()).toBe(2025);
      expect(expiryDate.getMonth()).toBe(0); // January
    });

    it('should handle zero retention days', () => {
      const baseDate = new Date('2024-01-15T12:00:00Z');
      const expiryMs = calculateRetentionUntil(0, baseDate);

      expect(expiryMs).toBe(baseDate.getTime());
    });
  });

  // ==========================================================================
  // PII Decryption
  // ==========================================================================

  describe('decryptPIIValues', () => {
    it('should decrypt values using AES-GCM', async () => {
      // Create a test key
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);

      const tenantId = 'tenant-1';
      const affectedFields = ['email', 'name'];
      const aad = generateAAD(tenantId, affectedFields);
      const iv = crypto.getRandomValues(new Uint8Array(12));

      // Encrypt test data
      const testData = { email: 'test@example.com', name: 'John' };
      const plaintext = new TextEncoder().encode(JSON.stringify(testData));

      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        key,
        plaintext
      );

      // Create encrypted value structure
      const encrypted = {
        ciphertext: arrayBufferToBase64(ciphertext),
        iv: arrayBufferToBase64(iv.buffer),
        keyId: 'test-key',
      };

      // Mock key provider
      const keyProvider = vi.fn().mockResolvedValue(key);

      // Decrypt
      const decrypted = await decryptPIIValues(encrypted, tenantId, affectedFields, keyProvider);

      expect(decrypted).toEqual(testData);
      expect(keyProvider).toHaveBeenCalledWith('test-key');
    });

    it('should fail with wrong AAD (different tenant)', async () => {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);

      const tenantId = 'tenant-1';
      const affectedFields = ['email'];
      const aad = generateAAD(tenantId, affectedFields);
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const testData = { email: 'test@example.com' };
      const plaintext = new TextEncoder().encode(JSON.stringify(testData));

      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        key,
        plaintext
      );

      const encrypted = {
        ciphertext: arrayBufferToBase64(ciphertext),
        iv: arrayBufferToBase64(iv.buffer),
        keyId: 'test-key',
      };

      const keyProvider = vi.fn().mockResolvedValue(key);

      // Try to decrypt with wrong tenant (different AAD)
      await expect(
        decryptPIIValues(encrypted, 'wrong-tenant', affectedFields, keyProvider)
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Async Audit Logging
  // ==========================================================================

  describe('logAuditAsync', () => {
    it('should call auditService.logEvent with waitUntil', async () => {
      const mockAuditService = {
        logEvent: vi.fn().mockResolvedValue(undefined),
      };

      const mockCtx = {
        waitUntil: vi.fn((promise: Promise<void>) => promise),
      };

      const params = {
        eventType: 'test.event',
        eventCategory: 'test',
        result: 'success' as const,
        requestId: 'req-123',
      };

      logAuditAsync(mockCtx as unknown as ExecutionContext, mockAuditService, 'tenant-1', params);

      // waitUntil should be called
      expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);

      // Wait for the promise to resolve
      await mockCtx.waitUntil.mock.calls[0][0];

      expect(mockAuditService.logEvent).toHaveBeenCalledWith('tenant-1', params);
    });

    it('should log warning on audit failure', async () => {
      const mockAuditService = {
        logEvent: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      };

      const mockLogger = {
        warn: vi.fn(),
      };

      const mockCtx = {
        waitUntil: vi.fn((promise: Promise<void>) => promise),
      };

      const params = {
        eventType: 'test.event',
        eventCategory: 'test',
        result: 'success' as const,
        requestId: 'req-123',
      };

      logAuditAsync(
        mockCtx as unknown as ExecutionContext,
        mockAuditService,
        'tenant-1',
        params,
        mockLogger
      );

      // Wait for the promise (should not throw)
      await mockCtx.waitUntil.mock.calls[0][0];

      // Logger should be called with warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'audit_write_failed',
        expect.objectContaining({
          tenantId: 'tenant-1',
          eventType: 'test.event',
          requestId: 'req-123',
        })
      );
    });

    it('should sanitize error messages in failure logs', async () => {
      const mockAuditService = {
        logEvent: vi.fn().mockRejectedValue(new Error('Failed with password=secret123')),
      };

      const mockLogger = {
        warn: vi.fn(),
      };

      const mockCtx = {
        waitUntil: vi.fn((promise: Promise<void>) => promise),
      };

      logAuditAsync(
        mockCtx as unknown as ExecutionContext,
        mockAuditService,
        'tenant-1',
        { eventType: 'test', eventCategory: 'test', result: 'success' as const },
        mockLogger
      );

      await mockCtx.waitUntil.mock.calls[0][0];

      const logCall = mockLogger.warn.mock.calls[0];
      expect(logCall[1].error).toContain('[REDACTED]');
      expect(logCall[1].error).not.toContain('secret123');
    });
  });

  // ==========================================================================
  // Constants Verification
  // ==========================================================================

  describe('Constants', () => {
    it('DETAILS_INLINE_LIMIT_BYTES should be 2KB', () => {
      expect(DETAILS_INLINE_LIMIT_BYTES).toBe(2048);
    });

    it('PII_VALUES_INLINE_LIMIT_BYTES should be 4KB', () => {
      expect(PII_VALUES_INLINE_LIMIT_BYTES).toBe(4096);
    });

    it('ERROR_MESSAGE_MAX_LENGTH should be 1024', () => {
      expect(ERROR_MESSAGE_MAX_LENGTH).toBe(1024);
    });
  });
});
