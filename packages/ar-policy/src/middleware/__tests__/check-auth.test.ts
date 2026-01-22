/**
 * Check API Authentication Middleware Tests
 *
 * Tests for:
 * - API Key validation (prefix-based, SHA-256 hash, timing-safe comparison)
 * - Access Token (JWT) validation
 * - Policy Secret fallback
 * - Rate limiting tiers (strict, moderate, lenient)
 * - Cache behavior (5-minute TTL)
 * - Expiration and inactive key handling
 *
 * Security-critical validations:
 * - Timing-safe comparison prevents timing attacks
 * - Hash comparison prevents plaintext key storage
 * - Expiration prevents use of revoked keys
 *
 * @see Phase 8.3: Real-time Check API Model
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  type CheckAuthResult,
  type CheckAuthContext,
} from '../check-auth';
import type { CheckApiKey, CheckApiOperation, RateLimitTier } from '@authrim/ar-lib-core';

// Mock @authrim/ar-lib-core with timingSafeEqual and logger
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    timingSafeEqual: (a: string, b: string) => a === b,
    createLogger: () => ({
      module: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  };
});

/**
 * Helper to create SHA-256 hash (same as in check-auth.ts)
 */
async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create mock D1 database
 */
function createMockDb(rows: unknown[] = []): CheckAuthContext['db'] {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: rows }),
      first: vi.fn().mockResolvedValue(rows[0] ?? null),
      run: vi.fn().mockResolvedValue({ success: true }),
    }),
  } as unknown as CheckAuthContext['db'];
}

/**
 * Create mock KV namespace
 */
function createMockKv(cache: Map<string, string> = new Map()): CheckAuthContext['cache'] {
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(cache.get(key) ?? null)),
    put: vi.fn().mockImplementation((key: string, value: string) => {
      cache.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      cache.delete(key);
      return Promise.resolve();
    }),
  } as unknown as CheckAuthContext['cache'];
}

/**
 * Create a valid API key record for testing
 */
