import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearProviderCache: vi.fn(),
  defaultProvider: vi.fn(() => 'cloudflare'),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getCloudProviderKVKey: vi.fn(() => 'security_cloud_provider'),
  getDefaultCloudProvider: mocks.defaultProvider,
  VALID_CLOUD_PROVIDERS: ['cloudflare', 'aws', 'azure', 'gcp', 'none'],
  clearCloudProviderCache: mocks.clearProviderCache,
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

import {
  getErrorConfig,
  getErrorIdMode,
  getErrorLocale,
  getErrorResponseFormat,
  resetErrorIdMode,
  resetErrorLocale,
  resetErrorResponseFormat,
  updateErrorIdMode,
  updateErrorLocale,
  updateErrorResponseFormat,
} from '../routes/settings/error-config';
import {
  clearIpSecurityConfig,
  getIpSecurityConfig,
  getIpSecuritySettings,
  updateIpSecurityConfig,
} from '../routes/settings/ip-security';

function kv(values: Record<string, string | null> = {}) {
  return {
    get: vi.fn((key: string) => Promise.resolve(values[key] ?? null)),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function context(options: { store?: ReturnType<typeof kv>; body?: unknown; bodyError?: boolean } = {}) {
  return {
    env: options.store ? { AUTHRIM_CONFIG: options.store } : {},
    req: {
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('error response and IP security settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.defaultProvider.mockReturnValue('cloudflare');
  });

  it('returns default error settings without KV', async () => {
    await expect((await getErrorConfig(context())).json()).resolves.toMatchObject({
      locale: { current: 'en', source: 'default' },
      response_format: { current: 'oauth', source: 'default' },
      error_id_mode: { current: '5xx', source: 'default' },
    });
    await expect((await getErrorLocale(context())).json()).resolves.toMatchObject({ locale: 'en' });
    await expect((await getErrorResponseFormat(context())).json()).resolves.toMatchObject({ response_format: 'oauth' });
    await expect((await getErrorIdMode(context())).json()).resolves.toMatchObject({ error_id_mode: '5xx' });
  });

  it('reads all error settings from KV', async () => {
    const store = kv({ error_locale: 'ja', error_response_format: 'problem_details', error_id_mode: 'security_only' });
    await expect((await getErrorConfig(context({ store }))).json()).resolves.toMatchObject({
      locale: { current: 'ja', source: 'kv' },
      response_format: { current: 'problem_details', source: 'kv' },
      error_id_mode: { current: 'security_only', source: 'kv' },
    });
  });

  it('falls back safely when KV reads fail', async () => {
    const store = kv();
    store.get.mockRejectedValue(new Error('KV unavailable'));
    await expect((await getErrorConfig(context({ store }))).json()).resolves.toMatchObject({ locale: { current: 'en' } });
    await expect((await getErrorLocale(context({ store }))).json()).resolves.toMatchObject({ locale: 'en' });
    await expect((await getErrorResponseFormat(context({ store }))).json()).resolves.toMatchObject({ response_format: 'oauth' });
    await expect((await getErrorIdMode(context({ store }))).json()).resolves.toMatchObject({ error_id_mode: '5xx' });
  });

  it.each([
    [updateErrorLocale, {}, 400],
    [updateErrorLocale, { locale: 'fr' }, 400],
    [updateErrorLocale, { locale: 'ja' }, 200],
    [updateErrorResponseFormat, {}, 400],
    [updateErrorResponseFormat, { format: 'html' }, 400],
    [updateErrorResponseFormat, { format: 'oauth' }, 200],
    [updateErrorResponseFormat, { format: 'problem_details' }, 200],
    [updateErrorIdMode, {}, 400],
    [updateErrorIdMode, { mode: 'invalid' }, 400],
    [updateErrorIdMode, { mode: 'all' }, 200],
    [updateErrorIdMode, { mode: '5xx' }, 200],
    [updateErrorIdMode, { mode: 'security_only' }, 200],
    [updateErrorIdMode, { mode: 'none' }, 200],
  ])('validates and updates error setting %#', async (handler, body, status) => {
    const store = kv();
    const response = await handler(context({ store, body }));
    expect(response.status).toBe(status);
    expect(store.put).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it.each([updateErrorLocale, updateErrorResponseFormat, updateErrorIdMode])(
    'requires configured KV for error update %#',
    async (handler) => expect((await handler(context({ body: {} }))).status).toBe(500)
  );

  it.each([resetErrorLocale, resetErrorResponseFormat, resetErrorIdMode])(
    'resets error setting and requires KV %#',
    async (handler) => {
      expect((await handler(context())).status).toBe(500);
      const store = kv();
      expect((await handler(context({ store }))).status).toBe(200);
      expect(store.delete).toHaveBeenCalledTimes(1);
    }
  );

  it('uses default or valid KV cloud provider and ignores failures/invalid values', async () => {
    await expect(getIpSecuritySettings({} as never)).resolves.toEqual({
      settings: { cloudProvider: 'cloudflare' }, sources: { cloudProvider: 'default' },
    });
    await expect(getIpSecuritySettings({ AUTHRIM_CONFIG: kv({ security_cloud_provider: 'aws' }) } as never)).resolves.toEqual({
      settings: { cloudProvider: 'aws' }, sources: { cloudProvider: 'kv' },
    });
    await expect(getIpSecuritySettings({ AUTHRIM_CONFIG: kv({ security_cloud_provider: 'invalid' }) } as never)).resolves.toMatchObject({
      settings: { cloudProvider: 'cloudflare' },
    });
    const store = kv();
    store.get.mockRejectedValueOnce(new Error('failure'));
    await expect(getIpSecuritySettings({ AUTHRIM_CONFIG: store } as never)).resolves.toMatchObject({
      settings: { cloudProvider: 'cloudflare' },
    });
  });

  it.each(['cloudflare', 'aws', 'azure', 'gcp', 'none'])('returns provider metadata for %s', async (provider) => {
    const response = await getIpSecurityConfig(context({ store: kv({ security_cloud_provider: provider }) }));
    const body = (await response.json()) as { settings: { cloudProvider: { info: { securityLevel: string } } }; availableProviders: unknown[] };
    expect(body.availableProviders).toHaveLength(5);
    expect(body.settings.cloudProvider.info.securityLevel).toMatch(/high|medium|low/);
  });

  it('requires KV and valid JSON/provider for IP security update', async () => {
    expect((await updateIpSecurityConfig(context())).status).toBe(500);
    expect((await updateIpSecurityConfig(context({ store: kv(), bodyError: true }))).status).toBe(400);
    expect((await updateIpSecurityConfig(context({ store: kv(), body: { cloudProvider: 'bad' } }))).status).toBe(400);
  });

  it.each(['cloudflare', 'aws', 'azure', 'gcp', 'none'])('updates IP provider %s and clears cache', async (cloudProvider) => {
    const store = kv({ security_cloud_provider: cloudProvider });
    const response = await updateIpSecurityConfig(context({ store, body: { cloudProvider } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.hasOwnProperty('warning')).toBe(cloudProvider === 'none');
    expect(mocks.clearProviderCache).toHaveBeenCalled();
  });

  it('allows an empty IP update and handles KV write failures', async () => {
    expect((await updateIpSecurityConfig(context({ store: kv(), body: {} }))).status).toBe(200);
    const store = kv();
    store.put.mockRejectedValueOnce(new Error('failure'));
    expect((await updateIpSecurityConfig(context({ store, body: { cloudProvider: 'aws' } }))).status).toBe(500);
  });

  it('clears IP override, requires KV, and handles delete failure', async () => {
    expect((await clearIpSecurityConfig(context())).status).toBe(500);
    const store = kv();
    expect((await clearIpSecurityConfig(context({ store }))).status).toBe(200);
    expect(mocks.clearProviderCache).toHaveBeenCalled();
    store.delete.mockRejectedValueOnce(new Error('failure'));
    expect((await clearIpSecurityConfig(context({ store }))).status).toBe(500);
  });
});
