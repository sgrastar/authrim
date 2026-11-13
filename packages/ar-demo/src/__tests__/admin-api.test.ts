/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- decoded JWT claims in assertions */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminApiError,
  buildJoinLink,
  createInvitation,
  createTenant,
  getProvisioningStatus,
  REQUIRED_SCOPES,
  resetAdminTokenCache,
} from '../admin-api';
import {
  API,
  configOf,
  createTestDb,
  createUpstream,
  generateKey,
  json,
  K,
  makeEnv,
  SCOPES,
  type Upstream,
} from './helpers';
import type { Config } from '../config';

let upstream: Upstream;
let config: Config;
let publicKey: CryptoKey;

function b64urlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

beforeEach(async () => {
  upstream = createUpstream();
  resetAdminTokenCache();
  const pair = await generateKey();
  publicKey = pair.publicKey;
  config = configOf(
    await makeEnv(createTestDb(), { MACHINE_PRIVATE_JWK: JSON.stringify(pair.privateJwk) })
  );
});

async function rejection(promise: Promise<unknown>): Promise<AdminApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdminApiError);
    return error as AdminApiError;
  }
  throw new Error('expected a rejection');
}

describe('token minting', () => {
  it('posts a private_key_jwt client-credentials request for the Admin API audience', async () => {
    await createTenant(config, upstream.deps, 'demo-abcde23456');
    const call = upstream.calls.find((c) => c.url === `${API}/token`);
    expect(call?.method).toBe('POST');
    expect(call?.redirect).toBe('manual');
    expect(call?.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(call?.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    );
    expect(form.get('audience')).toBe('authrim:admin-api');
    expect(form.get('scope')).toBe(SCOPES);
    expect(form.get('scope')?.split(' ')).toEqual([...REQUIRED_SCOPES]);
  });

  it('signs a valid ES256 assertion with the specified claims', async () => {
    await createTenant(config, upstream.deps, 'demo-abcde23456');
    const call = upstream.calls.find((c) => c.url === `${API}/token`);
    const assertion = new URLSearchParams(call?.body).get('client_assertion') as string;
    const [h, p, s] = assertion.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(header).toEqual({ alg: 'ES256', kid: 'machine-key-1', typ: 'JWT' });
    expect(payload.iss).toBe('machine-client-1');
    expect(payload.sub).toBe('machine-client-1');
    expect(payload.aud).toBe(`${API}/token`);
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti.length).toBeGreaterThanOrEqual(16);
    expect(payload.iat).toBe(Math.floor(upstream.clock.now / 1000));
    expect(payload.exp - payload.iat).toBe(120);
    const signature = b64urlToBytes(s);
    expect(signature).toHaveLength(64);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      new TextEncoder().encode(`${h}.${p}`)
    );
    expect(ok).toBe(true);
  });

  it('uses a fresh jti for every assertion', async () => {
    await createTenant(config, upstream.deps, 'demo-aaaaaaaaaa');
    upstream.clock.now += 20 * 60 * 1000;
    await createTenant(config, upstream.deps, 'demo-bbbbbbbbbb');
    const jtis = upstream.calls
      .filter((c) => c.url === `${API}/token`)
      .map(
        (c) =>
          JSON.parse(
            new TextDecoder().decode(
              b64urlToBytes(
                (new URLSearchParams(c.body).get('client_assertion') as string).split('.')[1]
              )
            )
          ).jti
      );
    expect(new Set(jtis).size).toBe(2);
  });

  it('caches the token until 60 seconds before expiry', async () => {
    await createTenant(config, upstream.deps, 'demo-aaaaaaaaaa');
    upstream.clock.now += 839 * 1000; // expires_in 900: valid until 840 s
    await createTenant(config, upstream.deps, 'demo-bbbbbbbbbb');
    expect(upstream.count(K.token)).toBe(1);
    upstream.clock.now += 2 * 1000;
    await createTenant(config, upstream.deps, 'demo-cccccccccc');
    expect(upstream.count(K.token)).toBe(2);
    const bearers = upstream.calls
      .filter((c) => c.url.endsWith('/tenants'))
      .map((c) => c.headers.authorization);
    expect(bearers).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
  });

  it('mints once for concurrent callers', async () => {
    await Promise.all([
      createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'),
      createTenant(config, upstream.deps, 'demo-bbbbbbbbbb'),
    ]);
    expect(upstream.count(K.token)).toBe(1);
  });

  it('fails closed as a configuration error when a required scope is missing', async () => {
    upstream.on(K.token, () =>
      json({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 900,
        scope: REQUIRED_SCOPES.slice(0, -1).join(' '),
      })
    );
    const error = await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'));
    expect(error.kind).toBe('config');
    expect(upstream.count(K.create)).toBe(0);
  });

  it('does not cache a token that was refused for its scope', async () => {
    upstream.on(K.token, () =>
      json({ access_token: 't', token_type: 'Bearer', expires_in: 900, scope: 'x' })
    );
    await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'));
    await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'));
    expect(upstream.count(K.token)).toBe(2);
  });

  it('rejects a DPoP token type and malformed token answers', async () => {
    for (const body of [
      { access_token: 't', token_type: 'DPoP', expires_in: 900, scope: SCOPES },
      { token_type: 'Bearer', expires_in: 900, scope: SCOPES },
      { access_token: 't', token_type: 'Bearer', expires_in: '900', scope: SCOPES },
    ]) {
      resetAdminTokenCache();
      upstream.on(K.token, () => json(body));
      expect((await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'))).kind).toBe(
        'invalid_response'
      );
    }
  });

  it('treats a token endpoint failure as an upstream error with only the status and code', async () => {
    upstream.on(K.token, () =>
      json({ error: 'invalid_client', error_description: 'secret words' }, 401)
    );
    const error = await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'));
    expect(error).toMatchObject({ kind: 'upstream', status: 401, code: 'invalid_client' });
    expect(JSON.stringify(error)).not.toContain('secret words');
  });

  it('treats a redirect from the token endpoint as a failure', async () => {
    upstream.on(
      K.token,
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })
    );
    expect((await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'))).kind).toBe(
      'redirect'
    );
  });
});

