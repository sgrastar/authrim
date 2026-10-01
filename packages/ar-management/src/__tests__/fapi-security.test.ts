import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));
import {
  clearFapiSecurityConfig,
  getFapiSecurityConfig,
  getFapiSecuritySettings,
  getStrictDPoPSetting,
  getSupportedAcrValues,
  updateFapiSecurityConfig,
} from '../routes/settings/fapi-security';
function kv(initial: string | null = null) {
  return { get: vi.fn().mockResolvedValue(initial), put: vi.fn().mockResolvedValue(undefined) };
}
function context(
  options: {
    store?: ReturnType<typeof kv>;
    body?: unknown;
    bodyError?: boolean;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    env: { ...(options.store ? { SETTINGS: options.store } : {}), ...(options.env ?? {}) },
    req: {
      path: '/api/admin/settings/fapi-security',
      header: vi.fn(() => undefined),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
    get: vi.fn(),
  } as never;
}
describe('FAPI security settings', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses secure defaults and environment ACR values', async () => {
    await expect(getFapiSecuritySettings({} as never)).resolves.toMatchObject({
      settings: { fapi: { enabled: false, strictDPoP: true, allowPublicClients: true } },
    });
    const result = await getFapiSecuritySettings({ SUPPORTED_ACR_VALUES: 'aal1, aal2 ' } as never);
    expect(result.settings.oidc.supportedAcrValues).toEqual(['aal1', 'aal2']);
    expect(result.sources.oidc.supportedAcrValues).toBe('env');
  });
  it('reads the public client allowance from env, as authorization does', async () => {
    for (const [value, allowed] of [
      ['false', false],
      ['0', false],
      ['FALSE', false],
      ['true', true],
      ['', true],
    ] as const) {
      const result = await getFapiSecuritySettings({ FAPI_ALLOW_PUBLIC_CLIENTS: value } as never);
      expect(result.settings.fapi.allowPublicClients, value).toBe(allowed);
      expect(result.sources.fapi.allowPublicClients).toBe('env');
    }
    // A saved value goes first.
    const saved = await getFapiSecuritySettings({
      SETTINGS: kv(JSON.stringify({ fapi: { allowPublicClients: true } })),
      FAPI_ALLOW_PUBLIC_CLIENTS: 'false',
    } as never);
    expect(saved.settings.fapi.allowPublicClients).toBe(true);
  });
  it('applies KV over env and coerces flags strictly', async () => {
    const store = kv(
      JSON.stringify({
        fapi: { enabled: true, strictDPoP: false, allowPublicClients: true },
        oidc: { supportedAcrValues: ['aal3'] },
      })
    );
    const result = await getFapiSecuritySettings({
      SETTINGS: store,
      SUPPORTED_ACR_VALUES: 'env',
    } as never);
    expect(result.settings).toEqual({
      fapi: { enabled: true, strictDPoP: false, allowPublicClients: true },
      oidc: { supportedAcrValues: ['aal3'] },
    });
    expect(result.sources.fapi).toEqual({
      enabled: 'kv',
      strictDPoP: 'kv',
      allowPublicClients: 'kv',
    });
  });
  it.each([
    '{',
    JSON.stringify({ fapi: { enabled: 'true' }, oidc: { supportedAcrValues: 'bad' } }),
  ])('ignores malformed/invalid KV %#', async (stored) => {
    const result = await getFapiSecuritySettings({ SETTINGS: kv(stored) } as never);
    expect(result.settings.fapi.enabled).toBe(false);
  });
  it('ignores KV read errors and exposes helper values', async () => {
    const store = kv();
    store.get.mockRejectedValueOnce(new Error('failure'));
    await expect(getFapiSecuritySettings({ SETTINGS: store } as never)).resolves.toMatchObject({
      settings: { fapi: { enabled: false } },
    });
    await expect(getSupportedAcrValues({} as never)).resolves.toEqual(expect.any(Array));
    await expect(getStrictDPoPSetting({} as never)).resolves.toBe(false);
    await expect(
      getStrictDPoPSetting({
        SETTINGS: kv(JSON.stringify({ fapi: { enabled: true, strictDPoP: true } })),
      } as never)
    ).resolves.toBe(true);
  });
  it('returns annotated FAPI config', async () => {
    await expect((await getFapiSecurityConfig(context())).json()).resolves.toMatchObject({
      settings: { fapi: { enabled: { value: false, source: 'default' } } },
    });
  });
  it("shows the tenant's Settings API values, as runtime applies them", async () => {
    const documents: Record<string, string> = {
      system_settings: JSON.stringify({ fapi: { enabled: false, allowPublicClients: true } }),
      'settings:tenant:default:security': JSON.stringify({
        'security.fapi_enabled': true,
        'security.fapi_allow_public_clients': false,
      }),
    };
    const store = {
      get: vi.fn(async (key: string) => documents[key] ?? null),
      put: vi.fn(),
    };
    const body = (await (await getFapiSecurityConfig(context({ store }))).json()) as {
      settings: { fapi: Record<string, { value: unknown; source: string }> };
    };
    expect(body.settings.fapi.enabled).toMatchObject({ value: true, source: 'kv' });
    expect(body.settings.fapi.allowPublicClients).toMatchObject({ value: false, source: 'kv' });
  });
  it('answers 503 instead of defaults when the settings cannot be read', async () => {
    const store = {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:default:security' ? 'not json' : null
      ),
      put: vi.fn(),
    };
    const response = await getFapiSecurityConfig(context({ store }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });
  it('requires KV and valid JSON for update', async () => {
    expect((await updateFapiSecurityConfig(context())).status).toBe(500);
    expect((await updateFapiSecurityConfig(context({ store: kv(), bodyError: true }))).status).toBe(
      400
    );
  });
  it.each([
    [{ fapi: { enabled: 'true' } }],
    [{ fapi: { strictDPoP: 1 } }],
    [{ fapi: { allowPublicClients: 1 } }],
    [{ oidc: { supportedAcrValues: 'bad' } }],
    [{ oidc: { supportedAcrValues: [] } }],
    [{ oidc: { supportedAcrValues: [''] } }],
    [{ oidc: { supportedAcrValues: [1] } }],
  ])('rejects invalid FAPI update %#', async (body) =>
    expect((await updateFapiSecurityConfig(context({ store: kv(), body }))).status).toBe(400)
  );
  it('merges all fields and preserves unrelated OIDC/system settings', async () => {
    const store = kv(
      JSON.stringify({ unrelated: true, oidc: { other: true }, fapi: { enabled: false } })
    );
    const body = {
      fapi: { enabled: true, strictDPoP: false, allowPublicClients: true },
      oidc: { supportedAcrValues: ['aal2'] },
    };
    expect((await updateFapiSecurityConfig(context({ store, body }))).status).toBe(200);
    expect(JSON.parse(store.put.mock.calls[0][1])).toMatchObject({
      unrelated: true,
      oidc: { other: true, supportedAcrValues: ['aal2'] },
      fapi: body.fapi,
    });
  });
  it('initializes nested settings and sanitizes update errors', async () => {
    const store = kv(null);
    expect((await updateFapiSecurityConfig(context({ store, body: {} }))).status).toBe(200);
    store.put.mockRejectedValueOnce(new Error('secret detail'));
    const response = await updateFapiSecurityConfig(
      context({ store, body: { fapi: { enabled: true } } })
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret detail');
  });
  it('requires KV and clears only FAPI/ACR overrides', async () => {
    expect((await clearFapiSecurityConfig(context())).status).toBe(500);
    const store = kv(
      JSON.stringify({
        unrelated: true,
        fapi: { enabled: true },
        oidc: { supportedAcrValues: ['aal2'], other: true },
      })
    );
    expect((await clearFapiSecurityConfig(context({ store }))).status).toBe(200);
    expect(JSON.parse(store.put.mock.calls[0][1])).toEqual({
      unrelated: true,
      oidc: { other: true },
    });
  });
  it('handles empty/corrupt clear state without exposing errors', async () => {
    expect((await clearFapiSecurityConfig(context({ store: kv(null) }))).status).toBe(200);
    const store = kv('{');
    const response = await clearFapiSecurityConfig(context({ store }));
    expect(response.status).toBe(500);
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});
