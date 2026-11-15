import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenant, resetAdminTokenCache } from '../admin-api';
import { verifyTurnstile } from '../turnstile';
import { createDeps, type Env, type ServiceBinding } from '../types';
import { API, configOf, createTestDb, makeEnv, PORTAL } from './helpers';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

async function seen(request: Request): Promise<Seen> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    url: request.url,
    method: request.method,
    headers,
    body: await request.text(),
    redirect: request.redirect,
  };
}

let globalCalls: Seen[];
let bindingCalls: Seen[];
let binding: ServiceBinding;
let env: Env;

function respond(url: string, body: string): Response {
  const path = new URL(url).pathname;
  if (path === '/token') {
    const scope = new URLSearchParams(body).get('scope') ?? '';
    return Response.json({ access_token: 't1', token_type: 'Bearer', expires_in: 900, scope });
  }
  return Response.json({ id: 'x' }, { status: 202 });
}

beforeEach(async () => {
  resetAdminTokenCache();
  globalCalls = [];
  bindingCalls = [];
  vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const call = await seen(request);
    globalCalls.push(call);
    return respond(call.url, call.body);
  });
  binding = {
    fetch: async (request) => {
      const call = await seen(request);
      bindingCalls.push(call);
      return respond(call.url, call.body);
    },
  };
  env = await makeEnv(createTestDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AUTHRIM_API service binding', () => {
  it('sends token and Admin API requests through the binding, not the global fetch', async () => {
    const config = configOf(env);
    await createTenant(config, createDeps({ ...env, AUTHRIM_API: binding }), 'demo-aaaaaaaaaa');
    expect(globalCalls).toHaveLength(0);
    expect(bindingCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/token`,
      `POST ${API}/api/admin/tenants`,
    ]);
    expect(bindingCalls[0].redirect).toBe('manual');
  });

  it('sends the same requests with and without the binding', async () => {
    const config = configOf(env);
    await createTenant(config, createDeps({ ...env, AUTHRIM_API: binding }), 'demo-aaaaaaaaaa');
    resetAdminTokenCache();
    await createTenant(config, createDeps(env), 'demo-aaaaaaaaaa');
    expect(bindingCalls).toHaveLength(2);
    expect(globalCalls).toHaveLength(2);
    for (let i = 0; i < 2; i += 1) {
      const a = bindingCalls[i];
      const b = globalCalls[i];
      expect(a.url).toBe(b.url);
      expect(a.method).toBe(b.method);
      expect(a.redirect).toBe(b.redirect);
      if (i === 1) {
        expect(a.body).toBe(b.body);
        expect(a.headers['content-type']).toBe(b.headers['content-type']);
      } else {
        // The client assertion is signed per call; compare everything else.
        const left = new URLSearchParams(a.body);
        const right = new URLSearchParams(b.body);
        left.delete('client_assertion');
        right.delete('client_assertion');
        expect(left.toString()).toBe(right.toString());
        expect(a.headers['content-type']).toBe(b.headers['content-type']);
      }
    }
  });

  it('uses the global fetch when the binding is absent', async () => {
    const config = configOf(env);
    await createTenant(config, createDeps(env), 'demo-aaaaaaaaaa');
    expect(bindingCalls).toHaveLength(0);
    expect(globalCalls.map((c) => c.url)).toEqual([`${API}/token`, `${API}/api/admin/tenants`]);
  });

  it('never sends Turnstile through the binding', async () => {
    globalThis.fetch = async () =>
      Response.json({ success: true, hostname: new URL(PORTAL).hostname });
    const deps = createDeps({ ...env, AUTHRIM_API: binding });
    const ok = await verifyTurnstile(deps, {
      secret: 's',
      token: 'tok',
      remoteIp: null,
      portalHost: new URL(PORTAL).hostname,
    });
    expect(ok).toBe(true);
    expect(bindingCalls).toHaveLength(0);
  });

  it('refuses a URL of another origin on the binding', async () => {
    const deps = createDeps({ ...env, AUTHRIM_API: binding });
    for (const url of [
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      'https://other.demo-test.example/token',
      `${API.replace('https://', 'http://')}/token`,
      `${API}.evil.example/token`,
      'not a url',
    ]) {
      await expect(deps.authrimFetch(url, { method: 'POST' })).rejects.toThrow();
    }
    expect(bindingCalls).toHaveLength(0);
    expect(globalCalls).toHaveLength(0);
  });

  it('refuses everything on the binding when ADMIN_API_ORIGIN is not set', async () => {
    const deps = createDeps({ ...env, ADMIN_API_ORIGIN: undefined, AUTHRIM_API: binding });
    await expect(deps.authrimFetch(`${API}/token`, { method: 'POST' })).rejects.toThrow();
    expect(bindingCalls).toHaveLength(0);
  });
});
