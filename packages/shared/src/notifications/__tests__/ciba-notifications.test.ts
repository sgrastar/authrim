/**
 * CIBA Notifications Unit Tests
 * Tests for ping and push mode notifications
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendPingNotification, validatePingModeRequirements } from '../ciba-ping';
import { sendPushModeTokens, validatePushModeRequirements } from '../ciba-push';

// Mock fetch globally
global.fetch = vi.fn();

describe('CIBA Ping Mode Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendPingNotification', () => {
    it('should send ping notification successfully', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

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
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Error details',
      });

      await expect(
        sendPingNotification('https://client.example.com/callback', 'token123', 'auth_req_id_123')
      ).rejects.toThrow();
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
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

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
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await sendPushModeTokens(
        'https://client.example.com/callback',
        'token123',
        'auth_req_id_123',
        'access_token_value',
        'id_token_value',
        null,
        3600
      );

      const callArgs = (fetch as any).mock.calls[0][1];
      const body = JSON.parse(callArgs.body);

      expect(body.refresh_token).toBeUndefined();
      expect(body.access_token).toBe('access_token_value');
      expect(body.id_token).toBe('id_token_value');
    });

    it('should throw error on failed delivery', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Error details',
      });

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
      ).rejects.toThrow();
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
