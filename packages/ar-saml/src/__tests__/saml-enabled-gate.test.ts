import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const passThrough = () => async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    // The request context normally resolves the tenant; here it is fixed.
    requestContextMiddleware: () => async (c: never, next: () => Promise<void>) => {
      (c as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
      await next();
    },
    pluginContextMiddleware: passThrough,
    diagnosticLoggingMiddleware: passThrough,
    adminAuthMiddleware: passThrough,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

vi.mock('../idp/metadata', () => ({
  handleIdPMetadata: (c: { text: (body: string) => Response }) => c.text('idp-metadata-ran'),
}));

import { app } from '../index';

type Settings = { federation: Record<string, unknown> | 'unreadable' | null };

function environment(settings: Settings) {
  return {
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'settings:tenant:tenant-a:federation') return null;
        if (settings.federation === 'unreadable') throw new Error('KV unavailable');
        return settings.federation ? JSON.stringify(settings.federation) : null;
      }),
    },
  } as never;
}

const off: Settings = { federation: { 'federation.saml_enabled': false } };

async function request(path: string, settings: Settings, init: { method?: string } = {}) {
  return app.fetch(new Request(`https://tenant.example.test${path}`, init), environment(settings));
}

const PROTOCOL_PATHS = ['/saml/', '/idp/profile/SAML2/'];

/** Every protocol route this worker registers, as [method, path]. */
function protocolRoutes(): Array<[string, string]> {
  const routes = app.routes
    .filter((route) => route.method !== 'ALL')
    .filter((route) => PROTOCOL_PATHS.some((prefix) => route.path.startsWith(prefix)))
    .filter((route) => route.path !== '/saml/health')
    .map((route) => [route.method, route.path] as [string, string]);
  return Array.from(new Map(routes.map((route) => [route.join(' '), route])).values());
}

describe('the tenant SAML switch on the SAML worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the protocol routes this test is meant to cover', () => {
    const paths = protocolRoutes().map(([, path]) => path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/saml/idp/metadata',
        '/saml/idp/sso',
        '/saml/idp/init',
        '/saml/idp/slo',
        '/saml/idp/attribute-release-consent',
        '/saml/metadata',
        '/saml/sp/metadata',
        '/saml/sp/login',
        '/saml/sp/acs',
        '/saml/sp/slo',
        '/idp/profile/SAML2/POST/SSO',
        '/idp/profile/SAML2/Redirect/SSO',
        '/idp/profile/SAML2/POST/SLO',
        '/idp/profile/SAML2/Redirect/SLO',
      ])
    );
  });

  it('refuses every registered protocol route with 403 while SAML is off', async () => {
    for (const [method, path] of protocolRoutes()) {
      const res = await request(path, off, { method });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = await res.json<{ error_code?: string }>();
      expect(body.error_code, `${method} ${path}`).toBe('AR050001');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it.each([
    '/saml/idp/metadata/',
    '/saml/idp/metadata//',
    '/SAML/idp/metadata',
    '/saml/IDP/Metadata',
    '/saml/%69dp/metadata',
    '/saml/./idp/metadata',
    '/saml/sp/../idp/metadata',
    '/idp/profile/saml2/post/sso',
    '/idp/profile/SAML2/POST/SSO/',
    '/saml/unknown',
  ])('refuses the path variant %s while SAML is off', async (path) => {
    const res = await request(path, off);
    expect(res.status).toBe(403);
    expect((await res.json<{ error_code?: string }>()).error_code).toBe('AR050001');
  });

  it('refuses the other methods on a protocol path too', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await request('/saml/idp/metadata', off, { method });
      expect(res.status, method).toBe(403);
    }
  });

  it('keeps the health check available while SAML is off', async () => {
    const res = await request('/saml/health', off);
    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('ok');
    // The router does not match a trailing slash, so this is a 404, but never the SAML refusal.
    expect((await request('/saml/health/', off)).status).not.toBe(403);
  });

  it('does not gate the admin API while SAML is off', async () => {
    for (const path of [
      '/api/admin/saml-settings',
      '/api/admin/saml-providers',
      '/api/admin/saml-metadata/preview',
    ]) {
      const res = await request(path, off);
      const body = await res.text();
      expect(body, path).not.toContain('AR050001');
    }
  });

  it('answers a protocol request while SAML is on, by default and when set', async () => {
    for (const settings of [
      { federation: null },
      { federation: { 'federation.saml_enabled': true } },
    ] as Settings[]) {
      const res = await request('/saml/idp/metadata', settings);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('idp-metadata-ran');
    }
  });

  it('refuses with a retryable 503 when the switch cannot be read, and not with 200', async () => {
    const unreadable: Settings = { federation: 'unreadable' };
    const res = await request('/saml/idp/metadata', unreadable);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('temporarily_unavailable');
    expect(JSON.stringify(body)).not.toMatch(/saml_enabled|federation|KV/);
    expect((await request('/saml/health', unreadable)).status).toBe(200);
  });

  it('does not name the setting in the refusal', async () => {
    const res = await request('/saml/idp/metadata', off);
    expect(await res.text()).not.toMatch(/saml_enabled|federation\./);
  });
});
