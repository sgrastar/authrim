import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ logger: { error: vi.fn() } }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

import {
  getLogoutWebhookConfig,
  resetLogoutWebhookConfig,
  updateLogoutWebhookConfig,
} from '../routes/settings/logout-webhook-config';
import { DEFAULT_LOGOUT_WEBHOOK_CONFIG, LOGOUT_WEBHOOK_SETTINGS_KEY } from '@authrim/ar-lib-core';

function kv(initial: string | null = null) {
  return { get: vi.fn().mockResolvedValue(initial), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
}
function context(options: { store?: ReturnType<typeof kv>; body?: unknown; bodyError?: boolean } = {}) {
  return {
    env: options.store ? { SETTINGS: options.store } : {},
    req: { json: options.bodyError ? vi.fn().mockRejectedValue(new SyntaxError('bad')) : vi.fn().mockResolvedValue(options.body ?? {}) },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('logout webhook configuration', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, '{', JSON.stringify({ enabled: true, retry: { max_attempts: 7 } })])(
    'gets merged config from stored=%s',
    async (stored) => {
      const response = await getLogoutWebhookConfig(context({ store: kv(stored) }));
      const body = (await response.json()) as { config: typeof DEFAULT_LOGOUT_WEBHOOK_CONFIG; source: string };
      expect(body.source).toBe(stored && stored !== '{' ? 'kv' : 'default');
      expect(body.config.retry.initial_delay_ms).toBe(DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry.initial_delay_ms);
      if (stored && stored !== '{') expect(body.config.retry.max_attempts).toBe(7);
    }
  );

  it('gets defaults without KV and sanitizes read errors', async () => {
    await expect((await getLogoutWebhookConfig(context())).json()).resolves.toMatchObject({ source: 'default' });
    const store = kv(); store.get.mockRejectedValueOnce(new Error('secret KV detail'));
    const response = await getLogoutWebhookConfig(context({ store }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret KV detail');
  });

  it('requires KV and valid JSON for update', async () => {
    expect((await updateLogoutWebhookConfig(context({ body: {} }))).status).toBe(500);
    expect((await updateLogoutWebhookConfig(context({ store: kv(), bodyError: true }))).status).toBe(400);
  });

  it.each([
    [{ enabled: 'true' }],
    [{ request_timeout_ms: '1000' }], [{ request_timeout_ms: 999 }], [{ request_timeout_ms: 30001 }],
    [{ include_sub_claim: 1 }], [{ include_sid_claim: 1 }],
    [{ retry: { max_attempts: '1' } }], [{ retry: { max_attempts: -1 } }], [{ retry: { max_attempts: 11 } }],
    [{ retry: { initial_delay_ms: '100' } }], [{ retry: { initial_delay_ms: 99 } }], [{ retry: { initial_delay_ms: 60001 } }],
    [{ retry: { max_delay_ms: '1000' } }], [{ retry: { max_delay_ms: 999 } }], [{ retry: { max_delay_ms: 300001 } }],
    [{ retry: { backoff_multiplier: '2' } }], [{ retry: { backoff_multiplier: 0.9 } }], [{ retry: { backoff_multiplier: 5.1 } }],
    [{ on_final_failure: 'ignore' }],
  ])('rejects invalid webhook config %#', async (body) => {
    expect((await updateLogoutWebhookConfig(context({ store: kv(), body }))).status).toBe(400);
  });

  it('deep-merges a valid partial retry configuration', async () => {
    const store = kv(JSON.stringify({ enabled: false, retry: { max_attempts: 2, initial_delay_ms: 500 } }));
    const body = {
      enabled: true, request_timeout_ms: 1000, include_sub_claim: false, include_sid_claim: true,
      retry: { max_attempts: 0, initial_delay_ms: 100, max_delay_ms: 1000, backoff_multiplier: 1 },
      on_final_failure: 'alert',
    };
    const response = await updateLogoutWebhookConfig(context({ store, body }));
    expect(response.status).toBe(200);
    const saved = JSON.parse(store.put.mock.calls[0][1]);
    expect(saved).toMatchObject(body);
    expect(store.put).toHaveBeenCalledWith(LOGOUT_WEBHOOK_SETTINGS_KEY, expect.any(String));
  });

  it.each([null, '{'])('uses defaults when existing config is %s', async (stored) => {
    const store = kv(stored);
    const response = await updateLogoutWebhookConfig(context({ store, body: { enabled: true } }));
    await expect(response.json()).resolves.toMatchObject({ config: { enabled: true, retry: DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry } });
  });

  it('preserves existing retry when omitted and sanitizes write errors', async () => {
    const store = kv(JSON.stringify({ retry: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry, max_attempts: 9 } }));
    const response = await updateLogoutWebhookConfig(context({ store, body: { enabled: true } }));
    await expect(response.json()).resolves.toMatchObject({ config: { retry: { max_attempts: 9 } } });
    store.put.mockRejectedValueOnce(new Error('secret write detail'));
    const failure = await updateLogoutWebhookConfig(context({ store, body: { enabled: false } }));
    expect(failure.status).toBe(500);
    expect(JSON.stringify(await failure.json())).not.toContain('secret write detail');
  });

  it('resets to defaults, requires KV, and sanitizes delete errors', async () => {
    expect((await resetLogoutWebhookConfig(context())).status).toBe(500);
    const store = kv();
    await expect((await resetLogoutWebhookConfig(context({ store }))).json()).resolves.toMatchObject({
      success: true, config: DEFAULT_LOGOUT_WEBHOOK_CONFIG,
    });
    store.delete.mockRejectedValueOnce(new Error('secret delete detail'));
    const response = await resetLogoutWebhookConfig(context({ store }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret delete detail');
  });
});
