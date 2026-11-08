import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  accountPagePathFromDocument,
  passkeyEndpointsHandler,
  passkeyLoginEnabledFromDocument,
} from '../passkey-endpoints';

type KvEntries = Record<string, string>;

function kv(entries: KvEntries, options: { fail?: boolean } = {}): KVNamespace {
  return {
    get: async (key: string) => {
      if (options.fail) throw new Error('kv unavailable');
      return entries[key] ?? null;
    },
  } as unknown as KVNamespace;
}

function authMethodsKey(tenantId: string) {
  return `settings:tenant:${tenantId}:authentication-methods`;
}

function selfServiceKey(tenantId: string) {
  return `settings:tenant:${tenantId}:self-service`;
}

function loginUiKey(tenantId: string) {
  return `settings:tenant:${tenantId}:login-ui`;
}

/** A `login-ui` document publishing one builder page with the given placement and widget. */
function publishedPage(options: {
  placementId: string;
  blockType: string;
  condition?: string;
  enabled?: boolean;
}) {
  return JSON.stringify({
    'login-ui.account_pages': JSON.stringify({
      schema_version: 'authrim.account_pages.v1',
      default_page_id: 'custom',
      pages: [
        {
          id: 'custom',
          name: 'Custom',
          published_version: 1,
          published_at: '2026-11-08T00:00:00.000Z',
          published: {
            schema_version: 'authrim.account_page.v1',
            resolved_at: '2026-11-08T00:00:00.000Z',
            screens: [
              {
                id: options.placementId,
                screen_key: 'custom_security',
                width: 'full',
                enabled: options.enabled ?? true,
                condition: options.condition ?? 'always',
                show_for_guests: true,
              },
            ],
            screen_snapshots: {
              custom_security: {
                screen_kind: 'account',
                screen_key: 'custom_security',
                fields: [{ block_type: options.blockType, field: 'widget', label: 'Widget' }],
                localizations: {},
              },
            },
          },
        },
      ],
    }),
  });
}

async function request(
  options: {
    tenantId?: string;
    url?: string;
    settings?: KvEntries;
    config?: KvEntries;
    failSettings?: boolean;
    env?: Partial<Env>;
  } = {}
) {
  const tenantId = options.tenantId ?? 'default';
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    await next();
  });
  app.get('/.well-known/passkey-endpoints', passkeyEndpointsHandler);
  const env = {
    ISSUER_URL: 'https://auth.example.com',
    SETTINGS: kv(options.settings ?? {}, { fail: options.failSettings }),
    AUTHRIM_CONFIG: kv(options.config ?? {}),
    ...options.env,
  } as Env;
  return app.fetch(
    new Request(options.url ?? 'https://auth.example.com/.well-known/passkey-endpoints'),
    env
  );
}

