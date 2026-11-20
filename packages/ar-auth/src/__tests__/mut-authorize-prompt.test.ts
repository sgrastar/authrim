import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function enableSso() {
  await env.SETTINGS!.put(
    'settings:client:default:test-client:client',
    JSON.stringify({ 'client.sso_enabled': true })
  );
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

async function withSession(overrides: Record<string, string | undefined>) {
  return app.request(
    authorizeQuery(overrides),
    { method: 'GET', headers: { Cookie: `authrim_session=${encodeURIComponent(SESSION_ID)}` } },
    env
  );
}

function errorOf(response: Response) {
  const { target, params } = redirectedError(response);
  expect(target).toBe('https://example.com/callback');
  return { error: params.get('error'), description: params.get('error_description') };
}

function wentToReauth(response: Response): boolean {
  const location = response.headers.get('Location') ?? '';
  return location.startsWith('https://login.example.com/') && location.includes('/reauth');
}

describe('authorize: prompt=none', () => {
  it('refuses prompt=none combined with another prompt value', async () => {
    await enableSso();
    seedSession(env);
    expect(errorOf(await withSession({ prompt: 'none login' }))).toEqual({
      error: 'invalid_request',
      description: 'prompt=none cannot be combined with other prompt values',
    });
  });

  it('answers login_required without a session', async () => {
    await enableSso();
    expect(errorOf(await withSession({ prompt: 'none' }))).toEqual({
      error: 'login_required',
      description: 'User authentication is required',
    });
  });

  it('answers login_required for a session while SSO is off for the client', async () => {
    seedSession(env);
    await env.SETTINGS!.put(
      'settings:client:default:test-client:client',
      JSON.stringify({ 'client.sso_enabled': false })
    );
    expect(errorOf(await withSession({ prompt: 'none' }))).toEqual({
      error: 'login_required',
      description:
        'SSO is disabled for this client - prompt=none requires an active session but session sharing is not allowed',
    });
  });

  it('refuses when the authentication is older than max_age, and only then', async () => {
    await enableSso();
    seedSession(env, 'test-user', NOW_S - 100);
    expect(errorOf(await withSession({ prompt: 'none', max_age: '99' }))).toEqual({
      error: 'login_required',
      description: 'Re-authentication is required due to max_age constraint',
    });
    const fresh = await withSession({ prompt: 'none', max_age: '100' });
    const issued = new URL(fresh.headers.get('Location')!);
    expect(issued.searchParams.get('error')).toBeNull();
    expect(issued.searchParams.get('code')).toBeTruthy();
  });

  it('treats max_age=0 as always exceeded', async () => {
    await enableSso();
    seedSession(env, 'test-user', NOW_S);
    expect(errorOf(await withSession({ prompt: 'none', max_age: '0' })).description).toBe(
      'Re-authentication is required due to max_age constraint'
    );
  });
});

describe('authorize: max_age and prompt=login with a session', () => {
  it('sends the user to re-authenticate once the authentication is older than max_age', async () => {
    await enableSso();
    seedSession(env, 'test-user', NOW_S - 100);
    const stale = await withSession({ max_age: '99' });
    expect(stale.status).toBe(302);
    expect(wentToReauth(stale)).toBe(true);
  });

  it('does not ask again at exactly max_age', async () => {
    await enableSso();
    seedSession(env, 'test-user', NOW_S - 100);
    const fresh = await withSession({ max_age: '100' });
    expect(fresh.status).toBe(302);
    expect(wentToReauth(fresh)).toBe(false);
    expect(new URL(fresh.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
  });

  it('sends the user to re-authenticate for max_age=0', async () => {
    await enableSso();
    seedSession(env, 'test-user', NOW_S);
    expect(wentToReauth(await withSession({ max_age: '0' }))).toBe(true);
  });

  it('sends the user to re-authenticate for prompt=login', async () => {
    await enableSso();
    seedSession(env);
    expect(wentToReauth(await withSession({ prompt: 'login' }))).toBe(true);
    expect(wentToReauth(await withSession({}))).toBe(false);
  });
});

describe('authorize: id_token_hint', () => {
  it('refuses an id_token_hint this server did not issue', async () => {
    await enableSso();
    seedSession(env);
    expect(errorOf(await withSession({ id_token_hint: 'a.b.c' }))).toEqual({
      error: 'invalid_request',
      description: 'id_token_hint is not an ID token this server issued',
    });
  });
});
