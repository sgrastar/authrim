import { describe, expect, it, vi } from 'vitest';
import {
  actions as discoverActions,
  load as discoverLoad,
} from '../../../packages/ar-login-ui/src/routes/discover/+page.server';
import { load as loginLoad } from '../../../packages/ar-login-ui/src/routes/login/+page.server';
import { REMEMBERED_TENANT_COOKIE } from '../../../packages/ar-login-ui/src/lib/discovery-session';
import { tenantSystemProfiles } from './fixtures/profiles';
import {
  applyLoginEntryProfile,
  buildEnvForTopology,
  createTenantSystemDiscoveryApp,
  seedTenantDataset,
} from './helpers';
import { loadMatrixCsv } from './fixtures/matrix-loader';

interface CookieSessionMatrixRow {
  case_id: string;
  cookie_session_item: string;
  condition: string;
  expect: string;
  test_type: string;
}

const candidate = {
  tenant_id: 'first',
  tenant_code: 'first',
  display_name: 'First Tenant',
  login_url: 'https://first.tenant-system.authrim.test/login',
  source: 'tenant_code',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function discoveryConfig(rememberLastTenant = true) {
  return {
    config: {
      tenant_id: 'first',
      mode: 'discovery_optional',
      discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
      email_resolution_policy: 'exact_email_then_domain',
      selection_policy: 'select_if_multiple',
      allow_manual_tenant_entry: true,
      remember_last_tenant: rememberLastTenant,
      redirect_default_login_to_discovery: true,
      require_common_discovery_before_login: true,
      skip_discovery_if_only_one_tenant: false,
      redirect_tenant_discover_to_common_entry: true,
    },
    ui: {
      theme: 'light',
      variant: 'blue-gray',
      brand_name: 'Authrim',
      logo_url: null,
      page_title: '',
      kicker_text: '',
      title_text: '',
      subtitle_text: '',
    },
    single_tenant_mode: false,
    is_common_entry_host: true,
    common_discover_url: 'https://tenant-system.authrim.test/discover',
  };
}

function tenantLoginConfig() {
  return {
    ...discoveryConfig(true),
    is_common_entry_host: false,
  };
}

function createCookies(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
}

function createApiFetch(
  app: ReturnType<typeof createTenantSystemDiscoveryApp>,
  env: Awaited<ReturnType<typeof buildEnvForTopology>>
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
    const originalHost =
      requestHeaders.get('x-authrim-original-host') ||
      requestHeaders.get('host') ||
      'tenant-system.authrim.test';
    const url =
      input instanceof Request
        ? new URL(input.url, `https://${originalHost}`)
        : new URL(String(input), `https://${originalHost}`);
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const apiRequest = new Request(`https://${originalHost}${url.pathname}${url.search}`, {
      method,
      headers: requestHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : init?.body,
    });
    apiRequest.headers.set('Host', originalHost);
    return app.request(apiRequest, {}, env);
  };
}

