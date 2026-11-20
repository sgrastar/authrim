import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIP: vi.fn(),
  readLiteModeState: vi.fn(),
  readLiteRuntimeState: vi.fn(),
  loadPowKeyringFromEnv: vi.fn(),
  readLitePowSettings: vi.fn(),
  createPowChallenge: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  ...m,
  getTenantIdFromContext: () => 'tenant-a',
}));

import {
  liteAtomicBudget,
  liteModeEndpointUnavailable,
  litePowChallengeHandler,
} from '../lite-mode';

function ctx(
  query: Record<string, string> = {},
  env: Record<string, unknown> = { LITE_POLICY_STORE: {} }
) {
  const headers = new Map<string, string>();
  return {
    env,
    req: { query: (name: string) => query[name] },
    header: (name: string, value: string) => headers.set(name, value),
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
    _headers: headers,
  };
}

async function read(response: Response | null) {
  return response ? { status: response.status, body: await response.json() } : null;
}

const LIMITS = { perIpPerMinute: 5, perTenantPerMinute: 50 };

beforeEach(() => {
  vi.clearAllMocks();
  m.getClientIP.mockReturnValue('198.51.100.7');
  m.checkRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
  m.readLiteRuntimeState.mockResolvedValue({ policyRevision: 7 });
  m.loadPowKeyringFromEnv.mockReturnValue({ keys: [] });
  m.readLitePowSettings.mockResolvedValue({
    issuePerIpPerMinute: 3,
    issuePerTenantPerMinute: 30,
    maxNumber: 1000,
    ttlSeconds: 120,
  });
  m.createPowChallenge.mockResolvedValue({ salt: 's' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liteModeEndpointUnavailable', () => {
  it('refuses without caching', async () => {
    const c = ctx();
    expect(await read(liteModeEndpointUnavailable(c as never))).toEqual({
      status: 403,
      body: {
        error: 'lite_mode_endpoint_unavailable',
        error_description: 'This tenant uses the lite Login UI, which does not use this endpoint',
      },
    });
    expect(c._headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('liteAtomicBudget', () => {
  it('counts the IP, then the tenant, atomically', async () => {
    expect(await liteAtomicBudget(ctx() as never, 'tenant-a', 'cls', LIMITS)).toBeNull();
    expect(m.getClientIP).toHaveBeenCalledWith(expect.anything(), 'cloudflare');
    expect(m.checkRateLimit.mock.calls).toEqual([
      [
        expect.anything(),
        '198.51.100.7',
        { maxRequests: 5, windowSeconds: 60, endpointClass: 'cls', requireAtomic: true },
        'tenant-a',
      ],
      [
        expect.anything(),
        'tenant-total',
        { maxRequests: 50, windowSeconds: 60, endpointClass: 'cls', requireAtomic: true },
        'tenant-a',
      ],
    ]);
  });

  it('counts an unknown IP under one key', async () => {
    m.getClientIP.mockReturnValue('');
    await liteAtomicBudget(ctx() as never, 'tenant-a', 'cls', LIMITS);
    expect(m.checkRateLimit.mock.calls[0][1]).toBe('unknown');
  });

  it('refuses with Retry-After until the window resets, at least one second', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const now = 1_800_000_000;
    m.checkRateLimit.mockResolvedValueOnce({ allowed: false, resetAt: now + 30 });
    const c = ctx();
    expect(await read(await liteAtomicBudget(c as never, 'tenant-a', 'cls', LIMITS))).toEqual({
      status: 429,
      body: {
        error: 'rate_limit_exceeded',
        error_description: 'Too many requests; try again later',
      },
    });
    expect(c._headers.get('Retry-After')).toBe('30');
    expect(c._headers.get('Cache-Control')).toBe('no-store');
    expect(m.checkRateLimit).toHaveBeenCalledTimes(1);

    m.checkRateLimit.mockResolvedValueOnce({ allowed: true, resetAt: 0 });
    m.checkRateLimit.mockResolvedValueOnce({ allowed: false, resetAt: now - 5 });
    const late = ctx();
    expect((await liteAtomicBudget(late as never, 'tenant-a', 'cls', LIMITS))?.status).toBe(429);
    expect(late._headers.get('Retry-After')).toBe('1');
  });

  it('answers 503 without caching when the counter cannot be reached', async () => {
    m.checkRateLimit.mockRejectedValueOnce(new Error('do'));
    const c = ctx();
    expect(await read(await liteAtomicBudget(c as never, 'tenant-a', 'cls', LIMITS))).toEqual({
      status: 503,
      body: { error: 'temporarily_unavailable', error_description: 'Try again in a moment' },
    });
    expect(c._headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('litePowChallengeHandler', () => {
  it('refuses a missing or unknown action', async () => {
    for (const query of [{}, { action: 'register' }] as Array<Record<string, string>>) {
      expect(await read(await litePowChallengeHandler(ctx(query) as never))).toEqual({
        status: 400,
        body: { error: 'invalid_request', error_description: 'Unknown action' },
      });
    }
  });

  it('is not found without a policy store or for a tenant that is off', async () => {
    expect(
      await read(await litePowChallengeHandler(ctx({ action: 'login' }, {}) as never))
    ).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    m.readLiteRuntimeState.mockResolvedValueOnce('off');
    expect((await litePowChallengeHandler(ctx({ action: 'login' }) as never))?.status).toBe(404);
  });

  it('answers 503 when the mode or the keyring is unavailable', async () => {
    const unavailable = { status: 503, body: { error: 'temporarily_unavailable' } };
    m.readLiteRuntimeState.mockResolvedValueOnce('unknown');
    expect(await read(await litePowChallengeHandler(ctx({ action: 'login' }) as never))).toEqual(
      unavailable
    );
    m.loadPowKeyringFromEnv.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    expect(await read(await litePowChallengeHandler(ctx({ action: 'signup' }) as never))).toEqual(
      unavailable
    );
    m.loadPowKeyringFromEnv.mockReturnValueOnce(null);
    expect(await read(await litePowChallengeHandler(ctx({ action: 'reauth' }) as never))).toEqual(
      unavailable
    );
    expect(m.createPowChallenge).not.toHaveBeenCalled();
  });

  it('issues a challenge within the issue budget and the configured size', async () => {
    const res = await read(await litePowChallengeHandler(ctx({ action: 'signup' }) as never));
    expect(res).toEqual({ status: 200, body: { challenge: { salt: 's' }, policy_revision: 7 } });
    expect(m.checkRateLimit.mock.calls[0][2]).toMatchObject({
      maxRequests: 3,
      endpointClass: 'litePowIssue',
    });
    expect(m.checkRateLimit.mock.calls[1][2]).toMatchObject({ maxRequests: 30 });
    expect(m.createPowChallenge).toHaveBeenCalledWith(
      { keys: [] },
      { tenantId: 'tenant-a', action: 'signup', policyRevision: 7 },
      { maxNumber: 1000, ttlSeconds: 120 }
    );
  });
});
