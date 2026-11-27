/**
 * Mutation-driven tests: HTTPS redirect, loopback handling, service-binding request
 * construction, trust-header stripping and the private Login UI entrypoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app, { LoginUiBackendEntrypoint } from '../index';
import worker from '../index';
import { createMockEnv, isolateGlobalCaches, type MockEnv } from './helpers/router-env';

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

let env: MockEnv;
let restore: () => void;
beforeEach(() => {
  restore = isolateGlobalCaches();
  env = createMockEnv();
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe('HTTPS redirect', () => {
  it('redirects with 308 and keeps path and query', async () => {
    const res = await app.fetch(new Request('http://id.example.com/a/b?x=1&y=2'), env);
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('https://id.example.com/a/b?x=1&y=2');
  });

  it('redirects an https URL that was forwarded as http', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/api/health', {
        headers: { 'x-forwarded-proto': 'http' },
      }),
      env
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('https://id.example.com/api/health');
  });

  it('matches x-forwarded-proto case-insensitively', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/api/health', {
        headers: { 'x-forwarded-proto': 'HTTP' },
      }),
      env
    );
    expect(res.status).toBe(308);
  });

  it('does not redirect when forwarded as https', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/api/health', {
        headers: { 'x-forwarded-proto': 'https' },
      }),
      env
    );
    expect(res.status).toBe(200);
  });

  it.each([
    'http://localhost/api/health',
    'http://127.0.0.1/api/health',
    'http://[::1]/api/health',
  ])('serves loopback HTTP %s without redirecting', async (url) => {
    const res = await app.fetch(new Request(url), env);
    expect(res.status).toBe(200);
  });

  it('does not treat loopback look-alikes as loopback', async () => {
    for (const host of ['localhost.evil.test', 'xlocalhost', '127.0.0.2']) {
      const res = await app.fetch(new Request(`http://${host}/api/health`), env);
      expect(res.status).toBe(308);
    }
  });

  it('redirects a loopback host forwarded as http only when it is not loopback', async () => {
    const res = await app.fetch(
      new Request('https://localhost/api/health', { headers: { 'x-forwarded-proto': 'http' } }),
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('service binding request construction', () => {
  it('overwrites spoofed host headers with the public host (including port)', async () => {
    await app.fetch(
      new Request('https://id.example.com:8443/introspect', {
        method: 'POST',
        headers: {
          Host: 'evil.test',
          'X-Forwarded-Host': 'evil.test',
          'X-Authrim-Forwarded-Host': 'evil.test',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      env
    );
    const forwarded = env.OP_MANAGEMENT.fetch.mock.calls[0][0];
    expect(forwarded.headers.get('Host')).toBe('id.example.com:8443');
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe('id.example.com:8443');
    expect(forwarded.headers.get('X-Authrim-Forwarded-Host')).toBe('id.example.com:8443');
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe('{}');
  });

  it('forwards the exact URL including the query string', async () => {
    await app.fetch(new Request('https://id.example.com/api/user/consents?a=1&b=%20x'), env);
    const forwarded = env.OP_MANAGEMENT.fetch.mock.calls[0][0];
    expect(forwarded.url).toBe('https://id.example.com/api/user/consents?a=1&b=%20x');
  });
});

describe('public entrypoint strips Login UI trust headers', () => {
  it('never passes internal Login UI headers to a backend', async () => {
    const res = await worker.fetch(
      new Request('https://id.example.com/introspect', {
        method: 'POST',
        headers: {
          'X-Authrim-Ui-Proxy': 'login-ui',
          'X-Authrim-Original-Host': 'id.example.com',
          'X-Authrim-Forwarded-Host': 'id.example.com',
          'X-Authrim-Browser-Origin': 'https://evil.test',
          'X-Authrim-Shared-Login-Host': 'true',
          'X-Keep': 'yes',
        },
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const forwarded = env.OP_MANAGEMENT.fetch.mock.calls[0][0];
    expect(forwarded.headers.get('X-Authrim-Ui-Proxy')).toBeNull();
    expect(forwarded.headers.get('X-Authrim-Original-Host')).toBeNull();
    expect(forwarded.headers.get('X-Authrim-Browser-Origin')).toBeNull();
    expect(forwarded.headers.get('X-Authrim-Shared-Login-Host')).toBeNull();
    expect(forwarded.headers.get('X-Keep')).toBe('yes');
    // The router itself re-adds the forwarded-host hint from the real URL.
    expect(forwarded.headers.get('X-Authrim-Forwarded-Host')).toBe('id.example.com');
  });

  it('does not let a visitor claim to be the Login UI to read tenant status', async () => {
    const res = await worker.fetch(
      new Request('https://id.example.com/api/auth/tenant-status', {
        headers: { 'X-Authrim-Ui-Proxy': 'login-ui' },
      }),
      env,
      ctx
    );
    expect(await res.json()).toMatchObject({ worker: 'OP_MANAGEMENT' });
    expect(env.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
  });

  it('relayed Login UI tenant-status calls are never answered', async () => {
    const entry = new LoginUiBackendEntrypoint(ctx, env as never);
    const res = await entry.fetch(
      new Request('https://id.example.com/api/auth/tenant-status', {
        headers: {
          'X-Authrim-Ui-Proxy': 'login-ui',
          'X-Authrim-Forwarded-Host': 'id.example.com',
          'X-Authrim-Original-Host': 'id.example.com',
        },
      })
    );
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
  });
});

describe('LoginUiBackendEntrypoint trust validation', () => {
  const call = (headers: Record<string, string>, url = 'https://id.example.com/api/health') =>
    new LoginUiBackendEntrypoint(ctx, env as never).fetch(new Request(url, { headers }));
  const trusted = {
    'X-Authrim-Ui-Proxy': 'login-ui',
    'X-Authrim-Forwarded-Host': 'id.example.com',
    'X-Authrim-Original-Host': 'id.example.com',
  };

  it('accepts a consistent request', async () => {
    expect((await call(trusted)).status).toBe(200);
  });

  it('refuses without the proxy marker or with another marker value', async () => {
    const { 'X-Authrim-Ui-Proxy': _drop, ...noMarker } = trusted;
    for (const headers of [noMarker, { ...trusted, 'X-Authrim-Ui-Proxy': 'admin-ui' }]) {
      const res = await call(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'access_denied' });
    }
  });

  it('refuses when only the forwarded host disagrees', async () => {
    expect((await call({ ...trusted, 'X-Authrim-Forwarded-Host': 'evil.test' })).status).toBe(403);
  });

  it('refuses when only the original host disagrees', async () => {
    expect((await call({ ...trusted, 'X-Authrim-Original-Host': 'evil.test' })).status).toBe(403);
  });

  it('refuses when a host hint is missing or blank', async () => {
    const { 'X-Authrim-Forwarded-Host': _f, ...noForwarded } = trusted;
    const { 'X-Authrim-Original-Host': _o, ...noOriginal } = trusted;
    expect((await call(noForwarded)).status).toBe(403);
    expect((await call(noOriginal)).status).toBe(403);
    expect((await call({ ...trusted, 'X-Authrim-Original-Host': '  ' })).status).toBe(403);
  });

  it('uses only the first value of a comma separated hint and trims it', async () => {
    const res = await call({
      ...trusted,
      'X-Authrim-Forwarded-Host': ' id.example.com , evil.test',
    });
    expect(res.status).toBe(200);
    expect(
      (
        await call({
          ...trusted,
          'X-Authrim-Forwarded-Host': 'evil.test, id.example.com',
        })
      ).status
    ).toBe(403);
  });

  it('refuses an unparseable host hint', async () => {
    expect((await call({ ...trusted, 'X-Authrim-Forwarded-Host': 'bad host' })).status).toBe(403);
  });

  it('normalises every host header to the request host before routing', async () => {
    await call(
      { ...trusted, Host: 'evil.test', 'X-Forwarded-Host': 'evil.test' },
      'https://id.example.com/api/user/consents'
    );
    const forwarded = env.OP_MANAGEMENT.fetch.mock.calls[0][0];
    expect(forwarded.headers.get('Host')).toBe('id.example.com');
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe('id.example.com');
    expect(forwarded.headers.get('X-Authrim-Forwarded-Host')).toBe('id.example.com');
    expect(forwarded.headers.get('X-Authrim-Original-Host')).toBe('id.example.com');
  });
});
