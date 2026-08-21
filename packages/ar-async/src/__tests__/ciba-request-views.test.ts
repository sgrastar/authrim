import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CIBARequestMetadata, Env } from '@authrim/ar-lib-core';

const { mockGetClient, mockLogger, mockCreateAuthContextFromHono } = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    mockGetClient: vi.fn(),
    mockLogger: logger,
    mockCreateAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: vi.fn(() => mockLogger),
    getClient: mockGetClient,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    isMockAuthEnabled: vi.fn().mockResolvedValue(true),
  };
});

import { cibaDetailsHandler } from '../ciba-details';
import { cibaPendingHandler } from '../ciba-pending';

function createCibaMetadata(overrides: Partial<CIBARequestMetadata> = {}): CIBARequestMetadata {
  const now = Math.floor(Date.now() / 1000);
  return {
    auth_req_id: 'auth-req-123',
    client_id: 'client-123',
    scope: 'openid profile',
    binding_message: 'Confirm sign-in',
    user_code: 'ABCD-1234',
    login_hint: 'user@example.com',
    created_at: now - 10,
    expires_at: now + 290,
    status: 'pending',
    expires_in: 300,
    interval: 5,
    poll_count: 0,
    last_poll_at: 0,
    ...overrides,
  } as CIBARequestMetadata;
}

function createStore(responseFactory: (request: Request) => Promise<Response> | Response) {
  return {
    fetch: vi.fn(responseFactory),
  };
}

function createEnv(store: ReturnType<typeof createStore>): Env {
  return {
    CIBA_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue('ciba-store-id'),
      get: vi.fn().mockReturnValue(store),
    },
  } as unknown as Env;
}

function createContext(options: {
  env: Env;
  authReqId?: string;
  query?: Record<string, string | undefined>;
  tenantId?: string | null;
}) {
  return {
    req: {
      param: vi.fn((name: string) => (name === 'auth_req_id' ? options.authReqId : undefined)),
      query: vi.fn((name: string) => options.query?.[name]),
    },
    env: options.env,
    get: vi.fn((name: string) =>
      name === 'tenantId' ? (options.tenantId ?? 'tenant-1') : undefined
    ),
    json: vi.fn(
      (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as never;
}

describe('CIBA request view APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockGetClient.mockResolvedValue({
      client_id: 'client-123',
      client_name: 'Banking App',
      logo_uri: 'https://client.example.com/logo.png',
      is_trusted: true,
    });
  });

  describe('cibaDetailsHandler', () => {
    it('returns enriched request details with bounded time remaining', async () => {
      vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
      const metadata = createCibaMetadata({
        created_at: Math.floor(Date.now() / 1000) - 20,
        expires_at: Math.floor(Date.now() / 1000) + 180,
      });
      const store = createStore(async (request) => {
        expect(new URL(request.url).pathname).toBe('/get-by-auth-req-id');
        await expect(request.json()).resolves.toEqual({ auth_req_id: 'auth-req-123' });
        return new Response(JSON.stringify(metadata), { status: 200 });
      });
      const ctx = createContext({
        env: createEnv(store),
        authReqId: 'auth-req-123',
      });

      const response = await cibaDetailsHandler(ctx);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        auth_req_id: 'auth-req-123',
        client: {
          client_id: 'client-123',
          client_name: 'Banking App',
          logo_uri: 'https://client.example.com/logo.png',
          is_trusted: true,
        },
        scope: 'openid profile',
        binding_message: 'Confirm sign-in',
        user_code: 'ABCD-1234',
        status: 'pending',
        time_remaining: 180,
      });
      expect(mockGetClient).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'client-123', {});
    });

    it('returns not_found when the stored CIBA request is absent', async () => {
      const store = createStore(
        () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
      );
      const ctx = createContext({
        env: createEnv(store),
        authReqId: 'missing-request',
      });

      const response = await cibaDetailsHandler(ctx);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(404);
      expect(body.error_description).toContain('not found');
    });

    it('requires auth_req_id before reading the CIBA request store', async () => {
      const store = createStore(
        () => new Response(JSON.stringify(createCibaMetadata()), { status: 200 })
      );
      const ctx = createContext({
        env: createEnv(store),
      });

      const response = await cibaDetailsHandler(ctx);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(store.fetch).not.toHaveBeenCalled();
    });
  });

  describe('cibaPendingHandler', () => {
    it('lists pending requests for login_hint and enriches client display fields', async () => {
      const metadata = createCibaMetadata();
      const store = createStore(async (request) => {
        expect(new URL(request.url).pathname).toBe('/get-by-login-hint');
        await expect(request.json()).resolves.toEqual({ login_hint: 'user@example.com' });
        return new Response(JSON.stringify(metadata), { status: 200 });
      });
      const ctx = createContext({
        env: createEnv(store),
        query: {
          login_hint: 'user@example.com',
        },
      });

      const response = await cibaPendingHandler(ctx);
      const body = (await response.json()) as { requests: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.requests).toEqual([
        expect.objectContaining({
          auth_req_id: 'auth-req-123',
          client_id: 'client-123',
          client_name: 'Banking App',
          client_logo_uri: 'https://client.example.com/logo.png',
          scope: 'openid profile',
          binding_message: 'Confirm sign-in',
          user_code: 'ABCD-1234',
          status: 'pending',
        }),
      ]);
    });

    it('uses user_id as a sub login hint only when login_hint is absent', async () => {
      const store = createStore(async (request) => {
        await expect(request.json()).resolves.toEqual({ login_hint: 'sub:user-123' });
        return new Response(JSON.stringify(null), { status: 200 });
      });
      const ctx = createContext({
        env: createEnv(store),
        query: {
          user_id: 'user-123',
        },
      });

      const response = await cibaPendingHandler(ctx);
      const body = (await response.json()) as { requests: unknown[] };

      expect(response.status).toBe(200);
      expect(body.requests).toEqual([]);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('returns an empty list for non-pending request metadata', async () => {
      const store = createStore(
        () =>
          new Response(JSON.stringify(createCibaMetadata({ status: 'approved' })), { status: 200 })
      );
      const ctx = createContext({
        env: createEnv(store),
        query: {
          login_hint: 'user@example.com',
        },
      });

      const response = await cibaPendingHandler(ctx);
      const body = (await response.json()) as { requests: unknown[] };

      expect(response.status).toBe(200);
      expect(body.requests).toEqual([]);
      expect(mockGetClient).not.toHaveBeenCalled();
    });

    it('requires either login_hint or user_id before reading the CIBA request store', async () => {
      const store = createStore(
        () => new Response(JSON.stringify(createCibaMetadata()), { status: 200 })
      );
      const ctx = createContext({
        env: createEnv(store),
        query: {},
      });

      const response = await cibaPendingHandler(ctx);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(store.fetch).not.toHaveBeenCalled();
    });
  });
});
