import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uiConfig: vi.fn(),
  uiSource: vi.fn(),
  uiRouting: vi.fn(),
  validateUI: vi.fn(),
  parseOrigins: vi.fn(),
  uiChange: vi.fn(),
  uiFailure: vi.fn(),
  canonicalUrl: vi.fn(),
  oauthSources: vi.fn(),
  oauthSet: vi.fn(),
  oauthClear: vi.fn(),
  oauthClearAll: vi.fn(),
  rateCacheClear: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getUIConfig: mocks.uiConfig,
  getUIConfigSource: mocks.uiSource,
  getUIRoutingConfig: mocks.uiRouting,
  validateUIBaseUrl: mocks.validateUI,
  parseAllowedOriginsEnv: mocks.parseOrigins,
  logUIConfigChange: mocks.uiChange,
  logUIConfigValidationFailure: mocks.uiFailure,
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  createOAuthConfigManager: vi.fn(() => ({
    getConfigSources: mocks.oauthSources,
    setConfig: mocks.oauthSet,
    clearConfig: mocks.oauthClear,
    clearAllConfig: mocks.oauthClearAll,
  })),
  clearRateLimitConfigCache: mocks.rateCacheClear,
  getProfileOverrideKVKey: vi.fn(() => 'rate_limit_profile_override'),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

vi.mock('../request-issuer', () => ({ getCanonicalTenantBaseUrl: mocks.canonicalUrl }));

import {
  deleteUIConfigHandler,
  deleteUIRoutingHandler,
  getUIConfigHandler,
  getUIRoutingHandler,
  updateUIConfigHandler,
  updateUIRoutingHandler,
} from '../routes/settings/ui-config';
import {
  clearAllOAuthConfig,
  clearOAuthConfig,
  getOAuthConfig,
  updateOAuthConfig,
} from '../routes/settings/oauth-config';
import {
  clearProfileOverride,
  getProfileOverride,
  getRateLimitProfile,
  getRateLimitSettings,
  resetRateLimitProfile,
  setProfileOverride,
  updateRateLimitProfile,
} from '../routes/settings/rate-limit';
import { CONFIG_NAMES, CONFIG_METADATA, DEFAULT_CONFIG } from '@authrim/ar-lib-core';

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

