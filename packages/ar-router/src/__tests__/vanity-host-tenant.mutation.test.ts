/**
 * Mutation-driven tests: tenant resolution for custom (vanity) domains through TENANT_HOST.
 * The account page is the observable: it is served only for a resolved tenant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../index';
import {
  createMockEnv,
  createMockFetcher,
  createMockKV,
  isolateGlobalCaches,
  type MockEnv,
} from './helpers/router-env';

let env: MockEnv;
let restore: () => void;
let seq = 0;
const host = (label = 'h') => `id.${label}${++seq}.test`;

beforeEach(() => {
  restore = isolateGlobalCaches();
  env = createMockEnv();
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const resolver = (answer: unknown = { tenantId: 'vanity-t' }) => ({
  resolveTenantForHost: vi.fn(async (_h: string) => answer as { tenantId: string | null }),
});

const envFor = (tenantHost: ReturnType<typeof resolver> | undefined, extra = {}) => ({
  ...env,
  BASE_DOMAIN: 'example.com',
  DEFAULT_TENANT_ID: `van-default-${++seq}`,
  SETTINGS: createMockKV(),
  ENABLE_LOGIN_UI_PROXY: 'true',
  AR_LOGIN_UI_URL: 'https://ui.example.workers.dev',
  LOGIN_UI_WORKER: createMockFetcher('LOGIN_UI_WORKER'),
  ...(tenantHost ? { TENANT_HOST: tenantHost } : {}),
  ...extra,
});

const account = (e: Record<string, unknown>, h: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://${h}/account`, init), e);

describe('host normalisation for the lookup', () => {
  it('asks with a lowercase hostname and no port (Host header)', async () => {
    const t = resolver();
    const h = host('Port');
    const res = await account(envFor(t), `${h}`, { headers: { Host: `${h.toUpperCase()}:8443` } });
    expect(res.status).toBe(200);
    expect(t.resolveTenantForHost).toHaveBeenCalledWith(h.toLowerCase());
  });

  it('falls back to the URL host (without port) when no Host header is present', async () => {
    const t = resolver();
    const h = host('Url');
    await account(envFor(t), `${h}:8443`);
    expect(t.resolveTenantForHost).toHaveBeenCalledWith(h.toLowerCase());
  });
});

describe('hosts that never consult TENANT_HOST', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['the base domain itself', 'example.com', {}],
    ['a tenant subdomain', 'acme.example.com', {}],
    ['a deployment without BASE_DOMAIN', 'id.nobase.test', { BASE_DOMAIN: undefined }],
    [
      'the configured Login UI host',
      'login.custom.test',
      { LOGIN_UI_URL: 'https://login.custom.test' },
    ],
    [
      'the configured Admin UI host',
      'admin.custom.test',
      { ADMIN_UI_URL: 'https://admin.custom.test' },
    ],
  ];

  it.each(cases)('%s', async (_label, h, extra) => {
    const t = resolver();
    const res = await account(envFor(t, extra), h, { headers: { Host: h } });
    expect(t.resolveTenantForHost).not.toHaveBeenCalled();
    // The default tenant keeps the account page on.
    expect(res.status).toBe(200);
  });

  it('keeps the default tenant when TENANT_HOST is not bound', async () => {
    const res = await account(envFor(undefined), host('nobind'));
    expect(res.status).toBe(200);
  });

  it('consults TENANT_HOST for a host that merely ends with the base domain text', async () => {
    const t = resolver();
    await account(envFor(t), 'evilexample.com', { headers: { Host: 'evilexample.com' } });
    expect(t.resolveTenantForHost).toHaveBeenCalledWith('evilexample.com');
  });
});

describe('per-tenant settings', () => {
  it('answers differently for each resolved tenant', async () => {
    const owners: Record<string, string> = {
      'id.tenant-a.test': 'tenant-a',
      'id.tenant-b.test': 'tenant-b',
    };
    const tenantHost = {
      resolveTenantForHost: vi.fn(async (h: string) => ({ tenantId: owners[h] ?? null })),
    };
    const e = envFor(tenantHost, {
      SETTINGS: createMockKV({
        'settings:tenant:tenant-a:self-service': JSON.stringify({
          'self-service.account_page_enabled': true,
          'self-service.account_page_path': '/acct-a',
        }),
        'settings:tenant:tenant-b:self-service': JSON.stringify({
          'self-service.account_page_enabled': false,
        }),
      }),
    });
    const at = (h: string, path: string) => app.fetch(new Request(`https://${h}${path}`), e);
    expect((await at('id.tenant-a.test', '/acct-a')).status).toBe(200);
    expect((await at('id.tenant-a.test', '/account')).status).toBe(404);
    expect((await at('id.tenant-b.test', '/acct-a')).status).toBe(404);
    expect((await at('id.tenant-b.test', '/account')).status).toBe(404);
    expect((await at('id.unowned.test', '/account')).status).toBe(404);
  });
});

describe('answers and caching', () => {
  it('serves no account page for a domain no tenant owns', async () => {
    const t = resolver({ tenantId: null });
    const res = await account(envFor(t), host('none'));
    expect(res.status).toBe(404);
  });

  it.each([
    ['an invalid identifier', { tenantId: 'bad id!' }],
    ['a non-string identifier', { tenantId: 42 }],
    ['an empty answer', null],
  ])('treats %s as unowned', async (_label, answer) => {
    const res = await account(envFor(resolver(answer)), host('inv'));
    expect(res.status).toBe(404);
  });

  it('does not cache a failed lookup and asks once per request', async () => {
    const t = {
      resolveTenantForHost: vi.fn(async () => {
        throw new Error('discovery down');
      }),
    };
    const e = envFor(t);
    const h = host('fail');
    expect((await account(e, h)).status).toBe(404);
    // Settings, CSP and routing all need the tenant, but the lookup runs once per request.
    expect(t.resolveTenantForHost).toHaveBeenCalledTimes(1);
    await account(e, h);
    expect(t.resolveTenantForHost).toHaveBeenCalledTimes(2);
  });

  it('caches an owned domain for exactly sixty seconds', async () => {
    const t = resolver();
    const e = envFor(t);
    const h = host('own');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(20_000_000);
    await account(e, h);
    now.mockReturnValue(20_059_999);
    await account(e, h);
    expect(t.resolveTenantForHost).toHaveBeenCalledTimes(1);
    now.mockReturnValue(20_060_000);
    await account(e, h);
    expect(t.resolveTenantForHost).toHaveBeenCalledTimes(2);
  });

  it('caches an unowned domain for exactly thirty seconds', async () => {
    const t = resolver({ tenantId: null });
    const e = envFor(t);
    const h = host('unown');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(30_000_000);
    await account(e, h);
    now.mockReturnValue(30_029_999);
    await account(e, h);
    expect(t.resolveTenantForHost).toHaveBeenCalledTimes(1);
    now.mockReturnValue(30_030_000);
    await account(e, h);
    expect(t.resolveTenantForHost).toHaveBeenCalledTimes(2);
  });
});
