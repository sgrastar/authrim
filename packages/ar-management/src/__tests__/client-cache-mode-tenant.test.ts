import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const state = vi.hoisted(() => ({
  tenantId: 'tenant-a',
  /** Clients of each tenant: the same client ID can exist in two tenants. */
  clients: {} as Record<string, string[]>,
}));

vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsTenantId: () => state.tenantId,
  resolveSettingsCoreAdapter: () => ({
    queryOne: async (_sql: string, [tenantId, clientId]: [string, string]) =>
      state.clients[tenantId]?.includes(clientId) ? { client_id: clientId } : null,
  }),
}));

import {
  getClientCacheModeHandler,
  setClientCacheModeHandler,
} from '../routes/settings/cache-mode';

/**
 * The cache mode of a client is kept per tenant and client. The tenant reaches only its own
 * clients', and two tenants that share a client ID (a copied tenant) do not affect each other.
 */

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

let kv: ReturnType<typeof memoryKv>;
const env = () => ({ AUTHRIM_CONFIG: kv }) as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/clients/:clientId/cache-mode', getClientCacheModeHandler);
  instance.post('/clients/:clientId/cache-mode', setClientCacheModeHandler);
  return instance;
}

async function read(tenantId: string, clientId: string) {
  state.tenantId = tenantId;
  const res = await app().request(`/clients/${clientId}/cache-mode`, {}, env());
  return { status: res.status, body: await res.json() };
}

async function write(tenantId: string, clientId: string, mode: string | null) {
  state.tenantId = tenantId;
  const res = await app().request(
    `/clients/${clientId}/cache-mode`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    env()
  );
  return { status: res.status, body: await res.json() };
}

describe('the cache mode of a client', () => {
  beforeEach(() => {
    kv = memoryKv();
    state.clients = { 'tenant-a': ['client-1', 'shared'], 'tenant-b': ['shared'] };
  });

  it('is read and changed for a client of the tenant, under the tenant and client', async () => {
    const write1 = await write('tenant-a', 'client-1', 'maintenance');
    const read1 = await read('tenant-a', 'client-1');

    expect([write1.status, read1.status]).toEqual([200, 200]);
    expect(read1.body).toMatchObject({ mode: 'maintenance', effective: 'maintenance' });
    expect([...kv.store.keys()]).toEqual(['v1:cache-mode:client:tenant-a:client-1']);
  });

  it('is neither read nor changed for a client of another tenant', async () => {
    const readForeign = await read('tenant-a', 'foreign');
    const writeForeign = await write('tenant-a', 'foreign', 'maintenance');

    expect([readForeign.status, writeForeign.status]).toEqual([404, 404]);
    expect(kv.store.size).toBe(0);
  });

  it('does not reach another tenant through a client ID that tenant also uses', async () => {
    // tenant-b has no client-1 although tenant-a does.
    const res = await write('tenant-b', 'client-1', 'maintenance');

    expect(res.status).toBe(404);
    expect(kv.store.size).toBe(0);
  });

  it('is independent for two tenants that share a client ID', async () => {
    await write('tenant-a', 'shared', 'maintenance');

    // tenant-b sees no override of its own and the platform default, not tenant-a's setting.
    expect((await read('tenant-b', 'shared')).body).toMatchObject({
      mode: null,
      effective: 'fixed',
      uses_platform_default: true,
    });

    await write('tenant-b', 'shared', 'fixed');
    expect((await read('tenant-a', 'shared')).body).toMatchObject({ mode: 'maintenance' });
    expect((await read('tenant-b', 'shared')).body).toMatchObject({ mode: 'fixed' });

    // Clearing one tenant's override leaves the other's.
    await write('tenant-b', 'shared', null);
    expect((await read('tenant-b', 'shared')).body).toMatchObject({ mode: null });
    expect((await read('tenant-a', 'shared')).body).toMatchObject({ mode: 'maintenance' });
    expect([...kv.store.keys()]).toEqual(['v1:cache-mode:client:tenant-a:shared']);
  });

  it('ignores the former un-tenanted key, whose tenant cannot be told', async () => {
    kv.store.set('v1:cache-mode:client:shared', 'maintenance');

    for (const tenantId of ['tenant-a', 'tenant-b']) {
      expect((await read(tenantId, 'shared')).body).toMatchObject({
        mode: null,
        effective: 'fixed',
      });
    }
  });
});
