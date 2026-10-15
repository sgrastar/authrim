/**
 * Four CIBA settings had no CIBA behaviour behind them and are gone: `ciba.auth_request_ttl`,
 * `ciba.notifier_default_timeout_ms`, `ciba.notifier_max_timeout_ms` and
 * `ciba.notifier_retry_delay_base_ms`. Documents saved before that still hold the keys: they must
 * read, save and resolve as before, and none of them is a setting any more.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSettingsManager } from '../utils/settings-manager';
import { CIBA_CATEGORY_META, CIBA_DEFAULTS, CIBA_SETTINGS_META } from '../types/settings/ciba';
import { resolveCibaConfig } from '../services/ciba-config';
import { TENANT_SETTING_FIELD_POLICIES } from '../services/tenant-portability/settings-field-registry';

const RETIRED = {
  'ciba.auth_request_ttl': 120,
  'ciba.notifier_default_timeout_ms': 2000,
  'ciba.notifier_max_timeout_ms': 9000,
  'ciba.notifier_retry_delay_base_ms': 500,
};
const RETIRED_ENV_KEYS = [
  'CIBA_AUTH_REQUEST_TTL',
  'NOTIFIER_DEFAULT_TIMEOUT_MS',
  'NOTIFIER_MAX_TIMEOUT_MS',
  'NOTIFIER_RETRY_DELAY_BASE_MS',
];

function createMockKV(data: Record<string, string>): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

const SAVED = {
  'settings:tenant:t1:ciba': JSON.stringify({ 'ciba.expires_in': 200, ...RETIRED }),
  'settings:platform:ciba': JSON.stringify(RETIRED),
};

describe('the retired CIBA settings', () => {
  it('are no longer settings', () => {
    for (const key of Object.keys(RETIRED)) {
      expect(Object.keys(CIBA_SETTINGS_META)).not.toContain(key);
      expect(Object.keys(CIBA_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(CIBA_DEFAULTS)).not.toContain(key);
      expect(TENANT_SETTING_FIELD_POLICIES.map((policy) => policy.key)).not.toContain(key);
    }
    const envKeys = Object.values(CIBA_SETTINGS_META).map((meta) => meta.envKey);
    for (const envKey of RETIRED_ENV_KEYS) expect(envKeys).not.toContain(envKey);
  });

  it('in a saved document do not break reading, and are not returned', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(CIBA_CATEGORY_META);

    const tenant = await manager.getAll('ciba', { type: 'tenant', id: 't1' });
    expect(tenant.values['ciba.expires_in']).toBe(200);
    expect(tenant.sources['ciba.expires_in']).toBe('kv');
    for (const key of Object.keys(RETIRED)) {
      expect(tenant.values).not.toHaveProperty(key);
      expect(tenant.sources).not.toHaveProperty(key);
    }
    await expect(manager.getAll('ciba', { type: 'platform' })).resolves.toMatchObject({
      category: 'ciba',
    });
  });

  it('in a saved document do not break saving another setting', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(CIBA_CATEGORY_META);
    const before = await manager.getAll('ciba', { type: 'tenant', id: 't1' });

    const result = await manager.patch(
      'ciba',
      { type: 'tenant', id: 't1' },
      { ifMatch: before.version, set: { 'ciba.max_poll_count': 200 } },
      'admin'
    );

    expect(result.applied).toEqual(['ciba.max_poll_count']);
    expect(result.rejected).toEqual({});
    const after = await manager.getAll('ciba', { type: 'tenant', id: 't1' });
    expect(after.values['ciba.max_poll_count']).toBe(200);
    expect(after.values['ciba.expires_in']).toBe(200);
  });

  it('are refused as unknown keys when set again', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV({}), cacheTTL: 0 });
    manager.registerCategory(CIBA_CATEGORY_META);
    const before = await manager.getAll('ciba', { type: 'tenant', id: 't1' });

    const result = await manager.patch(
      'ciba',
      { type: 'tenant', id: 't1' },
      { ifMatch: before.version, set: RETIRED },
      'admin'
    );

    expect(result.applied).toEqual([]);
    expect(Object.values(result.rejected)).toEqual(Array(4).fill('Unknown setting key'));
  });

  it('are ignored by the runtime reader, stored in a document or set in the environment', async () => {
    const config = await resolveCibaConfig(
      {
        SETTINGS: createMockKV(SAVED),
        CIBA_AUTH_REQUEST_TTL: '100',
        NOTIFIER_DEFAULT_TIMEOUT_MS: '2000',
        NOTIFIER_MAX_TIMEOUT_MS: '9000',
        NOTIFIER_RETRY_DELAY_BASE_MS: '500',
      } as never,
      't1'
    );

    // the one live value of the document applies; nothing else moved
    expect(config.expiresIn).toBe(200);
    expect(config.pollInterval).toBe(5);
    expect(config.pingNotificationTimeoutMs).toBe(5000);
    expect(Object.keys(config)).not.toContain('authRequestTtl');
  });
});
