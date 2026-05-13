import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockCreateAuthContextFromHono, mockResolveOptionalCoreAdapterFromHono } =
  vi.hoisted(() => ({
    mockAdapter: {
      query: vi.fn(),
    },
    mockCreateAuthContextFromHono: vi.fn(),
    mockResolveOptionalCoreAdapterFromHono: vi.fn(),
  }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    resolveOptionalCoreAdapterFromHono: mockResolveOptionalCoreAdapterFromHono,
  };
});

import {
  getPartitionStats,
  getPlatformPartitionStats,
  testPartitionRouting,
} from '../routes/settings/pii-partitions';

function createMockContext(query: Record<string, string | undefined> = {}) {
  const contextStore = new Map<string, unknown>([['tenantId', 'acme']]);
  return {
    req: {
      query: vi.fn((name: string) => query[name]),
      path: '/api/admin/settings/pii-partitions/stats',
      header: vi.fn(() => null),
    },
    env: {} as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

describe('pii partition stats routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.query.mockResolvedValue([{ pii_partition: 'default', count: 2 }]);
    mockCreateAuthContextFromHono.mockReturnValue({ coreAdapter: mockAdapter });
    mockResolveOptionalCoreAdapterFromHono.mockReturnValue(mockAdapter);
  });

  it('uses the context tenant for tenant-admin stats even when tenant_id is queried', async () => {
    const c = createMockContext({ tenant_id: 'other-tenant' });

    const response = await getPartitionStats(c);

    expect(response.status).toBe(200);
    expect(mockCreateAuthContextFromHono).toHaveBeenCalledWith(c, 'acme');
    expect(mockAdapter.query).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'acme',
    ]);
  });

  it('allows platform aggregate stats without a tenant filter', async () => {
    const c = createMockContext();

    const response = await getPlatformPartitionStats(c);
    const body = (await response.json()) as { tenantId: string; total: number };

    expect(body).toMatchObject({ tenantId: 'all', total: 2 });
    expect(mockResolveOptionalCoreAdapterFromHono).toHaveBeenCalledWith(c, 'pii-partition-stats');
    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.not.stringContaining('tenant_id = ?'),
      []
    );
  });

  it('uses the context tenant for partition routing tests', async () => {
    const c = createMockContext() as any;
    c.req.json = vi.fn().mockResolvedValue({
      tenantId: 'acme',
      attributes: { plan: 'enterprise' },
    });

    const response = await testPartitionRouting(c);
    const body = (await response.json()) as { tenantId: string };

    expect(response.status).toBe(200);
    expect(body.tenantId).toBe('acme');
  });

  it('rejects cross-tenant partition routing test input', async () => {
    const c = createMockContext() as any;
    c.req.json = vi.fn().mockResolvedValue({
      tenantId: 'other-tenant',
    });

    const response = await testPartitionRouting(c);

    expect(response.status).toBe(400);
  });
});
