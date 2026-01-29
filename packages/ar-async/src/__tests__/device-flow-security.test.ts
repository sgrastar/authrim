/**
 * Device Flow Security Tests
 *
 * Tests security enhancements including:
 * - Client validation
 * - Rate limiting for brute force protection
 * - User code verification security
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { deviceAuthorizationHandler } from '../device-authorization';
import { deviceVerifyApiHandler } from '../device-verify-api';
import type { Env } from '@authrim/ar-lib-core';

// Mock getClient and logger at module level - must use vi.hoisted for proper hoisting
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
  };
});

describe('Device Flow Security', () => {
  let app: Hono;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    app = new Hono();
    mockGetClient.mockReset();

    // Mock environment
    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      UI_URL: 'https://ui.example.com',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      } as any,
      DEVICE_CODE_STORE: {
        idFromName: vi.fn().mockReturnValue('mock-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
        }),
      } as any,
    };
  });

  describe('Client Validation', () => {
    it('should reject request with missing client_id', async () => {
      const mockContext = {
        req: {
          parseBody: vi.fn().mockResolvedValue({
            scope: 'openid',
          }),
        },
        json: vi.fn().mockImplementation((data, status) => {
          return new Response(JSON.stringify(data), { status });
        }),
        env: mockEnv,
      } as any;

      const response = await deviceAuthorizationHandler(mockContext);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(body.error_description).toContain('required');
    });

    it('should reject request with unregistered client_id', async () => {
      // Mock getClient to return null (client not found)
      mockGetClient.mockResolvedValue(null);

      const mockContext = {
        req: {
          parseBody: vi.fn().mockResolvedValue({
            client_id: 'invalid-client-123',
            scope: 'openid',
          }),
        },
        json: vi.fn().mockImplementation((data, status) => {
          return new Response(JSON.stringify(data), { status });
        }),
        env: mockEnv,
      } as any;

      const response = await deviceAuthorizationHandler(mockContext);
      const body = (await response.json()) as any;

      // Security: Generic message to prevent client_id enumeration
      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.error_description).toContain('Client authentication failed');
    });

    it('should reject client not authorized for device flow', async () => {
      // Mock client without device_code grant type
      const mockClient = {
        client_id: 'test-client',
        grant_types: ['authorization_code'], // No device_code
      };

      mockGetClient.mockResolvedValue(mockClient);

      const mockContext = {
        req: {
          parseBody: vi.fn().mockResolvedValue({
            client_id: 'test-client',
            scope: 'openid',
          }),
        },
        json: vi.fn().mockImplementation((data, status) => {
          return new Response(JSON.stringify(data), { status });
        }),
        env: mockEnv,
      } as any;

      const response = await deviceAuthorizationHandler(mockContext);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.error).toBe('unauthorized_client');
      // AR_ERROR_CODES.CLIENT_GRANT_TYPE_UNAUTHORIZED uses standardized message
      expect(body.error_description).toContain('not authorized to use this grant type');
    });
  });

  describe('Rate Limiting', () => {
    it('should block requests after multiple failed attempts', async () => {
      const mockRateLimiter = {
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              blocked: true,
              retry_after: 3600,
            }),
            { status: 200 }
          )
        ),
      };

      const mockEnvWithRateLimiter = {
        ...mockEnv,
        USER_CODE_RATE_LIMITER: {
          idFromName: vi.fn().mockReturnValue('rate-limiter-id'),
          get: vi.fn().mockReturnValue(mockRateLimiter),
        } as any,
      };

      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            user_code: 'ABCD-1234',
          }),
          header: vi.fn().mockReturnValue('192.168.1.1'),
        },
        json: vi.fn().mockImplementation((data, status) => {
          return new Response(JSON.stringify(data), { status });
        }),
        env: mockEnvWithRateLimiter,
      } as any;

      const response = await deviceVerifyApiHandler(mockContext);
      const body = (await response.json()) as any;

      expect(response.status).toBe(429);
      expect(body.error).toBe('slow_down');
      expect(body.error_description).toContain('Too many failed attempts');
      expect(body.error_description).toContain('3600 seconds');
    });

    it('should record failed attempt on invalid user_code', async () => {
      const recordFailureCalls: Request[] = [];

      const mockRateLimiter = {
        fetch: vi.fn().mockImplementation(async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname === '/check') {
            return new Response(JSON.stringify({ blocked: false }), { status: 200 });
          } else if (url.pathname === '/record-failure') {
            recordFailureCalls.push(request);
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response('Not found', { status: 404 });
        }),
      };

      const mockDeviceCodeStore = {
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }) // Invalid user code
        ),
      };

      const mockEnvWithRateLimiter = {
        ...mockEnv,
        USER_CODE_RATE_LIMITER: {
          idFromName: vi.fn().mockReturnValue('rate-limiter-id'),
          get: vi.fn().mockReturnValue(mockRateLimiter),
        } as any,
        DEVICE_CODE_STORE: {
          idFromName: vi.fn().mockReturnValue('device-code-store-id'),
          get: vi.fn().mockReturnValue(mockDeviceCodeStore),
        } as any,
      };

      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            // Use valid format chars (excluding 0,1,O,I,L) - but code not found in store
            user_code: 'WDJB-MJHT',
          }),
          header: vi.fn().mockReturnValue('192.168.1.1'),
        },
        json: vi.fn().mockImplementation((data, status) => {
          return new Response(JSON.stringify(data), { status });
        }),
        env: mockEnvWithRateLimiter,
      } as any;

      const response = await deviceVerifyApiHandler(mockContext);
      const body = (await response.json()) as any;

      expect(response.status).toBe(404);
      expect(body.error).toBe('invalid_code');
      // Verify that /record-failure was called
      expect(recordFailureCalls.length).toBeGreaterThan(0);
    });
  });

  describe('User Code Validation', () => {
    it('should normalize user code format', async () => {
      const receivedUserCodes: string[] = [];

      const mockDeviceCodeStore = {
        fetch: vi.fn().mockImplementation(async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname === '/get-by-user-code') {
            const body = (await request.json()) as any;
            receivedUserCodes.push(body.user_code);
            // Return success with normalized code (WDJBMJHT -> WDJB-MJHT)
            if (body.user_code === 'WDJB-MJHT') {
              return new Response(
                JSON.stringify({
                  device_code: 'device-123',
                  user_code: 'WDJB-MJHT',
                  status: 'pending',
                  client_id: 'test-client',
                  scope: 'openid',
                }),
                { status: 200 }
              );
            }
          }
          if (url.pathname === '/approve') {
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }),
      };

      const mockEnvWithStore = {
        ...mockEnv,
        DEVICE_CODE_STORE: {
          idFromName: vi.fn().mockReturnValue('device-code-store-id'),
          get: vi.fn().mockReturnValue(mockDeviceCodeStore),
        } as any,
      };

      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            // No hyphen, lowercase - should be normalized to WDJB-MJHT
            user_code: 'wdjbmjht',
          }),
          header: vi.fn().mockReturnValue('192.168.1.1'),
        },
        json: vi.fn().mockImplementation((data, status) => {
          return new Response(JSON.stringify(data), { status });
        }),
        env: mockEnvWithStore,
      } as any;

      await deviceVerifyApiHandler(mockContext);

      // Verify the store was called with normalized code (uppercase with hyphen)
      expect(receivedUserCodes.length).toBeGreaterThan(0);
      expect(receivedUserCodes[0]).toBe('WDJB-MJHT');
    });
  });
});
