import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  authorizeQuery,
  createAuthorizeApp,
  createMockEnv,
  SESSION_ID,
  seedSession,
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
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { env: Env; set: (key: string, value: unknown) => void }, userId: string) => {
        const context = {
          tenantId: 'default',
          accountId: userId,
          legacyUserId: userId,
          coreDb: c.env.DB,
          piiDb: c.env.DB,
          coreBindingRef: 'DB',
          piiBindingRef: 'DB',
          coreResidencyPartition: 'default',
          piiResidencyPartition: 'default',
          accountRouteGeneration: 1,
          userCacheScope: { tenantId: 'default', accountRouteGeneration: 1 },
          piiCacheMode: 'disabled',
        };
        c.set('accountDataContext', context);
        return context;
      }
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

let privatePEM: string;
let jarmPublicKey: CryptoKey;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privatePEM = await exportPKCS8(keys.privateKey);
  jarmPublicKey = keys.publicKey;
});

const AUTH_TIME = Math.floor(Date.now() / 1000) - 30;
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

async function signedIn({ trusted = true } = {}) {
  await env.SETTINGS!.put(
    'settings:client:default:test-client:client',
    JSON.stringify({ 'client.sso_enabled': true })
  );
  if (trusted) {
    (
      env.DB as unknown as { _trustPolicies: Map<string, Record<string, unknown>> }
    )._trustPolicies.set('default:oidc_client:test-client', {
      target_type: 'oidc_client',
      target_id: 'test-client',
      first_party: 1,
      trusted: 1,
      skip_authorization_consent: 1,
    });
  }
  seedSession(env, 'test-user', AUTH_TIME);
}

async function authorize(
  overrides: Record<string, string | undefined>,
  headers: Record<string, string> = {}
) {
  return app.request(
    authorizeQuery(overrides),
    {
      method: 'GET',
      headers: { Cookie: `authrim_session=${encodeURIComponent(SESSION_ID)}`, ...headers },
    },
    env
  );
}

function storeCodeRpc() {
  return (
    env.AUTH_CODE_STORE as unknown as { get: () => { storeCodeRpc: ReturnType<typeof vi.fn> } }
  ).get().storeCodeRpc;
}

function storedCode(): Record<string, unknown> {
  expect(storeCodeRpc()).toHaveBeenCalledTimes(1);
  return storeCodeRpc().mock.calls[0][0] as Record<string, unknown>;
}

