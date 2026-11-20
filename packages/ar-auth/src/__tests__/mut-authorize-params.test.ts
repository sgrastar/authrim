import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  authorizeQuery,
  createAuthorizeApp,
  createMockEnv,
  putSystemSettings,
  putTenantSettings,
  redirectedError,
} from './helpers/mut-authorize-env';

const mockGetClient = vi.hoisted(() =>
  vi.fn<(env: unknown, clientId: string) => Promise<Record<string, unknown> | null>>()
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: vi.fn((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    ),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { DB: unknown }, partition?: string) =>
        (
          actual as unknown as {
            ensureDatabaseAdapter: (db: unknown, partition?: string) => unknown;
          }
        ).ensureDatabaseAdapter(env.DB, partition)
    ),
  };
});

let app: Hono<{ Bindings: Env }>;
let env: Env;

function useClient(overrides: Record<string, unknown> = {}) {
  mockGetClient.mockResolvedValue({ ...DEFAULT_CLIENT, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  useClient();
  app = createAuthorizeApp();
  env = createMockEnv();
});

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

async function refusal(overrides: Record<string, string | undefined>) {
  const response = await app.request(authorizeQuery(overrides), { method: 'GET' }, env);
  expect(response.status).toBe(302);
  const { target, params } = redirectedError(response);
  expect(target).toBe('https://example.com/callback');
  return params;
}

async function reachesLogin(overrides: Record<string, string | undefined>) {
  const response = await app.request(authorizeQuery(overrides), { method: 'GET' }, env);
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toContain('https://login.example.com/login');
}

describe('authorize: scope', () => {
  it('refuses scopes outside the client scope with the disallowed and allowed lists', async () => {
    const params = await refusal({ scope: 'openid admin billing' });
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('error_description')).toBe(
      'Client is not authorized to request scope(s): admin, billing. Allowed scopes: openid, profile, email'
    );
  });

  it('refuses scopes outside requestable_scopes', async () => {
    useClient({ scope: undefined, requestable_scopes: ['openid', 'profile'] });
    const params = await refusal({ scope: 'openid  email' });
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('error_description')).toBe(
      'Client is not authorized to request scope(s): email. Allowed scopes: openid, profile'
    );
  });

  it('accepts scopes inside requestable_scopes; an empty list restricts nothing', async () => {
    useClient({ scope: undefined, requestable_scopes: ['openid', 'profile'] });
    await reachesLogin({ scope: 'openid profile' });
    useClient({ scope: undefined, requestable_scopes: [] });
    await reachesLogin({ scope: 'openid email' });
  });

  it('drops offline_access for a response that returns no code instead of refusing it', async () => {
    useClient({ scope: 'openid', response_types: ['id_token'] });
    // offline_access is not in the client scope: kept, it would be refused.
    await reachesLogin({ response_type: 'id_token', nonce: 'n', scope: 'openid offline_access' });
  });

  it('keeps offline_access for a code response (and checks it against the client scope)', async () => {
    useClient({ scope: 'openid' });
    const params = await refusal({ scope: 'openid offline_access' });
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('error_description')).toContain('offline_access');
  });
});

describe('authorize: authorization_details (RAR)', () => {
  const detail = JSON.stringify([{ type: 'unknown_type' }]);

  it('refuses authorization_details while RAR is off', async () => {
    const params = await refusal({ authorization_details: detail });
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe(
      'authorization_details parameter is not supported. Enable RAR feature to use Rich Authorization Requests.'
    );
  });

  it('refuses malformed JSON once RAR is on', async () => {
    env.ENABLE_RAR = 'true';
    const params = await refusal({ authorization_details: '[{' });
    expect(params.get('error')).toBe('invalid_authorization_details');
    expect(params.get('error_description')).toBe('authorization_details must be valid JSON');
  });

  it('refuses a type outside the allowed list', async () => {
    env.ENABLE_RAR = 'true';
    const params = await refusal({ authorization_details: detail });
    expect(params.get('error')).toBe('invalid_authorization_details');
    expect(params.get('error_description')).toBeTruthy();
    expect(params.get('error_description')).not.toBe('authorization_details must be valid JSON');
  });

  it('lets the tenant setting override ENABLE_RAR', async () => {
    env.ENABLE_RAR = 'true';
    await putSystemSettings(env, { oidc: { rar: { enabled: false } } });
    const params = await refusal({ authorization_details: detail });
    expect(params.get('error')).toBe('invalid_request');
  });
});

describe('authorize: state and nonce', () => {
  it('refuses response_type=none: no tenant profile allows it', async () => {
    useClient({ response_types: ['none'] });
    const params = await refusal({ response_type: 'none', state: undefined });
    expect(params.get('error')).toBe('unsupported_response_type');
    expect(params.get('error_description')).toBe(
      "Response type 'none' is not allowed for this tenant profile. Allowed: code, id_token, id_token token, code id_token, code token, code id_token token"
    );
  });

  it('does not require state for code by default', async () => {
    await reachesLogin({ state: undefined });
  });

  it('requires state for code when oauth.state_required is on', async () => {
    await putTenantSettings(env, 'oauth', { 'oauth.state_required': true });
    const params = await refusal({ state: undefined });
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe('state parameter is required (CSRF protection)');
  });

  it('refuses a state that is too long', async () => {
    const params = await refusal({ state: 'x'.repeat(5000) });
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toContain('state');
  });

  it.each(['id_token', 'code id_token', 'id_token token'])(
    'requires a nonce for response_type=%s',
    async (responseType) => {
      useClient({ response_types: [responseType] });
      const params = await refusal({ response_type: responseType, nonce: undefined });
      expect(params.get('error')).toBe('invalid_request');
      expect(params.get('error_description')).toBe(
        'nonce is required when response_type contains id_token'
      );
    }
  );

  it('refuses a nonce that is too long', async () => {
    const params = await refusal({ nonce: 'n'.repeat(600) });
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe('nonce is too long (max 512 characters)');
  });
});

