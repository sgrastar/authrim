/**
 * Webhook Registry Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WebhookRegistryImpl,
  createWebhookRegistry,
  validateEventPattern,
  type WebhookRegistryConfig,
  type WebhookConfigWithScope,
} from '../webhook-registry';
import type { DatabaseAdapter, ExecuteResult, HealthStatus } from '../../db/adapter';

// =============================================================================
// Mock Database Adapter
// =============================================================================

function createMockAdapter(): DatabaseAdapter & {
  mockRows: unknown[];
  executedQueries: { sql: string; params?: unknown[] }[];
} {
  const adapter = {
    mockRows: [] as unknown[],
    executedQueries: [] as { sql: string; params?: unknown[] }[],

    query: vi.fn(async function <T>(_sql: string, _params?: unknown[]): Promise<T[]> {
      adapter.executedQueries.push({ sql: _sql, params: _params });
      return adapter.mockRows as T[];
    }),

    queryOne: vi.fn(async function <T>(_sql: string, _params?: unknown[]): Promise<T | null> {
      adapter.executedQueries.push({ sql: _sql, params: _params });
      return (adapter.mockRows[0] as T) ?? null;
    }),

    execute: vi.fn(async function (_sql: string, _params?: unknown[]): Promise<ExecuteResult> {
      adapter.executedQueries.push({ sql: _sql, params: _params });
      return { rowsAffected: 1, success: true };
    }),

    transaction: vi.fn(async function <T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(adapter);
    }),

    batch: vi.fn(async function (): Promise<ExecuteResult[]> {
      return [];
    }),

    isHealthy: vi.fn(async function (): Promise<HealthStatus> {
      return { healthy: true, latencyMs: 1, type: 'mock' };
    }),

    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  };

  return adapter;
}

// =============================================================================
// Sample Data
// =============================================================================

function createSampleRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: 'wh_123',
    tenant_id: 'tenant_default',
    client_id: null,
    scope: 'tenant',
    name: 'Test Webhook',
    url: 'https://example.com/webhook',
    events: '["auth.*"]',
    secret_encrypted: 'encrypted_secret',
    headers: '{"X-Custom":"value"}',
    retry_policy: '{"maxRetries":3,"initialDelayMs":1000,"backoffMultiplier":2,"maxDelayMs":60000}',
    timeout_ms: 10000,
    active: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    last_success_at: null,
    last_failure_at: null,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('validateEventPattern', () => {
  describe('valid patterns', () => {
    it('should accept simple patterns', () => {
      expect(validateEventPattern('auth.login.succeeded')).toEqual({ valid: true });
      expect(validateEventPattern('token.access.issued')).toEqual({ valid: true });
    });

    it('should accept wildcard patterns', () => {
      expect(validateEventPattern('auth.*')).toEqual({ valid: true });
      expect(validateEventPattern('*.*.failed')).toEqual({ valid: true });
      expect(validateEventPattern('*')).toEqual({ valid: true });
    });

    it('should accept patterns with underscores and dashes', () => {
      expect(validateEventPattern('auth.before_authenticate')).toEqual({ valid: true });
      expect(validateEventPattern('my-app.user-created')).toEqual({ valid: true });
    });
  });

  describe('invalid patterns', () => {
    it('should reject empty patterns', () => {
      expect(validateEventPattern('')).toEqual({ valid: false, error: 'Pattern cannot be empty' });
      expect(validateEventPattern('  ')).toEqual({
        valid: false,
        error: 'Pattern cannot be empty',
      });
    });

    it('should reject patterns with invalid characters', () => {
      expect(validateEventPattern('auth.login!succeeded')).toMatchObject({ valid: false });
      expect(validateEventPattern('auth/login')).toMatchObject({ valid: false });
      expect(validateEventPattern('auth.login@domain')).toMatchObject({ valid: false });
    });

    it('should reject patterns with empty segments', () => {
      expect(validateEventPattern('auth..login')).toMatchObject({ valid: false });
      expect(validateEventPattern('.auth.login')).toMatchObject({ valid: false });
      expect(validateEventPattern('auth.login.')).toMatchObject({ valid: false });
    });

    it('should reject too long patterns', () => {
      const longPattern = 'a'.repeat(300);
      expect(validateEventPattern(longPattern)).toMatchObject({ valid: false });
    });

    it('should reject patterns with too many segments', () => {
      const manySegments = Array(15).fill('a').join('.');
      expect(validateEventPattern(manySegments)).toMatchObject({ valid: false });
    });
  });
});

describe('WebhookRegistry', () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let registry: WebhookRegistryImpl;
  let encryptSecret: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = createMockAdapter();
    encryptSecret = vi.fn(async (s: string) => `encrypted_${s}`);
    registry = createWebhookRegistry({
      adapter,
      encryptSecret,
      allowLocalhostHttp: false,
    });
  });

  // ===========================================================================
  // register Tests
  // ===========================================================================

  describe('register', () => {
    it('should register a tenant-level webhook', async () => {
      const id = await registry.register('tenant_default', {
        name: 'Test Webhook',
        url: 'https://example.com/webhook',
        events: ['auth.*'],
        secret: 'my-secret',
      });

      expect(id).toMatch(/^wh_[a-f0-9]+$/);
      expect(adapter.execute).toHaveBeenCalled();

      const insertCall = adapter.executedQueries.find((q) => q.sql.includes('INSERT'));
      expect(insertCall).toBeDefined();
      expect(insertCall?.params).toContain('tenant_default');
      expect(insertCall?.params).toContain('tenant'); // scope
      expect(insertCall?.params).toContain(null); // client_id
    });

    it('should register a client-level webhook', async () => {
      const id = await registry.register('tenant_default', {
        name: 'Client Webhook',
        url: 'https://example.com/webhook',
        events: ['auth.*'],
        clientId: 'client_123',
      });

      expect(id).toMatch(/^wh_[a-f0-9]+$/);

      const insertCall = adapter.executedQueries.find((q) => q.sql.includes('INSERT'));
      expect(insertCall?.params).toContain('client'); // scope
      expect(insertCall?.params).toContain('client_123'); // client_id
    });

    it('should encrypt the secret', async () => {
      await registry.register('tenant_default', {
        name: 'Test',
        url: 'https://example.com/webhook',
        events: ['auth.*'],
        secret: 'my-secret',
      });

      expect(encryptSecret).toHaveBeenCalledWith('my-secret');

      const insertCall = adapter.executedQueries.find((q) => q.sql.includes('INSERT'));
      expect(insertCall?.params).toContain('encrypted_my-secret');
    });

    it('should reject invalid URL (SSRF protection)', async () => {
      await expect(
        registry.register('tenant_default', {
          name: 'Test',
          url: 'http://localhost/webhook',
          events: ['auth.*'],
        })
      ).rejects.toThrow('Invalid webhook URL');
    });

    it('should reject private IP addresses', async () => {
      await expect(
        registry.register('tenant_default', {
          name: 'Test',
          url: 'https://192.168.1.1/webhook',
          events: ['auth.*'],
        })
      ).rejects.toThrow('Invalid webhook URL');
    });

    it('should reject cloud metadata endpoints', async () => {
      await expect(
        registry.register('tenant_default', {
          name: 'Test',
          url: 'http://169.254.169.254/latest/meta-data/',
          events: ['auth.*'],
        })
      ).rejects.toThrow('Invalid webhook URL');
    });

    it('should reject invalid event patterns', async () => {
      await expect(
        registry.register('tenant_default', {
          name: 'Test',
          url: 'https://example.com/webhook',
          events: ['auth..login'], // empty segment
        })
      ).rejects.toThrow('Invalid event pattern');
    });

    it('should reject empty events array', async () => {
      await expect(
        registry.register('tenant_default', {
          name: 'Test',
          url: 'https://example.com/webhook',
          events: [],
        })
      ).rejects.toThrow('At least one event pattern is required');
    });

    it('should reject too many event patterns', async () => {
      const manyEvents = Array(100).fill('auth.*');

      await expect(
        registry.register('tenant_default', {
          name: 'Test',
          url: 'https://example.com/webhook',
          events: manyEvents,
        })
      ).rejects.toThrow('Too many event patterns');
    });

    it('should apply custom retry policy', async () => {
      await registry.register('tenant_default', {
        name: 'Test',
        url: 'https://example.com/webhook',
        events: ['auth.*'],
        retryPolicy: { maxRetries: 5 },
      });

      const insertCall = adapter.executedQueries.find((q) => q.sql.includes('INSERT'));
      const retryPolicyJson = insertCall?.params?.find(
        (p) => typeof p === 'string' && p.includes('maxRetries')
      ) as string;

      expect(JSON.parse(retryPolicyJson).maxRetries).toBe(5);
    });

    it('should allow localhost HTTP in development mode', async () => {
      const devRegistry = createWebhookRegistry({
        adapter,
        allowLocalhostHttp: true,
      });

      const id = await devRegistry.register('tenant_default', {
        name: 'Test',
        url: 'http://localhost:3000/webhook',
        events: ['auth.*'],
      });

      expect(id).toMatch(/^wh_/);
    });
  });

  // ===========================================================================
  // update Tests
  // ===========================================================================

  describe('update', () => {
    beforeEach(() => {
      // Mock existing webhook
      adapter.mockRows = [createSampleRow()];
    });

    it('should update webhook name', async () => {
      await registry.update('tenant_default', 'wh_123', { name: 'New Name' });

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall).toBeDefined();
      expect(updateCall?.sql).toContain('name = ?');
      expect(updateCall?.params).toContain('New Name');
    });

    it('should update webhook URL with SSRF validation', async () => {
      await registry.update('tenant_default', 'wh_123', { url: 'https://new.example.com/webhook' });

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall?.params).toContain('https://new.example.com/webhook');
    });

    it('should reject invalid URL on update', async () => {
      await expect(
        registry.update('tenant_default', 'wh_123', { url: 'https://192.168.1.1/webhook' })
      ).rejects.toThrow('Invalid webhook URL');
    });

    it('should update event patterns with validation', async () => {
      await registry.update('tenant_default', 'wh_123', { events: ['token.*', 'session.*'] });

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall?.sql).toContain('events = ?');
    });

    it('should reject invalid event patterns on update', async () => {
      await expect(
        registry.update('tenant_default', 'wh_123', { events: ['auth..login'] })
      ).rejects.toThrow('Invalid event pattern');
    });

    it('should update active status', async () => {
      await registry.update('tenant_default', 'wh_123', { active: false });

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall?.sql).toContain('active = ?');
      expect(updateCall?.params).toContain(0);
    });

    it('should throw error for non-existent webhook', async () => {
      adapter.mockRows = [];

      await expect(
        registry.update('tenant_default', 'wh_nonexistent', { name: 'New Name' })
      ).rejects.toThrow('Webhook not found');
    });

    it('should not execute update if no fields provided', async () => {
      await registry.update('tenant_default', 'wh_123', {});

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall).toBeUndefined();
    });
  });

  // ===========================================================================
  // remove Tests
  // ===========================================================================

  describe('remove', () => {
    it('should delete webhook', async () => {
      await registry.remove('tenant_default', 'wh_123');

      const deleteCall = adapter.executedQueries.find((q) => q.sql.includes('DELETE'));
      expect(deleteCall).toBeDefined();
      expect(deleteCall?.params).toContain('wh_123');
      expect(deleteCall?.params).toContain('tenant_default');
    });

    it('should include tenant_id in WHERE clause for isolation', async () => {
      await registry.remove('tenant_default', 'wh_123');

      const deleteCall = adapter.executedQueries.find((q) => q.sql.includes('DELETE'));
      expect(deleteCall?.sql).toContain('tenant_id = ?');
    });
  });

  // ===========================================================================
  // get Tests
  // ===========================================================================

  describe('get', () => {
    it('should return webhook config', async () => {
      adapter.mockRows = [createSampleRow()];

      const config = await registry.get('tenant_default', 'wh_123');

      expect(config).toBeDefined();
      expect(config?.id).toBe('wh_123');
      expect(config?.tenantId).toBe('tenant_default');
      expect(config?.name).toBe('Test Webhook');
      expect(config?.url).toBe('https://example.com/webhook');
      expect(config?.events).toEqual(['auth.*']);
      expect(config?.scope).toBe('tenant');
      expect(config?.active).toBe(true);
    });

    it('should return null for non-existent webhook', async () => {
      adapter.mockRows = [];

      const config = await registry.get('tenant_default', 'wh_nonexistent');

      expect(config).toBeNull();
    });

    it('should parse JSON fields correctly', async () => {
      adapter.mockRows = [
        createSampleRow({
          events: '["auth.*", "token.*"]',
          headers: '{"X-Custom":"value","X-Another":"another"}',
        }),
      ];

      const config = await registry.get('tenant_default', 'wh_123');

      expect(config?.events).toEqual(['auth.*', 'token.*']);
      expect(config?.headers).toEqual({ 'X-Custom': 'value', 'X-Another': 'another' });
    });

    it('should include client_id for client-scoped webhooks', async () => {
      adapter.mockRows = [
        createSampleRow({
          client_id: 'client_123',
          scope: 'client',
        }),
      ];

      const config = await registry.get('tenant_default', 'wh_123');

      expect(config?.clientId).toBe('client_123');
      expect(config?.scope).toBe('client');
    });
  });

  // ===========================================================================
  // list Tests
  // ===========================================================================

  describe('list', () => {
    it('should list all webhooks for tenant', async () => {
      adapter.mockRows = [
        createSampleRow({ id: 'wh_1', name: 'Webhook 1' }),
        createSampleRow({ id: 'wh_2', name: 'Webhook 2' }),
      ];

      const webhooks = await registry.list('tenant_default');

      expect(webhooks).toHaveLength(2);
      expect(webhooks[0].id).toBe('wh_1');
      expect(webhooks[1].id).toBe('wh_2');
    });

    it('should filter by active status', async () => {
      adapter.mockRows = [];

      await registry.list('tenant_default', { activeOnly: true });

      const queryCall = adapter.executedQueries.find((q) => q.sql.includes('SELECT'));
      expect(queryCall?.sql).toContain('active = 1');
    });

    it('should filter by scope', async () => {
      adapter.mockRows = [];

      await registry.list('tenant_default', { scope: 'client' });

      const queryCall = adapter.executedQueries.find((q) => q.sql.includes('SELECT'));
      expect(queryCall?.sql).toContain('scope = ?');
      expect(queryCall?.params).toContain('client');
    });

    it('should filter by client_id', async () => {
      adapter.mockRows = [];

      await registry.list('tenant_default', { clientId: 'client_123' });

      const queryCall = adapter.executedQueries.find((q) => q.sql.includes('SELECT'));
      expect(queryCall?.sql).toContain('client_id = ?');
      expect(queryCall?.params).toContain('client_123');
    });

    it('should support pagination', async () => {
      adapter.mockRows = [];

      await registry.list('tenant_default', { limit: 10, offset: 20 });

      const queryCall = adapter.executedQueries.find((q) => q.sql.includes('SELECT'));
      expect(queryCall?.sql).toContain('LIMIT ?');
      expect(queryCall?.sql).toContain('OFFSET ?');
      expect(queryCall?.params).toEqual(['tenant_default', 10, 20]);
    });

    it('should ignore invalid runtime pagination values', async () => {
      adapter.mockRows = [];

      await registry.list('tenant_default', {
        limit: '1; DROP TABLE webhook_configs' as unknown as number,
        offset: -1,
      });

      const queryCall = adapter.executedQueries.find((q) => q.sql.includes('SELECT'));
      expect(queryCall?.sql).not.toContain('DROP TABLE');
      expect(queryCall?.sql).not.toContain('LIMIT');
      expect(queryCall?.params).toEqual(['tenant_default']);
    });
  });

  // ===========================================================================
  // findByEventType Tests
  // ===========================================================================

  describe('findByEventType', () => {
    it('should find webhooks matching event type (tenant-level)', async () => {
      adapter.mockRows = [
        createSampleRow({ id: 'wh_1', events: '["auth.*"]' }),
        createSampleRow({ id: 'wh_2', events: '["token.*"]' }),
      ];

      const matching = await registry.findByEventType('tenant_default', 'auth.login.succeeded');

      expect(matching).toHaveLength(1);
      expect(matching[0].id).toBe('wh_1');
    });

    it('should include client-level webhooks when clientId provided', async () => {
      adapter.mockRows = [
        createSampleRow({ id: 'wh_tenant', scope: 'tenant', events: '["auth.*"]' }),
        createSampleRow({
          id: 'wh_client',
          scope: 'client',
          client_id: 'client_123',
          events: '["auth.*"]',
        }),
      ];

      const matching = await registry.findByEventType(
        'tenant_default',
        'auth.login.succeeded',
        'client_123'
      );

      expect(matching).toHaveLength(2);
    });

    it('should match wildcard patterns', async () => {
      adapter.mockRows = [
        createSampleRow({ id: 'wh_1', events: '["*"]' }),
        createSampleRow({ id: 'wh_2', events: '["*.*.failed"]' }),
      ];

      const matching = await registry.findByEventType('tenant_default', 'auth.login.failed');

      expect(matching).toHaveLength(2);
    });

    it('should not match non-matching patterns', async () => {
      adapter.mockRows = [createSampleRow({ id: 'wh_1', events: '["token.*"]' })];

      const matching = await registry.findByEventType('tenant_default', 'auth.login.succeeded');

      expect(matching).toHaveLength(0);
    });

    it('should only return active webhooks', async () => {
      adapter.mockRows = [];

      await registry.findByEventType('tenant_default', 'auth.login.succeeded');

      const queryCall = adapter.executedQueries.find((q) => q.sql.includes('SELECT'));
      expect(queryCall?.sql).toContain('active = 1');
    });
  });

  // ===========================================================================
  // recordSuccess / recordFailure Tests
  // ===========================================================================

  describe('delivery status', () => {
    it('should record success timestamp', async () => {
      await registry.recordSuccess('wh_123', 'tenant_default');

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall?.sql).toContain('last_success_at = ?');
    });

    it('should record failure timestamp', async () => {
      await registry.recordFailure('wh_123', 'tenant_default');

      const updateCall = adapter.executedQueries.find((q) => q.sql.includes('UPDATE'));
      expect(updateCall?.sql).toContain('last_failure_at = ?');
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createWebhookRegistry', () => {
  it('should create registry with required config', () => {
    const adapter = createMockAdapter();
    const registry = createWebhookRegistry({ adapter });

    expect(registry).toBeInstanceOf(WebhookRegistryImpl);
  });

  it('should create registry with all options', () => {
    const adapter = createMockAdapter();
    const registry = createWebhookRegistry({
      adapter,
      encryptSecret: async (s) => s,
      allowLocalhostHttp: true,
      maxEventPatterns: 100,
    });

    expect(registry).toBeInstanceOf(WebhookRegistryImpl);
  });
});
