/**
 * The user code from issue to decision, over the REAL DeviceCodeStore: POST /device_authorization
 * issues a code in the tenant's format, POST /api/devices/lookup and /api/devices/verify find it
 * by what a person types, and a code that is already issued keeps working when the settings (or
 * the release) change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { DeviceCodeStore, type DeviceCodeMetadata, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  getClient: vi.fn(),
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    module: vi.fn().mockReturnThis(),
    startTimer: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getLogger: () => mocks.logger,
    getClientCached: vi.fn().mockImplementation(() => mocks.getClient()),
    getClient: vi.fn().mockImplementation(() => mocks.getClient()),
    isMockAuthEnabled: vi.fn().mockResolvedValue(false),
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createAccountAuthContextFromHono: () => ({
      // the whole adapter shape: anything less is taken for a raw D1 database
      coreAdapter: {
        query: vi.fn(),
        queryOne: async () => null,
        execute: vi.fn(),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn(),
        getType: () => 'mock',
        close: vi.fn(),
      },
    }),
    resolveAccountDataContextFromHono: vi.fn().mockResolvedValue({ tenantId: 'default' }),
  };
});

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { deviceAuthorizationHandler } from '../device-authorization';
import { deviceLookupApiHandler } from '../device-lookup-api';
import { deviceVerifyApiHandler } from '../device-verify-api';
import { deviceVerifyHandler } from '../device-verify';
import { realUserCodeLimiter, type RealUserCodeLimiter } from './real-user-code-limiter';

const TENANT_KEY = 'settings:tenant:default:device-flow';

/** Durable Storage in memory, as the store uses it. */
class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ''))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => [key, structuredClone(value)])
    ) as Map<string, T>;
  }
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(keys: string | string[]): Promise<number> {
    return [keys].flat().filter((key) => this.values.delete(key)).length;
  }
  async setAlarm(): Promise<void> {}
}

let storage: MemoryStorage;
let documents: Record<string, Record<string, unknown>>;
let limiter: RealUserCodeLimiter;

async function openStore(): Promise<DeviceCodeStore> {
  let ready: Promise<void> = Promise.resolve();
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => (ready = callback()),
  } as unknown as DurableObjectState;
  const store = new DeviceCodeStore(state, {} as never);
  await ready;
  return store;
}

async function environment(): Promise<Env> {
  const store = await openStore();
  return {
    ISSUER_URL: 'https://auth.example.com',
    UI_URL: 'https://ui.example.com',
    SETTINGS: {
      get: vi.fn(async (key: string) => (documents[key] ? JSON.stringify(documents[key]) : null)),
    },
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-store'),
      get: vi.fn().mockReturnValue({ fetch: (request: Request) => store.fetch(request) }),
    },
    USER_CODE_RATE_LIMITER: limiter.namespace,
  } as unknown as Env;
}

