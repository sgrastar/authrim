import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  etag: vi.fn(),
  stats: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: () => ({ coreAdapter: { marker: 'tenant-core' } }),
    D1StatusListRepository: class {
      getStats = mocks.stats;
    },
    StatusListManager: class {
      listStatusLists = mocks.list;
      getStatusList = mocks.get;
      calculateETag = mocks.etag;
    },
  };
});

import {
  getStatusListHandler,
  getStatusListStatsHandler,
  listStatusListsHandler,
} from '../credential-status';

function app() {
  const hono = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  hono.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  hono.get('/status-lists/stats', getStatusListStatsHandler);
  hono.get('/status-lists/:id', getStatusListHandler);
  hono.get('/status-lists', listStatusListsHandler);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VC status-list administration', () => {
  it('uses the authenticated tenant for listing despite a forged tenant_id query', async () => {
    mocks.list.mockResolvedValue([
      {
        id: 'list-a',
        tenant_id: 'tenant-a',
        purpose: 'revocation',
        capacity: 128,
        used_count: 10,
        state: 'active',
        created_at: 1,
        updated_at: 2,
        sealed_at: null,
        internal_secret: 'must-not-leak',
      },
    ]);

    const response = await app().request(
      '/status-lists?tenant_id=tenant-b&purpose=revocation&state=active'
    );

    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('tenant-a', {
      purpose: 'revocation',
      state: 'active',
    });
    const body = await response.json();
    expect(body).toEqual({
      status_lists: [
        {
          id: 'list-a',
          tenant_id: 'tenant-a',
          purpose: 'revocation',
          capacity: 128,
          used_count: 10,
          state: 'active',
          created_at: 1,
          updated_at: 2,
          sealed_at: null,
        },
      ],
      total: 1,
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  it('returns an empty tenant-scoped list without filters', async () => {
    mocks.list.mockResolvedValue([]);
    const response = await app().request('/status-lists');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status_lists: [], total: 0 });
    expect(mocks.list).toHaveBeenCalledWith('tenant-a', {
      purpose: undefined,
      state: undefined,
    });
  });

  it('fails closed when listing storage fails', async () => {
    mocks.list.mockRejectedValue(new Error('private storage host'));
    const response = await app().request('/status-lists');
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private storage host');
  });

  it('looks up a list and its ETag only in the authenticated tenant', async () => {
    mocks.get.mockResolvedValue({
      id: 'list-a',
      tenant_id: 'tenant-a',
      purpose: 'suspension',
      capacity: 64,
      used_count: 16,
      state: 'sealed',
      created_at: 1,
      updated_at: 2,
      sealed_at: 3,
    });
    mocks.etag.mockResolvedValue('"etag-a"');

    const response = await app().request('/status-lists/list-a?tenant_id=tenant-b');

    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('tenant-a', 'list-a');
    expect(mocks.etag).toHaveBeenCalledExactlyOnceWith('tenant-a', 'list-a');
    expect(await response.json()).toEqual({
      id: 'list-a',
      tenant_id: 'tenant-a',
      purpose: 'suspension',
      capacity: 64,
      used_count: 16,
      available_count: 48,
      utilization_percentage: 25,
      state: 'sealed',
      created_at: 1,
      updated_at: 2,
      sealed_at: 3,
      etag: '"etag-a"',
    });
  });

  it('returns 404 without calculating an ETag for a list absent from this tenant', async () => {
    mocks.get.mockResolvedValue(null);
    const response = await app().request('/status-lists/other-tenant-list');
    expect(response.status).toBe(404);
    expect(mocks.get).toHaveBeenCalledWith('tenant-a', 'other-tenant-list');
    expect(mocks.etag).not.toHaveBeenCalled();
  });

  it('returns 500 without exposing errors from list retrieval or ETag calculation', async () => {
    mocks.get.mockRejectedValueOnce(new Error('private list error'));
    const first = await app().request('/status-lists/list-a');
    expect(first.status).toBe(500);
    expect(JSON.stringify(await first.json())).not.toContain('private list error');

    mocks.get.mockResolvedValueOnce({ id: 'list-a', capacity: 64, used_count: 1 });
    mocks.etag.mockRejectedValueOnce(new Error('private etag error'));
    const second = await app().request('/status-lists/list-a');
    expect(second.status).toBe(500);
    expect(JSON.stringify(await second.json())).not.toContain('private etag error');
  });

  it('reports tenant-scoped aggregate utilization and available capacity', async () => {
    mocks.stats.mockResolvedValue({
      total: 4,
      active: 2,
      sealed: 1,
      archived: 1,
      totalCapacity: 1000,
      totalUsed: 375,
    });

    const response = await app().request('/status-lists/stats?tenant_id=tenant-b');

    expect(response.status).toBe(200);
    expect(mocks.stats).toHaveBeenCalledExactlyOnceWith('tenant-a');
    expect(await response.json()).toEqual({
      tenant_id: 'tenant-a',
      lists: { total: 4, active: 2, sealed: 1, archived: 1 },
      capacity: {
        total: 1000,
        used: 375,
        available: 625,
        utilization_percentage: 37.5,
      },
    });
  });

  it('reports zero utilization for an empty tenant without dividing by zero', async () => {
    mocks.stats.mockResolvedValue({
      total: 0,
      active: 0,
      sealed: 0,
      archived: 0,
      totalCapacity: 0,
      totalUsed: 0,
    });
    const response = await app().request('/status-lists/stats');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capacity: { total: 0, used: 0, available: 0, utilization_percentage: 0 },
    });
  });

  it('fails closed if aggregate statistics cannot be read', async () => {
    mocks.stats.mockRejectedValue(new Error('private stats error'));
    const response = await app().request('/status-lists/stats');
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private stats error');
  });
});
