/**
 * POST /device_authorization: a user code another live device code holds is refused by the
 * store (409), and the endpoint draws another one, a bounded number of times.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { deviceAuthorizationHandler } from '../device-authorization';
import { formRequest, realRateLimiter } from './real-rate-limiter';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  generateUserCode: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    module: vi.fn().mockReturnThis(),
    startTimer: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClientCached: vi.fn().mockImplementation(() => mocks.getClient()),
    generateUserCode: mocks.generateUserCode,
    getLogger: () => mocks.logger,
  };
});

function context(env: Partial<Env>) {
  return {
    req: {
      ...formRequest({ client_id: 'device-client', scope: 'openid' }),
    },
    json: vi.fn((data: unknown, status = 200, headers?: Record<string, string>) =>
      Response.json(data, { status, headers })
    ),
    env,
  } as never;
}

function envWithStore(statuses: number[]) {
  const stored: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (request: Request) => {
    stored.push((await request.json()) as Record<string, unknown>);
    const status = statuses[stored.length - 1] ?? 200;
    return status === 409
      ? Response.json({ error: 'user_code_conflict' }, { status })
      : Response.json(status === 200 ? { success: true } : { error: 'server_error' }, { status });
  });
  const env = {
    ISSUER_URL: 'https://auth.example.com',
    UI_URL: 'https://ui.example.com',
    RATE_LIMITER: realRateLimiter().namespace,
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-store'),
      get: vi.fn().mockReturnValue({ fetch }),
    },
  } as unknown as Partial<Env>;
  return { env, fetch, stored };
}

describe('device authorization user code retries', () => {
  beforeEach(() => {
    mocks.getClient
      .mockReset()
      .mockResolvedValue({ client_id: 'device-client', token_endpoint_auth_method: 'none' });
    let drawn = 0;
    mocks.generateUserCode.mockReset().mockImplementation(() => `AAAA-${2000 + ++drawn}`);
  });

  it('stores the first user code when the store accepts it, with the interval on the code', async () => {
    const { env, stored } = envWithStore([200]);

    const response = await deviceAuthorizationHandler(context(env));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ user_code: 'AAAA-2001', expires_in: 600, interval: 5 });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ user_code: 'AAAA-2001', interval: 5, poll_count: 0 });
  });

  it('draws another user code after a conflict, keeping the device code', async () => {
    const { env, fetch, stored } = envWithStore([409, 409, 200]);

    const response = await deviceAuthorizationHandler(context(env));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stored.map((entry) => entry.user_code)).toEqual(['AAAA-2001', 'AAAA-2002', 'AAAA-2003']);
    expect(new Set(stored.map((entry) => entry.device_code)).size).toBe(1);
    // What the device is told is what was stored last
    expect(body.user_code).toBe('AAAA-2003');
    expect(body.device_code).toBe(stored[2].device_code);
    expect(body.verification_uri_complete).toContain('user_code=AAAA-2003');
  });

  it('gives up after 5 conflicts with a retryable 503 that names no code', async () => {
    const { env, fetch } = envWithStore([409, 409, 409, 409, 409, 200]);

    const response = await deviceAuthorizationHandler(context(env));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'temporarily_unavailable' });
    expect(text).not.toMatch(/AAAA-|device_code|user_code/);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not retry a store failure that is not a conflict', async () => {
    const { env, fetch } = envWithStore([500]);

    const response = await deviceAuthorizationHandler(context(env));

    expect(response.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