describe('Admin API calls', () => {
  it('sends the bearer token to the same origin with manual redirects', async () => {
    await getProvisioningStatus(config, upstream.deps, 'demo-abcde23456');
    const call = upstream.calls.find((c) => c.url.includes('/provisioning'));
    expect(call?.url).toBe(`${API}/api/admin/tenants/demo-abcde23456/provisioning`);
    expect(call?.headers.authorization).toBe('Bearer token-1');
    expect(call?.redirect).toBe('manual');
  });

  it.each([301, 302, 303, 307, 308])('treats a %i as a failure on every call', async (status) => {
    const redirect = () =>
      new Response(null, { status, headers: { Location: 'https://evil.example/' } });
    upstream.on(K.create, redirect);
    upstream.on(K.provisioning, redirect);
    upstream.on(K.invite, redirect);
    expect((await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'))).kind).toBe(
      'redirect'
    );
    expect(
      (await rejection(getProvisioningStatus(config, upstream.deps, 'demo-aaaaaaaaaa'))).kind
    ).toBe('redirect');
    expect((await rejection(createInvitation(config, upstream.deps, 'demo-aaaaaaaaaa'))).kind).toBe(
      'redirect'
    );
  });

  it('expects 202 for create and 201 for the invitation', async () => {
    upstream.on(K.create, () => json({}, 200));
    expect((await rejection(createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'))).status).toBe(
      200
    );
    upstream.on(K.invite, () => json({ code: 'c' }, 200));
    expect(
      (await rejection(createInvitation(config, upstream.deps, 'demo-aaaaaaaaaa'))).status
    ).toBe(200);
  });

  it('times out after 10 seconds', async () => {
    await createTenant(config, upstream.deps, 'demo-aaaaaaaaaa'); // warms the token cache
    const original = upstream.deps.fetch;
    upstream.deps.fetch = (input, init) =>
      input.includes('/provisioning')
        ? new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
        : original(input, init);
    vi.useFakeTimers();
    try {
      const pending = rejection(getProvisioningStatus(config, upstream.deps, 'demo-aaaaaaaaaa'));
      await vi.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await pending).kind).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown provisioning status', async () => {
    upstream.on(K.provisioning, () => json({ status: 'exploded' }));
    expect(
      (await rejection(getProvisioningStatus(config, upstream.deps, 'demo-aaaaaaaaaa'))).kind
    ).toBe('invalid_response');
  });
});

describe('buildJoinLink', () => {
  const link = (joinUrl: string | null) =>
    buildJoinLink(config, { code: 'c o', email: 'e@demo.invalid', joinUrl });
  it('rebuilds the link from the configured origin', () => {
    expect(link('https://console.demo-test.example/admin/join')).toBe(
      'https://console.demo-test.example/admin/join#code=c%20o&email=e%40demo.invalid'
    );
  });
  it('refuses another origin, path, a null link or extra parts', () => {
    expect(link(null)).toBeNull();
    expect(link('https://evil.example/admin/join')).toBeNull();
    expect(link('https://console.demo-test.example/admin/join/')).toBeNull();
    expect(link('http://console.demo-test.example/admin/join')).toBeNull();
    expect(link('https://console.demo-test.example/admin/join?x=1')).toBeNull();
  });
});
