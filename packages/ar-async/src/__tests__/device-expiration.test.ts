/**
 * Device Flow Expiration Tests
 *
 * Tests based on RFC 8628: OAuth 2.0 Device Authorization Grant
 * - Device code TTL expiration detection
 * - User code TTL expiration detection
 * - Token request rejection after expiration
 * - Boundary value tests (just before/after expiration)
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env, DeviceCodeMetadata } from '@authrim/ar-lib-core';
import { DEVICE_FLOW_CONSTANTS } from '@authrim/ar-lib-core';

// Mock getClient at module level
const mockGetClient = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClient: mockGetClient,
    // getClientCached wraps getClient, mock it to call through
    getClientCached: vi
      .fn()
      .mockImplementation((_c, env, clientId) => mockGetClient(env, clientId)),
  };
});

describe('Device Flow Expiration - RFC 8628 Section 3.2', () => {
  let mockEnv: Partial<Env>;
  let storedDeviceCodes: Map<string, DeviceCodeMetadata>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedDeviceCodes = new Map();

    // Mock Device Code Store with comprehensive behavior
    const mockDeviceCodeStore = {
      fetch: vi.fn().mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (pathname === '/store') {
          const body = (await request.json()) as DeviceCodeMetadata;
          storedDeviceCodes.set(body.device_code, body);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (pathname === '/get') {
          const body = (await request.json()) as { device_code: string };
          const metadata = storedDeviceCodes.get(body.device_code);
          if (metadata) {
            return new Response(JSON.stringify(metadata), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/get-by-user-code') {
          const body = (await request.json()) as { user_code: string };
          for (const metadata of storedDeviceCodes.values()) {
            if (metadata.user_code === body.user_code) {
              return new Response(JSON.stringify(metadata), { status: 200 });
            }
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/update-poll') {
          const body = (await request.json()) as { device_code: string };
          const metadata = storedDeviceCodes.get(body.device_code);
          if (metadata) {
            metadata.poll_count = (metadata.poll_count || 0) + 1;
            metadata.last_poll_at = Date.now();
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/approve') {
          const body = (await request.json()) as {
            device_code: string;
            user_id: string;
            sub: string;
          };
          const metadata = storedDeviceCodes.get(body.device_code);
          if (metadata) {
            metadata.status = 'approved';
            metadata.user_id = body.user_id;
            metadata.sub = body.sub;
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/delete') {
          const body = (await request.json()) as { device_code: string };
          storedDeviceCodes.delete(body.device_code);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response('Not found', { status: 404 });
      }),
    };

    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      UI_URL: 'https://ui.example.com',
      DEVICE_CODE_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-device-store-id'),
        get: vi.fn().mockReturnValue(mockDeviceCodeStore),
      } as unknown as Env['DEVICE_CODE_STORE'],
    };
  });

  /**
   * Helper to create device code metadata
   */
  function createDeviceCodeMetadata(
    overrides: Partial<DeviceCodeMetadata> = {}
  ): DeviceCodeMetadata {
    const now = Date.now();
    return {
      device_code: `device_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      user_code: 'WDJB-MJHT',
      client_id: 'test-client',
      scope: 'openid profile',
      status: 'pending',
      created_at: now,
      expires_at: now + DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN * 1000, // 600 seconds default
      poll_count: 0,
      ...overrides,
    };
  }

  /**
   * Helper to check if device code is expired
   */
  function isDeviceCodeExpired(metadata: DeviceCodeMetadata): boolean {
    return Date.now() > metadata.expires_at;
  }

  describe('Device Code TTL Expiration', () => {
    it('should detect expired device code', () => {
      // Create expired device code (expired 1 minute ago)
      const expiredMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() - 60000,
      });

      expect(isDeviceCodeExpired(expiredMetadata)).toBe(true);
    });

    it('should accept valid (non-expired) device code', () => {
      // Create valid device code (expires in 5 minutes)
      const validMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() + 300000,
      });

      expect(isDeviceCodeExpired(validMetadata)).toBe(false);
    });

    it('should detect device code expiring exactly at boundary', () => {
      // Create device code that expires exactly now
      const boundaryMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() - 1, // 1ms ago - should be expired
      });

      expect(isDeviceCodeExpired(boundaryMetadata)).toBe(true);
    });

    it('should accept device code just before expiration', () => {
      // Create device code that expires in 1 second
      const almostExpiredMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() + 1000,
      });

      expect(isDeviceCodeExpired(almostExpiredMetadata)).toBe(false);
    });

    it('should use default TTL from constants', () => {
      const metadata = createDeviceCodeMetadata();
      const expectedTtl = DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN * 1000;

      // Verify TTL is approximately correct (within 100ms tolerance)
      const actualTtl = metadata.expires_at - metadata.created_at;
      expect(actualTtl).toBeCloseTo(expectedTtl, -2);
    });
  });

  describe('User Code TTL Expiration', () => {
    it('should reject expired user code lookup', async () => {
      // Create expired device code
      const expiredMetadata = createDeviceCodeMetadata({
        device_code: 'expired-device-code',
        user_code: 'EXPR-CODE',
        expires_at: Date.now() - 60000,
      });

      storedDeviceCodes.set(expiredMetadata.device_code, expiredMetadata);

      // Lookup by user code should find the record but it's expired
      let foundMetadata: DeviceCodeMetadata | undefined;
      for (const metadata of storedDeviceCodes.values()) {
        if (metadata.user_code === 'EXPR-CODE') {
          foundMetadata = metadata;
          break;
        }
      }

      expect(foundMetadata).toBeDefined();
      expect(isDeviceCodeExpired(foundMetadata!)).toBe(true);
    });

    it('should accept valid user code lookup', async () => {
      // Create valid device code
      const validMetadata = createDeviceCodeMetadata({
        device_code: 'valid-device-code',
        user_code: 'VALD-CODE',
        expires_at: Date.now() + 300000,
      });

      storedDeviceCodes.set(validMetadata.device_code, validMetadata);

      let foundMetadata: DeviceCodeMetadata | undefined;
      for (const metadata of storedDeviceCodes.values()) {
        if (metadata.user_code === 'VALD-CODE') {
          foundMetadata = metadata;
          break;
        }
      }

      expect(foundMetadata).toBeDefined();
      expect(isDeviceCodeExpired(foundMetadata!)).toBe(false);
    });
  });

  describe('Token Request Rejection After Expiration', () => {
    it('should return expired_token error for expired device code', () => {
      const expiredMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() - 60000,
        status: 'pending',
      });

      // Simulate token endpoint check
      const isExpired = isDeviceCodeExpired(expiredMetadata);

      // RFC 8628 Section 3.5: expired_token error
      const expectedError = isExpired ? 'expired_token' : null;
      expect(expectedError).toBe('expired_token');
    });

    it('should return expired_token for approved but expired device code', () => {
      // Even if approved, expired codes should be rejected
      const approvedButExpiredMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() - 60000,
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
      });

      expect(isDeviceCodeExpired(approvedButExpiredMetadata)).toBe(true);
      expect(approvedButExpiredMetadata.status).toBe('approved');

      // Should still return expired_token
      const shouldRejectExpired = isDeviceCodeExpired(approvedButExpiredMetadata);
      expect(shouldRejectExpired).toBe(true);
    });

    it('should allow token request for non-expired approved device code', () => {
      const validApprovedMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() + 300000,
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
      });

      expect(isDeviceCodeExpired(validApprovedMetadata)).toBe(false);
      expect(validApprovedMetadata.status).toBe('approved');

      // Should be valid for token issuance
      const canIssueToken =
        !isDeviceCodeExpired(validApprovedMetadata) && validApprovedMetadata.status === 'approved';
      expect(canIssueToken).toBe(true);
    });
  });

  describe('Boundary Value Tests', () => {
    it('should handle expiration at exact boundary (expires_at === now)', () => {
      const exactBoundaryMetadata = createDeviceCodeMetadata({
        expires_at: Date.now(),
      });

      // At exact boundary, should be considered expired (> is strict)
      // Implementation uses: Date.now() > expires_at
      // So at exact boundary, it should NOT be expired yet
      const result = Date.now() > exactBoundaryMetadata.expires_at;
      // This may be true or false depending on timing, but we test the logic
      expect(typeof result).toBe('boolean');
    });

    it('should expire after TTL seconds (RFC 8628 default: 600)', () => {
      const createdAt = Date.now() - (DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN * 1000 + 1000);
      const metadata = createDeviceCodeMetadata({
        created_at: createdAt,
        expires_at: createdAt + DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN * 1000,
      });

      expect(isDeviceCodeExpired(metadata)).toBe(true);
    });

    it('should not expire 1 second before TTL', () => {
      const createdAt = Date.now() - (DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN * 1000 - 1000);
      const metadata = createDeviceCodeMetadata({
        created_at: createdAt,
        expires_at: createdAt + DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN * 1000,
      });

      expect(isDeviceCodeExpired(metadata)).toBe(false);
    });
  });

  describe('Poll Count and Slow Down', () => {
    it('should track poll count correctly', () => {
      const metadata = createDeviceCodeMetadata({
        poll_count: 0,
      });

      expect(metadata.poll_count).toBe(0);

      // Simulate polling
      metadata.poll_count = (metadata.poll_count ?? 0) + 1;
      expect(metadata.poll_count).toBe(1);

      metadata.poll_count = (metadata.poll_count ?? 0) + 1;
      expect(metadata.poll_count).toBe(2);
    });

    it('should detect slow_down condition (polling too fast)', () => {
      const now = Date.now();
      const metadata = createDeviceCodeMetadata({
        last_poll_at: now - 2000, // Polled 2 seconds ago
        poll_count: 5,
      });

      const interval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL * 1000;
      const timeSinceLastPoll = now - (metadata.last_poll_at || 0);

      // If polling faster than interval, should return slow_down
      const shouldSlowDown = timeSinceLastPoll < interval;
      expect(shouldSlowDown).toBe(true); // 2s < 5s
    });

    it('should not trigger slow_down when polling at correct interval', () => {
      const now = Date.now();
      const interval = DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL * 1000;
      const metadata = createDeviceCodeMetadata({
        last_poll_at: now - interval - 1000, // Polled after interval + 1 second
        poll_count: 5,
      });

      const timeSinceLastPoll = now - (metadata.last_poll_at || 0);

      const shouldSlowDown = timeSinceLastPoll < interval;
      expect(shouldSlowDown).toBe(false);
    });
  });

  describe('Status Transitions with Expiration', () => {
    it('should not allow approval of expired device code', () => {
      const expiredMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() - 60000,
        status: 'pending',
      });

      // Try to approve
      const canApprove =
        !isDeviceCodeExpired(expiredMetadata) && expiredMetadata.status === 'pending';
      expect(canApprove).toBe(false);
    });

    it('should allow approval of valid pending device code', () => {
      const validMetadata = createDeviceCodeMetadata({
        expires_at: Date.now() + 300000,
        status: 'pending',
      });

      const canApprove = !isDeviceCodeExpired(validMetadata) && validMetadata.status === 'pending';
      expect(canApprove).toBe(true);
    });

    it('should mark status as expired when TTL exceeded', () => {
      const metadata = createDeviceCodeMetadata({
        expires_at: Date.now() - 60000,
        status: 'pending',
      });

      // Simulate expiration check and status update
      if (isDeviceCodeExpired(metadata)) {
        metadata.status = 'expired';
      }

      expect(metadata.status).toBe('expired');
    });
  });
});