describe('authorize: response_mode', () => {
  it('refuses an unknown response_mode with the supported list', async () => {
    const params = await refusal({ response_mode: 'web_message' });
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe(
      'Unsupported response_mode. Supported modes: query, fragment, form_post, query.jwt, fragment.jwt, form_post.jwt, jwt'
    );
  });

  it.each(['fragment'])('refuses %s for response_type=code', async (mode) => {
    const response = await app.request(
      authorizeQuery({ response_mode: mode }),
      { method: 'GET' },
      env
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain(
      'response_mode%3Dfragment+is+not+compatible'
    );
  });

  it.each([
    ['id_token', 'query'],
    ['code token', 'query'],
    ['code id_token token', 'query'],
  ])('refuses response_type=%s in response_mode=%s', async (responseType, mode) => {
    useClient({ response_types: [responseType] });
    const response = await app.request(
      authorizeQuery({ response_type: responseType, response_mode: mode, nonce: 'n' }),
      { method: 'GET' },
      env
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('Location')!;
    expect(decodeURIComponent(location.replace(/\+/g, ' '))).toContain(
      'response_mode=query is not compatible with token or id_token response types'
    );
  });

  it.each(['query', 'form_post', 'query.jwt', 'jwt'])(
    'accepts response_mode=%s for code',
    async (mode) => {
      await reachesLogin({ response_mode: mode });
    }
  );

  it('accepts fragment for an implicit response', async () => {
    useClient({ response_types: ['id_token'] });
    await reachesLogin({ response_type: 'id_token', response_mode: 'fragment', nonce: 'n' });
  });

  describe('when the tenant requires JARM', () => {
    beforeEach(async () => {
      await putTenantSettings(env, 'security', { 'security.require_jarm': true });
    });

    it('returns the refusal in the form_post the request asked for', async () => {
      const response = await app.request(
        authorizeQuery({ response_mode: 'form_post' }),
        { method: 'GET' },
        env
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('action="https://example.com/callback"');
      expect(html).toContain('A JARM response_mode is required for this FAPI profile');
    });

    it.each([undefined, 'query'])('refuses response_mode=%s', async (mode) => {
      const params = await refusal({ response_mode: mode });
      expect(params.get('error')).toBe('invalid_request');
      expect(params.get('error_description')).toBe(
        'A JARM response_mode is required for this FAPI profile'
      );
    });

    it.each(['jwt', 'query.jwt', 'form_post.jwt'])('accepts response_mode=%s', async (mode) => {
      await reachesLogin({ response_mode: mode });
    });
  });
});

describe('authorize: PKCE', () => {
  it('requires code_challenge_method with a code_challenge', async () => {
    const params = await refusal({ code_challenge: CHALLENGE });
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe(
      'code_challenge_method is required when code_challenge is provided'
    );
  });

  it('refuses plain', async () => {
    const params = await refusal({ code_challenge: CHALLENGE, code_challenge_method: 'plain' });
    expect(params.get('error_description')).toBe(
      'Unsupported code_challenge_method. Only S256 is supported'
    );
  });

  it.each(['short', 'a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}+`])(
    'refuses a malformed code_challenge %#',
    async (challenge) => {
      const params = await refusal({ code_challenge: challenge, code_challenge_method: 'S256' });
      expect(params.get('error_description')).toBe('Invalid code_challenge format');
    }
  );

  it.each(['a'.repeat(43), 'a'.repeat(128)])(
    'accepts a code_challenge at the bounds %#',
    async (c) => {
      await reachesLogin({ code_challenge: c, code_challenge_method: 'S256' });
    }
  );

  it.each([
    ['a public client (auth method none)', { token_endpoint_auth_method: 'none' }],
    ['a client without a secret', { client_secret: undefined }],
    ['a client registered with require_pkce', { require_pkce: true }],
  ])('requires PKCE for %s', async (_label, overrides) => {
    useClient(overrides);
    const params = await refusal({});
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe('PKCE with S256 is required for this client');
  });

  it('does not require PKCE of a confidential client by default', async () => {
    await reachesLogin({});
  });

  it('counts a hashed secret as confidential', async () => {
    useClient({ client_secret: undefined, client_secret_hash: 'hash' });
    await reachesLogin({});
  });

  it('does not require PKCE when no code is issued', async () => {
    useClient({ token_endpoint_auth_method: 'none', response_types: ['id_token'] });
    await reachesLogin({ response_type: 'id_token', nonce: 'n' });
  });
});
