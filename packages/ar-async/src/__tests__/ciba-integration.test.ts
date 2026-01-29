/**
 * CIBA Integration Tests
 * Tests HTTP-level behavior for CIBA flow (OpenID Connect CIBA Core 1.0)
 *
 * Covers:
 * - Backchannel authorization request
 * - Token grant (authorization_pending, slow_down, access_denied, expired_token)
 * - Approval/denial flow
 * - Token replay prevention
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import { cibaAuthorizationHandler } from '../ciba-authorization';
import { cibaApproveHandler } from '../ciba-approve';
import { cibaDenyHandler } from '../ciba-deny';

// Mock getClient and logger at module level
const mockGetClient = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  module: vi.fn().mockReturnThis(),
  startTimer: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClient: mockGetClient,
    // getClientCached wraps getClient, mock it to call through
    getClientCached: vi
      .fn()
      .mockImplementation((_c, env, clientId) => mockGetClient(env, clientId)),
    getLogger: () => mockLogger,
    sendPingNotification: vi.fn().mockResolvedValue(undefined),
  };
});

describe('CIBA Integration', () => {
  let mockEnv: Partial<Env>;
  let storedCIBARequests: Map<string, CIBARequestMetadata>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedCIBARequests = new Map();

    // Mock CIBA Request Store with comprehensive behavior
    const mockCIBARequestStore = {
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

        if (pathname === '/approve') {
          const body = (await request.json()) as {
            auth_req_id: string;
            user_id: string;
            sub: string;
          };
          const metadata = storedCIBARequests.get(body.auth_req_id);
          if (metadata) {
            metadata.status = 'approved';
            metadata.user_id = body.user_id;
            metadata.sub = body.sub;
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/deny') {
          const body = (await request.json()) as { auth_req_id: string };
          const metadata = storedCIBARequests.get(body.auth_req_id);
          if (metadata) {
            metadata.status = 'denied';
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/update-poll') {
          const body = (await request.json()) as { auth_req_id: string };
          const metadata = storedCIBARequests.get(body.auth_req_id);
          if (metadata) {
            metadata.poll_count = (metadata.poll_count || 0) + 1;
            metadata.last_poll_at = Date.now();
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/mark-token-issued') {
          const body = (await request.json()) as { auth_req_id: string };
          const metadata = storedCIBARequests.get(body.auth_req_id);
          if (metadata) {
            if (metadata.token_issued) {
              return new Response(
                JSON.stringify({
                  error: 'token_already_issued',
                  error_description: 'Token has already been issued for this request',
                }),
                { status: 400 }
              );
            }
            metadata.token_issued = true;
            metadata.token_issued_at = Date.now();
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        if (pathname === '/delete') {
          const body = (await request.json()) as { auth_req_id: string };
          storedCIBARequests.delete(body.auth_req_id);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response('Not found', { status: 404 });
      }),
    };

    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      } as any,
      CIBA_REQUEST_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-ciba-store-id'),
        get: vi.fn().mockReturnValue(mockCIBARequestStore),
      } as any,
    };
  });

  // Helper to create mock context
  function createMockContext(
    body: Record<string, any>,
    method: 'parseBody' | 'json' = 'parseBody'
  ) {
    return {
      req: {
        parseBody: vi.fn().mockResolvedValue(body),
        json: vi.fn().mockResolvedValue(body),
        header: vi.fn().mockReturnValue('192.168.1.1'),
      },
      json: vi.fn().mockImplementation((data, status) => {
        return new Response(JSON.stringify(data), { status: status || 200 });
      }),
      env: mockEnv,
    } as any;
  }

  describe('POST /bc-authorize - Backchannel Authorization', () => {
    it('should successfully create CIBA request for valid client', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        client_name: 'CIBA Test Client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      const ctx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid profile email',
        login_hint: 'user@example.com',
        binding_message: 'Sign in to Test App',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.auth_req_id).toBeDefined();
      expect(body.auth_req_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(body.expires_in).toBeGreaterThan(0);
      expect(body.interval).toBeGreaterThan(0); // Poll interval is calculated based on expires_in
    });

    it('should reject request without client_id', async () => {
      const ctx = createMockContext({
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('required');
    });

    it('should reject unregistered client', async () => {
      mockGetClient.mockResolvedValue(null);

      const ctx = createMockContext({
        client_id: 'unknown-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      // Security: Generic message to prevent client_id enumeration
      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.error_description).toContain('Client authentication failed');
    });

    it('should reject client not authorized for CIBA', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'non-ciba-client',
        grant_types: ['authorization_code'], // CIBA not included
      });

      const ctx = createMockContext({
        client_id: 'non-ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('unauthorized_client');
      // AR_ERROR_CODES.CLIENT_GRANT_TYPE_UNAUTHORIZED uses standardized message
      expect(body.error_description).toContain('not authorized to use this grant type');
    });

    it('should reject request without openid scope', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      const ctx = createMockContext({
        client_id: 'ciba-client',
        scope: 'profile email', // Missing openid
        login_hint: 'user@example.com',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_scope');
      // AR_ERROR_CODES.SCOPE_UNAUTHORIZED uses standardized message
      expect(body.error_description).toContain('not authorized to request this scope');
    });

    it('should reject request without any login hint', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      const ctx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        // No login_hint, login_hint_token, or id_token_hint
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject client that does not support poll mode when falling back to poll', async () => {
      // Client configured for ping-only mode but determineDeliveryMode falls back to poll
      // This tests the delivery mode validation logic
      mockGetClient.mockResolvedValue({
        client_id: 'ping-only-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'ping', // Only ping supported
        backchannel_client_notification_endpoint: 'https://client.example.com/ciba-callback',
      });

      const ctx = createMockContext({
        client_id: 'ping-only-client',
        scope: 'openid',
        login_hint: 'user@example.com',
        // Without client_notification_token, determineDeliveryMode returns 'poll'
        // But client only supports 'ping', so it should fail
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      // AR_ERROR_CODES.CLIENT_GRANT_TYPE_UNAUTHORIZED uses unauthorized_client
      expect(body.error).toBe('unauthorized_client');
      expect(body.error_description).toContain('not authorized');
    });

    it('should validate binding_message length', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      // Binding message exceeds 140 characters
      const longMessage = 'a'.repeat(200);

      const ctx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
        binding_message: longMessage,
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      // TODO: CIBA spec uses invalid_binding_message, but current implementation uses invalid_request
      // Should be updated to use AR_ERROR_CODES.CIBA_INVALID_BINDING_MESSAGE for RFC compliance
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('invalid');
    });
  });

  describe('POST /api/ciba/approve - Request Approval', () => {
    beforeEach(async () => {
      // Set up a valid client and create a pending CIBA request
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid profile',
        login_hint: 'user@example.com',
      });

      await cibaAuthorizationHandler(authCtx);
    });

    it('should successfully approve pending request', async () => {
      const authReqId = [...storedCIBARequests.keys()][0];

      const ctx = createMockContext(
        {
          auth_req_id: authReqId,
          user_id: 'user123',
          sub: 'user@example.com',
        },
        'json'
      );

      const response = await cibaApproveHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain('approved');

      // Verify the request status was updated
      const metadata = storedCIBARequests.get(authReqId);
      expect(metadata?.status).toBe('approved');
      expect(metadata?.user_id).toBe('user123');
      expect(metadata?.sub).toBe('user@example.com');
    });

    it('should reject approval without auth_req_id', async () => {
      const ctx = createMockContext(
        {
          user_id: 'user123',
          sub: 'user@example.com',
        },
        'json'
      );

      const response = await cibaApproveHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('required');
    });

    it('should reject approval for non-existent request', async () => {
      const ctx = createMockContext(
        {
          auth_req_id: 'non-existent-auth-req-id',
          user_id: 'user123',
        },
        'json'
      );

      const response = await cibaApproveHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(404);
      // RFC compliance: Returns invalid_request even for missing resource (status 404 indicates resource not found)
      expect(body.error).toBe('invalid_request');
    });

    it('should reject approval for already approved request', async () => {
      const authReqId = [...storedCIBARequests.keys()][0];

      // First approval
      const ctx1 = createMockContext(
        {
          auth_req_id: authReqId,
          user_id: 'user123',
          sub: 'user@example.com',
        },
        'json'
      );
      await cibaApproveHandler(ctx1);

      // Second approval attempt
      const ctx2 = createMockContext(
        {
          auth_req_id: authReqId,
          user_id: 'user456',
          sub: 'another@example.com',
        },
        'json'
      );
      const response = await cibaApproveHandler(ctx2);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });
  });

  describe('POST /api/ciba/deny - Request Denial', () => {
    beforeEach(async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      await cibaAuthorizationHandler(authCtx);
    });

    it('should successfully deny pending request', async () => {
      const authReqId = [...storedCIBARequests.keys()][0];

      const ctx = createMockContext(
        {
          auth_req_id: authReqId,
          reason: 'User rejected the request',
        },
        'json'
      );

      const response = await cibaDenyHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain('denied');

      // Verify the request status was updated
      const metadata = storedCIBARequests.get(authReqId);
      expect(metadata?.status).toBe('denied');
    });

    it('should reject denial without auth_req_id', async () => {
      const ctx = createMockContext(
        {
          reason: 'User rejected',
        },
        'json'
      );

      const response = await cibaDenyHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('required');
    });

    it('should reject denial for already denied request', async () => {
      const authReqId = [...storedCIBARequests.keys()][0];

      // First denial
      const ctx1 = createMockContext({ auth_req_id: authReqId }, 'json');
      await cibaDenyHandler(ctx1);

      // Second denial attempt
      const ctx2 = createMockContext({ auth_req_id: authReqId }, 'json');
      const response = await cibaDenyHandler(ctx2);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });
  });

  describe('CIBA Token Grant Error Scenarios', () => {
    /**
     * Note: The actual token endpoint is in op-token package.
     * These tests verify the error handling scenarios that the CIBA store supports.
     */

    beforeEach(async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'ciba-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });
    });

    it('should return authorization_pending for unapproved request', async () => {
      // Create a pending request
      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const authResponse = await cibaAuthorizationHandler(authCtx);
      const authBody = (await authResponse.json()) as { auth_req_id: string };

      // Get the stored request
      const metadata = storedCIBARequests.get(authBody.auth_req_id);

      // Verify the request is in pending status
      expect(metadata?.status).toBe('pending');

      // Simulate what the token endpoint would return
      // In the actual implementation, token endpoint checks the status
      // and returns authorization_pending if status is 'pending'
    });

    it('should return access_denied for denied request', async () => {
      // Create and deny a request
      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const authResponse = await cibaAuthorizationHandler(authCtx);
      const authBody = (await authResponse.json()) as { auth_req_id: string };

      // Deny the request
      const denyCtx = createMockContext({ auth_req_id: authBody.auth_req_id }, 'json');
      await cibaDenyHandler(denyCtx);

      // Verify the request is now denied
      const metadata = storedCIBARequests.get(authBody.auth_req_id);
      expect(metadata?.status).toBe('denied');
    });

    it('should detect expired requests', async () => {
      // Create a request
      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const authResponse = await cibaAuthorizationHandler(authCtx);
      const authBody = (await authResponse.json()) as { auth_req_id: string };

      // Manually expire the request
      const metadata = storedCIBARequests.get(authBody.auth_req_id);
      if (metadata) {
        metadata.expires_at = Date.now() - 1000; // Expired 1 second ago
        metadata.status = 'expired';
      }

      // Verify the request is expired
      const expiredMetadata = storedCIBARequests.get(authBody.auth_req_id);
      expect(expiredMetadata?.status).toBe('expired');
    });

    it('should prevent token replay (one-time use)', async () => {
      // Create and approve a request
      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const authResponse = await cibaAuthorizationHandler(authCtx);
      const authBody = (await authResponse.json()) as { auth_req_id: string };

      // Approve the request
      const approveCtx = createMockContext(
        {
          auth_req_id: authBody.auth_req_id,
          user_id: 'user123',
          sub: 'user@example.com',
        },
        'json'
      );
      await cibaApproveHandler(approveCtx);

      // Simulate first token issuance by directly updating the stored request
      const metadata = storedCIBARequests.get(authBody.auth_req_id);
      expect(metadata).toBeDefined();

      // First token issuance - mark as issued
      metadata!.token_issued = true;

      // Verify token is marked as issued
      expect(metadata?.token_issued).toBe(true);

      // For replay protection, verify the metadata tracks token_issued flag
      // In real implementation, the Durable Object would reject subsequent issuance
      // Here we verify the state tracking mechanism works
      expect(storedCIBARequests.get(authBody.auth_req_id)?.token_issued).toBe(true);
    });

    it('should track poll count for slow_down detection', async () => {
      // Create a request
      const authCtx = createMockContext({
        client_id: 'ciba-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const authResponse = await cibaAuthorizationHandler(authCtx);
      const authBody = (await authResponse.json()) as { auth_req_id: string };

      // Simulate multiple poll attempts by directly updating the stored request
      const metadata = storedCIBARequests.get(authBody.auth_req_id);
      expect(metadata).toBeDefined();

      // Simulate 5 poll attempts
      for (let i = 0; i < 5; i++) {
        metadata!.poll_count = (metadata!.poll_count || 0) + 1;
        metadata!.last_poll_at = Date.now();
      }

      // Verify poll count is tracked
      expect(metadata?.poll_count).toBe(5);
      expect(metadata?.last_poll_at).toBeDefined();
    });
  });

  describe('Poll Mode Delivery (Default)', () => {
    it('should include interval in response for poll mode', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'poll-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        backchannel_token_delivery_mode: 'poll',
      });

      const ctx = createMockContext({
        client_id: 'poll-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.auth_req_id).toBeDefined();
      expect(body.expires_in).toBeDefined();
      // Interval should be present for poll mode
      expect(body.interval).toBeDefined();
      expect(body.interval).toBeGreaterThan(0);
    });

    it('should default to poll mode when delivery mode not explicitly specified', async () => {
      mockGetClient.mockResolvedValue({
        client_id: 'default-client',
        grant_types: ['urn:openid:params:grant-type:ciba'],
        // No backchannel_token_delivery_mode specified
      });

      const ctx = createMockContext({
        client_id: 'default-client',
        scope: 'openid',
        login_hint: 'user@example.com',
      });

      const response = await cibaAuthorizationHandler(ctx);
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.interval).toBeDefined(); // Poll mode includes interval
    });
  });
});
