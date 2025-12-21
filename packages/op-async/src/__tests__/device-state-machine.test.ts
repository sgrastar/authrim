/**
 * Device Flow State Machine Tests
 *
 * Tests state transitions for OAuth 2.0 Device Authorization Grant (RFC 8628)
 * - pending → approved → token_issued transition
 * - Invalid state transition rejection
 * - Multiple approval attempt handling
 * - Token replay prevention after issuance
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DeviceCodeMetadata } from '@authrim/shared';

describe('Device Flow State Machine - RFC 8628', () => {
  /**
   * Device code status types (matches DeviceCodeMetadata['status'])
   * Note: Token issuance is tracked via token_issued boolean, not status
   */
  type DeviceStatus = 'pending' | 'approved' | 'denied' | 'expired';

  /**
   * Valid state transitions
   * Note: 'approved' is the final status before token issuance
   * Token issuance is tracked separately via token_issued flag
   */
  const VALID_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
    pending: ['approved', 'denied', 'expired'],
    approved: ['expired'], // Can only expire after approval (token_issued is tracked separately)
    denied: [], // Terminal state
    expired: [], // Terminal state
  };

  /**
   * Check if a state transition is valid
   */
  function isValidTransition(from: DeviceStatus, to: DeviceStatus): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /**
   * Helper to create device code metadata
   */
  function createDeviceCodeMetadata(
    overrides: Partial<DeviceCodeMetadata> = {}
  ): DeviceCodeMetadata {
    const now = Date.now();
    return {
      device_code: `device_${Date.now()}`,
      user_code: 'WDJB-MJHT',
      client_id: 'test-client',
      scope: 'openid profile',
      status: 'pending',
      created_at: now,
      expires_at: now + 600000, // 10 minutes
      poll_count: 0,
      ...overrides,
    };
  }

  describe('Valid State Transitions', () => {
    it('should allow pending → approved transition', () => {
      expect(isValidTransition('pending', 'approved')).toBe(true);
    });

    it('should allow pending → denied transition', () => {
      expect(isValidTransition('pending', 'denied')).toBe(true);
    });

    it('should allow pending → expired transition', () => {
      expect(isValidTransition('pending', 'expired')).toBe(true);
    });

    it('should allow approved → expired transition (timeout without token request)', () => {
      expect(isValidTransition('approved', 'expired')).toBe(true);
    });
  });

  describe('Invalid State Transitions', () => {
    it('should reject denied → approved transition', () => {
      expect(isValidTransition('denied', 'approved')).toBe(false);
    });

    it('should reject denied → pending transition', () => {
      expect(isValidTransition('denied', 'pending')).toBe(false);
    });

    it('should reject expired → approved transition', () => {
      expect(isValidTransition('expired', 'approved')).toBe(false);
    });

    it('should reject expired → pending transition', () => {
      expect(isValidTransition('expired', 'pending')).toBe(false);
    });

    it('should reject approved → pending transition (no rollback)', () => {
      expect(isValidTransition('approved', 'pending')).toBe(false);
    });

    it('should reject approved → denied transition (no rollback after approval)', () => {
      expect(isValidTransition('approved', 'denied')).toBe(false);
    });
  });

  describe('Full Flow: pending → approved with token issuance', () => {
    it('should complete successful flow with state tracking', () => {
      const metadata = createDeviceCodeMetadata();

      // Initial state
      expect(metadata.status).toBe('pending');
      expect(metadata.user_id).toBeUndefined();
      expect(metadata.sub).toBeUndefined();
      expect(metadata.token_issued).toBeUndefined();

      // User approves
      expect(isValidTransition(metadata.status as DeviceStatus, 'approved')).toBe(true);
      metadata.status = 'approved';
      metadata.user_id = 'user123';
      metadata.sub = 'user@example.com';

      expect(metadata.status).toBe('approved');
      expect(metadata.user_id).toBe('user123');
      expect(metadata.sub).toBe('user@example.com');

      // Token issued (tracked via token_issued flag, not status)
      // After token issuance, status remains 'approved' but token_issued is set
      metadata.token_issued = true;
      metadata.token_issued_at = Date.now();

      expect(metadata.status).toBe('approved');
      expect(metadata.token_issued).toBe(true);
      expect(metadata.token_issued_at).toBeDefined();
    });
  });

  describe('Multiple Approval Attempt Handling', () => {
    it('should reject second approval attempt for already approved code', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
      });

      // Try to approve again
      const canApproveAgain = metadata.status === 'pending';
      expect(canApproveAgain).toBe(false);
    });

    it('should reject approval attempt for denied code', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'denied',
      });

      const canApprove = isValidTransition(metadata.status as DeviceStatus, 'approved');
      expect(canApprove).toBe(false);
    });

    it('should reject approval attempt for expired code', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'expired',
        expires_at: Date.now() - 60000,
      });

      const canApprove = isValidTransition(metadata.status as DeviceStatus, 'approved');
      expect(canApprove).toBe(false);
    });

    it('should reject re-approval after token has been issued', () => {
      // Status remains 'approved' but token_issued flag is set
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
        token_issued: true,
        token_issued_at: Date.now() - 60000,
      });

      // Cannot re-approve (already approved with token issued)
      const canReApprove = metadata.status === 'pending';
      expect(canReApprove).toBe(false);
    });
  });

  describe('Token Replay Prevention', () => {
    it('should prevent token issuance after first issuance', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
        token_issued: true,
        token_issued_at: Date.now() - 30000,
      });

      // Token already issued - should reject
      const canIssueToken = metadata.status === 'approved' && !metadata.token_issued;
      expect(canIssueToken).toBe(false);
    });

    it('should allow first token issuance for approved code', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
        token_issued: false,
      });

      const canIssueToken = metadata.status === 'approved' && !metadata.token_issued;
      expect(canIssueToken).toBe(true);
    });

    it('should track token issuance timestamp', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
      });

      // Simulate token issuance
      metadata.token_issued = true;
      metadata.token_issued_at = Date.now();

      expect(metadata.token_issued).toBe(true);
      // token_issued_at should be >= created_at (may be equal if same millisecond)
      expect(metadata.token_issued_at).toBeGreaterThanOrEqual(metadata.created_at);
    });

    it('should reject token request when token_issued flag is true', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
        token_issued: true,
        token_issued_at: Date.now() - 60000,
      });

      // Simulate token request check - should reject because token already issued
      const shouldReject = metadata.token_issued === true;
      expect(shouldReject).toBe(true);
    });
  });

  describe('Denial Flow', () => {
    it('should allow pending → denied transition', () => {
      const metadata = createDeviceCodeMetadata();

      expect(metadata.status).toBe('pending');
      expect(isValidTransition(metadata.status as DeviceStatus, 'denied')).toBe(true);

      metadata.status = 'denied';
      expect(metadata.status).toBe('denied');
    });

    it('should reject token request for denied code', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'denied',
      });

      // Simulate token endpoint check - should return access_denied
      const canIssueToken = metadata.status === 'approved';
      expect(canIssueToken).toBe(false);
    });

    it('should not allow status change after denial', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'denied',
      });

      // Try all possible transitions - all should be rejected from denied state
      expect(isValidTransition('denied', 'pending')).toBe(false);
      expect(isValidTransition('denied', 'approved')).toBe(false);
      expect(isValidTransition('denied', 'expired')).toBe(false);
      // Note: denied is a terminal state, no transitions allowed
      expect(VALID_TRANSITIONS['denied'].length).toBe(0);
    });
  });

  describe('Expiration Flow', () => {
    it('should allow pending → expired when TTL exceeded', () => {
      const metadata = createDeviceCodeMetadata({
        created_at: Date.now() - 700000, // Created 700 seconds ago
        expires_at: Date.now() - 100000, // Expired 100 seconds ago
      });

      const isExpired = Date.now() > metadata.expires_at;
      expect(isExpired).toBe(true);
      expect(isValidTransition('pending', 'expired')).toBe(true);
    });

    it('should allow approved → expired when TTL exceeded without token request', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
        created_at: Date.now() - 700000,
        expires_at: Date.now() - 100000,
        token_issued: false,
      });

      const isExpired = Date.now() > metadata.expires_at;
      expect(isExpired).toBe(true);
      expect(metadata.status).toBe('approved');
      expect(isValidTransition('approved', 'expired')).toBe(true);
    });

    it('should reject all transitions from expired state', () => {
      expect(isValidTransition('expired', 'pending')).toBe(false);
      expect(isValidTransition('expired', 'approved')).toBe(false);
      expect(isValidTransition('expired', 'denied')).toBe(false);
      // Note: expired is a terminal state, no transitions allowed
      expect(VALID_TRANSITIONS['expired'].length).toBe(0);
    });
  });

  describe('Poll Count Tracking', () => {
    it('should increment poll count on each token request', () => {
      const metadata = createDeviceCodeMetadata({
        poll_count: 0,
      });

      // Simulate multiple polls
      for (let i = 1; i <= 5; i++) {
        metadata.poll_count = (metadata.poll_count ?? 0) + 1;
        expect(metadata.poll_count).toBe(i);
      }
    });

    it('should track last poll timestamp', () => {
      const metadata = createDeviceCodeMetadata({
        poll_count: 0,
      });

      // Simulate poll
      metadata.poll_count = (metadata.poll_count ?? 0) + 1;
      metadata.last_poll_at = Date.now();

      // last_poll_at should be >= created_at (may be equal if same millisecond)
      expect(metadata.last_poll_at).toBeGreaterThanOrEqual(metadata.created_at);
    });
  });

  describe('Concurrent Access Prevention', () => {
    it('should use atomic operations for status updates', () => {
      // This tests the conceptual requirement
      // Actual atomic operations are handled by Durable Object
      const metadata = createDeviceCodeMetadata();

      // Simulate concurrent approval check
      const checkAndApprove = (meta: DeviceCodeMetadata): boolean => {
        if (meta.status !== 'pending') {
          return false; // Already processed
        }
        meta.status = 'approved';
        return true;
      };

      // First approval succeeds
      expect(checkAndApprove(metadata)).toBe(true);
      expect(metadata.status).toBe('approved');

      // Second approval fails
      expect(checkAndApprove(metadata)).toBe(false);
    });

    it('should use atomic operations for token issuance', () => {
      const metadata = createDeviceCodeMetadata({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
        token_issued: false,
      });

      // Simulate concurrent token issuance check
      const checkAndIssueToken = (meta: DeviceCodeMetadata): boolean => {
        if (meta.status !== 'approved' || meta.token_issued) {
          return false;
        }
        meta.token_issued = true;
        meta.token_issued_at = Date.now();
        return true;
      };

      // First issuance succeeds
      expect(checkAndIssueToken(metadata)).toBe(true);
      expect(metadata.token_issued).toBe(true);

      // Second issuance fails
      expect(checkAndIssueToken(metadata)).toBe(false);
    });
  });
});
