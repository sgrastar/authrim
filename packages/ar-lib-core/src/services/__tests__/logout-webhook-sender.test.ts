/**
 * Logout Webhook Sender Service Tests
 *
 * Tests for the Simple Logout Webhook generation and sending functionality.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createWebhookPayload,
  generateWebhookSignature,
  verifyWebhookSignature,
  sendLogoutWebhook,
  isWebhookRetryableError,
  calculateWebhookRetryDelay,
  WebhookKVHelpers,
} from '../logout-webhook-sender';
import type { LogoutRetryConfig } from '../../types/logout';

// Mock fetch for sendLogoutWebhook tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock KV namespace
function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, limit }: { prefix: string; limit?: number }) => {
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit ?? 100)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    }),
  } as unknown as KVNamespace;
}

describe('createWebhookPayload', () => {
  it('should create a payload with all claims when configured', () => {
    const payload = createWebhookPayload({
      issuer: 'https://auth.example.com',
      clientId: 'test-client',
      userId: 'user-123',
      sessionId: 'session-456',
      includeSub: true,
      includeSid: true,
    });

    expect(payload.event).toBe('user.logout');
    expect(payload.client_id).toBe('test-client');
    expect(payload.issuer).toBe('https://auth.example.com');
    expect(payload.sub).toBe('user-123');
    expect(payload.sid).toBe('session-456');
    expect(typeof payload.iat).toBe('number');
    expect(payload.iat).toBeGreaterThan(0);
  });

  it('should create a payload without sub when includeSub is false', () => {
    const payload = createWebhookPayload({
      issuer: 'https://auth.example.com',
      clientId: 'test-client',
      userId: 'user-123',
      sessionId: 'session-456',
      includeSub: false,
      includeSid: true,
    });

    expect(payload.sub).toBeUndefined();
    expect(payload.sid).toBe('session-456');
  });

  it('should create a payload without sid when includeSid is false', () => {
    const payload = createWebhookPayload({
      issuer: 'https://auth.example.com',
      clientId: 'test-client',
      userId: 'user-123',
      sessionId: 'session-456',
      includeSub: true,
      includeSid: false,
    });

    expect(payload.sub).toBe('user-123');
    expect(payload.sid).toBeUndefined();
  });

  it('should create a minimal payload when no user/session info included', () => {
    const payload = createWebhookPayload({
      issuer: 'https://auth.example.com',
      clientId: 'test-client',
      includeSub: false,
      includeSid: false,
    });

    expect(payload.event).toBe('user.logout');
    expect(payload.client_id).toBe('test-client');
    expect(payload.issuer).toBe('https://auth.example.com');
    expect(payload.sub).toBeUndefined();
    expect(payload.sid).toBeUndefined();
  });
});

describe('generateWebhookSignature / verifyWebhookSignature', () => {
  const testSecret = 'test-webhook-secret-32-bytes-long!';

  it('should generate a hex signature', async () => {
    const payload = JSON.stringify({ event: 'user.logout', iat: 12345 });
    const signature = await generateWebhookSignature(payload, testSecret);

    expect(typeof signature).toBe('string');
    expect(signature).toMatch(/^[0-9a-f]+$/); // Hex string
    expect(signature.length).toBe(64); // SHA-256 produces 32 bytes = 64 hex chars
  });

  it('should verify a valid signature', async () => {
    const payload = JSON.stringify({ event: 'user.logout', iat: 12345 });
    const signature = await generateWebhookSignature(payload, testSecret);

    const isValid = await verifyWebhookSignature(payload, signature, testSecret);
    expect(isValid).toBe(true);
  });

  it('should reject an invalid signature', async () => {
    const payload = JSON.stringify({ event: 'user.logout', iat: 12345 });
    const invalidSignature = 'invalid-signature-12345';

    const isValid = await verifyWebhookSignature(payload, invalidSignature, testSecret);
    expect(isValid).toBe(false);
  });

  it('should reject signature from different payload', async () => {
    const payload1 = JSON.stringify({ event: 'user.logout', iat: 12345 });
    const payload2 = JSON.stringify({ event: 'user.logout', iat: 67890 });
    const signature = await generateWebhookSignature(payload1, testSecret);

    const isValid = await verifyWebhookSignature(payload2, signature, testSecret);
    expect(isValid).toBe(false);
  });

  it('should reject signature from different secret', async () => {
    const payload = JSON.stringify({ event: 'user.logout', iat: 12345 });
    const signature = await generateWebhookSignature(payload, testSecret);

    const isValid = await verifyWebhookSignature(payload, signature, 'different-secret');
    expect(isValid).toBe(false);
  });
});

describe('sendLogoutWebhook', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return success for 2xx response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const result = await sendLogoutWebhook({
      webhookUri: 'https://example.com/webhook',
      payload: '{"event":"user.logout"}',
      signature: 'abc123',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should include correct headers in request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await sendLogoutWebhook({
      webhookUri: 'https://example.com/webhook',
      payload: '{"event":"user.logout"}',
      signature: 'abc123',
      timeoutMs: 5000,
    });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('https://example.com/webhook');
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers['Content-Type']).toBe('application/json');
    expect(callArgs[1].headers['X-Authrim-Signature-256']).toBe('sha256=abc123');
    expect(callArgs[1].headers['X-Authrim-Timestamp']).toBeDefined();
    expect(callArgs[1].headers['X-Authrim-Delivery']).toBeDefined();
    expect(callArgs[1].headers['User-Agent']).toBe('Authrim-Webhook/1.0');
  });

  it('should return failure for 400 response (rejected by receiver)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Invalid request',
    });

    const result = await sendLogoutWebhook({
      webhookUri: 'https://example.com/webhook',
      payload: '{"event":"user.logout"}',
      signature: 'abc123',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('rejected_by_receiver');
  });

  it('should return failure for 500 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await sendLogoutWebhook({
      webhookUri: 'https://example.com/webhook',
      payload: '{"event":"user.logout"}',
      signature: 'abc123',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe('HTTP 500');
  });

  it('should return failure for network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await sendLogoutWebhook({
      webhookUri: 'https://example.com/webhook',
      payload: '{"event":"user.logout"}',
      signature: 'abc123',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request failed');
    // Should not expose network error details
    expect(result.error).not.toContain('Network error');
  });
});

describe('isWebhookRetryableError', () => {
  it('should not retry 400 (client rejected)', () => {
    expect(isWebhookRetryableError(400)).toBe(false);
  });

  it('should retry 500 errors', () => {
    expect(isWebhookRetryableError(500)).toBe(true);
    expect(isWebhookRetryableError(502)).toBe(true);
    expect(isWebhookRetryableError(503)).toBe(true);
  });

  it('should not retry 4xx errors (except network)', () => {
    expect(isWebhookRetryableError(401)).toBe(false);
    expect(isWebhookRetryableError(403)).toBe(false);
    expect(isWebhookRetryableError(404)).toBe(false);
  });

  it('should retry network errors', () => {
    expect(isWebhookRetryableError(undefined, 'Request failed')).toBe(true);
    expect(isWebhookRetryableError(undefined, 'Timeout')).toBe(true);
  });

  it('should not retry rejected_by_receiver errors', () => {
    expect(isWebhookRetryableError(undefined, 'rejected_by_receiver: invalid')).toBe(false);
  });
});

describe('calculateWebhookRetryDelay', () => {
  const defaultRetryConfig: LogoutRetryConfig = {
    max_attempts: 3,
    initial_delay_ms: 1000,
    max_delay_ms: 30000,
    backoff_multiplier: 2,
  };

  it('should calculate exponential backoff', () => {
    expect(calculateWebhookRetryDelay(0, defaultRetryConfig)).toBe(1000);
    expect(calculateWebhookRetryDelay(1, defaultRetryConfig)).toBe(2000);
    expect(calculateWebhookRetryDelay(2, defaultRetryConfig)).toBe(4000);
    expect(calculateWebhookRetryDelay(3, defaultRetryConfig)).toBe(8000);
  });

  it('should cap at max_delay_ms', () => {
    expect(calculateWebhookRetryDelay(10, defaultRetryConfig)).toBe(30000);
    expect(calculateWebhookRetryDelay(100, defaultRetryConfig)).toBe(30000);
  });

  it('should work with custom config', () => {
    const customConfig: LogoutRetryConfig = {
      max_attempts: 5,
      initial_delay_ms: 500,
      max_delay_ms: 10000,
      backoff_multiplier: 3,
    };

    expect(calculateWebhookRetryDelay(0, customConfig)).toBe(500);
    expect(calculateWebhookRetryDelay(1, customConfig)).toBe(1500);
    expect(calculateWebhookRetryDelay(2, customConfig)).toBe(4500);
    expect(calculateWebhookRetryDelay(3, customConfig)).toBe(10000); // Capped
  });
});

describe('WebhookKVHelpers', () => {
  let mockKV: KVNamespace;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  describe('getPendingKey', () => {
    it('should generate correct key format', () => {
      const key = WebhookKVHelpers.getPendingKey('session-123', 'client-456');
      expect(key).toBe('logout_webhook:pending:session-123:client-456');
    });
  });

  describe('getFailureKey', () => {
    it('should generate correct key format', () => {
      const key = WebhookKVHelpers.getFailureKey('client-456');
      expect(key).toBe('logout_webhook:failures:client-456');
    });
  });

  describe('isPending / setPending / clearPending', () => {
    it('should return false when not pending', async () => {
      const isPending = await WebhookKVHelpers.isPending(mockKV, 'session-1', 'client-1');
      expect(isPending).toBe(false);
    });

    it('should set and check pending status', async () => {
      await WebhookKVHelpers.setPending(mockKV, 'session-1', 'client-1', 1);

      const isPending = await WebhookKVHelpers.isPending(mockKV, 'session-1', 'client-1');
      expect(isPending).toBe(true);
    });

    it('should clear pending status', async () => {
      await WebhookKVHelpers.setPending(mockKV, 'session-1', 'client-1', 1);
      await WebhookKVHelpers.clearPending(mockKV, 'session-1', 'client-1');

      const isPending = await WebhookKVHelpers.isPending(mockKV, 'session-1', 'client-1');
      expect(isPending).toBe(false);
    });
  });

  describe('recordFailure / getFailure / clearFailure', () => {
    it('should record and retrieve failure', async () => {
      await WebhookKVHelpers.recordFailure(mockKV, 'client-1', {
        statusCode: 500,
        error: 'Server error',
      });

      const failure = await WebhookKVHelpers.getFailure(mockKV, 'client-1');
      expect(failure).not.toBeNull();
      expect(failure?.statusCode).toBe(500);
      expect(failure?.error).toBe('Server error');
      expect(failure?.method).toBe('webhook');
      expect(failure?.timestamp).toBeDefined();
    });

    it('should return null when no failure recorded', async () => {
      const failure = await WebhookKVHelpers.getFailure(mockKV, 'nonexistent-client');
      expect(failure).toBeNull();
    });

    it('should clear failure record', async () => {
      await WebhookKVHelpers.recordFailure(mockKV, 'client-1', {
        error: 'Test error',
      });
      await WebhookKVHelpers.clearFailure(mockKV, 'client-1');

      const failure = await WebhookKVHelpers.getFailure(mockKV, 'client-1');
      expect(failure).toBeNull();
    });
  });

  describe('listFailures', () => {
    it('should list all clients with failures', async () => {
      await WebhookKVHelpers.recordFailure(mockKV, 'client-1', { error: 'Error 1' });
      await WebhookKVHelpers.recordFailure(mockKV, 'client-2', { error: 'Error 2' });
      await WebhookKVHelpers.recordFailure(mockKV, 'client-3', { error: 'Error 3' });

      const failures = await WebhookKVHelpers.listFailures(mockKV);
      expect(failures).toContain('client-1');
      expect(failures).toContain('client-2');
      expect(failures).toContain('client-3');
    });

    it('should respect limit parameter', async () => {
      await WebhookKVHelpers.recordFailure(mockKV, 'client-1', { error: 'Error 1' });
      await WebhookKVHelpers.recordFailure(mockKV, 'client-2', { error: 'Error 2' });
      await WebhookKVHelpers.recordFailure(mockKV, 'client-3', { error: 'Error 3' });

      const failures = await WebhookKVHelpers.listFailures(mockKV, 2);
      expect(failures.length).toBeLessThanOrEqual(2);
    });
  });
});
