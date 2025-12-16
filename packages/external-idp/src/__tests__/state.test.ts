/**
 * Auth State Management Tests
 * Tests atomic state consumption and cleanup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  storeAuthState,
  consumeAuthState,
  cleanupExpiredStates,
  getStateExpiresAt,
} from '../utils/state';
import type { Env } from '@authrim/shared';

// Mock D1 database
function createMockDb() {
  const storage = new Map<string, Record<string, unknown>>();
  let lastBindValues: unknown[] = [];

  const mockStatement = {
    bind: vi.fn((...values: unknown[]) => {
      lastBindValues = values;
      return mockStatement;
    }),
    run: vi.fn(async () => {
      // Simulate INSERT/UPDATE/DELETE
      const changes = 1; // Default to 1 change
      return { meta: { changes } };
    }),
    first: vi.fn(async <T>(): Promise<T | null> => {
      return null;
    }),
    all: vi.fn(async <T>(): Promise<{ results: T[] }> => {
      return { results: [] };
    }),
  };

  return {
    prepare: vi.fn((_sql: string) => mockStatement),
    storage,
    mockStatement,
    getLastBindValues: () => lastBindValues,
  };
}

describe('Auth State Management', () => {
  describe('storeAuthState', () => {
    it('should store auth state with all required fields', async () => {
      const mockDb = createMockDb();
      const mockEnv = { DB: mockDb } as unknown as Env;

      const stateData = {
        tenantId: 'test-tenant',
        providerId: 'google-provider',
        state: 'random-state-value',
        nonce: 'random-nonce',
        codeVerifier: 'pkce-verifier',
        redirectUri: 'https://example.com/callback',
        expiresAt: Date.now() + 600000,
      };

      await storeAuthState(mockEnv, stateData);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO external_idp_auth_states')
      );
      expect(mockDb.mockStatement.bind).toHaveBeenCalled();
      expect(mockDb.mockStatement.run).toHaveBeenCalled();

      const bindValues = mockDb.getLastBindValues();
      expect(bindValues).toContain('test-tenant');
      expect(bindValues).toContain('google-provider');
      expect(bindValues).toContain('random-state-value');
      expect(bindValues).toContain('random-nonce');
      expect(bindValues).toContain('pkce-verifier');
    });

    it('should store auth state with optional fields as null', async () => {
      const mockDb = createMockDb();
      const mockEnv = { DB: mockDb } as unknown as Env;

      const stateData = {
        tenantId: 'default',
        providerId: 'github-provider',
        state: 'state-value',
        redirectUri: 'https://example.com/callback',
        expiresAt: Date.now() + 600000,
        // Optional fields not provided
      };

      await storeAuthState(mockEnv, stateData);

      const bindValues = mockDb.getLastBindValues();
      // Optional fields should be null
      const nullCount = bindValues.filter((v) => v === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(3); // nonce, codeVerifier, userId, sessionId, etc.
    });

    it('should store max_age when provided', async () => {
      const mockDb = createMockDb();
      const mockEnv = { DB: mockDb } as unknown as Env;

      const stateData = {
        tenantId: 'default',
        providerId: 'google-provider',
        state: 'state-value',
        nonce: 'nonce-value',
        codeVerifier: 'verifier',
        redirectUri: 'https://example.com/callback',
        maxAge: 300, // 5 minutes
        expiresAt: Date.now() + 600000,
      };

      await storeAuthState(mockEnv, stateData);

      const bindValues = mockDb.getLastBindValues();
      expect(bindValues).toContain(300);
    });
  });

  describe('consumeAuthState', () => {
    it('should consume valid state atomically', async () => {
      const mockDb = createMockDb();
      const now = Date.now();
      let updateCalled = false;

      mockDb.mockStatement.run.mockImplementation(async () => {
        updateCalled = true;
        return { meta: { changes: 1 } }; // State was successfully marked as consumed
      });

      mockDb.mockStatement.first.mockImplementation(async () => {
        if (updateCalled) {
          return {
            id: 'state-id',
            tenant_id: 'default',
            provider_id: 'google',
            state: 'valid-state',
            nonce: 'nonce',
            code_verifier: 'verifier',
            redirect_uri: 'https://example.com/callback',
            user_id: null,
            session_id: null,
            original_auth_request: null,
            max_age: null,
            expires_at: now + 300000,
            created_at: now - 60000,
            consumed_at: now,
          };
        }
        return null;
      });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const result = await consumeAuthState(mockEnv, 'valid-state');

      expect(result).not.toBeNull();
      expect(result?.state).toBe('valid-state');
      expect(result?.nonce).toBe('nonce');
      expect(result?.codeVerifier).toBe('verifier');

      // Verify UPDATE was called with correct conditions
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE external_idp_auth_states')
      );
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('consumed_at IS NULL'));
    });

    it('should return null for already consumed state', async () => {
      const mockDb = createMockDb();

      // Simulate state already consumed (UPDATE affects 0 rows)
      mockDb.mockStatement.run.mockResolvedValue({ meta: { changes: 0 } });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const result = await consumeAuthState(mockEnv, 'already-consumed-state');

      expect(result).toBeNull();
      // Should not attempt SELECT if UPDATE failed
      expect(mockDb.mockStatement.first).not.toHaveBeenCalled();
    });

    it('should return null for expired state', async () => {
      const mockDb = createMockDb();

      // Simulate expired state (UPDATE affects 0 rows)
      mockDb.mockStatement.run.mockResolvedValue({ meta: { changes: 0 } });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const result = await consumeAuthState(mockEnv, 'expired-state');

      expect(result).toBeNull();
    });

    it('should return null for non-existent state', async () => {
      const mockDb = createMockDb();

      // Simulate non-existent state (UPDATE affects 0 rows)
      mockDb.mockStatement.run.mockResolvedValue({ meta: { changes: 0 } });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const result = await consumeAuthState(mockEnv, 'nonexistent-state');

      expect(result).toBeNull();
    });

    it('should include max_age in returned state', async () => {
      const mockDb = createMockDb();
      const now = Date.now();

      mockDb.mockStatement.run.mockResolvedValue({ meta: { changes: 1 } });
      mockDb.mockStatement.first.mockResolvedValue({
        id: 'state-id',
        tenant_id: 'default',
        provider_id: 'google',
        state: 'state-with-maxage',
        nonce: 'nonce',
        code_verifier: 'verifier',
        redirect_uri: 'https://example.com/callback',
        user_id: null,
        session_id: null,
        original_auth_request: null,
        max_age: 300, // 5 minutes
        expires_at: now + 300000,
        created_at: now - 60000,
        consumed_at: now,
      });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const result = await consumeAuthState(mockEnv, 'state-with-maxage');

      expect(result).not.toBeNull();
      expect(result?.maxAge).toBe(300);
    });
  });

  describe('atomic consumption guarantees', () => {
    it('should prevent double consumption via UPDATE condition', async () => {
      const mockDb = createMockDb();
      let consumptionCount = 0;

      // First call succeeds, second call fails
      mockDb.mockStatement.run.mockImplementation(async () => {
        if (consumptionCount === 0) {
          consumptionCount++;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } }; // Already consumed
      });

      mockDb.mockStatement.first.mockResolvedValue({
        id: 'state-id',
        tenant_id: 'default',
        provider_id: 'google',
        state: 'race-condition-state',
        nonce: 'nonce',
        code_verifier: 'verifier',
        redirect_uri: 'https://example.com/callback',
        user_id: null,
        session_id: null,
        original_auth_request: null,
        max_age: null,
        expires_at: Date.now() + 300000,
        created_at: Date.now() - 60000,
        consumed_at: Date.now(),
      });

      const mockEnv = { DB: mockDb } as unknown as Env;

      // Simulate concurrent requests
      const [result1, result2] = await Promise.all([
        consumeAuthState(mockEnv, 'race-condition-state'),
        consumeAuthState(mockEnv, 'race-condition-state'),
      ]);

      // Only one should succeed
      const successCount = [result1, result2].filter((r) => r !== null).length;
      expect(successCount).toBe(1);
    });
  });

  describe('cleanupExpiredStates', () => {
    it('should delete expired and consumed states', async () => {
      const mockDb = createMockDb();

      mockDb.mockStatement.run.mockResolvedValue({ meta: { changes: 5 } });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const deleted = await cleanupExpiredStates(mockEnv);

      expect(deleted).toBe(5);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM external_idp_auth_states')
      );
      // Should check both expired and old consumed states
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('expires_at <'));
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('consumed_at IS NOT NULL')
      );
    });

    it('should return 0 when no states to cleanup', async () => {
      const mockDb = createMockDb();

      mockDb.mockStatement.run.mockResolvedValue({ meta: { changes: 0 } });

      const mockEnv = { DB: mockDb } as unknown as Env;

      const deleted = await cleanupExpiredStates(mockEnv);

      expect(deleted).toBe(0);
    });
  });

  describe('getStateExpiresAt', () => {
    it('should return expiration time 10 minutes in the future', () => {
      const before = Date.now();
      const expiresAt = getStateExpiresAt();
      const after = Date.now();

      const expectedMinMs = before + 600 * 1000; // 10 minutes
      const expectedMaxMs = after + 600 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(expectedMinMs);
      expect(expiresAt).toBeLessThanOrEqual(expectedMaxMs);
    });
  });
});

describe('Security considerations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use UPDATE...WHERE consumed_at IS NULL for atomic consumption', () => {
    // This test documents the security requirement
    // The SQL must include consumed_at IS NULL to prevent replay attacks
    const mockDb = createMockDb();
    const mockEnv = { DB: mockDb } as unknown as Env;

    consumeAuthState(mockEnv, 'test-state');

    const sqlCalls = mockDb.prepare.mock.calls.map((call) => call[0]);
    const updateCall = sqlCalls.find((sql) => typeof sql === 'string' && sql.includes('UPDATE'));

    expect(updateCall).toContain('consumed_at IS NULL');
    expect(updateCall).toContain('SET consumed_at');
    expect(updateCall).toContain('expires_at >');
  });
});