describe('authorize: the authorization code issued for a signed-in user', () => {
  it('stores the request with the code and returns it with state, iss and session_state', async () => {
    await signedIn();
    const response = await authorize({
      scope: 'openid profile',
      nonce: 'n-1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://example.com/callback');
    expect(location.searchParams.get('state')).toBe('test-state');
    expect(location.searchParams.get('iss')).toBe('https://test.example.com');
    expect(location.searchParams.get('session_state')).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(response.headers.get('Set-Cookie') ?? '').toContain('Path=/; SameSite=');

    const stored = storedCode();
    expect(stored).toMatchObject({
      code: location.searchParams.get('code'),
      tenantId: 'default',
      clientId: 'test-client',
      redirectUri: 'https://example.com/callback',
      userId: 'test-user',
      scope: 'openid profile',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      nonce: 'n-1',
      state: 'test-state',
      claimsRequestProtected: false,
      authTime: AUTH_TIME,
      sessionId: SESSION_ID,
      // A trusted client releases everything without asking.
      releaseApproval: ['*'],
    });
    expect(stored.dpopJkt).toBeUndefined();
    expect(stored.resource).toBeUndefined();
    expect(stored.pushedSignedRequest).toBeUndefined();
  });

  it('records the client default resource, else its default audience', async () => {
    await signedIn();
    useClient({ default_resource: 'https://api.example.com', default_audience: 'aud-1' });
    await authorize({});
    expect(storedCode().resource).toBe('https://api.example.com');

    storeCodeRpc().mockClear();
    useClient({ default_resource: '', default_audience: 'aud-1' });
    await authorize({});
    expect(storedCode().resource).toBe('aud-1');

    storeCodeRpc().mockClear();
    useClient({ default_audience: '' });
    await authorize({});
    expect(storedCode().resource).toBeUndefined();
  });

  it('uses the configured code lifetime and per-user code limit', async () => {
    await signedIn();
    await env.SETTINGS!.put(
      'settings:tenant:default:oauth',
      JSON.stringify({ 'oauth.auth_code_ttl': 90, 'oauth.max_codes_per_user': 7 })
    );
    await authorize({});
    expect(storedCode()).toMatchObject({ ttlSeconds: 90, maxCodesPerUser: 7 });
  });

  it('binds the code to dpop_jkt', async () => {
    await signedIn();
    await authorize({ dpop_jkt: 'thumbprint-1' });
    expect(storedCode().dpopJkt).toBe('thumbprint-1');
  });

  it('answers server_error when the code cannot be stored', async () => {
    await signedIn();
    storeCodeRpc().mockRejectedValueOnce(new Error('DO down'));
    const response = await authorize({});
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('server_error');
    expect(location.searchParams.get('error_description')).toBe(
      'Failed to process authorization request'
    );
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('posts the code for response_mode=form_post', async () => {
    await signedIn();
    const response = await authorize({ response_mode: 'form_post' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('action="https://example.com/callback"');
    expect(html).toContain(`name="code" value="${storedCode().code as string}"`);
  });

  it.each([
    ['query.jwt', 'query'],
    ['jwt', 'query'],
  ])('signs the response for response_mode=%s (%s)', async (mode, where) => {
    await signedIn();
    const keyRpc = vi.fn(async () => ({ kid: 'jarm-kid', privatePEM }));
    env.KEY_MANAGER = {
      idFromName: vi.fn(() => 'km'),
      get: vi.fn(() => ({ getActiveOIDCSigningKeyWithPrivateRpc: keyRpc })),
    } as unknown as Env['KEY_MANAGER'];
    // Each mode in its own tenant cache entry is not needed: the key is the same.
    const response = await authorize({ response_mode: mode });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('Location')!);
    const params = where === 'query' ? url.searchParams : new URLSearchParams(url.hash.slice(1));
    expect([...params.keys()]).toEqual(['response']);
    const token = params.get('response')!;
    expect(decodeProtectedHeader(token).typ).toBe('oauth-authz-resp+jwt');
    const { payload } = await jwtVerify(token, jarmPublicKey, {
      issuer: 'https://test.example.com',
      audience: 'test-client',
    });
    expect(payload).toMatchObject({
      iss: 'https://test.example.com',
      aud: 'test-client',
      code: storedCode().code,
      state: 'test-state',
    });
  });
});

describe('authorize: JARM error responses from the endpoint', () => {
  it('signs a refusal for response_mode=fragment.jwt with response_type=code', async () => {
    await signedIn();
    const keyRpc = vi.fn(async () => ({ kid: 'jarm-kid', privatePEM }));
    env.KEY_MANAGER = {
      idFromName: vi.fn(() => 'km'),
      get: vi.fn(() => ({ getActiveOIDCSigningKeyWithPrivateRpc: keyRpc })),
    } as unknown as Env['KEY_MANAGER'];
    const response = await authorize({ response_mode: 'fragment.jwt' });
    const url = new URL(response.headers.get('Location')!);
    const { payload } = await jwtVerify(
      new URLSearchParams(url.hash.slice(1)).get('response')!,
      jarmPublicKey,
      { issuer: 'https://test.example.com', audience: 'test-client' }
    );
    expect(payload).toMatchObject({
      error: 'invalid_request',
      error_description: 'response_mode=fragment is not compatible with response_type=code',
      state: 'test-state',
    });
    expect(storeCodeRpc()).not.toHaveBeenCalled();
  });
});

describe('authorize: DPoP at the authorization endpoint', () => {
  it('requires a DPoP proof of a client with DPoP-bound tokens', async () => {
    await signedIn();
    useClient({ dpop_bound_access_tokens: true });
    const params = redirectedError(await authorize({})).params;
    expect(params.get('error')).toBe('invalid_dpop_proof');
    expect(params.get('error_description')).toBe('DPoP proof is required for this client');
    expect(storeCodeRpc()).not.toHaveBeenCalled();
  });

  it('accepts dpop_jkt in place of the proof for such a client', async () => {
    await signedIn();
    useClient({ dpop_bound_access_tokens: true });
    await authorize({ dpop_jkt: 'thumbprint-2' });
    expect(storedCode().dpopJkt).toBe('thumbprint-2');
  });

  it('refuses an invalid proof for such a client', async () => {
    await signedIn();
    useClient({ dpop_bound_access_tokens: true });
    const params = redirectedError(await authorize({}, { DPoP: 'not-a-proof' })).params;
    expect(params.get('error')).toBe('invalid_dpop_proof');
    expect(params.get('error_description')).toBeTruthy();
    expect(storeCodeRpc()).not.toHaveBeenCalled();
  });

  it('ignores an invalid proof of another client and issues an unbound code', async () => {
    await signedIn();
    const response = await authorize({}, { DPoP: 'not-a-proof' });
    expect(new URL(response.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
    expect(storedCode().dpopJkt).toBeUndefined();
  });
});

describe('authorize: consent', () => {
  it('sends an untrusted client to the consent screen instead of issuing a code', async () => {
    await signedIn({ trusted: false });
    const response = await authorize({});
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin).toBe('https://login.example.com');
    expect(location.pathname).toContain('consent');
    expect(location.searchParams.get('challenge_id')).toBeTruthy();
    expect(storeCodeRpc()).not.toHaveBeenCalled();
  });

  it('answers consent_required for prompt=none when consent is needed', async () => {
    await signedIn({ trusted: false });
    const params = redirectedError(await authorize({ prompt: 'none' })).params;
    expect(params.get('error')).toBe('consent_required');
    expect(storeCodeRpc()).not.toHaveBeenCalled();
  });
});
