/**
 * CIBA Notifications Unit Tests
 * Tests for ping and push mode notifications
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendPingNotification, validatePingModeRequirements } from '../ciba-ping';
import { sendPushModeTokens, validatePushModeRequirements } from '../ciba-push';

/**
 * Create a mock Response object for testing
 */
function createMockResponse(
  status: number,
  ok: boolean,
  body: string = '',
  statusText: string = ''
): Response {
  // Try to parse as JSON for json() method, fallback to null
  let jsonBody: unknown = null;
  try {
    if (body) {
      jsonBody = JSON.parse(body);
    }
  } catch {
    // Not JSON, that's ok
  }

  return {
    ok,
    status,
    statusText,
    headers: new Headers({
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    }),
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(jsonBody),
    blob: vi.fn(),
    arrayBuffer: vi.fn(),
    formData: vi.fn(),
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
    url: '',
    type: 'basic',
    redirected: false,
    bytes: vi.fn(),
  } as unknown as Response;
}

// Mock fetch globally
global.fetch = vi.fn();

describe('CIBA Ping Mode Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendPingNotification', () => {
    it('should send ping notification successfully', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockResponse(200, true)
      );

      await sendPingNotification(
        'https://client.example.com/callback',
        'token123',
        'auth_req_id_123'
      );

      expect(fetch).toHaveBeenCalledWith(
        'https://client.example.com/callback',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token123',
          },
          body: JSON.stringify({
            auth_req_id: 'auth_req_id_123',
          }),
        })
      );
    });

    it('should throw error on failed notification', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockResponse(500, false, 'Error details', 'Internal Server Error')
      );

      await expect(
        sendPingNotification('https://client.example.com/callback', 'token123', 'auth_req_id_123')
      ).rejects.toThrow('Ping notification failed: 500 Internal Server Error');
    });

    it('should block internal URLs (SSRF protection)', async () => {
      await expect(
        sendPingNotification('https://192.168.1.1/callback', 'token123', 'auth_req_id_123')
      ).rejects.toThrow('SSRF protection');

      // Verify fetch was never called
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should block localhost URLs (SSRF protection) when allowLocalhost is false', async () => {
      await expect(
        sendPingNotification('https://localhost/callback', 'token123', 'auth_req_id_123')
      ).rejects.toThrow('SSRF protection');

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('validatePingModeRequirements', () => {
    it('should validate correct ping mode configuration', () => {
      const valid = validatePingModeRequirements('https://client.example.com/callback', 'token123');
      expect(valid).toBe(true);
    });

    it('should reject missing endpoint', () => {
      const valid = validatePingModeRequirements(null, 'token123');
      expect(valid).toBe(false);
    });

    it('should reject missing token', () => {
      const valid = validatePingModeRequirements('https://client.example.com/callback', null);
      expect(valid).toBe(false);
    });

    it('should reject invalid URL', () => {
      const valid = validatePingModeRequirements('not-a-url', 'token123');
      expect(valid).toBe(false);
    });

    it('should allow localhost HTTP URLs', () => {
      const valid = validatePingModeRequirements('http://localhost:3000/callback', 'token123');
      expect(valid).toBe(true);
    });

    it('should allow 127.0.0.1 HTTP URLs', () => {
      const valid = validatePingModeRequirements('http://127.0.0.1:3000/callback', 'token123');
      expect(valid).toBe(true);
    });

    it('should reject non-localhost HTTP URLs', () => {
      const valid = validatePingModeRequirements('http://client.example.com/callback', 'token123');
      expect(valid).toBe(false);
    });
  });
});

describe('CIBA Push Mode Token Delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendPushModeTokens', () => {
    it('should send tokens successfully', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockResponse(200, true)
      );

      await sendPushModeTokens(
        'https://client.example.com/callback',
        'token123',
        'auth_req_id_123',
        'access_token_value',
        'id_token_value',
        'refresh_token_value',
        3600
      );

      expect(fetch).toHaveBeenCalledWith(
        'https://client.example.com/callback',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token123',
          },
          body: JSON.stringify({
            auth_req_id: 'auth_req_id_123',
            access_token: 'access_token_value',
            token_type: 'Bearer',
            id_token: 'id_token_value',
            expires_in: 3600,
            refresh_token: 'refresh_token_value',
          }),
        })
      );
    });

    it('should handle null refresh token', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockResponse(200, true)
      );

      await sendPushModeTokens(
        'https://client.example.com/callback',
        'token123',
        'auth_req_id_123',
        'access_token_value',
        'id_token_value',
        null,
        3600
      );

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const body = JSON.parse(callArgs.body);

      expect(body.refresh_token).toBeUndefined();
      expect(body.access_token).toBe('access_token_value');
      expect(body.id_token).toBe('id_token_value');
    });

    it('should throw error on failed delivery', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockResponse(500, false, 'Error details', 'Internal Server Error')
      );

      await expect(
        sendPushModeTokens(
          'https://client.example.com/callback',
          'token123',
          'auth_req_id_123',
          'access_token_value',
          'id_token_value',
          null,
          3600
        )
      ).rejects.toThrow('Push token delivery failed: 500 Internal Server Error');
    });
  });

  describe('validatePushModeRequirements', () => {
    it('should validate correct push mode configuration', () => {
      const valid = validatePushModeRequirements('https://client.example.com/callback', 'token123');
      expect(valid).toBe(true);
    });

    it('should reject missing endpoint', () => {
      const valid = validatePushModeRequirements(null, 'token123');
      expect(valid).toBe(false);
    });

    it('should reject missing token', () => {
      const valid = validatePushModeRequirements('https://client.example.com/callback', null);
      expect(valid).toBe(false);
    });

    it('should reject invalid URL', () => {
      const valid = validatePushModeRequirements('not-a-url', 'token123');
      expect(valid).toBe(false);
    });

    it('should allow localhost HTTP URLs', () => {
      const valid = validatePushModeRequirements('http://localhost:3000/callback', 'token123');
      expect(valid).toBe(true);
    });

    it('should reject non-localhost HTTP URLs', () => {
      const valid = validatePushModeRequirements('http://client.example.com/callback', 'token123');
      expect(valid).toBe(false);
    });
  });
});