describe('passkeyEndpointsHandler', () => {
  it('publishes the account page passkeys section by default', async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Vary')).toBe('Host');
    expect(await response.json()).toEqual({
      enroll: 'https://auth.example.com/account#passkeys',
      manage: 'https://auth.example.com/account#passkeys',
    });
  });

  it('uses the tenant account page path', async () => {
    const response = await request({
      settings: {
        [selfServiceKey('default')]: JSON.stringify({
          'self-service.account_page_path': '/my-account',
        }),
      },
    });

    expect(await response.json()).toEqual({
      enroll: 'https://auth.example.com/my-account#passkeys',
      manage: 'https://auth.example.com/my-account#passkeys',
    });
  });

  it('uses the request host and that tenant settings in multi-tenant mode', async () => {
    const response = await request({
      tenantId: 'tenant1',
      url: 'https://tenant1.example.com/.well-known/passkey-endpoints',
      env: { ISSUER_URL: undefined, BASE_DOMAIN: 'example.com' },
      settings: {
        [authMethodsKey('default')]: JSON.stringify({
          'authentication-methods.passkey.login_enabled': false,
        }),
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enroll: 'https://tenant1.example.com/account#passkeys',
      manage: 'https://tenant1.example.com/account#passkeys',
    });
  });

  it('returns 404 while passkey sign-in is off', async () => {
    const response = await request({
      settings: {
        [authMethodsKey('default')]: JSON.stringify({
          'authentication-methods.passkey.login_enabled': false,
        }),
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 while the account page is off', async () => {
    const response = await request({
      settings: {
        [selfServiceKey('default')]: JSON.stringify({
          'self-service.account_page_enabled': false,
        }),
      },
    });

    expect(response.status).toBe(404);
  });

  it('points at the placement of a custom published page that shows the passkey widget', async () => {
    const response = await request({
      settings: {
        [loginUiKey('default')]: publishedPage({
          placementId: 'security-keys',
          blockType: 'account_passkey_widget',
        }),
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enroll: 'https://auth.example.com/account#security-keys',
      manage: 'https://auth.example.com/account#security-keys',
    });
  });

  it.each([
    ['without the passkey widget', { blockType: 'account_profile_widget' }],
    ['with the placement disabled', { blockType: 'account_passkey_widget', enabled: false }],
    [
      'shown only to some accounts',
      { blockType: 'account_passkey_widget', condition: 'multiple_sessions' },
    ],
  ])('returns 404 for a custom published page %s', async (_label, page) => {
    const response = await request({
      settings: { [loginUiKey('default')]: publishedPage({ placementId: 'security', ...page }) },
    });

    expect(response.status).toBe(404);
  });

  it('uses the built-in page when the login-ui document is damaged', async () => {
    const response = await request({ settings: { [loginUiKey('default')]: '{bad' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enroll: 'https://auth.example.com/account#passkeys',
    });
  });

  it('reads the self-service document from AUTHRIM_CONFIG when SETTINGS is not bound', async () => {
    const response = await request({
      env: { SETTINGS: undefined },
      config: {
        [selfServiceKey('default')]: JSON.stringify({
          'self-service.account_page_enabled': false,
        }),
      },
    });

    expect(response.status).toBe(404);
  });

  it('returns an uncached 404 when settings cannot be read', async () => {
    const response = await request({ failSettings: true });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns an uncached 404 when the authentication-methods document is damaged', async () => {
    const response = await request({
      settings: { [authMethodsKey('default')]: '{not json' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('shortens the cache lifetime in maintenance cache mode', async () => {
    const response = await request({ config: { 'v1:cache-mode:platform': 'maintenance' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=30');
  });
});

describe('passkeyLoginEnabledFromDocument', () => {
  it('is on when nothing is set', () => {
    expect(passkeyLoginEnabledFromDocument(null)).toBe(true);
    expect(passkeyLoginEnabledFromDocument('{}')).toBe(true);
  });

  it('prefers login_enabled over the older single switch', () => {
    expect(
      passkeyLoginEnabledFromDocument(
        JSON.stringify({
          'authentication-methods.passkey.enabled': false,
          'authentication-methods.passkey.login_enabled': true,
        })
      )
    ).toBe(true);
    expect(
      passkeyLoginEnabledFromDocument(
        JSON.stringify({ 'authentication-methods.passkey.enabled': 'false' })
      )
    ).toBe(false);
    expect(
      passkeyLoginEnabledFromDocument(
        JSON.stringify({ 'authentication-methods.passkey.login_enabled': ' FALSE ' })
      )
    ).toBe(false);
  });

  it('ignores the other passkey uses', () => {
    expect(
      passkeyLoginEnabledFromDocument(
        JSON.stringify({
          'authentication-methods.passkey.login_enabled': false,
          'authentication-methods.passkey.signup_enabled': true,
          'authentication-methods.passkey.reauth_enabled': true,
        })
      )
    ).toBe(false);
  });

  it('throws on a document that is not an object', () => {
    expect(() => passkeyLoginEnabledFromDocument('')).toThrow();
    expect(() => passkeyLoginEnabledFromDocument('[]')).toThrow();
    expect(() => passkeyLoginEnabledFromDocument('null')).toThrow();
  });
});

describe('accountPagePathFromDocument', () => {
  it('defaults to /account', () => {
    expect(accountPagePathFromDocument(null)).toBe('/account');
    expect(accountPagePathFromDocument('{bad')).toBe('/account');
  });

  it('falls back to /account for an invalid path, as the Router does', () => {
    expect(
      accountPagePathFromDocument(
        JSON.stringify({ 'self-service.account_page_path': '//evil.example' })
      )
    ).toBe('/account');
    expect(
      accountPagePathFromDocument(
        JSON.stringify({ 'self-service.account_page_path': '/authorize' })
      )
    ).toBe('/account');
  });

  it('is null while the account page is off', () => {
    expect(
      accountPagePathFromDocument(JSON.stringify({ 'self-service.account_page_enabled': false }))
    ).toBeNull();
  });
});
