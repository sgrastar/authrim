import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';

const mocks = vi.hoisted(() => ({
  rateLimitOptions: [] as Array<Record<string, unknown>>,
  diagnosticLoggingOptions: [] as Array<{ excludePatterns: RegExp[] }>,
  healthConfigs: [] as Array<Record<string, unknown>>,
  getRateLimitProfileAsync: vi.fn(),
  rateLimitBlock: { value: false },
  writeFence: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  tokenHandler: vi.fn(),
  adminAgentTokenHandler: vi.fn(),
  adminAgentDelegationHandler: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const passThrough = () => async (_c: Context, next: Next) => next();
  return {
    ...actual,
    requestContextMiddleware: passThrough,
    pluginContextMiddleware: passThrough,
    diagnosticLoggingMiddleware: (options: { excludePatterns: RegExp[] }) => {
      mocks.diagnosticLoggingOptions.push(options);
      return passThrough();
    },
    getRateLimitProfileAsync: mocks.getRateLimitProfileAsync,
    rateLimitMiddleware: (options: Record<string, unknown>) => {
      mocks.rateLimitOptions.push(options);
      return async (c: Context, next: Next) =>
        mocks.rateLimitBlock.value ? c.json({ error: 'rate_limited' }, 429) : next();
    },
    createHealthCheckHandlers: (config: Record<string, unknown>) => {
      mocks.healthConfigs.push(config);
      return {
        liveness: (c: Context) => c.json({ probe: 'live' }),
        readiness: (c: Context) => c.json({ probe: 'ready' }),
      };
    },
    createTenantPlacementWriteFenceResponse: mocks.writeFence,
    getLogger: () => ({ module: () => ({ info: mocks.logInfo, error: mocks.logError }) }),
  };
});
vi.mock('../token', () => ({ tokenHandler: mocks.tokenHandler }));
vi.mock('../admin-agent-token', () => ({
  adminAgentTokenHandler: mocks.adminAgentTokenHandler,
  adminAgentDelegationHandler: mocks.adminAgentDelegationHandler,
}));

import app, { SAML_DR_WRITER_SURFACES } from '../index';

const env = { ISSUER_URL: 'https://issuer.example' };
const post = (path: string, headers: Record<string, string> = {}) =>
  app.request(`https://issuer.example${path}`, { method: 'POST', headers }, env);

describe('token worker app wiring', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.rateLimitOptions.length = 0;
    mocks.rateLimitBlock.value = false;
    mocks.getRateLimitProfileAsync.mockReset().mockResolvedValue({
      maxRequests: 7,
      windowSeconds: 30,
    });
    mocks.writeFence.mockReset().mockReturnValue(null);
    mocks.logError.mockReset();
    for (const handler of [
      mocks.tokenHandler,
      mocks.adminAgentTokenHandler,
      mocks.adminAgentDelegationHandler,
    ]) {
      handler.mockReset().mockImplementation((c: Context) => c.json({ handled: c.req.path }));
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('builds the health probes and diagnostic logging exclusions once at module load', () => {
    expect(mocks.healthConfigs).toEqual([
      {
        serviceName: 'op-token',
        version: '0.1.0',
        checkDatabase: true,
        checkKV: true,
        checkKeyManager: true,
      },
    ]);
    const [{ excludePatterns }] = mocks.diagnosticLoggingOptions;
    const excluded = (path: string) => excludePatterns.some((pattern) => pattern.test(path));
    expect(excluded('/api/health')).toBe(true);
    expect(excluded('/health/live')).toBe(true);
    expect(excluded('/internal/metrics')).toBe(true);
    expect(excluded('/token')).toBe(false);
    expect(excluded('/x/api/health')).toBe(false);
    expect(excluded('/x/health/live')).toBe(false);
    expect(excluded('/x/internal/y')).toBe(false);
    expect(SAML_DR_WRITER_SURFACES).toEqual(['fetch']);
  });

  it.each([
    ['/token', () => mocks.tokenHandler],
    ['/oauth/admin-agent/token', () => mocks.adminAgentTokenHandler],
    ['/oauth/admin-agent/delegation', () => mocks.adminAgentDelegationHandler],
  ])('rate limits %s with the strict atomic profile before its handler', async (path, handler) => {
    const response = await post(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: path });
    expect(handler()).toHaveBeenCalledOnce();
    expect(mocks.getRateLimitProfileAsync).toHaveBeenCalledWith(
      expect.objectContaining(env),
      'strict'
    );
    expect(mocks.rateLimitOptions).toEqual([
      { maxRequests: 7, windowSeconds: 30, endpoints: [path], requireAtomic: true },
    ]);
  });

  it.each(['/token', '/oauth/admin-agent/token', '/oauth/admin-agent/delegation'])(
    'does not reach the %s handler when the rate limiter rejects',
    async (path) => {
      mocks.rateLimitBlock.value = true;
      const response = await post(path);
      expect(response.status).toBe(429);
      expect(mocks.tokenHandler).not.toHaveBeenCalled();
      expect(mocks.adminAgentTokenHandler).not.toHaveBeenCalled();
      expect(mocks.adminAgentDelegationHandler).not.toHaveBeenCalled();
    }
  );

  it('serves the health endpoints without rate limiting', async () => {
    const health = await app.request('https://issuer.example/api/health', {}, env);
    const body = await health.json<Record<string, string>>();
    expect(body).toMatchObject({ status: 'ok', service: 'op-token' });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    await expect(
      (await app.request('https://issuer.example/health/live', {}, env)).json()
    ).resolves.toEqual({ probe: 'live' });
    await expect(
      (await app.request('https://issuer.example/health/ready', {}, env)).json()
    ).resolves.toEqual({ probe: 'ready' });
    expect(mocks.rateLimitOptions).toEqual([]);
  });

  it('only routes POST to the token endpoints and answers unknown routes with not_found', async () => {
    const unknown = await app.request('https://issuer.example/nope', {}, env);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: 'not_found',
      message: 'The requested resource was not found',
    });
    const getToken = await app.request('https://issuer.example/token', {}, env);
    expect(getToken.status).toBe(404);
    expect(mocks.tokenHandler).not.toHaveBeenCalled();
  });

  it('hides unhandled errors behind a generic server_error and logs them', async () => {
    const failure = new Error('database exploded');
    mocks.tokenHandler.mockRejectedValue(failure);
    const response = await post('/token');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    });
    expect(mocks.writeFence).toHaveBeenCalledWith(expect.anything(), failure);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Unhandled error',
      { action: 'error_handler' },
      failure
    );
  });

  it('returns the tenant placement write-fence response when the error is a fence', async () => {
    mocks.tokenHandler.mockRejectedValue(new Error('fenced'));
    mocks.writeFence.mockReturnValue(new Response('fenced', { status: 409 }));
    const response = await post('/token');
    expect(response.status).toBe(409);
    expect(await response.text()).toBe('fenced');
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('applies the security headers to every response', async () => {
    const response = await post('/token');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
        "connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'self'; frame-src 'none'"
    );
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload'
    );
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('answers CORS preflight with the token endpoint policy', async () => {
    const response = await app.request(
      'https://issuer.example/token',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://rp.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'DPoP',
        },
      },
      env
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST,OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Content-Type,Authorization,DPoP,X-Diagnostic-Session-Id'
    );
    expect(response.headers.get('access-control-max-age')).toBe('86400');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(mocks.tokenHandler).not.toHaveBeenCalled();
  });

  it('exposes rate limit and diagnostic headers to cross-origin callers', async () => {
    const response = await post('/token', { Origin: 'https://rp.example' });
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Server-Timing,X-Authrim-Diagnostic-Session-Id'
    );
  });
});
