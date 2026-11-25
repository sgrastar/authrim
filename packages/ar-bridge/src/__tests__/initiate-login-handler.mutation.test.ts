import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ getProviderByIdOrSlug: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-1',
}));
vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mocks.getProviderByIdOrSlug,
}));

import {
  buildExternalStartUrl,
  handleThirdPartyInitiatedLogin,
  validateThirdPartyInitiatedIssuer,
} from '../handlers/initiate-login';

const ENV = { ISSUER_URL: 'https://rp.example' } as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/auth/external/:provider/initiate', handleThirdPartyInitiatedLogin);
  instance.post('/auth/external/:provider/initiate', handleThirdPartyInitiatedLogin);
  instance.get('/noprovider', handleThirdPartyInitiatedLogin);
  return instance;
}

const BASE = {
  iss: 'https://op.example',
  client_id: 'downstream',
  code_challenge: 'chal',
  code_challenge_method: 'S256',
};
function query(extra: Record<string, string> = {}, base: Record<string, string> = BASE) {
  return new URLSearchParams({ ...base, ...extra }).toString();
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

describe('validateThirdPartyInitiatedIssuer', () => {
  const OK = 'https://op.example';
  it('requires iss', () => {
    expect(validateThirdPartyInitiatedIssuer(undefined, OK)).toBe('iss is required');
    expect(validateThirdPartyInitiatedIssuer('', OK)).toBe('iss is required');
  });
  it('requires a parseable URL', () => {
    expect(validateThirdPartyInitiatedIssuer('not a url', OK)).toBe('iss must be a valid URL');
  });
  it('requires https', () => {
    expect(validateThirdPartyInitiatedIssuer('http://op.example', OK)).toBe('iss must use https');
  });
  it.each([
    'https://user@op.example',
    'https://user:pw@op.example',
    'https://:pw@op.example',
    'https://op.example#frag',
  ])('rejects userinfo or fragment: %s', (iss) => {
    expect(validateThirdPartyInitiatedIssuer(iss, iss)).toBe(
      'iss must be an issuer URL without userinfo or fragment'
    );
  });
  it('requires a configured issuer and an exact match', () => {
    const message = 'iss does not match the configured provider issuer';
    expect(validateThirdPartyInitiatedIssuer(OK, undefined)).toBe(message);
    expect(validateThirdPartyInitiatedIssuer(OK, '')).toBe(message);
    expect(validateThirdPartyInitiatedIssuer(OK, 'https://op.example/')).toBe(message);
    expect(validateThirdPartyInitiatedIssuer(OK, 'https://other.example')).toBe(message);
    expect(validateThirdPartyInitiatedIssuer(OK, OK)).toBeUndefined();
  });
});

describe('buildExternalStartUrl', () => {
  it('forwards each allowed parameter and nothing else', () => {
    const names = [
      'client_id',
      'redirect_uri',
      'state',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'prompt',
      'max_age',
      'acr_values',
    ];
    const parameters = new URLSearchParams();
    for (const name of names) parameters.set(name, `v-${name}`);
    parameters.set('iss', 'https://op.example');
    parameters.set('extra', 'x');
    const url = buildExternalStartUrl('https://rp.example', 'google', { parameters });
    expect(url.origin + url.pathname).toBe('https://rp.example/auth/external/google/start');
    expect([...url.searchParams.keys()].sort()).toEqual([...names].sort());
    for (const name of names) expect(url.searchParams.get(name)).toBe(`v-${name}`);
  });

  it('forwards empty values and omits absent ones', () => {
    const url = buildExternalStartUrl('https://rp.example', 'p', {
      parameters: new URLSearchParams('state='),
    });
    expect(url.searchParams.get('state')).toBe('');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('lets target_link_uri override redirect_uri and adds login_hint', () => {
    const url = buildExternalStartUrl('https://rp.example', 'p', {
      parameters: new URLSearchParams('redirect_uri=https%3A%2F%2Fa.example'),
      targetLinkUri: 'https://b.example/t',
      loginHint: 'alice',
    });
    expect(url.searchParams.get('redirect_uri')).toBe('https://b.example/t');
    expect(url.searchParams.get('login_hint')).toBe('alice');
  });

  it('keeps redirect_uri and omits login_hint when not supplied', () => {
    const url = buildExternalStartUrl('https://rp.example', 'p', {
      parameters: new URLSearchParams('redirect_uri=https%3A%2F%2Fa.example'),
    });
    expect(url.searchParams.get('redirect_uri')).toBe('https://a.example');
    expect(url.searchParams.has('login_hint')).toBe(false);
  });

  it('encodes the provider identifier into one path segment', () => {
    const url = buildExternalStartUrl('https://rp.example', 'a/b c', {
      parameters: new URLSearchParams(),
    });
    expect(url.pathname).toBe('/auth/external/a%2Fb%20c/start');
  });
});

describe('handleThirdPartyInitiatedLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderByIdOrSlug.mockResolvedValue({
      id: 'prov-id',
      slug: 'prov-slug',
      enabled: true,
      issuer: 'https://op.example',
    });
  });

  const get = (qs: string, path = '/auth/external/prov/initiate') =>
    app().request(`https://rp.example${path}?${qs}`, {}, ENV);

  it('redirects with 302 to the start URL and no-store headers', async () => {
    const response = await get(
      query({
        login_hint: 'alice@example.com',
        state: 's1',
        redirect_uri: 'https://rp.example/cb',
        ignored: 'x',
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const location = new URL(must(response.headers.get('Location')));
    expect(location.origin + location.pathname).toBe(
      'https://rp.example/auth/external/prov-slug/start'
    );
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: 'downstream',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 's1',
      redirect_uri: 'https://rp.example/cb',
      login_hint: 'alice@example.com',
    });
    expect(mocks.getProviderByIdOrSlug).toHaveBeenCalledWith(ENV, 'prov', 'tenant-1');
  });

  it('uses the provider id when it has no slug and honours target_link_uri', async () => {
    mocks.getProviderByIdOrSlug.mockResolvedValue({
      id: 'prov-id',
      enabled: true,
      issuer: 'https://op.example',
    });
    const response = await get(query({ target_link_uri: 'https://rp.example/target' }));
    const location = new URL(must(response.headers.get('Location')));
    expect(location.pathname).toBe('/auth/external/prov-id/start');
    expect(location.searchParams.get('redirect_uri')).toBe('https://rp.example/target');
  });

  it('treats empty iss/login_hint/target_link_uri as absent', async () => {
    const response = await get(query({ login_hint: '', target_link_uri: '' }));
    expect(response.status).toBe(302);
    const location = new URL(must(response.headers.get('Location')));
    expect(location.searchParams.has('login_hint')).toBe(false);
    expect(location.searchParams.has('redirect_uri')).toBe(false);
  });

  it('accepts a form-encoded POST that overrides query parameters', async () => {
    const response = await app().request(
      `https://rp.example/auth/external/prov/initiate?${query({ state: 'from-query' })}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ state: 'from-form', login_hint: 'bob' }).toString(),
      },
      ENV
    );
    expect(response.status).toBe(302);
    const location = new URL(must(response.headers.get('Location')));
    expect(location.searchParams.get('state')).toBe('from-form');
    expect(location.searchParams.get('login_hint')).toBe('bob');
  });

  it('rejects a POST with another content type', async () => {
    const variants: Array<Record<string, string>> = [{ 'Content-Type': 'application/json' }, {}];
    for (const headers of variants) {
      const response = await app().request(
        `https://rp.example/auth/external/prov/initiate?${query()}`,
        { method: 'POST', headers, body: '{}' },
        ENV
      );
      expect(response.status).toBe(400);
    }
    const response = await app().request(
      `https://rp.example/auth/external/prov/initiate?${query()}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ENV
    );
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'POST requests must use application/x-www-form-urlencoded',
    });
    expect(mocks.getProviderByIdOrSlug).not.toHaveBeenCalled();
  });

  it('rejects a bodyless POST that has no content type at all', async () => {
    const response = await app().request(
      `https://rp.example/auth/external/prov/initiate?${query()}`,
      { method: 'POST' },
      ENV
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'POST requests must use application/x-www-form-urlencoded',
    });
  });

  it('answers 400 when the route has no provider parameter', async () => {
    const response = await get(query(), '/noprovider');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing provider',
    });
    expect(mocks.getProviderByIdOrSlug).not.toHaveBeenCalled();
  });

  it('answers 404 for unknown and disabled providers', async () => {
    const expected = {
      error: 'invalid_request',
      error_description: 'Unknown or disabled provider',
    };
    mocks.getProviderByIdOrSlug.mockResolvedValue(null);
    const unknown = await get(query());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(expected);
    mocks.getProviderByIdOrSlug.mockResolvedValue({
      id: 'p',
      enabled: false,
      issuer: 'https://op.example',
    });
    const disabled = await get(query());
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual(expected);
  });

  it('answers 400 with the issuer validation message', async () => {
    const missing = await get(query({}, { client_id: 'c' }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'invalid_request',
      error_description: 'iss is required',
    });
    const mismatch = await get(query({ iss: 'https://evil.example' }));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: 'invalid_request',
      error_description: 'iss does not match the configured provider issuer',
    });
  });

  it.each([
    ['client_id', { code_challenge: 'c', code_challenge_method: 'S256' }],
    ['code_challenge', { client_id: 'c', code_challenge_method: 'S256' }],
    ['S256 method', { client_id: 'c', code_challenge: 'c' }],
    [
      'S256 method (plain)',
      { client_id: 'c', code_challenge: 'c', code_challenge_method: 'plain' },
    ],
    ['empty client_id', { client_id: '', code_challenge: 'c', code_challenge_method: 'S256' }],
    ['empty challenge', { client_id: 'c', code_challenge: '', code_challenge_method: 'S256' }],
  ])('requires a bound client and PKCE S256 (%s)', async (_name, params) => {
    const response = await get(query({}, { iss: 'https://op.example', ...params }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description:
        'The registered initiate_login_uri must bind an Authrim client_id and PKCE S256 challenge',
    });
  });
});
