/**
 * The request object a provider fetches by reference (`request_uri`).
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { callArg } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getObject: vi.fn(),
  setObject: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
}));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));
vi.mock('../utils/state', () => ({
  getAuthStateRequestObject: mocks.getObject,
  setAuthStateRequestObject: mocks.setObject,
}));

import { handleRequestObject, publishRequestObject } from '../handlers/request-object';

const ENV = {} as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/:provider/request-object', handleRequestObject);
  instance.get('/auth/external/request-object', handleRequestObject);
  return instance;
}
const get = (path = '/auth/external/corp/request-object?id=state-1') =>
  Promise.resolve(app().request(`https://rp.example${path}`, {}, ENV));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProvider.mockResolvedValue({ id: 'prov-1', enabled: true });
  mocks.getObject.mockResolvedValue('signed.request.object');
  mocks.setObject.mockResolvedValue(undefined);
});

describe('handleRequestObject', () => {
  it('serves the stored object with the JAR media type and no caching', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('signed.request.object');
    expect(response.headers.get('Content-Type')).toBe('application/oauth-authz-req+jwt');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(mocks.getProvider).toHaveBeenCalledWith(ENV, 'corp', 'tenant-a');
    expect(mocks.getObject).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1', 'state-1');
  });

  it('is a 404 without a provider, an unknown or disabled provider, a state or an object', async () => {
    expect((await get('/auth/external/request-object?id=s')).status).toBe(404);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    mocks.getProvider.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    mocks.getProvider.mockResolvedValue({ id: 'prov-1', enabled: false });
    expect((await get()).status).toBe(404);
    expect(mocks.getObject).not.toHaveBeenCalled();
    mocks.getProvider.mockResolvedValue({ id: 'prov-1', enabled: true });
    expect((await get('/auth/external/corp/request-object')).status).toBe(404);
    expect((await get('/auth/external/corp/request-object?id=')).status).toBe(404);
    expect(mocks.getObject).not.toHaveBeenCalled();
    mocks.getObject.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    mocks.getObject.mockResolvedValue('');
    expect((await get()).status).toBe(404);
  });
});

describe('publishRequestObject', () => {
  it('stores the object for the provider and state in the tenant', async () => {
    await publishRequestObject(ENV, 'tenant-a', 'prov-1', 'state-1', 'jwt');
    expect(mocks.setObject).toHaveBeenCalledTimes(1);
    expect(callArg(mocks.setObject, 0, 0)).toBe(ENV);
    expect([1, 2, 3, 4].map((index) => callArg(mocks.setObject, 0, index))).toEqual([
      'tenant-a',
      'prov-1',
      'state-1',
      'jwt',
    ]);
  });
});
