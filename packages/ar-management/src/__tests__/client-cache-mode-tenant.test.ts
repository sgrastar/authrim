import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const core = vi.hoisted(() => ({
  queryOne: vi.fn(),
  setClientCacheMode: vi.fn(async () => undefined),
  getClientCacheMode: vi.fn(async () => 'fixed'),
  getCacheMode: vi.fn(async () => 'fixed'),
}));

vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsTenantId: () => 'tenant-a',
  resolveSettingsCoreAdapter: () => ({ queryOne: core.queryOne }),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  setClientCacheMode: core.setClientCacheMode,
  getClientCacheMode: core.getClientCacheMode,
  getCacheMode: core.getCacheMode,
}));

import {
  getClientCacheModeHandler,
  setClientCacheModeHandler,
} from '../routes/settings/cache-mode';

/** The cache mode of a client is one shared KV key: a tenant reaches only its own clients'. */

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/clients/:clientId/cache-mode', getClientCacheModeHandler);
  instance.post('/clients/:clientId/cache-mode', setClientCacheModeHandler);
  return instance;
}

describe('the cache mode of a client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is read and changed for a client of the tenant', async () => {
    core.queryOne.mockResolvedValue({ client_id: 'client-1' });

    const read = await app().request('/clients/client-1/cache-mode', {}, {} as Env);
    const write = await app().request(
      '/clients/client-1/cache-mode',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'fixed' }),
      },
      {} as Env
    );

    expect([read.status, write.status]).toEqual([200, 200]);
    expect(core.setClientCacheMode).toHaveBeenCalledTimes(1);
    expect(core.queryOne).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      'client-1',
    ]);
  });

  it('is neither read nor changed for a client of another tenant', async () => {
    core.queryOne.mockResolvedValue(null);

    const read = await app().request('/clients/foreign/cache-mode', {}, {} as Env);
    const write = await app().request(
      '/clients/foreign/cache-mode',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: null }),
      },
      {} as Env
    );

    expect([read.status, write.status]).toEqual([404, 404]);
    expect(core.setClientCacheMode).not.toHaveBeenCalled();
    expect(core.getClientCacheMode).not.toHaveBeenCalled();
  });
});