describe('UI, OAuth, and rate-limit settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uiConfig.mockResolvedValue(null);
    mocks.uiSource.mockResolvedValue('none');
    mocks.uiRouting.mockResolvedValue(null);
    mocks.validateUI.mockReturnValue({ valid: true });
    mocks.parseOrigins.mockReturnValue([]);
    mocks.canonicalUrl.mockReturnValue('https://issuer.example');
    mocks.oauthSet.mockResolvedValue(undefined);
    mocks.oauthClear.mockResolvedValue(undefined);
    mocks.oauthClearAll.mockResolvedValue(undefined);
    const sources = Object.fromEntries(
      CONFIG_NAMES.map((name) => [name, { value: DEFAULT_CONFIG[name], source: 'default' }])
    );
    mocks.oauthSources.mockResolvedValue(sources);
  });

  it('gets UI config/routing with defaults and explicit values', async () => {
    await expect((await getUIConfigHandler(context())).json()).resolves.toMatchObject({
      config: { baseUrl: null },
      source: 'none',
    });
    await expect((await getUIRoutingHandler(context())).json()).resolves.toEqual({
      routing: { rolePathOverrides: {}, policyRedirects: [] },
    });
    mocks.uiConfig.mockResolvedValueOnce({ baseUrl: 'https://login.example', paths: {} });
    mocks.uiSource.mockResolvedValueOnce('kv');
    mocks.uiRouting.mockResolvedValueOnce({
      rolePathOverrides: { admin: { login: '/admin' } },
      policyRedirects: [],
    });
    await expect((await getUIConfigHandler(context())).json()).resolves.toMatchObject({
      source: 'kv',
    });
    await expect((await getUIRoutingHandler(context())).json()).resolves.toMatchObject({
      routing: { rolePathOverrides: expect.anything() },
    });
  });

  it.each([
    [{ baseUrl: 'javascript:alert(1)' }],
    [{ paths: { login: 'relative' } }],
    [{ paths: { login: 1 } }],
  ])('rejects unsafe UI config %#', async (body) => {
    if ('baseUrl' in body)
      mocks.validateUI.mockReturnValueOnce({ valid: false, error: 'HTTPS required' });
    expect((await updateUIConfigHandler(context({ store: kv(), body }))).status).toBe(400);
  });

  it.each([null, '', 'https://login.example'])('updates/clears UI base URL %#', async (baseUrl) => {
    const store = kv(
      JSON.stringify({
        unrelated: true,
        ui: { baseUrl: 'https://old.example', paths: { login: '/old' } },
      })
    );
    const response = await updateUIConfigHandler(
      context({ store, body: { baseUrl, paths: { login: '/login' } }, auth: { userId: 'admin-1' } })
    );
    expect(response.status).toBe(200);
    const saved = JSON.parse(store.put.mock.calls[0][1]);
    expect(saved.unrelated).toBe(true);
    expect(saved.ui.paths.login).toBe('/login');
    expect(saved.ui.hasOwnProperty('baseUrl')).toBe(Boolean(baseUrl));
    expect(mocks.uiChange).toHaveBeenCalled();
  });

  it('starts UI settings fresh when stored JSON is corrupt', async () => {
    const store = kv('{');
    expect(
      (await updateUIConfigHandler(context({ store, body: { paths: { consent: '/consent' } } })))
        .status
    ).toBe(200);
  });

  it('deletes UI config/routing while preserving unrelated settings', async () => {
    const store = kv(
      JSON.stringify({
        unrelated: true,
        ui: { baseUrl: 'https://login' },
        routing: { policyRedirects: [] },
      })
    );
    expect(
      (
        await deleteUIConfigHandler(
          context({ store, auth: { authMethod: 'machine_access_token' } })
        )
      ).status
    ).toBe(200);
    expect(JSON.parse(store.put.mock.calls[0][1])).toEqual({
      unrelated: true,
      routing: { policyRedirects: [] },
    });
    store.get.mockResolvedValueOnce(
      JSON.stringify({ unrelated: true, routing: { policyRedirects: [] } })
    );
    expect((await deleteUIRoutingHandler(context({ store }))).status).toBe(200);
    expect(JSON.parse(store.put.mock.calls[1][1])).toEqual({ unrelated: true });
  });

  it.each([
    [{ rolePathOverrides: { admin: { login: 'relative' } } }],
    [{ rolePathOverrides: { '': { login: '/admin' } } }],
    [{ policyRedirects: [{ conditions: 'bad', redirectPath: '/admin' }] }],
    [{ policyRedirects: [{ conditions: [], redirectPath: 'relative' }] }],
  ])('rejects invalid UI routing %#', async (body) => {
    expect((await updateUIRoutingHandler(context({ store: kv(), body }))).status).toBe(400);
  });

  it('merges valid role and policy routing', async () => {
    const store = kv(
      JSON.stringify({ routing: { rolePathOverrides: { viewer: { login: '/view' } } } })
    );
    const body = {
      rolePathOverrides: { admin: { login: '/admin' } },
      policyRedirects: [{ conditions: [], redirectPath: '/step-up' }],
    };
    expect((await updateUIRoutingHandler(context({ store, body }))).status).toBe(200);
    expect(mocks.uiChange).toHaveBeenCalled();
  });

  it('gets OAuth config metadata and handles manager error', async () => {
    const response = await getOAuthConfig(context());
    const body = (await response.json()) as { configs: Record<string, unknown> };
    expect(Object.keys(body.configs)).toEqual(CONFIG_NAMES);
    expect(body.configs[CONFIG_NAMES[0]]).toMatchObject({
      metadata: CONFIG_METADATA[CONFIG_NAMES[0]],
    });
    mocks.oauthSources.mockRejectedValueOnce(new Error('failure'));
    expect((await getOAuthConfig(context())).status).toBe(500);
  });

  it('rejects unknown/missing/wrong-type OAuth updates', async () => {
    expect(
      (await updateOAuthConfig(context({ param: 'unknown', body: { value: 1 } }))).status
    ).toBe(400);
    const numberName = CONFIG_NAMES.find((name) => CONFIG_METADATA[name].type === 'number')!;
    expect((await updateOAuthConfig(context({ param: numberName, body: {} }))).status).toBe(400);
    expect(
      (await updateOAuthConfig(context({ param: numberName, body: { value: 'bad' } }))).status
    ).toBe(400);
    const booleanName = CONFIG_NAMES.find((name) => CONFIG_METADATA[name].type === 'boolean')!;
    expect(
      (await updateOAuthConfig(context({ param: booleanName, body: { value: 1 } }))).status
    ).toBe(400);
  });

  it('validates numeric OAuth ranges and persists valid number/boolean', async () => {
    const numberName = CONFIG_NAMES.find(
      (name) =>
        CONFIG_METADATA[name].type === 'number' &&
        CONFIG_METADATA[name].min !== undefined &&
        CONFIG_METADATA[name].max !== undefined
    )!;
    const metadata = CONFIG_METADATA[numberName];
    expect(
      (
        await updateOAuthConfig(
          context({ store: kv(), param: numberName, body: { value: Number.NaN } })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await updateOAuthConfig(
          context({ store: kv(), param: numberName, body: { value: metadata.min! - 1 } })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await updateOAuthConfig(
          context({ store: kv(), param: numberName, body: { value: metadata.max! + 1 } })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await updateOAuthConfig(
          context({ store: kv(), param: numberName, body: { value: metadata.min! } })
        )
      ).status
    ).toBe(200);
    const booleanName = CONFIG_NAMES.find((name) => CONFIG_METADATA[name].type === 'boolean')!;
    expect(
      (
        await updateOAuthConfig(
          context({ store: kv(), param: booleanName, body: { value: false } })
        )
      ).status
    ).toBe(200);
  });

  it('requires KV and sanitizes OAuth persistence failures', async () => {
    const name = CONFIG_NAMES[0];
    expect(
      (await updateOAuthConfig(context({ param: name, body: { value: DEFAULT_CONFIG[name] } })))
        .status
    ).toBe(500);
    mocks.oauthSet.mockRejectedValueOnce(new Error('secret database detail'));
    const response = await updateOAuthConfig(
      context({ store: kv(), param: name, body: { value: DEFAULT_CONFIG[name] } })
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret database detail');
  });

  it('clears one/all OAuth config and validates availability', async () => {
    expect((await clearOAuthConfig(context({ param: 'unknown', store: kv() }))).status).toBe(400);
    expect((await clearOAuthConfig(context({ param: CONFIG_NAMES[0] }))).status).toBe(500);
    expect((await clearOAuthConfig(context({ param: CONFIG_NAMES[0], store: kv() }))).status).toBe(
      200
    );
    expect((await clearAllOAuthConfig(context())).status).toBe(500);
    expect((await clearAllOAuthConfig(context({ store: kv() }))).status).toBe(200);
    mocks.oauthClearAll.mockRejectedValueOnce(new Error('failure'));
    expect((await clearAllOAuthConfig(context({ store: kv() }))).status).toBe(500);
  });

  it('gets all/single rate profiles with KV/defaults and invalid profile rejection', async () => {
    const store = kv();
    store.get.mockImplementation((key: string) =>
      Promise.resolve(key.includes('max_requests') ? '99' : '60')
    );
    const all = (await (
      await getRateLimitSettings(context({ store, env: { RATE_LIMIT_PROFILE: 'strict' } }))
    ).json()) as { profiles: Record<string, unknown> };
    expect(Object.keys(all.profiles)).toEqual([
      'strict',
      'moderate',
      'lenient',
      'publicRead',
      'loginStart',
      'sendChallenge',
      'loadTest',
    ]);
    expect((await getRateLimitProfile(context({ param: 'invalid' }))).status).toBe(400);
    expect((await getRateLimitProfile(context({ store, param: 'loadTest' }))).status).toBe(200);
  });

  it('falls back when rate KV reads fail', async () => {
    const store = kv();
    store.get.mockRejectedValue(new Error('failure'));
    expect((await getRateLimitSettings(context({ store }))).status).toBe(200);
    expect((await getRateLimitProfile(context({ store, param: 'strict' }))).status).toBe(200);
  });

  it.each([
    [{ maxRequests: 0 }],
    [{ maxRequests: 1_000_001 }],
    [{ maxRequests: 'bad' }],
    [{ windowSeconds: 0 }],
    [{ windowSeconds: 86401 }],
    [{ windowSeconds: 'bad' }],
    [{}],
  ])('rejects invalid rate profile update %#', async (body) => {
    expect(
      (await updateRateLimitProfile(context({ store: kv(), param: 'strict', body }))).status
    ).toBe(400);
  });

  it('updates/resets rate profile and clears cache', async () => {
    const store = kv();
    expect(
      (
        await updateRateLimitProfile(
          context({ store, param: 'loadTest', body: { maxRequests: 1000, windowSeconds: 60 } })
        )
      ).status
    ).toBe(200);
    expect(store.put).toHaveBeenCalledTimes(2);
    expect((await resetRateLimitProfile(context({ store, param: 'loadTest' }))).status).toBe(200);
    expect(store.delete).toHaveBeenCalledTimes(2);
    expect(mocks.rateCacheClear).toHaveBeenCalledTimes(2);
  });

  it('validates rate profile/KV availability for update/reset', async () => {
    expect((await updateRateLimitProfile(context({ param: 'bad', body: {} }))).status).toBe(400);
    expect((await updateRateLimitProfile(context({ param: 'strict', body: {} }))).status).toBe(500);
    expect((await resetRateLimitProfile(context({ param: 'bad' }))).status).toBe(400);
    expect((await resetRateLimitProfile(context({ param: 'strict' }))).status).toBe(500);
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
    await expect(response.json()).resolves.toMatchObject({ warning: expect.any(String) });
    expect((await clearProfileOverride(context({ store }))).status).toBe(200);
  });

  it('requires KV for profile override mutation and handles override read failure', async () => {
    expect((await setProfileOverride(context({ body: { profile: 'strict' } }))).status).toBe(500);
    expect((await clearProfileOverride(context())).status).toBe(500);
    const store = kv();
    store.get.mockRejectedValueOnce(new Error('failure'));
    expect((await getProfileOverride(context({ store }))).status).toBe(200);
  });
});