describe('tenant-system cookie and session matrix', () => {
  const rows = loadMatrixCsv<CookieSessionMatrixRow>('tenant-system-cookie-session-matrix.csv');
  const localRows = rows.filter((row) => row.case_id !== 'CS-015');

  it('keeps CS-015 out of the local non-E2E phase', () => {
    expect(rows.find((row) => row.case_id === 'CS-015')).toBeDefined();
    expect(localRows.some((row) => row.case_id === 'CS-015')).toBe(false);
  });

  it.each(localRows)('$case_id has cookie/session coverage metadata', (row) => {
    expect(row.cookie_session_item).toBeTruthy();
    expect(row.condition).toBeTruthy();
    expect(row.expect).toBeTruthy();
    expect(row.test_type).toBeTruthy();
  });

  it('CS-001 sets the remembered tenant cookie after resolved discovery when enabled', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(discoveryConfig(true)))
      .mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate }))
      .mockResolvedValueOnce(
        jsonResponse({
          grant: 'grant-token',
          login_url: 'https://first.tenant-system.authrim.test/login?discovery_grant=grant-token',
        })
      );
    const cookies = createCookies();

    await expect(
      discoverActions.resolve({
        cookies,
        fetch,
        request: new Request('https://tenant-system.authrim.test/discover?/resolve', {
          method: 'POST',
          body: new URLSearchParams({ mode: 'tenant_code', value: 'first' }),
        }),
        url: new URL('https://tenant-system.authrim.test/discover?/resolve'),
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location: 'https://first.tenant-system.authrim.test/login?discovery_grant=grant-token',
    });

    expect(cookies.set).toHaveBeenCalledWith(
      REMEMBERED_TENANT_COOKIE,
      JSON.stringify(candidate),
      expect.objectContaining({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' })
    );
  });

  it('CS-002 clears the remembered tenant cookie after resolved discovery when disabled', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(discoveryConfig(false)))
      .mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate }))
      .mockResolvedValueOnce(
        jsonResponse({
          grant: 'grant-token',
          login_url: 'https://first.tenant-system.authrim.test/login?discovery_grant=grant-token',
        })
      );
    const cookies = createCookies({ [REMEMBERED_TENANT_COOKIE]: JSON.stringify(candidate) });

    await expect(
      discoverActions.resolve({
        cookies,
        fetch,
        request: new Request('https://tenant-system.authrim.test/discover?/resolve', {
          method: 'POST',
          body: new URLSearchParams({ mode: 'tenant_code', value: 'first' }),
        }),
        url: new URL('https://tenant-system.authrim.test/discover?/resolve'),
      } as never)
    ).rejects.toMatchObject({ status: 303 });

    expect(cookies.delete).toHaveBeenCalledWith(REMEMBERED_TENANT_COOKIE, { path: '/' });
  });

  it('CS-003 and CS-004 read remembered tenant cookies without unsafe redirects', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(discoveryConfig(true))));
    const invalidResult = await discoverLoad({
      cookies: createCookies({ [REMEMBERED_TENANT_COOKIE]: '{bad-json' }),
      fetch,
      request: new Request('https://tenant-system.authrim.test/discover'),
      url: new URL('https://tenant-system.authrim.test/discover'),
    } as never);
    expect(invalidResult.rememberedCandidate).toBeNull();

    const validResult = await discoverLoad({
      cookies: createCookies({ [REMEMBERED_TENANT_COOKIE]: JSON.stringify(candidate) }),
      fetch,
      request: new Request('https://tenant-system.authrim.test/discover'),
      url: new URL('https://tenant-system.authrim.test/discover'),
    } as never);
    expect(validResult.rememberedCandidate).toMatchObject({ tenant_id: 'first' });
  });

  it('CS-005 and CS-014 set a short-lived verified grant cookie before stripping the URL', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tenantLoginConfig()))
      .mockResolvedValueOnce(
        jsonResponse({
          valid: true,
          tenant_id: 'first',
          target_url: 'https://first.tenant-system.authrim.test/login',
        })
      );
    const cookies = createCookies();

    await expect(
      loginLoad({
        cookies,
        fetch,
        request: new Request(
          'https://first.tenant-system.authrim.test/login?discovery_grant=grant-token'
        ),
        url: new URL('https://first.tenant-system.authrim.test/login?discovery_grant=grant-token'),
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location: 'https://first.tenant-system.authrim.test/login',
    });

    expect(cookies.set).toHaveBeenCalledWith(
      'authrim_discovery_grant_verified',
      'https://first.tenant-system.authrim.test/login',
      expect.objectContaining({
        path: '/login',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 300,
      })
    );
  });

  it('CS-006 consumes the verified grant cookie on the stripped login URL', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(tenantLoginConfig()));
    const cookies = createCookies({
      authrim_discovery_grant_verified: 'https://first.tenant-system.authrim.test/login',
    });

    await expect(
      loginLoad({
        cookies,
        fetch,
        request: new Request('https://first.tenant-system.authrim.test/login'),
        url: new URL('https://first.tenant-system.authrim.test/login'),
      } as never)
    ).resolves.toEqual({});

    expect(cookies.delete).toHaveBeenCalledWith('authrim_discovery_grant_verified', {
      path: '/login',
    });
  });

  it('CS-007 redirects replay without grant back to common discovery', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(tenantLoginConfig()));

    await expect(
      loginLoad({
        cookies: createCookies(),
        fetch,
        request: new Request('https://first.tenant-system.authrim.test/login'),
        url: new URL('https://first.tenant-system.authrim.test/login'),
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location:
        'https://tenant-system.authrim.test/discover?expected_tenant_id=first&return_to=https%3A%2F%2Ffirst.tenant-system.authrim.test%2Flogin',
    });
  });

  it('round-trips common discovery through real grant issue, tenant grant verify, and URL strip', async () => {
    const env = await buildEnvForTopology('D3_custom_subdomain');
    await seedTenantDataset(env, 'default');
    await applyLoginEntryProfile(env, 'first', tenantSystemProfiles.P00);

    const app = createTenantSystemDiscoveryApp('first');
    const fetch = vi.fn(createApiFetch(app, env));
    const cookies = createCookies();

    const redirectLocation = (await discoverActions
      .resolve({
        cookies,
        fetch,
        request: new Request('https://tenant-system.authrim.test/discover?/resolve', {
          method: 'POST',
          body: new URLSearchParams({ mode: 'tenant_code', value: 'first' }),
        }),
        url: new URL('https://tenant-system.authrim.test/discover?/resolve'),
      } as never)
      .catch((error: { location: string }) => error.location)) as string;
    expect(redirectLocation).toMatch(
      /^https:\/\/first\.tenant-system\.authrim\.test\/login\?discovery_grant=/
    );
    const tenantLoginUrl = new URL(redirectLocation);
    expect(tenantLoginUrl.searchParams.get('discovery_grant')).toBeTruthy();

    await expect(
      loginLoad({
        cookies,
        fetch,
        request: new Request(tenantLoginUrl),
        url: tenantLoginUrl,
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location: 'https://first.tenant-system.authrim.test/login',
    });

    expect(cookies.set).toHaveBeenCalledWith(
      'authrim_discovery_grant_verified',
      'https://first.tenant-system.authrim.test/login',
      expect.objectContaining({ path: '/login', httpOnly: true, maxAge: 300 })
    );
  });
});
