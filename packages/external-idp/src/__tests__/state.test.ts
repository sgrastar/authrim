/**
 * Auth State Management Tests
 * Tests atomic state consumption and cleanup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Storage for tracking SQL calls across all D1Adapter instances
const sqlTracker = {
  calls: [] as { method: string; sql: string; params: unknown[] }[],
  reset() {
    this.calls.length = 0;
  },
};

// Create hoisted mocks that can be configured in tests
const { mockExecute, mockQueryOne, MockD1Adapter } = vi.hoisted(() => {
  // These are the actual mock functions that tests can configure
  const executeMock = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const queryOneMock = vi.fn().mockResolvedValue(null);

  // Create a class that wraps the mock functions and tracks calls
  class D1AdapterClass {
    execute = (sql: string, params?: unknown[]) => {
      sqlTracker.calls.push({ method: 'execute', sql, params: params || [] });
      return executeMock(sql, params);
    };

    queryOne = (sql: string, params?: unknown[]) => {
      sqlTracker.calls.push({ method: 'queryOne', sql, params: params || [] });
      return queryOneMock(sql, params);
    };

    query = vi.fn().mockResolvedValue([]);
  }

  return {
    mockExecute: executeMock,
    mockQueryOne: queryOneMock,
    MockD1Adapter: D1AdapterClass,
  };
});

// Mock @authrim/shared to prevent Cloudflare Workers imports
vi.mock('@authrim/shared', () => ({
  D1Adapter: MockD1Adapter,
}));

import {
  storeAuthState,
  consumeAuthState,
  cleanupExpiredStates,
  getStateExpiresAt,
} from '../utils/state';
import type { Env } from '@authrim/shared';

describe('Auth State Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlTracker.reset();
    // Reset mock implementations to defaults
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockQueryOne.mockResolvedValue(null);
  });

  describe('storeAuthState', () => {
    it('should store auth state with all required fields', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

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

      // Verify execute was called
      const executeCalls = sqlTracker.calls.filter((c) => c.method === 'execute');
      expect(executeCalls.length).toBeGreaterThan(0);

      // Verify INSERT SQL was called
      const insertCall = executeCalls.find((c) =>
        c.sql.includes('INSERT INTO external_idp_auth_states')
      );
      expect(insertCall).toBeDefined();

      // Check params contain expected values
      expect(insertCall!.params).toContain('test-tenant');
      expect(insertCall!.params).toContain('google-provider');
      expect(insertCall!.params).toContain('random-state-value');
      expect(insertCall!.params).toContain('random-nonce');
      expect(insertCall!.params).toContain('pkce-verifier');
    });

    it('should store auth state with optional fields as null', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

      const stateData = {
        tenantId: 'default',
        providerId: 'github-provider',
        state: 'state-value',
        redirectUri: 'https://example.com/callback',
        expiresAt: Date.now() + 600000,
        // Optional fields not provided
      };

      await storeAuthState(mockEnv, stateData);

      const insertCall = sqlTracker.calls.find((c) =>
        c.sql.includes('INSERT INTO external_idp_auth_states')
      );
      expect(insertCall).toBeDefined();

      // Optional fields should be null (nonce, codeVerifier, userId, sessionId, etc.)
      const nullCount = insertCall!.params.filter((v) => v === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(3);
    });

    it('should store max_age when provided', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

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

      const insertCall = sqlTracker.calls.find((c) =>
        c.sql.includes('INSERT INTO external_idp_auth_states')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.params).toContain(300);
    });
  });

  describe('consumeAuthState', () => {
    it('should consume valid state atomically', async () => {
      const mockEnv = { DB: {} } as unknown as Env;
      const now = Date.now();

      // First call (execute) succeeds with rowsAffected: 1
      mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });

      // Second call (queryOne) returns the consumed state
      mockQueryOne.mockResolvedValueOnce({
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
        acr_values: null,
        expires_at: now + 300000,
        created_at: now - 60000,
        consumed_at: now,
      });

      const result = await consumeAuthState(mockEnv, 'valid-state');

      expect(result).not.toBeNull();
      expect(result?.state).toBe('valid-state');
      expect(result?.nonce).toBe('nonce');
      expect(result?.codeVerifier).toBe('verifier');

      // Verify UPDATE was called with correct conditions
      const updateCall = sqlTracker.calls.find((c) =>
        c.sql.includes('UPDATE external_idp_auth_states')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall!.sql).toContain('consumed_at IS NULL');
    });

    it('should return null for already consumed state', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

      // Simulate state already consumed (UPDATE affects 0 rows)
      mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });

      const result = await consumeAuthState(mockEnv, 'already-consumed-state');

      expect(result).toBeNull();
      // Should not attempt SELECT if UPDATE failed
      const queryOneCalls = sqlTracker.calls.filter((c) => c.method === 'queryOne');
      expect(queryOneCalls.length).toBe(0);
    });

    it('should return null for expired state', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

      // Simulate expired state (UPDATE affects 0 rows)
      mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });

      const result = await consumeAuthState(mockEnv, 'expired-state');

      expect(result).toBeNull();
    });

    it('should return null for non-existent state', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

      // Simulate non-existent state (UPDATE affects 0 rows)
      mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });

      const result = await consumeAuthState(mockEnv, 'nonexistent-state');

      expect(result).toBeNull();
    });

    it('should include max_age in returned state', async () => {
      const mockEnv = { DB: {} } as unknown as Env;
      const now = Date.now();

      mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
      mockQueryOne.mockResolvedValueOnce({
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
        acr_values: null,
        expires_at: now + 300000,
        created_at: now - 60000,
        consumed_at: now,
      });

      const result = await consumeAuthState(mockEnv, 'state-with-maxage');

      expect(result).not.toBeNull();
      expect(result?.maxAge).toBe(300);
    });
  });

  describe('atomic consumption guarantees', () => {
    it('should prevent double consumption via UPDATE condition', async () => {
      const mockEnv = { DB: {} } as unknown as Env;
      const now = Date.now();
      let consumptionCount = 0;

      // First call succeeds, second call fails
      mockExecute.mockImplementation(async () => {
        if (consumptionCount === 0) {
          consumptionCount++;
          return { rowsAffected: 1 };
        }
        return { rowsAffected: 0 }; // Already consumed
      });

      mockQueryOne.mockResolvedValue({
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
        acr_values: null,
        expires_at: now + 300000,
        created_at: now - 60000,
        consumed_at: now,
      });

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
      const mockEnv = { DB: {} } as unknown as Env;

      mockExecute.mockResolvedValueOnce({ rowsAffected: 5 });

      const deleted = await cleanupExpiredStates(mockEnv);

      expect(deleted).toBe(5);

      // Verify DELETE SQL was called with correct conditions
      const deleteCall = sqlTracker.calls.find((c) =>
        c.sql.includes('DELETE FROM external_idp_auth_states')
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.sql).toContain('expires_at <');
      expect(deleteCall!.sql).toContain('consumed_at IS NOT NULL');
    });

    it('should return 0 when no states to cleanup', async () => {
      const mockEnv = { DB: {} } as unknown as Env;

      mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });

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
    sqlTracker.reset();
    mockExecute.mockResolvedValue({ rowsAffected: 0 });
  });

  it('should use UPDATE...WHERE consumed_at IS NULL for atomic consumption', async () => {
    // This test documents the security requirement
    // The SQL must include consumed_at IS NULL to prevent replay attacks
    const mockEnv = { DB: {} } as unknown as Env;

    await consumeAuthState(mockEnv, 'test-state');

    const updateCall = sqlTracker.calls.find(
      (c) => c.method === 'execute' && c.sql.includes('UPDATE')
    );

    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain('consumed_at IS NULL');
    expect(updateCall!.sql).toContain('SET consumed_at');
    expect(updateCall!.sql).toContain('expires_at >');
  });
});
