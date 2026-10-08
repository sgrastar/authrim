/**
 * The introspection response cache is gone, with `feature.introspection_cache_enabled` and
 * `tokens.introspection_cache_ttl`. Documents saved before that still hold the two keys: they must
 * read, save and import as before, and neither key is a setting any more.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSettingsManager, type CategoryMeta } from '../utils/settings-manager';
import {
  FEATURE_FLAGS_CATEGORY_META,
  FEATURE_FLAGS_DEFAULTS,
} from '../types/settings/feature-flags';
import { TOKENS_CATEGORY_META, TOKENS_DEFAULTS } from '../types/settings/tokens';
import { SYSTEM_SETTINGS_FIELDS } from '../utils/system-settings-fields';
import { TENANT_SETTING_FIELD_POLICIES } from '../services/tenant-portability/settings-field-registry';

const RETIRED_KEYS = ['feature.introspection_cache_enabled', 'tokens.introspection_cache_ttl'];

function createMockKV(data: Record<string, string>): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(data));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const SAVED: Array<[string, CategoryMeta, string, Record<string, unknown>]> = [
  [
    'tokens',
    TOKENS_CATEGORY_META,
    'tokens.introspection_strict_validation',
    { 'tokens.introspection_cache_ttl': 300 },
  ],
  [
    'feature-flags',
    FEATURE_FLAGS_CATEGORY_META,
    'feature.enable_abac',
    { 'feature.introspection_cache_enabled': true },
  ],
];

describe('the retired introspection cache settings', () => {
  it('are no longer settings', () => {
    for (const key of RETIRED_KEYS) {
      expect(Object.keys(TOKENS_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(FEATURE_FLAGS_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(TOKENS_DEFAULTS)).not.toContain(key);
      expect(Object.keys(FEATURE_FLAGS_DEFAULTS)).not.toContain(key);
      expect(SYSTEM_SETTINGS_FIELDS.map((field) => field.key)).not.toContain(key);
      expect(TENANT_SETTING_FIELD_POLICIES.map((policy) => policy.key)).not.toContain(key);
    }
  });

  it.each(SAVED)(
    'in a saved %s document do not break reading, and are not returned',
    async (category, meta, otherKey, retired) => {
      const kv = createMockKV({
        [`settings:tenant:t1:${category}`]: JSON.stringify({ [otherKey]: true, ...retired }),
        [`settings:platform:${category}`]: JSON.stringify(retired),
      });
      const manager = createSettingsManager({ env: {}, kv, cacheTTL: 0 });
      manager.registerCategory(meta);

      const tenant = await manager.getAll(category, { type: 'tenant', id: 't1' });
      expect(tenant.values[otherKey]).toBe(true);
      expect(tenant.sources[otherKey]).toBe('kv');
      for (const key of Object.keys(retired)) {
        expect(tenant.values).not.toHaveProperty(key);
        expect(tenant.sources).not.toHaveProperty(key);
      }
      await expect(manager.getAll(category, { type: 'platform' })).resolves.toMatchObject({
        category,
      });
    }
  );

  it.each(SAVED)(
    'in a saved %s document do not break saving another setting',
    async (category, meta, otherKey, retired) => {
      const kv = createMockKV({
        [`settings:tenant:t1:${category}`]: JSON.stringify(retired),
      });
      const manager = createSettingsManager({ env: {}, kv, cacheTTL: 0 });
      manager.registerCategory(meta);

      const before = await manager.getAll(category, { type: 'tenant', id: 't1' });
      const result = await manager.patch(
        category,
        { type: 'tenant', id: 't1' },
        { ifMatch: before.version, set: { [otherKey]: true } },
        'admin'
      );

      expect(result.applied).toEqual([otherKey]);
      expect(result.rejected).toEqual({});
      const after = await manager.getAll(category, { type: 'tenant', id: 't1' });
      expect(after.values[otherKey]).toBe(true);
    }
  );

  it.each(SAVED)(
    'are refused as unknown keys when set again (%s)',
    async (category, meta, _o, retired) => {
      const manager = createSettingsManager({ env: {}, kv: createMockKV({}), cacheTTL: 0 });
      manager.registerCategory(meta);
      const before = await manager.getAll(category, { type: 'tenant', id: 't1' });

      const result = await manager.patch(
        category,
        { type: 'tenant', id: 't1' },
        { ifMatch: before.version, set: retired },
        'admin'
      );

      expect(result.applied).toEqual([]);
      expect(Object.values(result.rejected)).toEqual(['Unknown setting key']);
    }
  );
});
