import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { cibaTestPageHandler } from '../ciba-test-page';
import { resolveAsyncTenantId } from '../tenant';

describe('async tenant and test surface boundaries', () => {
  it('renders the CIBA test page using the trusted context tenant', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
      await next();
    });
    app.get('/api/ciba/test', cibaTestPageHandler);

    const response = await app.request('https://tenant-a.example.com/api/ciba/test', {}, {
      BASE_DOMAIN: 'example.com',
    } as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('CIBA Flow Test');
  });

  it('fails closed when the CIBA test page has no tenant context', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/api/ciba/test', cibaTestPageHandler);
    const response = await app.request('https://example.com/api/ciba/test', {}, {
      BASE_DOMAIN: 'example.com',
    } as Env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('uses the legacy default tenant only when multi-tenant routing is disabled', () => {
    const contextWithoutGetter = {
      env: { DEFAULT_TENANT_ID: 'legacy-tenant' },
    } as unknown as Parameters<typeof resolveAsyncTenantId>[0];
    expect(resolveAsyncTenantId(contextWithoutGetter)).toBe('legacy-tenant');

    const multiTenantContext = {
      env: { BASE_DOMAIN: 'example.com' },
      get: () => '   ',
    } as unknown as Parameters<typeof resolveAsyncTenantId>[0];
    expect(resolveAsyncTenantId(multiTenantContext)).toBeNull();
  });
});
