/**
 * Event Dispatcher Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  EventDispatcherImpl,
  createEventDispatcher,
  type EventDispatcherConfig,
} from '../event-dispatcher';
import type { DatabaseAdapter, ExecuteResult, HealthStatus } from '../../db/adapter';
import type { UnifiedEvent } from '../../types/events/unified-event';
import type { EventHandlerContext } from '../../types/events/handler';

// =============================================================================
// Mock Dependencies
// =============================================================================

// Mock fetch for webhook sends
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async (): Promise<ExecuteResult> => ({ rowsAffected: 1, success: true })),
    transaction: vi.fn(async (fn) => fn({} as any)),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(
      async (): Promise<HealthStatus> => ({ healthy: true, latencyMs: 1, type: 'mock' })
    ),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  };
}

function createMockKV(): any {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [] })),
    _store: store,
  };
}

function createMockWebhookRegistry(): any {
  return {
    findByEventType: vi.fn(async () => []),
    recordSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
  };
}

function createMockHandlerRegistry(): any {
  return {
    getHandlers: vi.fn(() => []),
    register: vi.fn(),
    unregister: vi.fn(),
  };
}

function createMockHookRegistry(): any {
  return {
    getBeforeHooks: vi.fn(() => []),
    getAfterHooks: vi.fn(() => []),
    registerBefore: vi.fn(),
    registerAfter: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('EventDispatcher', () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let kv: ReturnType<typeof createMockKV>;
  let webhookRegistry: ReturnType<typeof createMockWebhookRegistry>;
  let handlerRegistry: ReturnType<typeof createMockHandlerRegistry>;
  let hookRegistry: ReturnType<typeof createMockHookRegistry>;
  let dispatcher: EventDispatcherImpl;

  const decryptSecret = vi.fn(async (s: string) => s.replace('encrypted_', ''));

  beforeEach(() => {
    adapter = createMockAdapter();
    kv = createMockKV();
    webhookRegistry = createMockWebhookRegistry();
    handlerRegistry = createMockHandlerRegistry();
    hookRegistry = createMockHookRegistry();
    mockFetch.mockReset();
    decryptSecret.mockClear();

    dispatcher = createEventDispatcher({
      adapter,
      kv,
      webhookRegistry,
      handlerRegistry,
      hookRegistry,
      decryptSecret,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Basic Publish Tests
  // ===========================================================================

  describe('publish', () => {
    it('should publish an event and return result', async () => {
      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: { userId: 'user_123' },
      });

      expect(result.eventId).toMatch(/^evt_[a-f0-9]+$/);
      expect(result.success).toBe(true);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.delivery).toBeDefined();
    });

    it('should generate unique event IDs', async () => {
      const result1 = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      const result2 = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(result1.eventId).not.toBe(result2.eventId);
    });

    it('should reject oversized payloads', async () => {
      const largeData = { content: 'x'.repeat(300 * 1024) }; // 300KB

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: largeData,
      });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].error).toContain('Payload too large');
    });
  });

  // ===========================================================================
  // Deduplication Tests
  // ===========================================================================

  describe('deduplication', () => {
    it('should deduplicate events with same deduplicationKey', async () => {
      const result1 = await dispatcher.publish(
        {
          type: 'auth.login.succeeded',
          tenantId: 'tenant_default',
          data: { userId: 'user_123' },
        },
        { deduplicationKey: 'unique-key-1' }
      );

      const result2 = await dispatcher.publish(
        {
          type: 'auth.login.succeeded',
          tenantId: 'tenant_default',
          data: { userId: 'user_123' },
        },
        { deduplicationKey: 'unique-key-1' }
      );

      expect(result1.success).toBe(true);
      expect(result1.deduplicated).toBeUndefined();
      expect(result2.success).toBe(true);
      expect(result2.deduplicated).toBe(true);
    });

    it('should include tenant_id in deduplication key', async () => {
      // Publish same dedup key for different tenants
      await dispatcher.publish(
        { type: 'auth.login.succeeded', tenantId: 'tenant_a', data: {} },
        { deduplicationKey: 'same-key' }
      );

      const result = await dispatcher.publish(
        { type: 'auth.login.succeeded', tenantId: 'tenant_b', data: {} },
        { deduplicationKey: 'same-key' }
      );

      // Should NOT be deduplicated because different tenant
      expect(result.deduplicated).toBeUndefined();
    });

    it('should set deduplication TTL', async () => {
      await dispatcher.publish(
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
        { deduplicationKey: 'test-key', deduplicationTtlSeconds: 7200 }
      );

      expect(kv.put).toHaveBeenCalledWith(expect.stringContaining('test-key'), expect.any(String), {
        expirationTtl: 7200,
      });
    });
  });

  // ===========================================================================
  // Before Hook Tests
  // ===========================================================================

  describe('before hooks', () => {
    it('should execute before hooks and allow event', async () => {
      const hookHandler = vi.fn().mockResolvedValue({ continue: true });
      hookRegistry.getBeforeHooks.mockReturnValue([
        {
          id: 'test-hook',
          name: 'Test Hook',
          eventPattern: '*',
          handler: hookHandler,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(hookHandler).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should deny event when before hook denies', async () => {
      hookRegistry.getBeforeHooks.mockReturnValue([
        {
          id: 'deny-hook',
          name: 'Deny Hook',
          eventPattern: '*',
          handler: vi.fn().mockResolvedValue({
            continue: false,
            denyReason: 'Rate limited',
            denyCode: 'RATE_LIMITED',
          }),
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].error).toBe('Rate limited');
    });

    it('should merge annotations from hooks', async () => {
      const hookHandler = vi.fn().mockResolvedValue({
        continue: true,
        annotations: { riskScore: 0.1 },
      });

      hookRegistry.getBeforeHooks.mockReturnValue([
        {
          id: 'annotate-hook',
          name: 'Annotate Hook',
          eventPattern: '*',
          handler: hookHandler,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(result.success).toBe(true);
      expect(hookHandler).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Internal Handler Tests
  // ===========================================================================

  describe('internal handlers', () => {
    it('should execute matching handlers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      handlerRegistry.getHandlers.mockReturnValue([
        {
          id: 'test-handler',
          name: 'Test Handler',
          eventPattern: 'auth.*',
          handler,
          timeoutMs: 5000,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: { userId: 'user_123' },
      });

      expect(handler).toHaveBeenCalled();
      expect(result.delivery.handlers.executed).toBe(1);
    });

    it('should skip handlers when skipInternalHandlers is true', async () => {
      const handler = vi.fn();
      handlerRegistry.getHandlers.mockReturnValue([
        {
          id: 'test-handler',
          name: 'Test Handler',
          eventPattern: 'auth.*',
          handler,
        },
      ]);

      const result = await dispatcher.publish(
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
        { skipInternalHandlers: true }
      );

      expect(handler).not.toHaveBeenCalled();
      expect(result.delivery.handlers.executed).toBe(0);
    });

    it('should handle handler errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      handlerRegistry.getHandlers.mockReturnValue([
        {
          id: 'error-handler',
          name: 'Error Handler',
          eventPattern: '*',
          handler: vi.fn().mockRejectedValue(new Error('Handler crashed')),
          onError: 'log',
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(result.delivery.handlers.failed).toBe(1);
      // With onError: 'log', it should not add to errors
      expect(result.errors).toBeUndefined();

      consoleErrorSpy.mockRestore();
    });
  });

  // ===========================================================================
  // Webhook Delivery Tests
  // ===========================================================================

  describe('webhook delivery', () => {
    it('should deliver to matching webhooks', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_1',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook',
          secretEncrypted: 'encrypted_secret',
          timeoutMs: 10000,
          events: ['auth.*'],
          active: true,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: { userId: 'user_123' },
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(result.delivery.webhooks.sent).toBe(1);
      expect(webhookRegistry.recordSuccess).toHaveBeenCalled();
    });

    it('should skip webhooks when skipWebhooks is true', async () => {
      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_1',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook',
          secretEncrypted: 'encrypted_secret',
          events: ['auth.*'],
          active: true,
        },
      ]);

      const result = await dispatcher.publish(
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
        { skipWebhooks: true }
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.delivery.webhooks.sent).toBe(0);
    });

    it('should record webhook failures', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_1',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook',
          secretEncrypted: 'encrypted_secret',
          timeoutMs: 10000,
          events: ['auth.*'],
          active: true,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(result.delivery.webhooks.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].target).toBe('webhook');
      expect(webhookRegistry.recordFailure).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should skip webhooks without secrets', async () => {
      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_no_secret',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook',
          secretEncrypted: null, // No secret
          events: ['auth.*'],
          active: true,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.delivery.webhooks.skipped).toBe(1);
    });
  });

  // ===========================================================================
  // Audit Log Tests
  // ===========================================================================

  describe('audit log', () => {
    it('should record audit log by default', async () => {
      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: { userId: 'user_123' },
      });

      expect(adapter.execute).toHaveBeenCalled();
      const calls = (adapter.execute as any).mock.calls;
      const auditLogCall = calls.find((c: any) => c[0].includes('audit_log'));
      expect(auditLogCall).toBeDefined();
      expect(result.delivery.auditLog).toBe(true);
    });

    it('should skip audit log when skipAuditLog is true', async () => {
      const result = await dispatcher.publish(
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
        { skipAuditLog: true }
      );

      const calls = (adapter.execute as any).mock.calls;
      const auditLogCall = calls.find((c: any) => c[0].includes('audit_log'));
      expect(auditLogCall).toBeUndefined();
      expect(result.delivery.auditLog).toBe(false);
    });
  });

  // ===========================================================================
  // After Hook Tests
  // ===========================================================================

  describe('after hooks', () => {
    it('should execute sync after hooks', async () => {
      const afterHandler = vi.fn().mockResolvedValue(undefined);
      hookRegistry.getAfterHooks.mockReturnValue([
        {
          id: 'after-hook',
          name: 'After Hook',
          eventPattern: '*',
          handler: afterHandler,
          async: false,
        },
      ]);

      await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      // Wait for async operations
      await new Promise((r) => setTimeout(r, 10));

      expect(afterHandler).toHaveBeenCalled();
    });

    it('should fire async after hooks without waiting', async () => {
      let asyncHookCalled = false;
      hookRegistry.getAfterHooks.mockReturnValue([
        {
          id: 'async-hook',
          name: 'Async Hook',
          eventPattern: '*',
          handler: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 50));
            asyncHookCalled = true;
          }),
          async: true,
        },
      ]);

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      // Result should return before async hook completes
      expect(result.success).toBe(true);
      expect(asyncHookCalled).toBe(false);

      // Wait for async hook to complete
      await new Promise((r) => setTimeout(r, 100));
      expect(asyncHookCalled).toBe(true);
    });
  });

  // ===========================================================================
  // publishBatch Tests
  // ===========================================================================

  describe('publishBatch', () => {
    it('should publish multiple events', async () => {
      const results = await dispatcher.publishBatch([
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: { userId: '1' } },
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: { userId: '2' } },
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: { userId: '3' } },
      ]);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should process events concurrently', async () => {
      const startTime = Date.now();

      // Add a handler with delay
      handlerRegistry.getHandlers.mockReturnValue([
        {
          id: 'slow-handler',
          name: 'Slow Handler',
          eventPattern: '*',
          handler: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 50));
          }),
        },
      ]);

      await dispatcher.publishBatch([
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
        { type: 'auth.login.succeeded', tenantId: 'tenant_default', data: {} },
      ]);

      const elapsed = Date.now() - startTime;
      // Should be concurrent, not sequential (3 * 50ms = 150ms)
      // Concurrent should be around 50-100ms
      expect(elapsed).toBeLessThan(200);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle KV errors gracefully', async () => {
      kv.get.mockRejectedValue(new Error('KV unavailable'));
      kv.put.mockRejectedValue(new Error('KV unavailable'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should still succeed (fail-open for dedup)
      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      expect(result.success).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it('should handle webhook registry errors', async () => {
      webhookRegistry.findByEventType.mockRejectedValue(new Error('DB error'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await dispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: {},
      });

      // Should still complete but with error
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();

      consoleErrorSpy.mockRestore();
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createEventDispatcher', () => {
  it('should create dispatcher with all dependencies', () => {
    const dispatcher = createEventDispatcher({
      adapter: createMockAdapter(),
      kv: createMockKV(),
      webhookRegistry: createMockWebhookRegistry(),
      handlerRegistry: createMockHandlerRegistry(),
      hookRegistry: createMockHookRegistry(),
      decryptSecret: async (s) => s,
    });

    expect(dispatcher).toBeInstanceOf(EventDispatcherImpl);
  });

  it('should accept custom options', () => {
    const dispatcher = createEventDispatcher({
      adapter: createMockAdapter(),
      kv: createMockKV(),
      webhookRegistry: createMockWebhookRegistry(),
      handlerRegistry: createMockHandlerRegistry(),
      hookRegistry: createMockHookRegistry(),
      decryptSecret: async (s) => s,
      options: {
        publishTimeoutMs: 60000,
        maxPayloadSize: 512 * 1024,
        enableAuditLog: false,
      },
    });

    expect(dispatcher).toBeInstanceOf(EventDispatcherImpl);
  });
});
