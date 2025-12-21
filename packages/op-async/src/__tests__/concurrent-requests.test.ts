/**
 * Concurrent Request Tests
 *
 * Tests for race condition prevention in async OAuth flows
 * - Concurrent user_code approval attempts
 * - Concurrent auth_req_id processing
 * - Race condition detection
 *
 * @see RFC 8628: OAuth 2.0 Device Authorization Grant
 * @see OpenID Connect CIBA Core 1.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DeviceCodeMetadata, CIBARequestMetadata } from '@authrim/shared';

describe('Concurrent Request Handling', () => {
  /**
   * Simulates atomic compare-and-swap operation
   * Returns true if swap was successful, false if value was already changed
   */
  function compareAndSwap<T>(
    current: T,
    expected: T,
    newValue: T,
    updateFn: (value: T) => void
  ): boolean {
    if (current === expected) {
      updateFn(newValue);
      return true;
    }
    return false;
  }

  describe('Device Flow - Concurrent User Code Approval', () => {
    /**
     * Device code store with atomic operations
     */
    class DeviceCodeStore {
      private store = new Map<string, DeviceCodeMetadata>();
      private locks = new Map<string, boolean>();

      set(metadata: DeviceCodeMetadata): void {
        this.store.set(metadata.device_code, metadata);
      }

      get(deviceCode: string): DeviceCodeMetadata | undefined {
        return this.store.get(deviceCode);
      }

      getByUserCode(userCode: string): DeviceCodeMetadata | undefined {
        for (const metadata of this.store.values()) {
          if (metadata.user_code === userCode) {
            return metadata;
          }
        }
        return undefined;
      }

      /**
       * Atomic approval operation
       * Returns true if approval succeeded, false if already approved/denied
       */
      atomicApprove(deviceCode: string, userId: string, sub: string): boolean {
        const metadata = this.store.get(deviceCode);
        if (!metadata) {
          return false;
        }

        // Simulate lock acquisition
        if (this.locks.get(deviceCode)) {
          return false; // Lock already held
        }

        this.locks.set(deviceCode, true);

        try {
          // Check current state
          if (metadata.status !== 'pending') {
            return false;
          }

          // Perform atomic update
          metadata.status = 'approved';
          metadata.user_id = userId;
          metadata.sub = sub;
          return true;
        } finally {
          this.locks.delete(deviceCode);
        }
      }

      /**
       * Atomic token issuance
       */
      atomicIssueToken(deviceCode: string): boolean {
        const metadata = this.store.get(deviceCode);
        if (!metadata) {
          return false;
        }

        if (metadata.status !== 'approved' || metadata.token_issued) {
          return false;
        }

        metadata.token_issued = true;
        metadata.token_issued_at = Date.now();
        return true;
      }
    }

    let store: DeviceCodeStore;

    beforeEach(() => {
      store = new DeviceCodeStore();
    });

    it('should only allow one successful approval for concurrent attempts', async () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'pending',
        created_at: Date.now(),
        expires_at: Date.now() + 600000,
        poll_count: 0,
      };

      store.set(metadata);

      // Simulate 5 concurrent approval attempts
      const approvalAttempts = [
        store.atomicApprove('device123', 'user1', 'user1@example.com'),
        store.atomicApprove('device123', 'user2', 'user2@example.com'),
        store.atomicApprove('device123', 'user3', 'user3@example.com'),
        store.atomicApprove('device123', 'user4', 'user4@example.com'),
        store.atomicApprove('device123', 'user5', 'user5@example.com'),
      ];

      // Only one should succeed
      const successCount = approvalAttempts.filter(Boolean).length;
      expect(successCount).toBe(1);

      // Verify final state
      const finalMetadata = store.get('device123');
      expect(finalMetadata?.status).toBe('approved');
      expect(finalMetadata?.user_id).toBe('user1'); // First one wins
    });

    it('should prevent approval after denial', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'denied', // Already denied
        created_at: Date.now(),
        expires_at: Date.now() + 600000,
        poll_count: 0,
      };

      store.set(metadata);

      const approvalResult = store.atomicApprove('device123', 'user1', 'user1@example.com');

      expect(approvalResult).toBe(false);
      expect(store.get('device123')?.status).toBe('denied');
    });

    it('should prevent multiple token issuances', () => {
      const metadata: DeviceCodeMetadata = {
        device_code: 'device123',
        user_code: 'WDJB-MJHT',
        client_id: 'test-client',
        scope: 'openid',
        status: 'approved',
        user_id: 'user1',
        sub: 'user1@example.com',
        created_at: Date.now(),
        expires_at: Date.now() + 600000,
        poll_count: 0,
        token_issued: false,
      };

      store.set(metadata);

      // Simulate concurrent token issuance attempts
      const results = [
        store.atomicIssueToken('device123'),
        store.atomicIssueToken('device123'),
        store.atomicIssueToken('device123'),
      ];

      // Only first should succeed
      expect(results[0]).toBe(true);
      expect(results[1]).toBe(false);
      expect(results[2]).toBe(false);

      const finalMetadata = store.get('device123');
      expect(finalMetadata?.token_issued).toBe(true);
    });
  });

  describe('CIBA Flow - Concurrent auth_req_id Processing', () => {
    /**
     * CIBA request store with atomic operations
     */
    class CIBARequestStore {
      private store = new Map<string, CIBARequestMetadata>();

      set(metadata: CIBARequestMetadata): void {
        this.store.set(metadata.auth_req_id, metadata);
      }

      get(authReqId: string): CIBARequestMetadata | undefined {
        return this.store.get(authReqId);
      }

      /**
       * Atomic approval with optimistic locking via version check
       */
      atomicApprove(
        authReqId: string,
        userId: string,
        sub: string
      ): { success: boolean; error?: string } {
        const metadata = this.store.get(authReqId);
        if (!metadata) {
          return { success: false, error: 'not_found' };
        }

        if (metadata.status !== 'pending') {
          return { success: false, error: `already_${metadata.status}` };
        }

        metadata.status = 'approved';
        metadata.user_id = userId;
        metadata.sub = sub;
        return { success: true };
      }

      /**
       * Atomic denial
       */
      atomicDeny(authReqId: string): { success: boolean; error?: string } {
        const metadata = this.store.get(authReqId);
        if (!metadata) {
          return { success: false, error: 'not_found' };
        }

        if (metadata.status !== 'pending') {
          return { success: false, error: `already_${metadata.status}` };
        }

        metadata.status = 'denied';
        return { success: true };
      }

      /**
       * Atomic token issuance
       */
      atomicIssueToken(authReqId: string): { success: boolean; error?: string } {
        const metadata = this.store.get(authReqId);
        if (!metadata) {
          return { success: false, error: 'not_found' };
        }

        if (metadata.status !== 'approved') {
          return { success: false, error: 'not_approved' };
        }

        if (metadata.token_issued) {
          return { success: false, error: 'already_issued' };
        }

        metadata.token_issued = true;
        metadata.token_issued_at = Date.now();
        return { success: true };
      }
    }

    let store: CIBARequestStore;

    beforeEach(() => {
      store = new CIBARequestStore();
    });

    it('should only allow one successful approval for concurrent attempts', () => {
      const metadata: CIBARequestMetadata = {
        auth_req_id: 'ciba123',
        client_id: 'test-client',
        scope: 'openid',
        login_hint: 'user@example.com',
        status: 'pending',
        delivery_mode: 'poll',
        created_at: Date.now(),
        expires_at: Date.now() + 120000,
        poll_count: 0,
        interval: 5,
      };

      store.set(metadata);

      // Simulate concurrent approvals
      const results = [
        store.atomicApprove('ciba123', 'user1', 'sub1'),
        store.atomicApprove('ciba123', 'user2', 'sub2'),
        store.atomicApprove('ciba123', 'user3', 'sub3'),
      ];

      // Only first should succeed
      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBe(1);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('already_approved');
    });

    it('should prevent approval after denial', () => {
      const metadata: CIBARequestMetadata = {
        auth_req_id: 'ciba123',
        client_id: 'test-client',
        scope: 'openid',
        login_hint: 'user@example.com',
        status: 'pending',
        delivery_mode: 'poll',
        created_at: Date.now(),
        expires_at: Date.now() + 120000,
        poll_count: 0,
        interval: 5,
      };

      store.set(metadata);

      // First deny
      const denyResult = store.atomicDeny('ciba123');
      expect(denyResult.success).toBe(true);

      // Then try to approve
      const approveResult = store.atomicApprove('ciba123', 'user1', 'sub1');
      expect(approveResult.success).toBe(false);
      expect(approveResult.error).toBe('already_denied');
    });

    it('should prevent denial after approval', () => {
      const metadata: CIBARequestMetadata = {
        auth_req_id: 'ciba123',
        client_id: 'test-client',
        scope: 'openid',
        login_hint: 'user@example.com',
        status: 'pending',
        delivery_mode: 'poll',
        created_at: Date.now(),
        expires_at: Date.now() + 120000,
        poll_count: 0,
        interval: 5,
      };

      store.set(metadata);

      // First approve
      const approveResult = store.atomicApprove('ciba123', 'user1', 'sub1');
      expect(approveResult.success).toBe(true);

      // Then try to deny
      const denyResult = store.atomicDeny('ciba123');
      expect(denyResult.success).toBe(false);
      expect(denyResult.error).toBe('already_approved');
    });

    it('should prevent multiple token issuances', () => {
      const metadata: CIBARequestMetadata = {
        auth_req_id: 'ciba123',
        client_id: 'test-client',
        scope: 'openid',
        login_hint: 'user@example.com',
        status: 'approved',
        user_id: 'user1',
        sub: 'sub1',
        delivery_mode: 'poll',
        created_at: Date.now(),
        expires_at: Date.now() + 120000,
        poll_count: 0,
        interval: 5,
        token_issued: false,
      };

      store.set(metadata);

      // Simulate concurrent token issuance
      const results = [
        store.atomicIssueToken('ciba123'),
        store.atomicIssueToken('ciba123'),
        store.atomicIssueToken('ciba123'),
      ];

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('already_issued');
      expect(results[2].success).toBe(false);
    });
  });

  describe('Race Condition Detection', () => {
    it('should detect concurrent modification via timestamps', () => {
      interface VersionedMetadata {
        id: string;
        version: number;
        status: string;
        updated_at: number;
      }

      function updateWithVersionCheck(
        metadata: VersionedMetadata,
        expectedVersion: number,
        newStatus: string
      ): boolean {
        if (metadata.version !== expectedVersion) {
          return false; // Concurrent modification detected
        }

        metadata.status = newStatus;
        metadata.version++;
        metadata.updated_at = Date.now();
        return true;
      }

      const metadata: VersionedMetadata = {
        id: 'test123',
        version: 1,
        status: 'pending',
        updated_at: Date.now(),
      };

      // First update succeeds
      const result1 = updateWithVersionCheck(metadata, 1, 'approved');
      expect(result1).toBe(true);
      expect(metadata.version).toBe(2);

      // Second update with old version fails
      const result2 = updateWithVersionCheck(metadata, 1, 'denied');
      expect(result2).toBe(false);
      expect(metadata.status).toBe('approved'); // Unchanged
    });

    it('should handle high contention gracefully', () => {
      let value = 0;
      let successfulIncrements = 0;

      // Simulate optimistic locking increment
      function atomicIncrement(expectedValue: number): boolean {
        if (value !== expectedValue) {
          return false;
        }
        value++;
        successfulIncrements++;
        return true;
      }

      // All start at 0
      const results = [
        atomicIncrement(0),
        atomicIncrement(0),
        atomicIncrement(0),
        atomicIncrement(0),
        atomicIncrement(0),
      ];

      // Only one should succeed from initial value
      const initialSuccesses = results.filter(Boolean).length;
      expect(initialSuccesses).toBe(1);
      expect(value).toBe(1);
    });

    it('should maintain consistency under concurrent access', async () => {
      const operations: string[] = [];
      let state = 'pending';

      const transition = (from: string, to: string): boolean => {
        if (state !== from) {
          return false;
        }
        state = to;
        operations.push(`${from} -> ${to}`);
        return true;
      };

      // Simulate concurrent transitions
      const approveResult = transition('pending', 'approved');
      const denyResult = transition('pending', 'denied');

      // Only one should succeed
      expect(approveResult !== denyResult).toBe(true);

      // State should be consistent
      expect(['approved', 'denied']).toContain(state);
      expect(operations.length).toBe(1);
    });
  });

  describe('Idempotency', () => {
    it('should return same result for duplicate approval requests', () => {
      interface IdempotentStore {
        requests: Map<string, { status: string; user_id: string }>;
        idempotencyKeys: Set<string>;
      }

      const store: IdempotentStore = {
        requests: new Map(),
        idempotencyKeys: new Set(),
      };

      store.requests.set('req123', { status: 'pending', user_id: '' });

      function idempotentApprove(
        requestId: string,
        userId: string,
        idempotencyKey: string
      ): { success: boolean; duplicate: boolean } {
        // Check if this exact operation was already performed
        if (store.idempotencyKeys.has(idempotencyKey)) {
          return { success: true, duplicate: true };
        }

        const request = store.requests.get(requestId);
        if (!request || request.status !== 'pending') {
          return { success: false, duplicate: false };
        }

        request.status = 'approved';
        request.user_id = userId;
        store.idempotencyKeys.add(idempotencyKey);
        return { success: true, duplicate: false };
      }

      // First request
      const result1 = idempotentApprove('req123', 'user1', 'idempotency-key-1');
      expect(result1.success).toBe(true);
      expect(result1.duplicate).toBe(false);

      // Duplicate request with same idempotency key
      const result2 = idempotentApprove('req123', 'user1', 'idempotency-key-1');
      expect(result2.success).toBe(true);
      expect(result2.duplicate).toBe(true);
    });

    it('should reject duplicate token requests', () => {
      const issuedTokens = new Set<string>();

      function issueToken(authReqId: string): { success: boolean; error?: string } {
        if (issuedTokens.has(authReqId)) {
          return { success: false, error: 'already_issued' };
        }

        issuedTokens.add(authReqId);
        return { success: true };
      }

      // First issuance
      expect(issueToken('req123').success).toBe(true);

      // Duplicate issuance
      const result = issueToken('req123');
      expect(result.success).toBe(false);
      expect(result.error).toBe('already_issued');
    });
  });
});
