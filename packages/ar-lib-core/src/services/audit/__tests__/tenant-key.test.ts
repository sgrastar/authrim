import { describe, expect, it, vi } from 'vitest';
import { createTenantRegistryKeyResolver, resolveAuditTenantKey } from '../tenant-key';
import type { DatabaseAdapter, ExecuteResult, HealthStatus } from '../../../db/adapter';

function createMockAdapter(rows: Record<string, { tenant_key: string | null } | null>) {
  const adapter: DatabaseAdapter = {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async (_sql: string, params?: unknown[]) => {
      const tenantId = String(params?.[0] ?? '');
      return rows[tenantId] ?? null;
    }),
    execute: vi.fn(async (): Promise<ExecuteResult> => ({ rowsAffected: 0, success: true })),
    transaction: vi.fn(async (fn) => fn(adapter)),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(
      async (): Promise<HealthStatus> => ({ healthy: true, latencyMs: 1, type: 'mock' })
    ),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  };
  return adapter;
}

describe('tenant key resolver', () => {
  it('resolves and caches opaque tenant keys from the tenant registry', async () => {
    const adapter = createMockAdapter({ tenant_a: { tenant_key: 't_registry' } });
    const resolver = createTenantRegistryKeyResolver(adapter);

    await expect(resolver('tenant_a')).resolves.toBe('t_registry');
    await expect(resolver('tenant_a')).resolves.toBe('t_registry');

    expect(adapter.queryOne).toHaveBeenCalledTimes(1);
  });

  it('falls back to derived tenant keys when the registry is unavailable', async () => {
    const adapter = createMockAdapter({});
    const tenantKey = await resolveAuditTenantKey('tenant_a', {
      tenantKeyResolver: createTenantRegistryKeyResolver(adapter),
      tenantKeySalt: 'salt',
    });

    expect(tenantKey).toMatch(/^t_/);
    expect(tenantKey).not.toBe('tenant_a');
  });
});