async function createApiKeyRecord(
  apiKey: string,
  options?: {
    isActive?: boolean;
    expiresAt?: number | null;
    rateLimitTier?: RateLimitTier;
    allowedOperations?: CheckApiOperation[];
    tenantId?: string;
    clientId?: string;
  }
): Promise<{
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_operations: string;
  rate_limit_tier: string;
  is_active: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}> {
  const keyHash = await hashString(apiKey);
  const now = Math.floor(Date.now() / 1000);

  return {
    id: 'key_123',
    tenant_id: options?.tenantId ?? 'default',
    client_id: options?.clientId ?? 'client_abc',
    name: 'Test API Key',
    key_hash: keyHash,
    key_prefix: apiKey.substring(0, 8),
    allowed_operations: JSON.stringify(
      options?.allowedOperations ?? ['check', 'batch', 'subscribe']
    ),
    rate_limit_tier: options?.rateLimitTier ?? 'moderate',
    is_active: options?.isActive !== false ? 1 : 0,
    expires_at: options?.expiresAt ?? null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create a JWT token for testing
 */
function createJwt(payload: Record<string, unknown>, expiry?: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    iat: now,
    exp: expiry ?? now + 3600,
    ...payload,
  };

  const headerB64 = btoa(JSON.stringify(header)).replace(/[=]/g, '');
  const payloadB64 = btoa(JSON.stringify(fullPayload)).replace(/[=]/g, '');
  const signature = 'fake_signature_for_testing';

  return `${headerB64}.${payloadB64}.${signature}`;
}

describe('Check API Authentication Middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('API Key Authentication', () => {
    const TEST_API_KEY = 'chk_test1234567890abcdef';

    it('should authenticate valid API key', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY);
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.method).toBe('api_key');
      expect(result.apiKeyId).toBe('key_123');
      expect(result.clientId).toBe('client_abc');
      expect(result.tenantId).toBe('default');
      expect(result.rateLimitTier).toBe('moderate');
    });

    it('should reject invalid API key', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY);
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest('Bearer chk_invalid_key_here', ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should reject inactive API key', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, { isActive: false });
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should reject expired API key', async () => {
      const now = Math.floor(Date.now() / 1000);
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, {
        expiresAt: now - 3600, // Expired 1 hour ago
      });
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should accept API key with future expiration', async () => {
      const now = Math.floor(Date.now() / 1000);
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, {
        expiresAt: now + 86400, // Expires in 1 day
      });
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(true);
    });

    it('should accept API key without expiration', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, {
        expiresAt: null,
      });
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(true);
    });

    it('should return correct rate limit tier', async () => {
      // Strict tier
      let keyRecord = await createApiKeyRecord(TEST_API_KEY, { rateLimitTier: 'strict' });
      let db = createMockDb([keyRecord]);
      let result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, { db });
      expect(result.rateLimitTier).toBe('strict');

      // Lenient tier
      keyRecord = await createApiKeyRecord(TEST_API_KEY, { rateLimitTier: 'lenient' });
      db = createMockDb([keyRecord]);
      result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, { db });
      expect(result.rateLimitTier).toBe('lenient');
    });

    it('should return allowed operations', async () => {
      const operations: CheckApiOperation[] = ['check', 'batch'];
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, {
        allowedOperations: operations,
      });
      const db = createMockDb([keyRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.allowedOperations).toEqual(operations);
    });

    it('should reject missing Authorization header', async () => {
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(undefined, ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should reject invalid Authorization header format', async () => {
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      // Missing Bearer prefix
      let result = await authenticateCheckApiRequest(TEST_API_KEY, ctx);
      expect(result.authenticated).toBe(false);

      // Wrong auth scheme
      result = await authenticateCheckApiRequest(`Basic ${TEST_API_KEY}`, ctx);
      expect(result.authenticated).toBe(false);
    });
  });

  describe('API Key Cache Behavior', () => {
    const TEST_API_KEY = 'chk_cached_key_12345';

    it('should use cached API key when available', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY);
      const keyHash = await hashString(TEST_API_KEY);
      const cache = new Map<string, string>();

      // Pre-populate cache
      const cacheKey: CheckApiKey = {
        id: keyRecord.id,
        tenant_id: keyRecord.tenant_id,
        client_id: keyRecord.client_id,
        name: keyRecord.name,
        key_hash: keyRecord.key_hash,
        key_prefix: keyRecord.key_prefix,
        allowed_operations: JSON.parse(keyRecord.allowed_operations),
        rate_limit_tier: keyRecord.rate_limit_tier as RateLimitTier,
        is_active: true,
        expires_at: undefined,
        created_at: keyRecord.created_at,
        updated_at: keyRecord.updated_at,
      };
      cache.set(`check:apikey:${keyHash}`, JSON.stringify(cacheKey));

      const db = createMockDb();
      const kvMock = createMockKv(cache);
      const ctx: CheckAuthContext = { db, cache: kvMock };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(true);
      // DB should not be called since cache was hit
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('should cache API key after successful DB validation', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY);
      const cache = new Map<string, string>();
      const db = createMockDb([keyRecord]);
      const kvMock = createMockKv(cache);
      const ctx: CheckAuthContext = { db, cache: kvMock };

      await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      // Cache should now contain the key
      const keyHash = await hashString(TEST_API_KEY);
      expect(cache.has(`check:apikey:${keyHash}`)).toBe(true);
    });

    it('should reject cached but expired API key', async () => {
      const now = Math.floor(Date.now() / 1000);
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, {
        expiresAt: now - 3600,
      });
      const keyHash = await hashString(TEST_API_KEY);
      const cache = new Map<string, string>();

      // Pre-populate cache with expired key
      const cacheKey: CheckApiKey = {
        id: keyRecord.id,
        tenant_id: keyRecord.tenant_id,
        client_id: keyRecord.client_id,
        name: keyRecord.name,
        key_hash: keyRecord.key_hash,
        key_prefix: keyRecord.key_prefix,
        allowed_operations: JSON.parse(keyRecord.allowed_operations),
        rate_limit_tier: keyRecord.rate_limit_tier as RateLimitTier,
        is_active: true,
        expires_at: now - 3600, // Expired
        created_at: keyRecord.created_at,
        updated_at: keyRecord.updated_at,
      };
      cache.set(`check:apikey:${keyHash}`, JSON.stringify(cacheKey));

      const db = createMockDb();
      const kvMock = createMockKv(cache);
      const ctx: CheckAuthContext = { db, cache: kvMock };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should reject cached but inactive API key', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY, { isActive: false });
      const keyHash = await hashString(TEST_API_KEY);
      const cache = new Map<string, string>();

      // Pre-populate cache with inactive key
      const cacheKey: CheckApiKey = {
        id: keyRecord.id,
        tenant_id: keyRecord.tenant_id,
        client_id: keyRecord.client_id,
        name: keyRecord.name,
        key_hash: keyRecord.key_hash,
        key_prefix: keyRecord.key_prefix,
        allowed_operations: JSON.parse(keyRecord.allowed_operations),
        rate_limit_tier: keyRecord.rate_limit_tier as RateLimitTier,
        is_active: false,
        expires_at: undefined,
        created_at: keyRecord.created_at,
        updated_at: keyRecord.updated_at,
      };
      cache.set(`check:apikey:${keyHash}`, JSON.stringify(cacheKey));

      const db = createMockDb();
      const kvMock = createMockKv(cache);
      const ctx: CheckAuthContext = { db, cache: kvMock };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should fall back to DB when cache is unavailable', async () => {
      const keyRecord = await createApiKeyRecord(TEST_API_KEY);
      const db = createMockDb([keyRecord]);
      // No cache provided
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${TEST_API_KEY}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(db.prepare).toHaveBeenCalled();
    });
  });

  describe('Access Token (JWT) Authentication', () => {
    it('should authenticate valid JWT', async () => {
      const jwt = createJwt({
        sub: 'user_123',
        client_id: 'client_xyz',
        tenant_id: 'tenant_abc',
      });
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${jwt}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.method).toBe('access_token');
      expect(result.subjectId).toBe('user_123');
      expect(result.clientId).toBe('client_xyz');
      expect(result.tenantId).toBe('tenant_abc');
    });

    it('should use azp claim when client_id is missing', async () => {
      const jwt = createJwt({
        sub: 'user_456',
        azp: 'client_from_azp',
      });
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${jwt}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.clientId).toBe('client_from_azp');
    });

    it('should default tenant_id to "default" when missing', async () => {
      const jwt = createJwt({
        sub: 'user_789',
        client_id: 'client_test',
        // No tenant_id
      });
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${jwt}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.tenantId).toBe('default');
    });

    it('should reject expired JWT', async () => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = createJwt(
        {
          sub: 'user_expired',
          client_id: 'client_test',
        },
        now - 3600 // Expired 1 hour ago
      );
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${jwt}`, ctx);

      expect(result.authenticated).toBe(false);
      // Implementation returns 'invalid_token' for security (no information leakage)
      expect(result.error).toBe('invalid_token');
    });

    it('should accept JWT with future expiration', async () => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = createJwt(
        {
          sub: 'user_valid',
          client_id: 'client_test',
        },
        now + 7200 // Expires in 2 hours
      );
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${jwt}`, ctx);

      expect(result.authenticated).toBe(true);
    });

    it('should reject malformed JWT', async () => {
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      // Only 2 parts
      let result = await authenticateCheckApiRequest('Bearer header.payload', ctx);
      expect(result.authenticated).toBe(false);

      // Invalid base64
      result = await authenticateCheckApiRequest('Bearer !!!.!!!.!!!', ctx);
      expect(result.authenticated).toBe(false);
    });
  });

  describe('Policy Secret Fallback', () => {
    it('should authenticate with policy secret', async () => {
      const policySecret = 'super_secret_policy_key_12345';
      const db = createMockDb();
      const ctx: CheckAuthContext = {
        db,
        policyApiSecret: policySecret,
      };

      const result = await authenticateCheckApiRequest(`Bearer ${policySecret}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.method).toBe('policy_secret');
      expect(result.rateLimitTier).toBe('lenient');
    });

    it('should grant all operations with policy secret', async () => {
      const policySecret = 'policy_secret_for_all_ops';
      const db = createMockDb();
      const ctx: CheckAuthContext = {
        db,
        policyApiSecret: policySecret,
      };

      const result = await authenticateCheckApiRequest(`Bearer ${policySecret}`, ctx);

      expect(result.authenticated).toBe(true);
      expect(result.allowedOperations).toContain('check');
      expect(result.allowedOperations).toContain('batch');
      expect(result.allowedOperations).toContain('subscribe');
    });

    it('should not authenticate with wrong policy secret', async () => {
      const db = createMockDb();
      const ctx: CheckAuthContext = {
        db,
        policyApiSecret: 'correct_secret',
      };

      const result = await authenticateCheckApiRequest('Bearer wrong_secret', ctx);

      expect(result.authenticated).toBe(false);
    });
  });

  describe('isOperationAllowed', () => {
    it('should return true when operation is in allowed list', () => {
      const authResult: CheckAuthResult = {
        authenticated: true,
        allowedOperations: ['check', 'batch'],
      };

      expect(isOperationAllowed(authResult, 'check')).toBe(true);
      expect(isOperationAllowed(authResult, 'batch')).toBe(true);
    });

    it('should return false when operation is not in allowed list', () => {
      const authResult: CheckAuthResult = {
        authenticated: true,
        allowedOperations: ['check'],
      };

      expect(isOperationAllowed(authResult, 'batch')).toBe(false);
      expect(isOperationAllowed(authResult, 'subscribe')).toBe(false);
    });

    it('should return false when not authenticated', () => {
      const authResult: CheckAuthResult = {
        authenticated: false,
        allowedOperations: ['check', 'batch_check'],
      };

      expect(isOperationAllowed(authResult, 'check')).toBe(false);
    });

    it('should return false when allowedOperations is undefined', () => {
      const authResult: CheckAuthResult = {
        authenticated: true,
        // No allowedOperations
      };

      expect(isOperationAllowed(authResult, 'check')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty bearer token', async () => {
      const db = createMockDb();
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest('Bearer ', ctx);

      expect(result.authenticated).toBe(false);
    });

    it('should handle DB error gracefully', async () => {
      const db = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockRejectedValue(new Error('DB connection failed')),
        }),
      } as unknown as CheckAuthContext['db'];
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest('Bearer chk_test12345678', ctx);

      expect(result.authenticated).toBe(false);
      // Implementation maps internal errors to 'server_error' for internal failures
      expect(result.error).toBe('server_error');
    });

    it('should handle cache error gracefully and fall back to DB', async () => {
      const keyRecord = await createApiKeyRecord('chk_fallback_key123');
      const db = createMockDb([keyRecord]);
      const cache = {
        get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
        put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      } as unknown as CheckAuthContext['cache'];
      const ctx: CheckAuthContext = { db, cache };

      const result = await authenticateCheckApiRequest('Bearer chk_fallback_key123', ctx);

      // Should still succeed via DB
      expect(result.authenticated).toBe(true);
      expect(db.prepare).toHaveBeenCalled();
    });

    it('should handle multiple keys with same prefix', async () => {
      const targetKey = 'chk_sameprefix_target';
      const otherKey = 'chk_sameprefix_other';

      const targetRecord = await createApiKeyRecord(targetKey);
      const otherRecord = await createApiKeyRecord(otherKey);

      // Both have same prefix: chk_same
      const db = createMockDb([otherRecord, targetRecord]);
      const ctx: CheckAuthContext = { db };

      const result = await authenticateCheckApiRequest(`Bearer ${targetKey}`, ctx);

      expect(result.authenticated).toBe(true);
    });
  });
});
