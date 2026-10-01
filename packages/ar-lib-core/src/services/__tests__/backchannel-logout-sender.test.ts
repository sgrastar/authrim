/**
 * Backchannel Logout Sender Service Tests
 *
 * Tests for the Logout Token generation and sending functionality.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import {
  createLogoutToken,
  sendLogoutToken,
  isRetryableError,
  calculateRetryDelay,
  LogoutKVHelpers,
  createBackchannelLogoutOrchestrator,
} from '../backchannel-logout-sender';
import type { BackchannelLogoutConfig } from '../../types/logout';
import type { SessionClientWithDetails } from '../../repositories/core/session-client';
import { generateKeyPair, jwtVerify } from 'jose';

// Test key pair - generated dynamically at test time
let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;

// Generate key pair once for all tests
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  testPrivateKey = privateKey;
  testPublicKey = publicKey;
});

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

describe('createLogoutToken', () => {
  it('should create a valid logout token with both sub and sid', async () => {
    const token = await createLogoutToken(
      {
        issuer: 'https://example.com',
        clientId: 'test-client',
        userId: 'user-123',
        sessionId: 'session-456',
        expirationSeconds: 120,
        includeSub: true,
        includeSid: true,
      },
      testPrivateKey,
      'kid-123'
    );

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    // Verify the token
    const { payload } = await jwtVerify(token, testPublicKey);

    expect(payload.iss).toBe('https://example.com');
    expect(payload.aud).toBe('test-client');
    expect(payload.sub).toBe('user-123');
    expect(payload.sid).toBe('session-456');
    expect(payload.jti).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.events).toEqual({
      'http://schemas.openid.net/event/backchannel-logout': {},
    });
  });

  it('should create a token with only sub claim', async () => {
    const token = await createLogoutToken(
      {
        issuer: 'https://example.com',
        clientId: 'test-client',
        userId: 'user-123',
        expirationSeconds: 120,
        includeSub: true,
        includeSid: false,
      },
      testPrivateKey,
      'kid-123'
    );

    const { payload } = await jwtVerify(token, testPublicKey);

    expect(payload.sub).toBe('user-123');
    expect(payload.sid).toBeUndefined();
  });

  it('should create a token with only sid claim', async () => {
    const token = await createLogoutToken(
      {
        issuer: 'https://example.com',
        clientId: 'test-client',
        sessionId: 'session-456',
        expirationSeconds: 120,
        includeSub: false,
        includeSid: true,
      },
      testPrivateKey,
      'kid-123'
    );

    const { payload } = await jwtVerify(token, testPublicKey);

    expect(payload.sub).toBeUndefined();
    expect(payload.sid).toBe('session-456');
  });

  it('should throw error when neither sub nor sid is provided', async () => {
    await expect(
      createLogoutToken(
        {
          issuer: 'https://example.com',
          clientId: 'test-client',
          expirationSeconds: 120,
          includeSub: false,
          includeSid: false,
        },
        testPrivateKey,
        'kid-123'
      )
    ).rejects.toThrow('Logout token must contain either sub or sid claim');
  });

  it('should set correct expiration time', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expirationSeconds = 300;

    const token = await createLogoutToken(
      {
        issuer: 'https://example.com',
        clientId: 'test-client',
        userId: 'user-123',
        expirationSeconds,
        includeSub: true,
        includeSid: false,
      },
      testPrivateKey,
      'kid-123'
    );

    const { payload } = await jwtVerify(token, testPublicKey);

    const iat = payload.iat as number;
    const exp = payload.exp as number;

    expect(exp - iat).toBe(expirationSeconds);
    expect(iat).toBeGreaterThanOrEqual(now);
    expect(iat).toBeLessThanOrEqual(now + 5); // Allow 5 second tolerance
  });
});

describe('sendLogoutToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return success for 200 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
    });

    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
        body: expect.stringContaining('logout_token='),
      })
    );
  });

  it('does not wait past the timeout for a 400 body that never ends', async () => {
    // Headers arrive, then the body stalls.
    const cancel = vi.fn();
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(new ReadableStream({ start() {}, cancel }), { status: 400 }));

    const started = Date.now();
    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 200,
    });

    expect(result).toMatchObject({ success: false, statusCode: 400, error: 'rejected_by_rp: ' });
    expect(Date.now() - started).toBeLessThan(1000);
    // The stalled body is cancelled, not left reading.
    expect(cancel).toHaveBeenCalled();
  });

  it('keeps a short rejection reason from the body', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('invalid_token', { status: 400 }));

    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 1000,
    });

    expect(result.error).toBe('rejected_by_rp: invalid_token');
  });

  it('should return success for 204 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 204,
      ok: true,
    });

    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(204);
  });

  it('should return failure for 400 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      text: vi.fn().mockResolvedValue('Invalid token'),
    });

    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('rejected_by_rp');
  });

  it('should return failure for 500 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
    });

    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe('HTTP 500');
  });

  it('should handle network errors', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await sendLogoutToken({
      logoutToken: 'test-token',
      backchannelLogoutUri: 'https://example.com/logout',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    // SECURITY: Generic message to avoid exposing network error details
    expect(result.error).toBe('Request failed');
  });
});

describe('isRetryableError', () => {
  it('should return false for 400 status', () => {
    expect(isRetryableError(400, undefined)).toBe(false);
  });

  it('should return true for 500 status', () => {
    expect(isRetryableError(500, undefined)).toBe(true);
  });

  it('should return true for 502 status', () => {
    expect(isRetryableError(502, undefined)).toBe(true);
  });

  it('should return true for 503 status', () => {
    expect(isRetryableError(503, undefined)).toBe(true);
  });

  it('should return false for rejected_by_rp error', () => {
    expect(isRetryableError(undefined, 'rejected_by_rp: Invalid token')).toBe(false);
  });

  it('should return true for network error', () => {
    expect(isRetryableError(undefined, 'Network error')).toBe(true);
  });

  it('should return true for timeout error', () => {
    expect(isRetryableError(undefined, 'timeout')).toBe(true);
  });
});

describe('calculateRetryDelay', () => {
  const config = {
    initial_delay_ms: 1000,
    max_delay_ms: 30000,
    backoff_multiplier: 2,
  };

  it('should return initial delay for first retry', () => {
    expect(calculateRetryDelay(0, config)).toBe(1000);
  });

  it('should double delay for second retry', () => {
    expect(calculateRetryDelay(1, config)).toBe(2000);
  });

  it('should respect max delay', () => {
    expect(calculateRetryDelay(10, config)).toBe(30000);
  });

  it('should calculate exponential backoff correctly', () => {
    expect(calculateRetryDelay(2, config)).toBe(4000);
    expect(calculateRetryDelay(3, config)).toBe(8000);
    expect(calculateRetryDelay(4, config)).toBe(16000);
  });
});

describe('LogoutKVHelpers', () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  describe('pending lock', () => {
    it('should check if pending lock exists', async () => {
      expect(await LogoutKVHelpers.isPending(kv, 'session-1', 'client-1')).toBe(false);

      await LogoutKVHelpers.setPending(kv, 'session-1', 'client-1', 1, 300);

      expect(await LogoutKVHelpers.isPending(kv, 'session-1', 'client-1')).toBe(true);
    });

    it('should clear pending lock', async () => {
      await LogoutKVHelpers.setPending(kv, 'session-1', 'client-1', 1, 300);
      expect(await LogoutKVHelpers.isPending(kv, 'session-1', 'client-1')).toBe(true);

      await LogoutKVHelpers.clearPending(kv, 'session-1', 'client-1');

      expect(await LogoutKVHelpers.isPending(kv, 'session-1', 'client-1')).toBe(false);
    });
  });

  describe('failure records', () => {
    it('should record and retrieve failure', async () => {
      await LogoutKVHelpers.recordFailure(kv, 'client-1', {
        statusCode: 500,
        error: 'Internal error',
        errorDetail: 'Server crashed',
      });

      const failure = await LogoutKVHelpers.getFailure(kv, 'client-1');

      expect(failure).toBeDefined();
      expect(failure?.statusCode).toBe(500);
      expect(failure?.error).toBe('Internal error');
      expect(failure?.errorDetail).toBe('Server crashed');
      expect(failure?.timestamp).toBeDefined();
    });

    it('should return null for non-existent failure', async () => {
      const failure = await LogoutKVHelpers.getFailure(kv, 'non-existent');
      expect(failure).toBeNull();
    });

    it('should clear failure record', async () => {
      await LogoutKVHelpers.recordFailure(kv, 'client-1', {
        error: 'Test error',
      });

      await LogoutKVHelpers.clearFailure(kv, 'client-1');

      const failure = await LogoutKVHelpers.getFailure(kv, 'client-1');
      expect(failure).toBeNull();
    });

    it('should list all failures', async () => {
      await LogoutKVHelpers.recordFailure(kv, 'client-1', { error: 'Error 1' });
      await LogoutKVHelpers.recordFailure(kv, 'client-2', { error: 'Error 2' });
      await LogoutKVHelpers.recordFailure(kv, 'client-3', { error: 'Error 3' });

      const failures = await LogoutKVHelpers.listFailures(kv);

      expect(failures).toHaveLength(3);
      expect(failures).toContain('client-1');
      expect(failures).toContain('client-2');
      expect(failures).toContain('client-3');
    });
  });
});

describe('createBackchannelLogoutOrchestrator', () => {
  let kv: KVNamespace;

  const mockConfig: BackchannelLogoutConfig = {
    enabled: true,
    logout_token_exp_seconds: 120,
    include_sub_claim: true,
    include_sid_claim: true,
    request_timeout_ms: 5000,
    retry: {
      max_attempts: 3,
      initial_delay_ms: 1000,
      max_delay_ms: 30000,
      backoff_multiplier: 2,
    },
    on_final_failure: 'log_only',
  };

  beforeEach(() => {
    kv = createMockKV();
    vi.resetAllMocks();
  });

  it('should send logout notifications to all clients', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
    });

    const orchestrator = createBackchannelLogoutOrchestrator(kv);

    const clients: SessionClientWithDetails[] = [
      {
        id: 'sc-1',
        session_id: 'session-1',
        client_id: 'client-1',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Test Client 1',
        backchannel_logout_uri: 'https://client1.example.com/logout',
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: false,
      },
      {
        id: 'sc-2',
        session_id: 'session-1',
        client_id: 'client-2',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Test Client 2',
        backchannel_logout_uri: 'https://client2.example.com/logout',
        backchannel_logout_session_required: true,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: false,
      },
    ];

    const results = await orchestrator.sendToAll(
      clients,
      {
        issuer: 'https://example.com',
        userId: 'user-123',
        sessionId: 'session-1',
        privateKey: testPrivateKey,
        kid: 'kid-123',
      },
      mockConfig
    );

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].clientId).toBe('client-1');
    expect(results[1].success).toBe(true);
    expect(results[1].clientId).toBe('client-2');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should skip clients without backchannel_logout_uri', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
    });

    const orchestrator = createBackchannelLogoutOrchestrator(kv);

    const clients: SessionClientWithDetails[] = [
      {
        id: 'sc-1',
        session_id: 'session-1',
        client_id: 'client-1',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Test Client 1',
        backchannel_logout_uri: null, // No URI
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: false,
      },
    ];

    const results = await orchestrator.sendToAll(
      clients,
      {
        issuer: 'https://example.com',
        userId: 'user-123',
        sessionId: 'session-1',
        privateKey: testPrivateKey,
        kid: 'kid-123',
      },
      mockConfig
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should not retry when already pending', async () => {
    // Set pending lock first
    await LogoutKVHelpers.setPending(kv, 'session-1', 'client-1', 1);

    const orchestrator = createBackchannelLogoutOrchestrator(kv);

    const clients: SessionClientWithDetails[] = [
      {
        id: 'sc-1',
        session_id: 'session-1',
        client_id: 'client-1',
        first_token_at: Date.now(),
        last_token_at: Date.now(),
        last_seen_at: null,
        client_name: 'Test Client 1',
        backchannel_logout_uri: 'https://client1.example.com/logout',
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: false,
      },
    ];

    const results = await orchestrator.sendToAll(
      clients,
      {
        issuer: 'https://example.com',
        userId: 'user-123',
        sessionId: 'session-1',
        privateKey: testPrivateKey,
        kid: 'kid-123',
      },
      mockConfig
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('already_pending');
  });

  describe('retries within the request', () => {
    const client: SessionClientWithDetails = {
      id: 'sc-1',
      session_id: 'session-1',
      client_id: 'client-1',
      first_token_at: Date.now(),
      last_token_at: Date.now(),
      last_seen_at: null,
      client_name: 'Test Client 1',
      backchannel_logout_uri: 'https://client1.example.com/logout',
      backchannel_logout_session_required: false,
      frontchannel_logout_uri: null,
      frontchannel_logout_session_required: false,
    };
    const params = () => ({
      issuer: 'https://example.com',
      userId: 'user-123',
      sessionId: 'session-1',
      privateKey: testPrivateKey,
      kid: 'kid-123',
    });
    const response = (status: number) => ({ status, ok: status < 300 });

    it('retries a retryable failure with backoff, then succeeds', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(response(503))
        .mockResolvedValueOnce(response(502))
        .mockResolvedValueOnce(response(200));
      const sleep = vi.fn(async () => {});
      await LogoutKVHelpers.recordFailure(kv, 'client-1', { error: 'HTTP 503' });
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, { sleep });

      const [first] = await orchestrator.sendToAll([client], params(), mockConfig);
      expect(first).toMatchObject({ success: false, retryScheduled: true });
      const [final] = await orchestrator.settle();

      expect(final.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      // A failure recorded by an earlier logout is cleared by the successful retry.
      await expect(LogoutKVHelpers.getFailure(kv, 'client-1')).resolves.toBeNull();
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
      // The pending lock is released afterwards.
      await expect(LogoutKVHelpers.isPending(kv, 'session-1', 'client-1')).resolves.toBe(false);
    });

    it('does not retry a failure the client reports as final', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(400));
      const sleep = vi.fn(async () => {});
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, { sleep });

      const [result] = await orchestrator.sendToAll([client], params(), mockConfig);

      expect(result).toMatchObject({ success: false, retryScheduled: false });
      await expect(orchestrator.settle()).resolves.toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('records the failure and raises an alert after the last retry', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      const onAlert = vi.fn(async () => {});
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
        onAlert,
      });

      await orchestrator.sendToAll([client], params(), {
        ...mockConfig,
        retry: { ...mockConfig.retry, max_attempts: 2 },
        on_final_failure: 'alert',
      });
      const [final] = await orchestrator.settle();

      expect(final.success).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(onAlert).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'client-1', attempts: 3 })
      );
      await expect(kv.get(LogoutKVHelpers.getFailureKey('client-1'))).resolves.not.toBeNull();
    });

    it('still raises the alert when the failure cannot be recorded', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      const failureKey = LogoutKVHelpers.getFailureKey('client-1');
      const put = kv.put.bind(kv);
      kv.put = vi.fn(async (key: string, ...rest: unknown[]) => {
        if (key === failureKey) throw new Error('kv unavailable');
        return (put as (...args: unknown[]) => Promise<void>)(key, ...rest);
      }) as unknown as KVNamespace['put'];
      const onAlert = vi.fn(async () => {});
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
        onAlert,
      });

      await orchestrator.sendToAll([client], params(), {
        ...mockConfig,
        retry: { ...mockConfig.retry, max_attempts: 1 },
        on_final_failure: 'alert',
      });
      const [final] = await orchestrator.settle();

      expect(final.success).toBe(false);
      expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client-1' }));
      await expect(LogoutKVHelpers.isPending(kv, 'session-1', 'client-1')).resolves.toBe(false);
    });

    it('stops retrying at the retry budget', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
        retryBudgetMs: 7300,
        storeTimeoutMs: 500,
      });

      await orchestrator.sendToAll([client], params(), mockConfig);
      await orchestrator.settle();

      // The first retry (1 s wait + 0.5 s lock + 5 s timeout + 0.5 s clean-up) fits the budget;
      // the second (2 s + 5 s + 0.5 s) does not.
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('ends retries and their clean-up by the deadline while the store stalls', async () => {
      // Only timers and the clock are faked: signing (WebCrypto) still completes on its own.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      /** Run scheduled timers, allowing native signing to finish without advancing time. */
      const drive = async <T>(p: Promise<T>): Promise<T> => {
        let done = false;
        void p.finally(() => {
          done = true;
        });
        while (!done) {
          await new Promise((resolve) => setImmediate(resolve));
          if (!done && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
        }
        return p;
      };
      try {
        const start = Date.now();
        // Each request takes its whole 10 s timeout; the store never answers.
        global.fetch = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          return response(503);
        });
        const stalled = () => new Promise<never>(() => {});
        kv.get = vi.fn(stalled) as unknown as KVNamespace['get'];
        kv.put = vi.fn(stalled) as unknown as KVNamespace['put'];
        kv.delete = vi.fn(stalled) as unknown as KVNamespace['delete'];
        const orchestrator = createBackchannelLogoutOrchestrator(kv);

        await drive(
          orchestrator.sendToAll([client], params(), {
            ...mockConfig,
            request_timeout_ms: 10_000,
          })
        );
        await drive(orchestrator.settle());

        // Everything, clean-up included, ended within the 25 s budget.
        expect(Date.now() - start).toBeLessThanOrEqual(25_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps to the deadline when the first attempt fails just before it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const drive = async <T>(p: Promise<T>): Promise<T> => {
        let done = false;
        void p.finally(() => {
          done = true;
        });
        while (!done) {
          await new Promise((resolve) => setImmediate(resolve));
          if (!done && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
        }
        return p;
      };
      try {
        const now = Date.now();
        // 20.8 s of the 25 s are gone; requests time out after 1 s; the store never answers.
        global.fetch = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return response(503);
        });
        const stalled = () => new Promise<never>(() => {});
        kv.get = vi.fn(stalled) as unknown as KVNamespace['get'];
        kv.put = vi.fn(stalled) as unknown as KVNamespace['put'];
        kv.delete = vi.fn(stalled) as unknown as KVNamespace['delete'];
        const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
          startedAt: now - 20_800,
        });

        await drive(
          orchestrator.sendToAll([client], params(), {
            ...mockConfig,
            request_timeout_ms: 1_000,
            retry: { ...mockConfig.retry, initial_delay_ms: 100 },
          })
        );
        await drive(orchestrator.settle());

        // Ended by the deadline: no retry fits, and no store operation is waited for past it.
        expect(Date.now()).toBeLessThanOrEqual(now - 20_800 + 25_000);
        expect(global.fetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('settles an exhausted budget without waiting for a zero-delay cleanup timer', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const start = Date.now();
        global.fetch = vi.fn().mockResolvedValue(response(503));
        const stalled = () => new Promise<never>(() => {});
        kv.put = vi.fn(stalled) as unknown as KVNamespace['put'];
        const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
          retryBudgetMs: 0,
        });
        const [result] = await orchestrator.sendToAll([client], params(), mockConfig);
        await orchestrator.settle();
        expect(result.success).toBe(false);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(kv.put).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(Date.now()).toBe(start);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fits retries with slow requests within the budget', async () => {
      let now = Date.now();
      const start = now;
      global.fetch = vi.fn(async () => {
        now += 10_000; // each request times out after 10 s
        return response(503);
      });
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
          sleep: async (ms) => {
            now += ms;
          },
        });
        await orchestrator.sendToAll([client], params(), {
          ...mockConfig,
          request_timeout_ms: 8_000,
        });
        await orchestrator.settle();
      } finally {
        clock.mockRestore();
      }

      // 8 s, then a retry needing 1 s + 3 s (lock) + 8 s + 3 s (clean-up) fits 25 s; another
      // 2 s + 8 s + 3 s would not.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(now - start).toBeLessThanOrEqual(25_000);
    });

    it('counts the retry budget from when the work began', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      // Preparing the sends took 20 s of the 25 s: a retry (1 s + 5 s) no longer fits.
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
        startedAt: Date.now() - 20_000,
      });

      await orchestrator.sendToAll([client], params(), mockConfig);
      await orchestrator.settle();

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not send a retry whose wait ran past the time left', async () => {
      let now = Date.now();
      global.fetch = vi.fn().mockResolvedValue(response(503));
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
          // The 1 s wait takes 22 s: 5 s of request no longer fits the 25 s budget.
          sleep: async () => {
            now += 22_000;
          },
        });
        await orchestrator.sendToAll([client], params(), mockConfig);
        const [final] = await orchestrator.settle();
        expect(final.success).toBe(false);
      } finally {
        clock.mockRestore();
      }

      expect(global.fetch).toHaveBeenCalledTimes(1);
      await expect(kv.get(LogoutKVHelpers.getFailureKey('client-1'))).resolves.not.toBeNull();
    });

    it('retries even when the pending lock cannot be written', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValue(response(200));
      const put = kv.put.bind(kv);
      kv.put = vi.fn(async (key: string, ...rest: unknown[]) => {
        if (key.includes('pending')) throw new Error('kv unavailable');
        return (put as (...args: unknown[]) => Promise<void>)(key, ...rest);
      }) as unknown as KVNamespace['put'];
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
      });

      const [first] = await orchestrator.sendToAll([client], params(), mockConfig);
      const [retried] = await orchestrator.settle();

      expect(first).toMatchObject({ success: false, retryScheduled: true });
      expect(retried).toMatchObject({ success: true });
    });

    it('raises the alert while the failure record has not completed', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      const failureKey = LogoutKVHelpers.getFailureKey('client-1');
      const put = kv.put.bind(kv);
      kv.put = vi.fn((key: string, ...rest: unknown[]) =>
        key === failureKey
          ? new Promise<void>(() => {}) // stalls
          : (put as (...args: unknown[]) => Promise<void>)(key, ...rest)
      ) as unknown as KVNamespace['put'];
      const onAlert = vi.fn(async () => {});
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        onAlert,
        storeTimeoutMs: 20,
      });

      // No retry: the first failure is final; its record stalls.
      const [result] = await orchestrator.sendToAll([client], params(), {
        ...mockConfig,
        retry: { ...mockConfig.retry, max_attempts: 0 },
        on_final_failure: 'alert',
      });
      await orchestrator.settle();

      expect(result.success).toBe(false);
      expect(onAlert).toHaveBeenCalled();
    });

    it('notifies every client and settles while the store stalls', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      const stalled = () => new Promise<never>(() => {});
      kv.get = vi.fn(stalled) as unknown as KVNamespace['get'];
      kv.put = vi.fn(stalled) as unknown as KVNamespace['put'];
      kv.delete = vi.fn(stalled) as unknown as KVNamespace['delete'];
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
        storeTimeoutMs: 20,
      });
      const config = { ...mockConfig, retry: { ...mockConfig.retry, max_attempts: 1 } };
      const clients = Array.from({ length: 12 }, (_, i) => ({
        ...client,
        id: `sc-${i}`,
        client_id: `client-${i}`,
      }));

      await orchestrator.sendToAll(clients, params(), config);
      await orchestrator.sendToAll(
        [{ ...client, session_id: 'session-2' }],
        { ...params(), sessionId: 'session-2' },
        config
      );
      // Every first attempt was made, across batches and sessions.
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(
        13
      );
      const settled = await orchestrator.settle();
      expect(settled).toHaveLength(13);
    });

    it('keeps sending when a pending lock cannot be read', async () => {
      // The two clients are sent to at the same time: answer by address, not by call order.
      const firstFailed = new Set<string>();
      global.fetch = vi.fn(async (url: string) => {
        if (url.includes('client1') && !firstFailed.has(url)) {
          firstFailed.add(url);
          return response(503);
        }
        return response(200);
      }) as unknown as typeof fetch;
      const get = kv.get.bind(kv);
      kv.get = vi.fn(async (key: string, ...rest: unknown[]) => {
        if (key.includes('client-2')) throw new Error('kv unavailable');
        return (get as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
      }) as unknown as KVNamespace['get'];
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: async () => {},
      });

      const results = await orchestrator.sendToAll(
        [
          client,
          {
            ...client,
            id: 'sc-2',
            client_id: 'client-2',
            backchannel_logout_uri: 'https://client2.example.com/logout',
          },
        ],
        params(),
        mockConfig
      );
      // The first client's retry still ends through settle().
      const [retried] = await orchestrator.settle();

      expect(results.map((r) => r.clientId)).toEqual(['client-1', 'client-2']);
      expect(results[1].success).toBe(true);
      expect(retried).toMatchObject({ clientId: 'client-1', success: true });
    });

    it('makes every first attempt before any retry ends', async () => {
      global.fetch = vi.fn().mockResolvedValue(response(503));
      let openGate = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const orchestrator = createBackchannelLogoutOrchestrator(kv, undefined, {
        sleep: () => gate,
      });
      const config = { ...mockConfig, retry: { ...mockConfig.retry, max_attempts: 1 } };
      // Two batches of clients in one session, then another session.
      const clients = Array.from({ length: 12 }, (_, i) => ({
        ...client,
        id: `sc-${i}`,
        client_id: `client-${i}`,
      }));

      await orchestrator.sendToAll(clients, params(), config);
      await orchestrator.sendToAll(
        [{ ...client, session_id: 'session-2' }],
        {
          ...params(),
          sessionId: 'session-2',
        },
        config
      );

      // Every client got its first attempt while the retries still wait.
      expect(global.fetch).toHaveBeenCalledTimes(13);
      openGate();
      const settled = await orchestrator.settle();
      expect(settled).toHaveLength(13);
      expect(global.fetch).toHaveBeenCalledTimes(26);
    });
  });
});
