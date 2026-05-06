/**
 * Webhook Sender Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateWebhookSignature,
  verifyWebhookSignature,
  timingSafeEqual,
  sendWebhook,
  isRetryableError,
  calculateRetryDelay,
  sendWebhookBatch,
  DEFAULT_RETRY_CONFIG,
  type WebhookRetryConfig,
} from '../webhook-sender';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Webhook Signature Functions', () => {
  describe('generateWebhookSignature', () => {
    it('should generate consistent signatures for same payload and secret', async () => {
      const payload = JSON.stringify({ event: 'test', data: { id: '123' } });
      const secret = 'my-secret-key';

      const sig1 = await generateWebhookSignature(payload, secret);
      const sig2 = await generateWebhookSignature(payload, secret);

      expect(sig1).toBe(sig2);
    });

    it('should generate different signatures for different payloads', async () => {
      const secret = 'my-secret-key';
      const payload1 = JSON.stringify({ event: 'test1' });
      const payload2 = JSON.stringify({ event: 'test2' });

      const sig1 = await generateWebhookSignature(payload1, secret);
      const sig2 = await generateWebhookSignature(payload2, secret);

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different secrets', async () => {
      const payload = JSON.stringify({ event: 'test' });

      const sig1 = await generateWebhookSignature(payload, 'secret1');
      const sig2 = await generateWebhookSignature(payload, 'secret2');

      expect(sig1).not.toBe(sig2);
    });

    it('should return hex-encoded string', async () => {
      const sig = await generateWebhookSignature('test', 'secret');

      // Hex string should only contain 0-9 and a-f
      expect(sig).toMatch(/^[0-9a-f]+$/);
      // SHA-256 produces 32 bytes = 64 hex characters
      expect(sig).toHaveLength(64);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('should verify valid signature', async () => {
      const payload = JSON.stringify({ event: 'test' });
      const secret = 'my-secret';
      const signature = await generateWebhookSignature(payload, secret);

      const isValid = await verifyWebhookSignature(payload, signature, secret);

      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', async () => {
      const payload = JSON.stringify({ event: 'test' });
      const secret = 'my-secret';
      const wrongSignature = 'invalid-signature';

      const isValid = await verifyWebhookSignature(payload, wrongSignature, secret);

      expect(isValid).toBe(false);
    });

    it('should reject signature with wrong secret', async () => {
      const payload = JSON.stringify({ event: 'test' });
      const signature = await generateWebhookSignature(payload, 'secret1');

      const isValid = await verifyWebhookSignature(payload, signature, 'secret2');

      expect(isValid).toBe(false);
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for equal strings', () => {
      expect(timingSafeEqual('hello', 'hello')).toBe(true);
      expect(timingSafeEqual('', '')).toBe(true);
      expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(timingSafeEqual('hello', 'world')).toBe(false);
      expect(timingSafeEqual('abc', 'abcd')).toBe(false);
      expect(timingSafeEqual('abc', 'abd')).toBe(false);
    });

    it('should return false for different length strings', () => {
      expect(timingSafeEqual('a', 'ab')).toBe(false);
      expect(timingSafeEqual('abcdef', 'abc')).toBe(false);
    });
  });
});

describe('sendWebhook', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send webhook with correct headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const result = await sendWebhook({
      url: 'https://example.com/webhook',
      payload: '{"event":"test"}',
      signature: 'abc123',
      timeoutMs: 30000,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.deliveryId).toBeDefined();

    // Verify headers
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['X-Authrim-Signature-256']).toBe('sha256=abc123');
    expect(options.headers['X-Authrim-Timestamp']).toBeDefined();
    expect(options.headers['X-Authrim-Delivery']).toBeDefined();
    expect(options.headers['User-Agent']).toBe('Authrim-Webhook/1.0');
  });

  it('should handle 400 response as non-retryable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Invalid payload'),
    });

    const result = await sendWebhook({
      url: 'https://example.com/webhook',
      payload: '{}',
      signature: 'sig',
      timeoutMs: 30000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('rejected_by_receiver');
  });

  it('should handle 500 response as retryable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await sendWebhook({
      url: 'https://example.com/webhook',
      payload: '{}',
      signature: 'sig',
      timeoutMs: 30000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.retryable).toBe(true);
  });

  it('should handle network errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await sendWebhook({
      url: 'https://example.com/webhook',
      payload: '{}',
      signature: 'sig',
      timeoutMs: 30000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request failed');
    expect(result.retryable).toBe(true);

    consoleErrorSpy.mockRestore();
  });

  it('should include custom headers', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await sendWebhook({
      url: 'https://example.com/webhook',
      payload: '{}',
      signature: 'sig',
      timeoutMs: 30000,
      customHeaders: {
        'X-Custom-Header': 'custom-value',
      },
    });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-Custom-Header']).toBe('custom-value');
  });

  it('should reject internal webhook URLs before fetch', async () => {
    const result = await sendWebhook({
      url: 'https://169.254.169.254/latest/meta-data',
      payload: '{}',
      signature: 'sig',
      timeoutMs: 30000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid webhook URL');
    expect(result.retryable).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Retry Logic', () => {
  describe('isRetryableError', () => {
    it('should return false for 400', () => {
      expect(isRetryableError(400)).toBe(false);
    });

    it('should return true for 5xx errors', () => {
      expect(isRetryableError(500)).toBe(true);
      expect(isRetryableError(502)).toBe(true);
      expect(isRetryableError(503)).toBe(true);
      expect(isRetryableError(599)).toBe(true);
    });

    it('should return true for 429 Too Many Requests', () => {
      expect(isRetryableError(429)).toBe(true);
    });

    it('should return false for other 4xx errors', () => {
      expect(isRetryableError(401)).toBe(false);
      expect(isRetryableError(403)).toBe(false);
      expect(isRetryableError(404)).toBe(false);
    });

    it('should return true for undefined (network error)', () => {
      expect(isRetryableError(undefined)).toBe(true);
    });
  });

  describe('calculateRetryDelay', () => {
    const config: WebhookRetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 60000,
    };

    it('should calculate exponential backoff', () => {
      expect(calculateRetryDelay(0, config)).toBe(1000);
      expect(calculateRetryDelay(1, config)).toBe(2000);
      expect(calculateRetryDelay(2, config)).toBe(4000);
      expect(calculateRetryDelay(3, config)).toBe(8000);
    });

    it('should cap at maxDelayMs', () => {
      expect(calculateRetryDelay(10, config)).toBe(60000);
      expect(calculateRetryDelay(20, config)).toBe(60000);
    });

    it('should use default config values', () => {
      expect(calculateRetryDelay(0, DEFAULT_RETRY_CONFIG)).toBe(1000);
      expect(calculateRetryDelay(1, DEFAULT_RETRY_CONFIG)).toBe(2000);
    });
  });
});

describe('sendWebhookBatch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send multiple webhooks', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const results = await sendWebhookBatch([
      { url: 'https://a.com/webhook', secret: 'secret-a', payload: { id: 1 } },
      { url: 'https://b.com/webhook', secret: 'secret-b', payload: { id: 2 } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].result.success).toBe(true);
    expect(results[1].result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should track duration for each webhook', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const results = await sendWebhookBatch([
      { url: 'https://a.com/webhook', secret: 'secret', payload: {} },
    ]);

    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should use webhookId as identifier when provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const results = await sendWebhookBatch([
      { url: 'https://a.com/webhook', secret: 'secret', payload: {}, webhookId: 'wh-123' },
    ]);

    expect(results[0].identifier).toBe('wh-123');
  });

  it('should use URL as identifier when webhookId not provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const results = await sendWebhookBatch([
      { url: 'https://a.com/webhook', secret: 'secret', payload: {} },
    ]);

    expect(results[0].identifier).toBe('https://a.com/webhook');
  });

  it('should respect maxConcurrent limit', async () => {
    // Create a slow response to test concurrency
    let activeCalls = 0;
    let maxActiveCalls = 0;

    mockFetch.mockImplementation(async () => {
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls--;
      return { ok: true, status: 200 };
    });

    const webhooks = Array.from({ length: 15 }, (_, i) => ({
      url: `https://example.com/${i}`,
      secret: 'secret',
      payload: {},
    }));

    await sendWebhookBatch(webhooks, 5);

    // With maxConcurrent=5, max active calls should be <= 5
    expect(maxActiveCalls).toBeLessThanOrEqual(5);
  });

  it('should handle individual webhook errors without failing batch', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    // Use maxConcurrent=1 to ensure sequential execution for predictable mock ordering
    const results = await sendWebhookBatch(
      [
        { url: 'https://a.com/webhook', secret: 's1', payload: {} },
        { url: 'https://b.com/webhook', secret: 's2', payload: {} },
        { url: 'https://c.com/webhook', secret: 's3', payload: {} },
      ],
      1 // Sequential execution
    );

    expect(results).toHaveLength(3);
    expect(results[0].result.success).toBe(true);
    expect(results[1].result.success).toBe(false);
    expect(results[2].result.success).toBe(true);

    consoleErrorSpy.mockRestore();
  });
});
