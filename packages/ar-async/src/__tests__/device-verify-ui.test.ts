import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCodeMetadata, Env } from '@authrim/ar-lib-core';

const { mockIsMockAuthEnabled, mockGetUIConfig, mockLogger } = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    mockIsMockAuthEnabled: vi.fn(),
    mockGetUIConfig: vi.fn(),
    mockLogger: logger,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: vi.fn(() => mockLogger),
    isMockAuthEnabled: mockIsMockAuthEnabled,
    getUIConfig: mockGetUIConfig,
  };
});

import { deviceVerifyHandler } from '../device-verify';
import { realUserCodeLimiter, type RealUserCodeLimiter } from './real-user-code-limiter';

function createDeviceMetadata(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  return {
    device_code: 'device-code-123',
    user_code: 'WDJB-MJHT',
    client_id: 'client-123',
    scope: 'openid profile',
    status: 'pending',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    interval: 5,
    created_at: Math.floor(Date.now() / 1000),
    last_poll_at: 0,
    poll_count: 0,
    ...overrides,
  } as DeviceCodeMetadata;
}

function createDeviceStore(handler: (request: Request) => Promise<Response> | Response) {
  return {
    fetch: vi.fn(handler),
  };
}

function createEnv(
  store: ReturnType<typeof createDeviceStore>,
  limiter: RealUserCodeLimiter | null = realUserCodeLimiter()
): Env {
  return {
    ...(limiter ? { USER_CODE_RATE_LIMITER: limiter.namespace } : {}),
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-store-id'),
      get: vi.fn().mockReturnValue(store),
    },
  } as unknown as Env;
}

