/**
 * `identity_mapping.shadow_compare_enabled` is gone. It switched on a comparison of the Mapping Set
 * selection with the resolution the release of claims used before the selection replaced it; with
 * that resolution gone there is nothing to compare. A platform document saved before that, and
 * the `IDENTITY_MAPPING_SHADOW_COMPARE` environment variable, may still hold it: they must read and
 * save as before, and the key is not a setting any more.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSettingsManager } from '../utils/settings-manager';
import {
  IDENTITY_MAPPING_CATEGORY_META,
  IDENTITY_MAPPING_DEFAULTS,
  IDENTITY_MAPPING_SETTINGS_META,
} from '../types/settings/identity-mapping';
import { ALL_CATEGORY_META } from '../types/settings/catalog';
import { TENANT_SETTING_FIELD_POLICIES } from '../services/tenant-portability/settings-field-registry';
import { resolvePlatformSettingsWithSources } from '../services/effective-settings';

const RETIRED_KEY = 'identity_mapping.shadow_compare_enabled';
const KEY = 'identity_mapping.oidc_default_set_id';

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
  'settings:platform:identity-mapping': JSON.stringify({ [RETIRED_KEY]: true, [KEY]: 'set-1' }),
};

describe('the retired identity mapping shadow comparison setting', () => {
  it('is no longer a setting', () => {
    // The default Mapping Set, and the platform's limits of the search for what names a set.
    expect(Object.keys(IDENTITY_MAPPING_SETTINGS_META)).toEqual([
      KEY,
      'identity_mapping.reference_scan_tenant_limit',
      'identity_mapping.reference_scan_row_limit',
      'identity_mapping.reference_scan_concurrency',
      'identity_mapping.reference_display_limit',
    ]);
    expect(Object.keys(IDENTITY_MAPPING_CATEGORY_META.settings)).not.toContain(RETIRED_KEY);
    expect(Object.keys(IDENTITY_MAPPING_DEFAULTS)).not.toContain(RETIRED_KEY);
    expect(TENANT_SETTING_FIELD_POLICIES.map((policy) => policy.key)).not.toContain(RETIRED_KEY);
    for (const meta of Object.values(ALL_CATEGORY_META)) {
      expect(Object.keys(meta.settings)).not.toContain(RETIRED_KEY);
    }
    const envKeys = Object.values(ALL_CATEGORY_META).flatMap((meta) =>
      Object.values(meta.settings).map((setting) => (setting as { envKey?: string }).envKey)
    );
    expect(envKeys).not.toContain('IDENTITY_MAPPING_SHADOW_COMPARE');
  });

  it('in a saved document does not break reading, and is not returned', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(IDENTITY_MAPPING_CATEGORY_META);

    const all = await manager.getAll('identity-mapping', { type: 'platform' });

    expect(all.values[KEY]).toBe('set-1');
    expect(all.values).not.toHaveProperty(RETIRED_KEY);
    expect(all.sources).not.toHaveProperty(RETIRED_KEY);
  });

  it('in a saved document does not break saving the default Mapping Set', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(IDENTITY_MAPPING_CATEGORY_META);

    const all = await manager.getAll('identity-mapping', { type: 'platform' });
    const result = await manager.patch(
      'identity-mapping',
      { type: 'platform' },
      { ifMatch: all.version, set: { [KEY]: 'set-2' } },
      'admin'
    );

    expect(result.applied).toEqual([KEY]);
    expect(result.rejected).toEqual({});
  });

  it('is rejected as an unknown key when set again', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV({}), cacheTTL: 0 });
    manager.registerCategory(IDENTITY_MAPPING_CATEGORY_META);

    const all = await manager.getAll('identity-mapping', { type: 'platform' });
    const result = await manager.patch(
      'identity-mapping',
      { type: 'platform' },
      { ifMatch: all.version, set: { [RETIRED_KEY]: true } },
      'admin'
    );

    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual({ [RETIRED_KEY]: 'Unknown setting key' });
  });

  it('is ignored by the runtime reader, stored in a document or set in the environment', async () => {
    const env = {
      SETTINGS: createMockKV(SAVED),
      IDENTITY_MAPPING_SHADOW_COMPARE: 'true',
    };

    const { values } = await resolvePlatformSettingsWithSources(env, 'identity-mapping');

    expect(values[KEY]).toBe('set-1');
    expect(values).not.toHaveProperty(RETIRED_KEY);
  });
});
