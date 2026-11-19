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

import app from '../index';

const SESSION_HEADER = 'X-Diagnostic-Session-Id';
const enabledEnv = {
  ISSUER_URL: 'https://issuer.example',
  AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
};
const post = (path: string, headers: Record<string, string>, env: Record<string, string>) =>
  app.request(`https://issuer.example${path}`, { method: 'POST', headers }, env);

/** Every performance.now() call advances the clock by 1.25 ms. */
function steppedClock(step = 1.25) {
  let now = 0;
  return vi.spyOn(performance, 'now').mockImplementation(() => {
    now += step;
    return now;
  });
}

describe('token request middleware diagnostics', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.rateLimitBlock.value = false;
    mocks.getRateLimitProfileAsync.mockReset().mockResolvedValue({ maxRequests: 7 });
    mocks.logInfo.mockReset();
    mocks.tokenHandler.mockReset().mockImplementation((c: Context) => c.json({ ok: true }, 201));
    mocks.adminAgentTokenHandler.mockReset().mockImplementation((c: Context) => c.json({}));
  });
  afterEach(() => vi.restoreAllMocks());

  it('emits per-middleware Server-Timing spans for an enabled diagnostic session', async () => {
    steppedClock();
    const response = await post('/token', { [SESSION_HEADER]: 'session-1' }, enabledEnv);
    expect(response.status).toBe(201);
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('session-1');
    const spans = (response.headers.get('Server-Timing') ?? '').split(', ');
    expect(spans).toEqual([
      'token_logger;dur=1.3',
      'token_request_context;dur=1.3',
      'token_diagnostic_logging;dur=1.3',
      'token_plugin_context;dur=1.3',
      'token_secure_headers;dur=1.3',
      'token_cors;dur=1.3',
      'token_rate_limit_profile;dur=1.3',
      'token_rate_limit;dur=1.3',
      'token_handler_downstream;dur=1.3',
      expect.stringMatching(/^token_total;dur=\d+\.\d$/u),
    ]);
    const total = Number(spans[9].split('dur=')[1]);
    // startedAt is the first clock reading; the total is read after the downstream span.
    expect(total).toBe(13.8);
    expect(mocks.logInfo).toHaveBeenCalledOnce();
    const [message, details] = mocks.logInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Token request middleware diagnostics');
    expect(details).toMatchObject({
      diagnosticSessionId: 'session-1',
      method: 'POST',
      path: '/token',
      status: 201,
      timingMs: {
        token_logger: 1.3,
        token_rate_limit_profile: 1.3,
        token_handler_downstream: 1.3,
        token_total: 13.8,
      },
    });
  });

  it('records the timing headers even when the token handler throws', async () => {
    steppedClock();
    mocks.tokenHandler.mockRejectedValue(new Error('boom'));
    const response = await post('/token', { [SESSION_HEADER]: 'session-err' }, enabledEnv);
    expect(response.status).toBe(500);
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('session-err');
    expect(response.headers.get('Server-Timing')).toContain('token_total;dur=');
  });

  it.each([
    ['replaces characters outside the safe set', ' a b/c<d>:e.f_g-h ', 'a_b_c_d_:e.f_g-h'],
    ['truncates to 128 characters', 'x'.repeat(200), 'x'.repeat(128)],
  ])('%s in the echoed session id', async (_name, raw, expected) => {
    const response = await post('/token', { [SESSION_HEADER]: raw }, enabledEnv);
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe(expected);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      'Token request middleware diagnostics',
      expect.objectContaining({ diagnosticSessionId: expected })
    );
  });

  it.each([
    ['without a session header', {}, enabledEnv],
    ['with a blank session header', { [SESSION_HEADER]: '   ' }, enabledEnv],
    [
      'when diagnostics are disabled',
      { [SESSION_HEADER]: 'session-1' },
      { ISSUER_URL: 'https://issuer.example' },
    ],
  ])('adds no timing headers %s', async (_name, headers, env) => {
    const clock = steppedClock();
    const response = await post('/token', headers, env);
    expect(response.status).toBe(201);
    expect(response.headers.get('Server-Timing')).toBeNull();
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
    expect(mocks.logInfo).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(mocks.getRateLimitProfileAsync).toHaveBeenCalledWith(expect.anything(), 'strict');
  });

  it('does not instrument other token endpoints', async () => {
    const response = await post(
      '/oauth/admin-agent/token',
      { [SESSION_HEADER]: 'session-1' },
      enabledEnv
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Server-Timing')).toBeNull();
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });
});
