/**
 * Event Dispatcher Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../logging-runtime-emitter', () => ({
  emitRuntimeLogRecords: vi.fn(async () => ({ tenantKey: 'tk_test', targetResults: [] })),
}));

import {
  EventDispatcherImpl,
  createEventDispatcher,
  type EventDispatcherConfig,
} from '../event-dispatcher';
import { emitRuntimeLogRecords } from '../logging-runtime-emitter';
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
    vi.mocked(emitRuntimeLogRecords).mockClear();

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
    it('keeps durable outbox identity and retries after a failed publish without a KV lock', async () => {
      webhookRegistry.findByEventType.mockRejectedValueOnce(
        new Error('temporary registry failure')
      );
      const payload = { type: 'account.deleted', tenantId: 't', data: { userId: 'u' } };
      const options = {
        durableEvent: { id: 'evt_durable', occurredAt: 1234000 },
        skipAuditLog: true,
      };
      const failed = await dispatcher.publish(payload, options);
      const retried = await dispatcher.publish(payload, options);
      expect(failed.success).toBe(false);
      expect(retried.success).toBe(true);
      expect(retried.deduplicated).toBeUndefined();
      expect(failed.eventId).toBe('evt_durable');
      expect(retried.eventId).toBe(failed.eventId);
      expect(retried.timestamp).toBe(1234000);
      expect(kv.put).not.toHaveBeenCalled();
    });

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
    it('materializes selected data independently for each destination', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'email',
          tenantId: 'tenant_default',
          scope: 'tenant',
          url: 'https://example.com/email',
          secretEncrypted: 'secret',
          timeoutMs: 1000,
          events: ['account.email.changed'],
          payloadFields: ['email'],
          active: true,
        },
        {
          id: 'ids',
          tenantId: 'tenant_default',
          scope: 'tenant',
          url: 'https://example.com/ids',
          secretEncrypted: 'secret',
          timeoutMs: 1000,
          events: ['account.email.changed'],
          payloadFields: [],
          active: true,
        },
      ]);
      await dispatcher.publish(
        { type: 'account.email.changed', tenantId: 'tenant_default', data: { userId: 'u' } },
        {
          skipAuditLog: true,
          skipInternalHandlers: true,
          accountWebhookData: async (webhook) =>
            webhook.payloadFields?.includes('email')
              ? {
                  userId: 'u',
                  changes: { email: { before: 'old@example.com', after: 'new@example.com' } },
                }
              : { userId: 'u' },
        }
      );
      const bodies = new Map(
        mockFetch.mock.calls.map(([url, request]) => [String(url), JSON.parse(request.body).data])
      );
      expect(bodies.get('https://example.com/ids')).toEqual({ userId: 'u' });
      expect(bodies.get('https://example.com/email')).toHaveProperty(
        'changes.email.before',
        'old@example.com'
      );
    });
    it.each([
      'user.created',
      'user.updated',
      'user.deleted',
      'account.guest.created',
      'account.guest.updated',
      'account.guest.deleted',
      'account.registered.created',
      'account.registered.updated',
      'account.registered.deleted',
      'account.registration.promoted',
      'account.registration.demoted',
    ])('does not deliver removed lifecycle webhook %s', async (type) => {
      await dispatcher.publish(
        { type, tenantId: 'tenant_default', data: { userId: 'u' } },
        { skipAuditLog: true }
      );
      expect(webhookRegistry.findByEventType).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it('filters account state without resolving legacy subscription aliases', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const base = {
        tenantId: 'tenant_default',
        scope: 'tenant',
        url: 'https://example.com/hook',
        secretEncrypted: 'secret',
        timeoutMs: 1000,
        active: true,
      };
      webhookRegistry.findByEventType.mockImplementation(async (_tenant, type) =>
        type === 'account.created'
          ? [
              {
                ...base,
                id: 'registered',
                events: ['account.created'],
                registrationStates: ['registered'],
              },
            ]
          : [{ ...base, id: 'legacy', events: ['account.guest.created'] }]
      );
      await dispatcher.publish(
        {
          type: 'account.created',
          tenantId: 'tenant_default',
          data: { registration_state: 'guest' },
        },
        { skipAuditLog: true }
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(webhookRegistry.findByEventType).toHaveBeenCalledTimes(1);
    });
    it('sends a durable account event with its original envelope on every delivery attempt', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_account',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook',
          secretEncrypted: 'encrypted_secret',
          timeoutMs: 10000,
          events: ['account.*'],
          active: true,
        },
      ]);
      const payload = {
        type: 'account.deleted',
        tenantId: 'tenant_default',
        data: { userId: 'u' },
      };
      const options = {
        durableEvent: { id: 'evt_original', occurredAt: 1000 },
        skipAuditLog: true,
      };
      await dispatcher.publish(payload, options);
      await dispatcher.publish(payload, options);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [, request] of mockFetch.mock.calls) {
        expect(JSON.parse(request.body)).toMatchObject({
          id: 'evt_original',
          timestamp: '1970-01-01T00:00:01.000Z',
          type: 'account.deleted',
          tenantId: 'tenant_default',
          data: { userId: 'u' },
        });
      }
    });
    it('keeps a durable event pending when a matching webhook cannot sign the payload', async () => {
      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_account',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook',
          events: ['account.*'],
          active: true,
        },
      ]);
      const result = await dispatcher.publish(
        { type: 'account.deleted', tenantId: 'tenant_default', data: {} },
        { durableEvent: { id: 'evt_missing_secret', occurredAt: 1000 }, skipAuditLog: true }
      );
      expect(result.delivery.webhooks.skipped).toBe(1);
      expect(result.success).toBe(false);
    });

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

    it('should emit metadata-only runtime logs for normal webhook delivery', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      webhookRegistry.findByEventType.mockResolvedValue([
        {
          id: 'wh_1',
          tenantId: 'tenant_default',
          url: 'https://example.com/webhook?token=secret',
          secretEncrypted: 'encrypted_secret',
          timeoutMs: 10000,
          events: ['auth.*'],
          active: true,
        },
      ]);

      const runtimeDispatcher = createEventDispatcher({
        adapter,
        kv,
        webhookRegistry,
        handlerRegistry,
        hookRegistry,
        decryptSecret,
        runtimeLogging: {
          env: { DB_ADMIN: adapter },
          tenantKeyResolver: async () => 'tk_registry',
        },
      });

      await runtimeDispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: { userId: 'user_123', secretValue: 'must-not-log' },
      });

      expect(emitRuntimeLogRecords).toHaveBeenCalledTimes(1);
      const input = vi.mocked(emitRuntimeLogRecords).mock.calls[0][0];
      expect(input.logType).toBe('webhook');
      expect(input.surface).toBe('webhook_delivery');
      expect(input.planes).toEqual(['archive', 'external_sink']);
      expect(input.records[0].payload).toMatchObject({
        kind: 'webhook_delivery',
        event_type: 'auth.login.succeeded',
        webhook_id: 'wh_1',
        status: 'delivered',
        status_code: 200,
        endpoint_host: 'example.com',
        error_class: null,
      });
      expect(JSON.stringify(input.records[0].payload)).not.toContain('must-not-log');
      expect(JSON.stringify(input.records[0].payload)).not.toContain('token=secret');
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

    it('should use a custom auditLogWriter when provided', async () => {
      const auditLogWriter = vi.fn().mockResolvedValue(undefined);
      const customDispatcher = createEventDispatcher({
        adapter,
        kv,
        webhookRegistry,
        handlerRegistry,
        hookRegistry,
        decryptSecret,
        auditLogWriter,
      });

      const result = await customDispatcher.publish({
        type: 'auth.login.succeeded',
        tenantId: 'tenant_default',
        data: { userId: 'user_123' },
      });

      expect(auditLogWriter).toHaveBeenCalledTimes(1);
      expect(adapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        expect.any(Array)
      );
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