function app(env: Env) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'default');
    await next();
  });
  hono.post('/device_authorization', deviceAuthorizationHandler);
  hono.post('/lookup', deviceLookupApiHandler);
  hono.post('/verify', deviceVerifyApiHandler);
  hono.post('/device', deviceVerifyHandler);
  const call = (path: string, body: unknown, form = false) =>
    hono.request(
      `https://auth.example.com${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          'CF-Connecting-IP': '203.0.113.9',
        },
        body: form
          ? new URLSearchParams(body as Record<string, string>).toString()
          : JSON.stringify(body),
      },
      env
    );
  return {
    issue: async () => {
      const response = await call('/device_authorization', { client_id: 'device-client' }, true);
      expect(response.status).toBe(200);
      return (await response.json()) as { user_code: string; device_code: string };
    },
    lookup: (user_code: string) => call('/lookup', { user_code }),
    verify: (user_code: string, approve = true) => call('/verify', { user_code, approve }),
    html: (user_code: string) => call('/device', { user_code }, true),
  };
}

const stored = (deviceCode: string) => storage.values.get(`d:${deviceCode}`) as DeviceCodeMetadata;

beforeEach(() => {
  vi.clearAllMocks();
  storage = new MemoryStorage();
  documents = {};
  limiter = realUserCodeLimiter();
  mocks.getClient.mockReset().mockResolvedValue({
    client_id: 'device-client',
    client_name: 'Acme TV',
  });
  mocks.authenticatedUser.mockResolvedValue({ userId: 'user-1', sub: 'subject-1', email: 'u@x.y' });
});

describe.each([
  ['NUMERIC', 12, /^\d{4}-\d{4}-\d{4}$/],
  ['NUMERIC', 11, /^\d{4}-\d{4}-\d{3}$/],
  ['BASE20', 8, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/],
  ['BASE31', 7, /^[2-9A-HJKMN-Z]{4}-[2-9A-HJKMN-Z]{3}$/],
  ['BASE31', 16, /^([2-9A-HJKMN-Z]{4}-){3}[2-9A-HJKMN-Z]{4}$/],
] as const)('a %s x %i code', (charset, length, shape) => {
  beforeEach(() => {
    documents[TENANT_KEY] = {
      'device_flow.user_code_charset': charset,
      'device_flow.user_code_length': length,
    };
  });

  it('is issued, looked up and approved in the way a person types it', async () => {
    const api = app(await environment());
    const { user_code, device_code } = await api.issue();
    expect(user_code).toMatch(shape);
    expect(stored(device_code).user_code).toBe(user_code);
    // the mapping is under the canonical code only
    expect([...storage.values.keys()].filter((key) => key.startsWith('u:'))).toEqual([
      `u:${user_code.replace(/-/g, '')}`,
    ]);

    const typed = user_code.toLowerCase().replace(/-/g, ' ');
    const lookup = await api.lookup(typed);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      client_id: 'device-client',
      client_name: 'Acme TV',
    });
    expect((await api.verify(typed)).status).toBe(200);

    expect(stored(device_code)).toMatchObject({ status: 'approved', user_id: 'user-1' });
    expect(limiter.failuresOf('203.0.113.9')).toBe(0);
  });

  it('is denied by the code as shown', async () => {
    const api = app(await environment());
    const { user_code, device_code } = await api.issue();

    expect((await api.verify(user_code, false)).status).toBe(200);

    expect(stored(device_code).status).toBe('denied');
  });

  it('keeps working after the tenant changes the settings, and after they are cleared', async () => {
    const api = app(await environment());
    const { user_code, device_code } = await api.issue();

    // another alphabet and length now: the code that was issued is looked up as before
    documents[TENANT_KEY] = {
      'device_flow.user_code_charset': charset === 'NUMERIC' ? 'BASE31' : 'NUMERIC',
      'device_flow.user_code_length': 16,
    };
    expect((await api.lookup(user_code)).status).toBe(200);
    // and then back to nothing saved (BASE31 x 8)
    documents = {};
    expect((await api.verify(user_code.replace(/-/g, ''))).status).toBe(200);
    expect(stored(device_code).status).toBe('approved');
    expect(limiter.failuresOf('203.0.113.9')).toBe(0);
  });

  it('is not found by another code of the same shape, and the miss is counted', async () => {
    const api = app(await environment());
    const { user_code } = await api.issue();
    const other = user_code.replace(/.$/, (last) => (last === '2' ? '3' : '2'));

    expect((await api.lookup(other)).status).toBe(404);
    expect(limiter.failuresOf('203.0.113.9')).toBe(1);
  });
});

describe('a code issued by the previous release', () => {
  /** What the release before this one stored for a live code. */
  function legacy(deviceCode: string, userCode: string) {
    storage.values.set(`d:${deviceCode}`, {
      tenant_id: 'default',
      device_code: deviceCode,
      user_code: userCode,
      client_id: 'device-client',
      scope: 'openid',
      status: 'pending',
      created_at: Date.now(),
      expires_at: Date.now() + 600_000,
      poll_count: 0,
      token_issued: false,
    });
    storage.values.set(`u:${userCode}`, deviceCode);
  }

  it.each(['WDJB-MJHT', 'wdjb-mjht', 'wdjbmjht', 'WDJB MJHT'])(
    'is looked up and approved with %s',
    async (typed) => {
      legacy('legacy-1', 'WDJB-MJHT');
      const api = app(await environment());

      expect((await api.lookup(typed)).status).toBe(200);
      expect((await api.verify(typed)).status).toBe(200);

      expect(stored('legacy-1').status).toBe('approved');
    }
  );

  it('is found whatever the tenant issues now', async () => {
    legacy('legacy-1', 'WDJB-MJHT');
    documents[TENANT_KEY] = {
      'device_flow.user_code_charset': 'NUMERIC',
      'device_flow.user_code_length': 12,
    };
    const api = app(await environment());

    expect((await api.verify('WDJBMJHT')).status).toBe(200);
  });

  it('is not given to a new device even if the new code has the same characters', async () => {
    legacy('legacy-1', 'WDJB-MJHT');
    const env = await environment();
    const api = app(env);
    // the store refuses the user code of the live legacy code (409) when it is drawn again
    const store = env.DEVICE_CODE_STORE.get(env.DEVICE_CODE_STORE.idFromName('x'));
    const response = await store.fetch(
      new Request('https://internal/store', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: 'default',
          device_code: 'new-1',
          user_code: 'WDJBMJHT',
          client_id: 'device-client',
          scope: 'openid',
          status: 'pending',
          created_at: Date.now(),
          expires_at: Date.now() + 600_000,
          poll_count: 0,
        }),
      })
    );
    expect(response.status).toBe(409);
    expect((await api.lookup('WDJB-MJHT')).status).toBe(200);
  });
});

describe('the per-IP failure budget (real UserCodeRateLimiter)', () => {
  const miss = 'ZZZZ-ZZZZ';

  it('is one counter for the lookup API, the verify API and the HTML page', async () => {
    const api = app(await environment());

    expect((await api.lookup(miss)).status).toBe(404);
    expect((await api.verify(miss)).status).toBe(404);
    expect((await api.html(miss)).status).toBe(302);
    expect((await api.lookup('YYYY-YYYY')).status).toBe(404);
    expect((await api.html('YYYY-YYYX')).status).toBe(302);
    expect(limiter.failuresOf('203.0.113.9')).toBe(5);

    // blocked everywhere now, and the store is not read again
    const lookup = await api.lookup(miss);
    expect(lookup.status).toBe(429);
    expect((await api.verify(miss)).status).toBe(429);
    const html = await api.html(miss);
    expect(html.headers.get('Location')).toMatch(/Too many failed attempts/);
  });

  it('is not cleared by an approval: issuing a code of your own does not buy new guesses', async () => {
    const api = app(await environment());

    // 4 wrong guesses, then an approval of a code the attacker issued for themselves, 4 more...
    for (let round = 0; round < 2; round++) {
      for (let guess = 0; guess < 4 - round * 2; guess++) {
        const response = round === 0 ? await api.lookup(miss) : await api.html(miss);
        if (round === 0) expect(response.status).toBe(404);
      }
      const own = await api.issue();
      const approved = await api.verify(own.user_code);
      if (round === 0) expect(approved.status).toBe(200);
    }

    // 4 + 2 = 6 failures inside the window: the budget of 5 is spent
    expect(limiter.failuresOf('203.0.113.9')).toBeGreaterThanOrEqual(5);
    expect((await api.lookup(miss)).status).toBe(429);
    const own = await api.issue();
    expect((await api.verify(own.user_code)).status).toBe(429);
  });
});