function createContext(options: {
  method: 'GET' | 'POST' | 'PUT';
  env: Env;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  tenantId?: string | null;
  ip?: string;
}) {
  return {
    req: {
      method: options.method,
      header: vi.fn((name: string) =>
        name === 'CF-Connecting-IP' ? (options.ip ?? '203.0.113.9') : undefined
      ),
      query: vi.fn((name: string) => options.query?.[name]),
      parseBody: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env,
    get: vi.fn((name: string) =>
      name === 'tenantId' ? (options.tenantId ?? 'tenant-1') : undefined
    ),
    html: vi.fn(
      (body: unknown, status = 200) =>
        new Response(String(body), {
          status,
          headers: { 'Content-Type': 'text/html; charset=UTF-8' },
        })
    ),
    redirect: vi.fn(
      (location: string, status = 302) =>
        new Response(null, {
          status,
          headers: { Location: location },
        })
    ),
    json: vi.fn(
      (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    text: vi.fn((body: string, status = 200) => new Response(body, { status })),
  } as never;
}

describe('Device verification browser handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMockAuthEnabled.mockResolvedValue(false);
    mockGetUIConfig.mockResolvedValue(null);
  });

  it('renders the minimal verification form with query feedback', async () => {
    const store = createDeviceStore(() => new Response('unused', { status: 500 }));
    const ctx = createContext({
      method: 'GET',
      env: createEnv(store),
      query: {
        user_code: 'WDJB-MJHT',
        error: 'Invalid code',
        success: 'Authorized',
      },
    });

    const response = await deviceVerifyHandler(ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Device Verification');
    expect(html).toContain('value="WDJB-MJHT"');
    expect(html).toContain('Invalid code');
    expect(html).toContain('Authorized');
    expect(store.fetch).not.toHaveBeenCalled();
  });

  it('rejects missing and malformed user codes before reading the store', async () => {
    const store = createDeviceStore(() => new Response('unused', { status: 500 }));
    const env = createEnv(store);

    const missingResponse = await deviceVerifyHandler(
      createContext({
        method: 'POST',
        env,
        body: {},
      })
    );
    expect(missingResponse.status).toBe(302);
    expect(missingResponse.headers.get('Location')).toBe('/device?error=User code is required');

    const invalidResponse = await deviceVerifyHandler(
      createContext({
        method: 'POST',
        env,
        body: { user_code: 'no' },
      })
    );
    expect(invalidResponse.status).toBe(302);
    expect(invalidResponse.headers.get('Location')).toBe('/device?error=Invalid user code format');
    expect(store.fetch).not.toHaveBeenCalled();
  });

  it('redirects users to the configured UI when mock auth is disabled', async () => {
    mockGetUIConfig.mockResolvedValue({
      baseUrl: 'https://login.example.com',
      paths: {
        deviceAuthorize: '/device/authorize',
      },
    });
    const store = createDeviceStore((request) => {
      expect(new URL(request.url).pathname).toBe('/get-by-user-code');
      return new Response(JSON.stringify(createDeviceMetadata()), { status: 200 });
    });
    const ctx = createContext({
      method: 'POST',
      env: createEnv(store),
      body: {
        user_code: 'wdjbmjht',
      },
    });

    const response = await deviceVerifyHandler(ctx);
    const location = new URL(response.headers.get('Location')!);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://login.example.com/device/authorize');
    expect(location.searchParams.get('user_code')).toBe('WDJB-MJHT');
    expect(location.searchParams.get('tenant_hint')).toBe('tenant-1');
  });

  it('does not promise a fixed format in the form: any length of 4 to 16 characters can be typed', async () => {
    const store = createDeviceStore(() => new Response('unused', { status: 500 }));
    const ctx = createContext({ method: 'GET', env: createEnv(store), query: {} });

    const html = await (await deviceVerifyHandler(ctx)).text();

    expect(html).not.toContain('maxlength="9"');
    expect(html).not.toMatch(/pattern="\[A-Z0-9\]\{4\}-\[A-Z0-9\]\{4\}"/);
  });

  it.each([
    ['wdjbmjht', 'WDJBMJHT', 'WDJB-MJHT'],
    ['1234-5678-901', '12345678901', '1234-5678-901'],
    ['abcd', 'ABCD', 'ABCD'],
    ['abcd efgh jkmn pqrs', 'ABCDEFGHJKMNPQRS', 'ABCD-EFGH-JKMN-PQRS'],
  ])(
    'looks %s up in canonical form and passes it on in groups of 4',
    async (typed, canonical, shown) => {
      mockGetUIConfig.mockResolvedValue({
        baseUrl: 'https://login.example.com',
        paths: { deviceAuthorize: '/device/authorize' },
      });
      const looked: string[] = [];
      const store = createDeviceStore(async (request) => {
        looked.push(((await request.json()) as { user_code: string }).user_code);
        return new Response(JSON.stringify(createDeviceMetadata()), { status: 200 });
      });
      const ctx = createContext({
        method: 'POST',
        env: createEnv(store),
        body: { user_code: typed },
      });

      const response = await deviceVerifyHandler(ctx);

      expect(looked).toEqual([canonical]);
      expect(new URL(response.headers.get('Location')!).searchParams.get('user_code')).toBe(shown);
    }
  );

  it.each(['abc', 'ABCD-EFGH-JKMN-PQRS-T', 'WDJB_MJHT', 'WDJB-MJH%'])(
    'rejects %s as malformed without reading the store',
    async (typed) => {
      const store = createDeviceStore(() => new Response('unused', { status: 500 }));
      const response = await deviceVerifyHandler(
        createContext({ method: 'POST', env: createEnv(store), body: { user_code: typed } })
      );
      expect(response.headers.get('Location')).toBe('/device?error=Invalid user code format');
      expect(store.fetch).not.toHaveBeenCalled();
    }
  );

  it('auto-approves pending codes only when mock auth is enabled', async () => {
    mockIsMockAuthEnabled.mockResolvedValue(true);
    const approveBodies: Array<Record<string, unknown>> = [];
    const store = createDeviceStore(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/get-by-user-code') {
        return new Response(JSON.stringify(createDeviceMetadata()), { status: 200 });
      }
      if (path === '/approve') {
        approveBodies.push((await request.json()) as Record<string, unknown>);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    });
    const ctx = createContext({
      method: 'POST',
      env: createEnv(store),
      body: {
        user_code: 'wdjbmjht',
      },
    });

    const response = await deviceVerifyHandler(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      '/device?success=Device authorized successfully! You can close this window.'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Mock authentication is enabled. This should NEVER be used in production!'
    );
    expect(approveBodies).toEqual([
      expect.objectContaining({
        user_code: 'WDJBMJHT',
        sub: 'mock-user@example.com',
      }),
    ]);
  });

  it('does not approve codes that are no longer pending', async () => {
    const store = createDeviceStore((request) => {
      if (new URL(request.url).pathname === '/get-by-user-code') {
        return new Response(JSON.stringify(createDeviceMetadata({ status: 'denied' })), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const ctx = createContext({
      method: 'POST',
      env: createEnv(store),
      body: {
        user_code: 'WDJB-MJHT',
      },
    });

    const response = await deviceVerifyHandler(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/device?error=Invalid or expired user code');
    expect(store.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns method not allowed for unsupported methods', async () => {
    const store = createDeviceStore(() => new Response('unused', { status: 500 }));
    const ctx = createContext({
      method: 'PUT',
      env: createEnv(store),
    });

    const response = await deviceVerifyHandler(ctx);

    expect(response.status).toBe(405);
    await expect(response.text()).resolves.toBe('Method not allowed');
  });

  describe('the per-IP user code limit (shared with the JSON APIs)', () => {
    const absentStore = () =>
      createDeviceStore(() => new Response(JSON.stringify(null), { status: 200 }));
    const submit = (env: Env, user_code = 'WDJB-MJHT', ip = '203.0.113.9') =>
      deviceVerifyHandler(createContext({ method: 'POST', env, body: { user_code }, ip }));
    const location = (response: Response) => response.headers.get('Location');

    it('counts a well-formed code that does not exist, and blocks the IP after 5', async () => {
      const store = absentStore();
      const limiter = realUserCodeLimiter();
      const env = createEnv(store, limiter);

      for (let guess = 1; guess <= 5; guess++) {
        const response = await submit(env, `WDJB-MJH${guess}`);
        expect(location(response)).toBe('/device?error=Invalid or expired user code');
      }
      expect(limiter.failuresOf('203.0.113.9')).toBe(5);
      expect(store.fetch).toHaveBeenCalledTimes(5);

      // the sixth is refused before any code is read
      const blocked = await submit(env, 'WDJB-MJH6');
      expect(location(blocked)).toBe(
        '/device?error=Too many failed attempts. Please try again later.'
      );
      expect(store.fetch).toHaveBeenCalledTimes(5);
    });

    it('refuses an IP that is already blocked without touching the store', async () => {
      const store = absentStore();
      const limiter = realUserCodeLimiter();
      for (let failure = 0; failure < 5; failure++) {
        await limiter.namespace.get('x').fetch(
          new Request('https://internal/record-failure', {
            method: 'POST',
            body: JSON.stringify({ ip: '203.0.113.9', reservation_id: `earlier-${failure}` }),
          })
        );
      }

      const response = await submit(createEnv(store, limiter));

      expect(location(response)).toMatch(/^\/device\?error=Too many failed attempts/);
      expect(store.fetch).not.toHaveBeenCalled();
      // another address is not affected
      const other = await submit(createEnv(store, limiter), 'WDJB-MJHT', '198.51.100.4');
      expect(location(other)).toBe('/device?error=Invalid or expired user code');
    });

    it('does not count a malformed code', async () => {
      const store = absentStore();
      const limiter = realUserCodeLimiter();
      for (let attempt = 0; attempt < 8; attempt++) {
        await submit(createEnv(store, limiter), 'abc');
      }
      expect(limiter.failuresOf('203.0.113.9')).toBe(0);
      expect(store.fetch).not.toHaveBeenCalled();
    });

    it('answers a code that is no longer pending like one that does not exist, without counting it', async () => {
      const store = createDeviceStore(
        () =>
          new Response(JSON.stringify(createDeviceMetadata({ status: 'approved' })), {
            status: 200,
          })
      );
      const limiter = realUserCodeLimiter();

      const response = await submit(createEnv(store, limiter));

      expect(location(response)).toBe('/device?error=Invalid or expired user code');
      expect(limiter.failuresOf('203.0.113.9')).toBe(0);
    });

    it('reserves a guess only after the form body is read', async () => {
      const store = absentStore();
      const limiter = realUserCodeLimiter();
      const ctx = createContext({ method: 'POST', env: createEnv(store, limiter), body: {} });
      let release!: (body: Record<string, unknown>) => void;
      (ctx as unknown as { req: { parseBody: unknown } }).req.parseBody = vi.fn(
        () => new Promise((resolve) => (release = resolve))
      );

      const pendingResponse = deviceVerifyHandler(ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(limiter.calls).toEqual([]);
      expect(store.fetch).not.toHaveBeenCalled();

      release({ user_code: 'WDJB-MJHT' });
      const response = await pendingResponse;
      expect(limiter.calls).toEqual(['/reserve', '/record-failure']);
      expect(location(response)).toBe('/device?error=Invalid or expired user code');
    });

    it('refuses to read codes when there is no limiter', async () => {
      const store = absentStore();

      const response = await submit(createEnv(store, null));

      expect(location(response)).toMatch(
        /^\/device\?error=Device code verification is temporarily unavailable/
      );
      expect(store.fetch).not.toHaveBeenCalled();
    });

    it('refuses to read codes when the limiter fails', async () => {
      const store = absentStore();
      const env = createEnv(store, null);
      (env as unknown as Record<string, unknown>).USER_CODE_RATE_LIMITER = {
        idFromName: () => 'limiter',
        get: () => ({
          fetch: async () => {
            throw new Error('limiter down');
          },
        }),
      };

      const response = await submit(env);

      expect(location(response)).toMatch(/temporarily unavailable/);
      expect(store.fetch).not.toHaveBeenCalled();
    });

    it('neither reports "no such code" nor counts a failure when the store cannot answer', async () => {
      const store = createDeviceStore(() => new Response('boom', { status: 500 }));
      const limiter = realUserCodeLimiter();

      const response = await submit(createEnv(store, limiter));

      expect(location(response)).toMatch(/temporarily unavailable/);
      expect(limiter.failuresOf('203.0.113.9')).toBe(0);
    });

    it('refuses when the failure cannot be counted, after the lookup happened', async () => {
      const store = absentStore();
      const env = createEnv(store, null);
      const limiterCalls: string[] = [];
      (env as unknown as Record<string, unknown>).USER_CODE_RATE_LIMITER = {
        idFromName: () => 'limiter',
        get: () => ({
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            limiterCalls.push(path);
            if (path === '/reserve') return Response.json({ blocked: false, reservation_id: 'r1' });
            throw new Error('cannot record');
          },
        }),
      };

      const response = await submit(env);

      // the code was looked up (the reservation was valid) and the miss could not be counted
      expect(store.fetch).toHaveBeenCalledTimes(1);
      expect(limiterCalls).toEqual(['/reserve', '/record-failure']);
      expect(location(response)).toMatch(/temporarily unavailable/);
      expect(location(response)).not.toMatch(/Invalid or expired/);
    });

    it.each([
      ['no settled flag', { success: true }],
      ['expired as a string', { settled: true, expired: 'false', outcome: 'failure' }],
      ['no outcome', { settled: true, expired: false }],
      ['the outcome of the other call', { settled: true, expired: false, outcome: 'released' }],
    ])('refuses and discloses nothing when a miss is settled with %s', async (_label, answer) => {
      const store = absentStore();
      const env = createEnv(store, null);
      (env as unknown as Record<string, unknown>).USER_CODE_RATE_LIMITER = {
        idFromName: () => 'limiter',
        get: () => ({
          fetch: async (request: Request) =>
            new URL(request.url).pathname === '/reserve'
              ? Response.json({ blocked: false, reservation_id: 'r1' })
              : Response.json(answer),
        }),
      };

      const response = await submit(env);

      expect(location(response)).toMatch(/temporarily unavailable/);
      expect(location(response)).not.toMatch(/Invalid or expired/);
    });

    it('lets a development deployment with mock authentication run without a limiter', async () => {
      mockIsMockAuthEnabled.mockResolvedValue(true);
      const store = createDeviceStore(async (request) =>
        new URL(request.url).pathname === '/get-by-user-code'
          ? new Response(JSON.stringify(createDeviceMetadata()), { status: 200 })
          : new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const response = await submit(createEnv(store, null));

      expect(location(response)).toMatch(/success=Device authorized/);
    });
  });
});
