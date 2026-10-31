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

function context(
  options: {
    store?: ReturnType<typeof kv>;
    settings?: ReturnType<typeof kv>;
    body?: unknown;
    bodyError?: boolean;
  } = {}
) {
  return {
    env: {
      ...(options.store ? { AUTHRIM_CONFIG: options.store } : {}),
      ...(options.settings ? { SETTINGS: options.settings } : {}),
    },
    get: vi.fn(),
    req: {
      path: '/api/admin/settings/ip-security',
      header: vi.fn(() => undefined),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('IP security settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.defaultProvider.mockReturnValue('cloudflare');
  });

  it('uses default or valid KV cloud provider and ignores failures/invalid values', async () => {
    await expect(getIpSecuritySettings({} as never)).resolves.toEqual({
      settings: { cloudProvider: 'cloudflare' },
      sources: { cloudProvider: 'default' },
    });
    await expect(
      getIpSecuritySettings({ AUTHRIM_CONFIG: kv({ security_cloud_provider: 'aws' }) } as never)
    ).resolves.toEqual({
      settings: { cloudProvider: 'aws' },
      sources: { cloudProvider: 'kv' },
    });
    await expect(
      getIpSecuritySettings({ AUTHRIM_CONFIG: kv({ security_cloud_provider: 'invalid' }) } as never)
    ).resolves.toMatchObject({
      settings: { cloudProvider: 'cloudflare' },
    });
    const store = kv();
    store.get.mockRejectedValueOnce(new Error('failure'));
    await expect(getIpSecuritySettings({ AUTHRIM_CONFIG: store } as never)).resolves.toMatchObject({
      settings: { cloudProvider: 'cloudflare' },
    });
  });

  it.each(['cloudflare', 'aws', 'azure', 'gcp', 'none'])(
    'returns provider metadata for %s',
    async (provider) => {
      const response = await getIpSecurityConfig(
        context({ store: kv({ security_cloud_provider: provider }) })
      );
      const body = (await response.json()) as {
        settings: { cloudProvider: { info: { securityLevel: string } } };
        availableProviders: unknown[];
      };
      expect(body.availableProviders).toHaveLength(5);
      expect(body.settings.cloudProvider.info.securityLevel).toMatch(/high|medium|low/);
    }
  );

  it('requires KV and valid JSON/provider for IP security update', async () => {
    expect((await updateIpSecurityConfig(context())).status).toBe(500);
    expect((await updateIpSecurityConfig(context({ store: kv(), bodyError: true }))).status).toBe(
      400
    );
    expect(
      (await updateIpSecurityConfig(context({ store: kv(), body: { cloudProvider: 'bad' } })))
        .status
    ).toBe(400);
  });

  it.each(['cloudflare', 'aws', 'azure', 'gcp', 'none'])(
    'updates IP provider %s and clears cache',
    async (cloudProvider) => {
      const store = kv({ security_cloud_provider: cloudProvider });
      const response = await updateIpSecurityConfig(context({ store, body: { cloudProvider } }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.hasOwnProperty('warning')).toBe(cloudProvider === 'none');
      expect(mocks.clearProviderCache).toHaveBeenCalled();
    }
  );

  it('allows an empty IP update and handles KV write failures', async () => {
    expect((await updateIpSecurityConfig(context({ store: kv(), body: {} }))).status).toBe(200);
    const store = kv();
    store.put.mockRejectedValueOnce(new Error('failure'));
    expect(
      (await updateIpSecurityConfig(context({ store, body: { cloudProvider: 'aws' } }))).status
    ).toBe(500);
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
