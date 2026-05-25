import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCodeMetadata, Env } from '@authrim/ar-lib-core';

const { mockIsMockAuthEnabled, mockShouldUseBuiltinForms, mockGetUIConfig, mockLogger } =
  vi.hoisted(() => {
    const logger = {
      module: vi.fn().mockReturnThis(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    return {
      mockIsMockAuthEnabled: vi.fn(),
      mockShouldUseBuiltinForms: vi.fn(),
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
    shouldUseBuiltinForms: mockShouldUseBuiltinForms,
    getUIConfig: mockGetUIConfig,
  };
});

import { deviceVerifyHandler } from '../device-verify';

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

function createEnv(store: ReturnType<typeof createDeviceStore>): Env {
  return {
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
}) {
  return {
    req: {
      method: options.method,
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
    mockShouldUseBuiltinForms.mockResolvedValue(false);
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
        body: { user_code: 'not-valid' },
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
        user_code: 'WDJB-MJHT',
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
    expect(response.headers.get('Location')).toBe(
      '/device?error=This code has already been denied'
    );
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
});
