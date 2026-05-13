import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';

const { mockCreateAuthContextFromHono, mockGetClient } = vi.hoisted(() => ({
  mockCreateAuthContextFromHono: vi.fn(),
  mockGetClient: vi.fn(),
}));

vi.mock('../../context', () => ({
  createAuthContextFromHono: mockCreateAuthContextFromHono,
}));

vi.mock('../kv', () => ({
  getClient: mockGetClient,
}));

import { getClientCached, getRequestCacheStats } from '../request-cache';

function createContext() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
  } as any;
}

describe('request client cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caches client metadata by tenant and client_id', async () => {
    const c = createContext();
    const env = {} as Env;
    const tenantACoreAdapter = { id: 'tenant-a-core' };
    const tenantBCoreAdapter = { id: 'tenant-b-core' };

    mockCreateAuthContextFromHono
      .mockReturnValueOnce({ tenantId: 'tenant-a', coreAdapter: tenantACoreAdapter })
      .mockReturnValueOnce({ tenantId: 'tenant-b', coreAdapter: tenantBCoreAdapter });
    mockGetClient
      .mockResolvedValueOnce({ client_id: 'shared-mobile', client_name: 'Tenant A Mobile' })
      .mockResolvedValueOnce({ client_id: 'shared-mobile', client_name: 'Tenant B Mobile' });

    c.set('tenantId', 'tenant-a');
    const tenantAClient = await getClientCached(c, env, 'shared-mobile');
    c.set('tenantId', 'tenant-b');
    const tenantBClient = await getClientCached(c, env, 'shared-mobile');

    expect(tenantAClient?.client_name).toBe('Tenant A Mobile');
    expect(tenantBClient?.client_name).toBe('Tenant B Mobile');
    expect(mockCreateAuthContextFromHono).toHaveBeenNthCalledWith(1, c, 'tenant-a');
    expect(mockCreateAuthContextFromHono).toHaveBeenNthCalledWith(2, c, 'tenant-b');
    expect(mockGetClient).toHaveBeenNthCalledWith(
      1,
      env,
      'tenant-a',
      'shared-mobile',
      tenantACoreAdapter
    );
    expect(mockGetClient).toHaveBeenNthCalledWith(
      2,
      env,
      'tenant-b',
      'shared-mobile',
      tenantBCoreAdapter
    );
    expect(getRequestCacheStats(c).clientMiss).toBe(2);
    expect(getRequestCacheStats(c).clientHit).toBe(0);
  });

  it('reuses the cached client within the same tenant', async () => {
    const c = createContext();
    const env = {} as Env;
    const coreAdapter = { id: 'tenant-a-core' };

    mockCreateAuthContextFromHono.mockReturnValue({ tenantId: 'tenant-a', coreAdapter });
    mockGetClient.mockResolvedValue({ client_id: 'shared-mobile', client_name: 'Tenant A Mobile' });

    c.set('tenantId', 'tenant-a');
    await getClientCached(c, env, 'shared-mobile');
    await getClientCached(c, env, 'shared-mobile');

    expect(mockGetClient).toHaveBeenCalledTimes(1);
    expect(getRequestCacheStats(c).clientMiss).toBe(1);
    expect(getRequestCacheStats(c).clientHit).toBe(1);
  });

  it('rejects client cache lookup when tenant context is missing', async () => {
    const c = createContext();
    const env = {} as Env;

    await expect(getClientCached(c, env, 'shared-mobile')).rejects.toThrow(
      'Request cache requires tenant context'
    );
    expect(mockCreateAuthContextFromHono).not.toHaveBeenCalled();
    expect(mockGetClient).not.toHaveBeenCalled();
  });
});
