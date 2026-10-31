/**
 * The session's user is read from the user's ACCOUNT databases, never the tenant metadata
 * database (which holds no users since tenant D1 routing). Separate metadata and account
 * databases make a read from the wrong one visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  /** The user each core adapter holds, by adapter. */
  usersByAdapter: new Map<unknown, { id: string; active: number; email: string | null }>(),
  storeAdapters: [] as unknown[],
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    isShardedSessionId: (value: string) => value.startsWith('s1_'),
    getSessionStoreBySessionId: () => ({ stub: { getSessionRpc: mocks.getSession } }),
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    CanonicalRuntimeUserStore: class {
      constructor(private readonly options: { coreAdapter: unknown }) {
        mocks.storeAdapters.push(options.coreAdapter);
      }
      findById = async () => mocks.usersByAdapter.get(this.options.coreAdapter) ?? null;
    },
  };
});

import { getAuthenticatedAsyncUser } from '../authenticated-session';

function fakeAdapter(name: string) {
  const adapter = {
    name,
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(),
    close: vi.fn(),
  };
  return adapter;
}

let metadataAdapter: ReturnType<typeof fakeAdapter>;
let accountAdapter: ReturnType<typeof fakeAdapter>;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const vars = c as unknown as { set(key: string, value: unknown): void };
    vars.set('tenantId', 'tenant-a');
    vars.set('tenantMetadataContext', { tenantId: 'tenant-a', coreDb: metadataAdapter });
    await next();
  });
  app.get('/', async (c) => c.json(await getAuthenticatedAsyncUser(c, 'tenant-a')));
  return app;
}

async function authenticate() {
  const response = await createApp().request(
    'http://localhost/',
    { headers: { 'X-Session-Id': 's1_session' } },
    {} as Env
  );
  return response.json();
}

describe('authenticated async user (account database)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usersByAdapter.clear();
    mocks.storeAdapters.length = 0;
    metadataAdapter = fakeAdapter('metadata');
    accountAdapter = fakeAdapter('account');
    mocks.getSession.mockResolvedValue({
      userId: 'user-1',
      expiresAt: Date.now() + 60_000,
    } as Session);
    mocks.usersByAdapter.set(accountAdapter, {
      id: 'user-1',
      active: 1,
      email: 'user@example.com',
    });
    mocks.resolveAccountDataContextFromHono.mockImplementation(
      async (c: { set(key: string, value: unknown): void }, accountId: string) => {
        const context = {
          tenantId: 'tenant-a',
          accountId: `account:${accountId}`,
          coreDb: accountAdapter,
          piiDb: accountAdapter,
          userCacheScope: 'account',
          piiCacheMode: 'encrypted_short_ttl',
        };
        c.set('accountDataContext', context);
        return context;
      }
    );
  });

  it("reads the session's user from its account database", async () => {
    await expect(authenticate()).resolves.toEqual({
      userId: 'user-1',
      sub: 'user-1',
      email: 'user@example.com',
    });
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'user-1'
    );
    expect(mocks.storeAdapters).toEqual([accountAdapter]);
  });

  it('does not authenticate a user that is active only in the metadata database', async () => {
    mocks.usersByAdapter.delete(accountAdapter);
    mocks.usersByAdapter.set(metadataAdapter, { id: 'user-1', active: 1, email: null });
    await expect(authenticate()).resolves.toBeNull();
  });

  it('does not authenticate an inactive account', async () => {
    mocks.usersByAdapter.set(accountAdapter, { id: 'user-1', active: 0, email: null });
    await expect(authenticate()).resolves.toBeNull();
  });

  it.each([
    ['no account', 'account_data_route_not_found'],
    ['a non-active account', 'lookup_destination_revalidation_failed'],
    ['an unavailable route', 'account_data_runtime_registry_unavailable'],
  ])('fails closed for %s', async (_label, code) => {
    mocks.resolveAccountDataContextFromHono.mockRejectedValue(new Error(code));
    await expect(authenticate()).resolves.toBeNull();
  });
});
