/**
 * POST /device_authorization: the scope. What is requested must be well formed and within what the
 * client may request (the same rule as /authorize); with none requested the code gets the OpenID
 * Connect default, narrowed to what the client may request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceClients, harness, registerClient } from './device-authorization-harness';

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  const shared = globalThis as unknown as {
    __deviceClients: Map<string, Record<string, unknown>>;
    __deviceLogger: unknown;
  };
  return {
    ...actual,
    getClientCached: async (_c: unknown, _env: unknown, id: string) =>
      shared.__deviceClients.get(id) ?? null,
    getLogger: () => shared.__deviceLogger,
  };
});

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function issue(scope: string | undefined, client: Record<string, unknown> = {}) {
  await registerClient('tv', {
    token_endpoint_auth_method: 'none',
    grant_types: [DEVICE_GRANT],
    ...client,
  });
  const h = harness();
  const form: Record<string, string> = { client_id: 'tv' };
  if (scope !== undefined) form.scope = scope;
  const { response, body } = await h.post(form);
  return { response, body, stored: h.stored };
}

beforeEach(() => deviceClients.clear());

describe('with no scope sent', () => {
  it.each([
    ['nothing at all', undefined],
    ['an empty scope', ''],
    ['a blank scope', '  \t '],
  ])('%s gets the default, as before', async (_label, scope) => {
    const { response, stored } = await issue(scope);
    expect(response.status).toBe(200);
    expect(stored[0].scope).toBe('openid profile email');
  });

  it('gets the default narrowed to what a client registered with a narrower scope may request', async () => {
    const { response, stored } = await issue(undefined, { scope: 'openid profile' });
    expect(response.status).toBe(200);
    expect(stored[0].scope).toBe('openid profile');
  });

  it('gets the default narrowed to the allowed_scopes it holds', async () => {
    const { stored } = await issue(undefined, { allowed_scopes: ['email', 'openid', 'read'] });
    expect(stored[0].scope).toBe('openid email');
  });

  it('is refused (invalid_scope) when the client may request none of the default', async () => {
    const { response, body, stored } = await issue(undefined, { scope: 'read write' });
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_scope');
    expect(stored).toHaveLength(0);
  });
});

describe('with a scope sent', () => {
  it('is issued for scopes within what the client may request', async () => {
    const { response, stored } = await issue('openid email');
    expect(response.status).toBe(200);
    expect(stored[0].scope).toBe('openid email');
  });

  it('does not need openid: a device that only wants an API scope can ask for it', async () => {
    const { response, stored } = await issue('read', { allowed_scopes: ['read', 'write'] });
    expect(response.status).toBe(200);
    expect(stored[0].scope).toBe('read');
  });

  it('is stored once per scope, single-spaced, in the order sent', async () => {
    const { stored } = await issue('profile  openid\tprofile\nopenid email');
    expect(stored[0].scope).toBe('profile openid email');
  });

  it.each([
    ['a scope the client may not request', 'openid offline_access', undefined],
    ['a scope the client registered without', 'openid email', { scope: 'openid profile' }],
    ['a scope outside allowed_scopes', 'openid admin', { allowed_scopes: ['openid', 'read'] }],
    [
      'a scope outside requestable_scopes, which takes precedence',
      'openid read',
      {
        requestable_scopes: ['openid'],
        allowed_scopes: ['openid', 'read'],
      },
    ],
    ['a scope the server does not know', 'openid made-up-scope', undefined],
  ])('is refused (invalid_scope) for %s', async (_label, scope, client) => {
    const { response, body, stored } = await issue(scope, client);
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_scope', error_description: expect.any(String) });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(stored).toHaveLength(0);
  });

  it.each([
    ['an AI scope', 'ai:read'],
    ['a reserved namespace', 'authrim:admin'],
    ['a control character', 'openid\u0000'],
    ['a quote', 'openid "x"'],
    ['a scope over 256 characters', 'a'.repeat(257)],
  ])('is refused (invalid_scope) for %s, even when the client lists it', async (_label, scope) => {
    const { response, body, stored } = await issue(scope, {
      allowed_scopes: ['openid', scope.trim()],
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_scope');
    expect(stored).toHaveLength(0);
  });

  it('is refused (invalid_request) over 2048 characters', async () => {
    const scopes = Array.from({ length: 300 }, (_, i) => `scope-${i}`).join(' ');
    const { response, body, stored } = await issue(scopes);
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(stored).toHaveLength(0);
  });

  it('does not echo the scope, the allowed scopes or a setting name back', async () => {
    const { body } = await issue('openid secret-internal-scope', {
      allowed_scopes: ['openid', 'registered-only-scope'],
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('secret-internal-scope');
    expect(text).not.toContain('registered-only-scope');
    expect(text).not.toMatch(/authrim:|system:|internal:/u);
  });
});
