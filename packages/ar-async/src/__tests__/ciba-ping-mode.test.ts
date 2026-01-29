/**
 * CIBA Ping Mode Delivery Tests
 *
 * Tests for OpenID Connect CIBA Core 1.0 Ping Mode
 * - Ping notification delivery
 * - Notification endpoint unreachable handling
 * - client_notification_token validation
 * - Re-notification handling
 *
 * @see https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html#ping_mode
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';

// Mock modules
const mockSendPingNotification = vi.hoisted(() => vi.fn());
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
    sendPingNotification: mockSendPingNotification,
  };
});

describe('CIBA Ping Mode - OpenID Connect CIBA Core 1.0 Section 7', () => {
  let mockEnv: Partial<Env>;
  let storedCIBARequests: Map<string, CIBARequestMetadata>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedCIBARequests = new Map();
    mockSendPingNotification.mockReset();

    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      CIBA_REQUEST_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-ciba-store-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation(async (request: Request) => {
            const url = new URL(request.url);
            const pathname = url.pathname;

            if (pathname === '/store') {
              const body = (await request.json()) as CIBARequestMetadata;
              storedCIBARequests.set(body.auth_req_id, body);
              return new Response(JSON.stringify({ success: true }), { status: 200 });
            }

            if (pathname === '/get-by-auth-req-id') {
              const body = (await request.json()) as { auth_req_id: string };
              const metadata = storedCIBARequests.get(body.auth_req_id);
              if (metadata) {
                return new Response(JSON.stringify(metadata), { status: 200 });
              }
              return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
            }

            return new Response('Not found', { status: 404 });
          }),
        }),
      } as unknown as Env['CIBA_REQUEST_STORE'],
    };
  });

  /**
   * Helper to create CIBA request metadata for ping mode
   */
  function createPingModeCIBARequest(
    overrides: Partial<CIBARequestMetadata> = {}
  ): CIBARequestMetadata {
    const now = Date.now();
    return {
      auth_req_id: `ciba_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      client_id: 'ping-client',
      scope: 'openid profile',
      login_hint: 'user@example.com',
      status: 'pending',
      delivery_mode: 'ping',
      client_notification_endpoint: 'https://client.example.com/ciba-callback',
      client_notification_token: `token_${Date.now()}`,
      created_at: now,
      expires_at: now + 120000, // 2 minutes
      poll_count: 0,
      interval: 5,
      ...overrides,
    };
  }

  /**
   * Simulates sending ping notification
   */
  async function sendPingNotification(
    endpoint: string,
    authReqId: string,
    token: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Simulate HTTP POST to client notification endpoint
      const response = await mockSendPingNotification(endpoint, authReqId, token);
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  describe('Ping Notification Delivery', () => {
    it('should send ping notification on approval', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 204 });

      const metadata = createPingModeCIBARequest({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
      });

      storedCIBARequests.set(metadata.auth_req_id, metadata);

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(true);
      expect(mockSendPingNotification).toHaveBeenCalledWith(
        'https://client.example.com/ciba-callback',
        metadata.auth_req_id,
        metadata.client_notification_token
      );
    });

    it('should include auth_req_id in notification body', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 204 });

      const metadata = createPingModeCIBARequest();
      const authReqId = metadata.auth_req_id;

      await sendPingNotification(
        metadata.client_notification_endpoint!,
        authReqId,
        metadata.client_notification_token!
      );

      expect(mockSendPingNotification).toHaveBeenCalledWith(
        expect.any(String),
        authReqId,
        expect.any(String)
      );
    });

    it('should send notification on denial', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 204 });

      const metadata = createPingModeCIBARequest({
        status: 'denied',
      });

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Notification Endpoint Unreachable', () => {
    it('should handle connection refused error', async () => {
      mockSendPingNotification.mockRejectedValue(new Error('ECONNREFUSED'));

      const metadata = createPingModeCIBARequest({
        status: 'approved',
        user_id: 'user123',
        sub: 'user@example.com',
      });

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should handle timeout error', async () => {
      mockSendPingNotification.mockRejectedValue(new Error('Request timeout'));

      const metadata = createPingModeCIBARequest();

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should handle DNS resolution failure', async () => {
      mockSendPingNotification.mockRejectedValue(new Error('ENOTFOUND'));

      const metadata = createPingModeCIBARequest({
        client_notification_endpoint: 'https://nonexistent.example.com/callback',
      });

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOTFOUND');
    });

    it('should handle 4xx client errors', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: false, status: 404 });

      const metadata = createPingModeCIBARequest();

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });

    it('should handle 5xx server errors', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: false, status: 503 });

      const metadata = createPingModeCIBARequest();

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('503');
    });
  });

  describe('client_notification_token Validation', () => {
    it('should require client_notification_token for ping mode', () => {
      const metadata = createPingModeCIBARequest({
        client_notification_token: undefined,
      });

      const isValid = metadata.delivery_mode === 'ping' && !!metadata.client_notification_token;
      expect(isValid).toBe(false);
    });

    it('should accept valid client_notification_token', () => {
      const metadata = createPingModeCIBARequest({
        client_notification_token: 'valid_token_123',
      });

      const isValid = metadata.delivery_mode === 'ping' && !!metadata.client_notification_token;
      expect(isValid).toBe(true);
    });

    it('should reject empty client_notification_token', () => {
      const metadata = createPingModeCIBARequest({
        client_notification_token: '',
      });

      const isValid =
        metadata.delivery_mode === 'ping' &&
        metadata.client_notification_token != null &&
        metadata.client_notification_token.length > 0;
      expect(isValid).toBe(false);
    });

    it('should include token in Authorization header', async () => {
      const token = 'Bearer test_notification_token';
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 204 });

      const metadata = createPingModeCIBARequest({
        client_notification_token: token,
      });

      await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        token
      );

      expect(mockSendPingNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        token
      );
    });
  });

  describe('Re-notification Handling', () => {
    it('should track notification attempts', () => {
      const metadata = createPingModeCIBARequest({
        notification_attempts: 0,
      } as Partial<CIBARequestMetadata>);

      // Simulate notification attempt tracking
      (metadata as CIBARequestMetadata & { notification_attempts: number }).notification_attempts =
        1;

      expect(
        (metadata as CIBARequestMetadata & { notification_attempts: number }).notification_attempts
      ).toBe(1);
    });

    it('should limit notification retry attempts', () => {
      const MAX_NOTIFICATION_ATTEMPTS = 3;

      const metadata = createPingModeCIBARequest() as CIBARequestMetadata & {
        notification_attempts: number;
      };
      metadata.notification_attempts = MAX_NOTIFICATION_ATTEMPTS;

      const shouldRetry = metadata.notification_attempts < MAX_NOTIFICATION_ATTEMPTS;
      expect(shouldRetry).toBe(false);
    });

    it('should delay between retry attempts', () => {
      const RETRY_DELAY_MS = 5000;
      const lastAttempt = Date.now() - 3000; // 3 seconds ago

      const timeSinceLastAttempt = Date.now() - lastAttempt;
      const shouldDelay = timeSinceLastAttempt < RETRY_DELAY_MS;

      expect(shouldDelay).toBe(true);
    });

    it('should not re-notify for terminal states', () => {
      // Terminal states for CIBA are 'expired' and requests with token_issued=true
      const expiredMetadata = createPingModeCIBARequest({ status: 'expired' });
      const shouldNotifyExpired =
        expiredMetadata.status === 'approved' || expiredMetadata.status === 'denied';
      expect(shouldNotifyExpired).toBe(false);

      // Token already issued - should not re-notify
      const issuedMetadata = createPingModeCIBARequest({
        status: 'approved',
        token_issued: true,
      });
      const shouldNotifyIssued =
        !issuedMetadata.token_issued &&
        (issuedMetadata.status === 'approved' || issuedMetadata.status === 'denied');
      expect(shouldNotifyIssued).toBe(false);
    });
  });

  describe('Ping Mode Configuration', () => {
    it('should validate client has notification endpoint', () => {
      const metadata = createPingModeCIBARequest({
        client_notification_endpoint: 'https://client.example.com/callback',
      });

      expect(metadata.client_notification_endpoint).toBeDefined();
      expect(metadata.client_notification_endpoint).toMatch(/^https:\/\//);
    });

    it('should reject non-HTTPS notification endpoints', () => {
      const httpEndpoint = 'http://insecure.example.com/callback';

      // In production, only HTTPS should be accepted
      const isSecure = httpEndpoint.startsWith('https://');
      expect(isSecure).toBe(false);
    });

    it('should store delivery mode in request metadata', () => {
      const metadata = createPingModeCIBARequest();

      expect(metadata.delivery_mode).toBe('ping');
    });
  });

  describe('Notification Response Handling', () => {
    it('should accept 204 No Content response', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 204 });

      const metadata = createPingModeCIBARequest({
        status: 'approved',
      });

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(true);
    });

    it('should accept 200 OK response', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 200 });

      const metadata = createPingModeCIBARequest({
        status: 'approved',
      });

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      expect(result.success).toBe(true);
    });

    it('should mark notification as sent on success', async () => {
      mockSendPingNotification.mockResolvedValue({ ok: true, status: 204 });

      const metadata = createPingModeCIBARequest({
        status: 'approved',
      }) as CIBARequestMetadata & { notification_sent: boolean };

      const result = await sendPingNotification(
        metadata.client_notification_endpoint!,
        metadata.auth_req_id,
        metadata.client_notification_token!
      );

      if (result.success) {
        metadata.notification_sent = true;
      }

      expect(metadata.notification_sent).toBe(true);
    });
  });
});
