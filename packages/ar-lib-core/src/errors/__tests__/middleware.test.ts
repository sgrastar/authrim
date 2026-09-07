import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AR_ERROR_CODES } from '../codes';
import {
  AuthrimError,
  RFCError,
  createErrorFactoryFromContext,
  createErrorResponse,
  createRFCErrorResponse,
  errorHandler,
  errorMiddleware,
} from '../middleware';

type TestEnv = { AUTHRIM_CONFIG?: { get: (key: string) => Promise<string | null> } };

function appWithError(
  error: unknown,
  env: TestEnv = {},
  options: Parameters<typeof errorMiddleware>[0] = {}
) {
  const app = new Hono<{ Bindings: TestEnv }>();
  app.onError(errorHandler(options));
  app.get('/test', () => {
    throw error;
  });
  app.get('/authorize', () => {
    throw error;
  });
  return { app, env };
}

describe('error middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes an Authrim error without leaking implementation details', async () => {
    const { app, env } = appWithError(
      new AuthrimError(AR_ERROR_CODES.AUTH_SESSION_EXPIRED, {
        state: 'state-1',
        extensions: { safe_hint: 'sign_in_again' },
      })
    );

    const response = await app.request('/authorize', {}, env);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.state).toBe('state-1');
    expect(JSON.stringify(body)).not.toContain('AuthrimError:');
  });

  it('serializes an RFC error in OAuth format', async () => {
    const { app, env } = appWithError(new RFCError('invalid_request', 400, 'Bad request'));

    const response = await app.request('/authorize', {}, env);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });

  it('uses problem details when requested by Accept header', async () => {
    const { app, env } = appWithError(new RFCError('invalid_request', 422, 'Invalid input'));

    const response = await app.request(
      '/test',
      { headers: { Accept: 'application/problem+json' } },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toMatchObject({ status: 422 });
  });

  it('calls the supplied unhandled-error hook and returns a masked internal error', async () => {
    const onError = vi.fn();
    const rawError = new Error('database password must never leak');
    const { app, env } = appWithError(rawError, {}, { onError });

    const response = await app.request('/test', {}, env);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledWith(rawError, expect.anything());
    expect(text).not.toContain('database password');
  });

  it('uses valid KV locale, format, and error-id settings', async () => {
    const values: Record<string, string> = {
      error_locale: 'ja',
      error_response_format: 'problem_details',
      error_id_mode: 'all',
    };
    const kv = { get: vi.fn(async (key: string) => values[key] ?? null) };
    const { app, env } = appWithError(new RFCError('invalid_request', 400), {
      AUTHRIM_CONFIG: kv,
    });

    const response = await app.request('/test', {}, env);

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(kv.get).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['invalid KV values', vi.fn(async () => 'invalid')],
    ['KV read failure', vi.fn(async () => Promise.reject(new Error('KV unavailable')))],
  ])('falls back safely after %s', async (_label, get) => {
    const { app, env } = appWithError(new RFCError('invalid_request', 400), {
      AUTHRIM_CONFIG: { get },
    });

    const response = await app.request('/authorize', {}, env);

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('honors explicit middleware defaults when KV has no overrides', async () => {
    const kv = { get: vi.fn(async () => null) };
    const { app, env } = appWithError(
      new RFCError('invalid_request', 400),
      {
        AUTHRIM_CONFIG: kv,
      },
      {
        locale: 'ja',
        format: 'problem_details',
        errorIdMode: 'none',
        baseUrl: 'https://errors.example.com',
      }
    );

    const response = await app.request('/test', {}, env);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(String(body.type)).toContain('errors.example.com');
  });

  it('handles runtimes that propagate downstream errors through next()', async () => {
    const middleware = errorMiddleware();
    const context = {
      env: {},
      req: { path: '/authorize', header: () => undefined },
    } as never;

    const response = (await middleware(context, async () => {
      throw new RFCError('invalid_request', 400, 'Invalid');
    })) as Response;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('does not replace a successful downstream response', async () => {
    const middleware = errorMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    const result = await middleware(
      { env: {}, req: { path: '/test', header: () => undefined } } as never,
      next
    );

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('error response helpers', () => {
  it('creates a configured factory from a Hono context', async () => {
    const app = new Hono<{ Bindings: TestEnv }>();
    app.get('/factory', async (c) => {
      const factory = await createErrorFactoryFromContext(c);
      const descriptor = factory.create(AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
      return c.json({ code: descriptor.code });
    });

    const response = await app.request('/factory');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: AR_ERROR_CODES.AUTH_SESSION_EXPIRED,
    });
  });

  it('creates an Authrim error response directly', async () => {
    const app = new Hono();
    app.get('/error', (c) =>
      createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED, { state: 'state-2' })
    );

    const response = await app.request('/error');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.state).toBe('state-2');
  });

  it('creates a legacy RFC response without throwing', async () => {
    const app = new Hono();
    app.get('/error', (c) => createRFCErrorResponse(c, 'invalid_request', 400, 'Invalid'));

    const response = await app.request('/error');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });
});
