import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rateCacheClear: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  clearRateLimitConfigCache: mocks.rateCacheClear,
  getProfileOverrideKVKey: vi.fn(() => 'rate_limit_profile_override'),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

import {
  clearProfileOverride,
  getProfileOverride,
  setProfileOverride,
} from '../routes/rate-limit-override';

function kv(initial: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(initial),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}
function context(
  options: {
    store?: ReturnType<typeof kv>;
    body?: unknown;
    bodyError?: boolean;
    param?: string;
    auth?: Record<string, unknown>;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    get: vi.fn((name: string) => (name === 'adminAuth' ? (options.auth ?? null) : undefined)),
    req: {
      param: vi.fn(() => options.param),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      ...(options.store ? { SETTINGS: options.store, AUTHRIM_CONFIG: options.store } : {}),
      ...(options.env ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('rate limit profile override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gets/sets/clears global profile override including load-test warning', async () => {
    await expect((await getProfileOverride(context())).json()).resolves.toMatchObject({
      profile_override: null,
    });
    const store = kv('loadTest');
    await expect((await getProfileOverride(context({ store }))).json()).resolves.toMatchObject({
      profile_override: 'loadTest',
    });
    expect((await setProfileOverride(context({ store, body: {} }))).status).toBe(400);
    expect((await setProfileOverride(context({ store, body: { profile: 'bad' } }))).status).toBe(
      400
    );
    const response = await setProfileOverride(context({ store, body: { profile: 'loadTest' } }));
    await expect(response.json()).resolves.toMatchObject({
      warning: expect.any(String),
      expires_in: 900,
    });
    expect(store.put).toHaveBeenLastCalledWith(
      'rate_limit_profile_override',
      expect.stringContaining('"profile":"loadTest","expires_at":'),
      { expirationTtl: 900 }
    );
    expect(
      (
        await setProfileOverride(
          context({ store, body: { profile: 'loadTest', expires_in: 1200 } })
        )
      ).status
    ).toBe(200);
    expect(store.put).toHaveBeenLastCalledWith(
      'rate_limit_profile_override',
      expect.stringContaining('"profile":"loadTest","expires_at":'),
      { expirationTtl: 1200 }
    );
    expect(
      (await setProfileOverride(context({ store, body: { profile: 'loadTest', expires_in: 59 } })))
        .status
    ).toBe(400);
    expect(
      (await setProfileOverride(context({ store, body: { profile: 'strict', expires_in: 120 } })))
        .status
    ).toBe(400);
    expect((await clearProfileOverride(context({ store }))).status).toBe(200);
  });

  it('shows the RATE_LIMIT_PROFILE override that applies when none is set', async () => {
    const env = { RATE_LIMIT_PROFILE: 'loadTest' };
    await expect(
      (await getProfileOverride(context({ store: kv(), env }))).json()
    ).resolves.toMatchObject({
      profile_override: null,
      env_profile_override: 'loadTest',
      effective_profile_override: 'loadTest',
    });
    await expect(
      (await clearProfileOverride(context({ store: kv(), env }))).json()
    ).resolves.toMatchObject({ env_profile_override: 'loadTest' });
  });

  it('shows when a stored override stops applying', async () => {
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const store = kv(JSON.stringify({ profile: 'loadTest', expires_at: expiresAt }));
    await expect((await getProfileOverride(context({ store }))).json()).resolves.toMatchObject({
      profile_override: 'loadTest',
      expires_at: Math.ceil(expiresAt / 1000),
    });
  });

  it('answers with the limits the rate limiter applies to the profile set', async () => {
    const store = kv();
    const settings = kv(JSON.stringify({ 'rate_limit.loadtest': 20000 }));
    const response = await setProfileOverride(
      context({ store, env: { SETTINGS: settings }, body: { profile: 'loadTest' } })
    );
    await expect(response.json()).resolves.toMatchObject({
      effective_config: { maxRequests: 20000, windowSeconds: 60 },
    });
  });

  it('requires KV for profile override mutation; an override it cannot read is not shown unset', async () => {
    expect((await setProfileOverride(context({ body: { profile: 'strict' } }))).status).toBe(500);
    expect((await clearProfileOverride(context())).status).toBe(500);
    const store = kv();
    store.get.mockRejectedValueOnce(new Error('failure'));
    expect((await getProfileOverride(context({ store }))).status).toBe(503);
  });
});
