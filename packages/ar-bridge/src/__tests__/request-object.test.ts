import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { getProviderByIdOrSlug, getAuthStateRequestObject, setAuthStateRequestObject } = vi.hoisted(
  () => ({
    getProviderByIdOrSlug: vi.fn(),
    getAuthStateRequestObject: vi.fn(),
    setAuthStateRequestObject: vi.fn(),
  })
);
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug }));
vi.mock('../utils/state', () => ({ getAuthStateRequestObject, setAuthStateRequestObject }));
vi.mock('@authrim/ar-lib-core', () => ({
  getTenantIdFromContext: () => 'tenant-1',
}));

import { handleRequestObject, publishRequestObject } from '../handlers/request-object';

describe('request object by reference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderByIdOrSlug.mockResolvedValue({ id: 'provider-1', enabled: true });
    getAuthStateRequestObject.mockResolvedValue('header.payload.signature');
    setAuthStateRequestObject.mockResolvedValue(undefined);
  });

  it('publishes a short-lived JWT with no-store response headers', async () => {
    const env = {} as Env;
    await publishRequestObject(
      env,
      'tenant-1',
      'provider-1',
      'state-1',
      'header.payload.signature'
    );

    expect(setAuthStateRequestObject).toHaveBeenCalledWith(
      env,
      'tenant-1',
      'provider-1',
      'state-1',
      'header.payload.signature'
    );

    const app = new Hono<{ Bindings: Env }>();
    app.get('/auth/external/:provider/request-object', handleRequestObject);
    const response = await app.request(
      '/auth/external/provider-slug/request-object?id=state-1',
      undefined,
      env
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('header.payload.signature');
    expect(response.headers.get('content-type')).toContain('application/oauth-authz-req+jwt');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getAuthStateRequestObject).toHaveBeenCalledWith(
      env,
      'tenant-1',
      'provider-1',
      'state-1'
    );
  });

  it('does not reveal request objects for unknown or disabled providers', async () => {
    getProviderByIdOrSlug.mockResolvedValue({ id: 'provider-1', enabled: false });
    const app = new Hono<{ Bindings: Env }>();
    app.get('/auth/external/:provider/request-object', handleRequestObject);
    const response = await app.request(
      '/auth/external/provider/request-object?id=state-1',
      undefined,
      {} as Env
    );
    expect(response.status).toBe(404);
  });
});
