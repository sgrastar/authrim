import { describe, expect, it, vi } from 'vitest';
import { load as rootLoad } from '../../../packages/ar-login-ui/src/routes/+page.server';
import {
  actions as discoverActions,
  load as discoverLoad,
} from '../../../packages/ar-login-ui/src/routes/discover/+page.server';
import { load as loginLoad } from '../../../packages/ar-login-ui/src/routes/login/+page.server';
import { clearLoginDiscoveryConfigCacheForTests } from '../../../packages/ar-login-ui/src/lib/login-discovery-config-cache';
import { tenantSystemProfiles } from './fixtures/profiles';
import {
  applyLoginEntryProfile,
  buildEnvForTopology,
  createTenantSystemApiFetch,
  createTenantSystemDiscoveryApp,
  makeCommonHost,
  postDiscoveryRequest,
  seedTenantDataset,
} from './helpers';

type CookieOptions = Record<string, unknown>;

function createCookies(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: string, _options?: CookieOptions) => {
      store.set(key, value);
    }),
    delete: vi.fn((key: string, _options?: CookieOptions) => {
      store.delete(key);
    }),
    store,
  };
}

async function createFlow(profileId: keyof typeof tenantSystemProfiles, tenantId = 'first') {
  clearLoginDiscoveryConfigCacheForTests();
  const env = await buildEnvForTopology('D3_custom_subdomain');
  await seedTenantDataset(env, 'with-inactive');
  await applyLoginEntryProfile(env, 'first', tenantSystemProfiles[profileId]);
  const app = createTenantSystemDiscoveryApp(tenantId);
  return {
    app,
    env,
    fetch: vi.fn(createTenantSystemApiFetch(app, env)),
  };
}

async function resolveOnDiscover(
  fetch: typeof globalThis.fetch,
  cookies: ReturnType<typeof createCookies>,
  body: URLSearchParams
) {
  return discoverActions
    .resolve({
      cookies,
      fetch,
      request: new Request('https://tenant-system.authrim.test/discover?/resolve', {
        method: 'POST',
        body,
      }),
      url: new URL('https://tenant-system.authrim.test/discover?/resolve'),
    } as never)
    .catch((error: unknown) => error);
}

describe('tenant-system user flows', () => {
  it('P00 common entry resolves tenant code, issues a grant, verifies it on tenant login, and strips the URL', async () => {
    const { fetch } = await createFlow('P00');
    const cookies = createCookies();

    await expect(
      rootLoad({
        cookies,
        fetch,
        request: new Request('https://tenant-system.authrim.test/'),
        url: new URL('https://tenant-system.authrim.test/'),
      } as never)
    ).rejects.toMatchObject({ status: 303, location: '/discover' });

    const discoverRedirect = (await resolveOnDiscover(
      fetch,
      cookies,
      new URLSearchParams({ mode: 'tenant_code', value: 'first' })
    )) as { status: number; location: string };
    expect(discoverRedirect).toMatchObject({ status: 303 });
    expect(discoverRedirect.location).toMatch(
      /^https:\/\/first\.tenant-system\.authrim\.test\/login\?discovery_grant=/
    );

    const tenantLoginUrl = new URL(discoverRedirect.location);
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

  it('P00 generic email discovery reveals no membership, then manual code completes the tenant login grant flow', async () => {
    const { app, env, fetch } = await createFlow('P00');
    const cookies = createCookies();

    const emailResponse = await postDiscoveryRequest(
      app,
      env,
      makeCommonHost('D3_custom_subdomain'),
      { mode: 'email', value: 'first.user@example.test' }
    );
    expect(emailResponse.status).toBe(200);
    await expect(emailResponse.json()).resolves.toMatchObject({
      result: 'manual_required',
      allow_manual_tenant_entry: true,
    });

    const codeRedirect = (await resolveOnDiscover(
      fetch,
      cookies,
      new URLSearchParams({ mode: 'tenant_code', value: 'first' })
    )) as { status: number; location: string };
    expect(codeRedirect).toMatchObject({ status: 303 });
    expect(codeRedirect.location).toMatch(
      /^https:\/\/first\.tenant-system\.authrim\.test\/login\?discovery_grant=/
    );
  });

  it('P08 generic email discovery still reveals no membership when manual entry is disabled', async () => {
    const { app, env } = await createFlow('P08');
    const response = await postDiscoveryRequest(app, env, makeCommonHost('D3_custom_subdomain'), {
      mode: 'email',
      value: 'missing@example.test',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: 'manual_required',
      allow_manual_tenant_entry: false,
    });
  });

  it('P09 allows direct tenant login without common discovery', async () => {
    const { fetch } = await createFlow('P09');

    await expect(
      loginLoad({
        cookies: createCookies(),
        fetch,
        request: new Request('https://first.tenant-system.authrim.test/login'),
        url: new URL('https://first.tenant-system.authrim.test/login'),
      } as never)
    ).resolves.toEqual({});
  });

  it('P00 redirects direct tenant login without grant back to common discovery', async () => {
    const { fetch } = await createFlow('P00');

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

  it('P01 tenant-only still allows invite-token discovery to tenant signup', async () => {
    const { fetch } = await createFlow('P01');

    await expect(
      discoverLoad({
        cookies: createCookies(),
        fetch,
        request: new Request(
          'https://tenant-system.authrim.test/discover?invite_token=valid-invite'
        ),
        url: new URL('https://tenant-system.authrim.test/discover?invite_token=valid-invite'),
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location:
        'https://first.tenant-system.authrim.test/signup?invite_token=valid-invite&tenant=First+Tenant&email=invited%40example.test',
    });
  });

  it('P11 app_hint resolves the client tenant, while P00 keeps app_hint disabled', async () => {
    const enabled = await createFlow('P11');
    await expect(
      discoverLoad({
        cookies: createCookies(),
        fetch: enabled.fetch,
        request: new Request('https://tenant-system.authrim.test/discover?app_hint=client_first'),
        url: new URL('https://tenant-system.authrim.test/discover?app_hint=client_first'),
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location: 'https://first.tenant-system.authrim.test/login',
    });

    const disabled = await createFlow('P00');
    await expect(
      discoverLoad({
        cookies: createCookies(),
        fetch: disabled.fetch,
        request: new Request('https://tenant-system.authrim.test/discover?app_hint=client_first'),
        url: new URL('https://tenant-system.authrim.test/discover?app_hint=client_first'),
      } as never)
    ).resolves.toMatchObject({ inviteErrorCode: null });
  });

  it('invalid discovery grant on tenant login redirects to common discovery with safe return_to', async () => {
    const { fetch } = await createFlow('P00');

    await expect(
      loginLoad({
        cookies: createCookies(),
        fetch,
        request: new Request(
          'https://first.tenant-system.authrim.test/login?discovery_grant=tampered'
        ),
        url: new URL('https://first.tenant-system.authrim.test/login?discovery_grant=tampered'),
      } as never)
    ).rejects.toMatchObject({
      status: 303,
      location:
        'https://tenant-system.authrim.test/discover?expected_tenant_id=first&return_to=https%3A%2F%2Ffirst.tenant-system.authrim.test%2Flogin',
    });
  });
});
