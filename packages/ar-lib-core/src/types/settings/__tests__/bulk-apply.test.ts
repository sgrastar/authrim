/**
 * The bulk-apply category: the platform's limits on one request. Settable by the platform only,
 * between 1 and 100, from KV, then the environment, then the code defaults.
 */
import { describe, expect, it } from 'vitest';
import { resolvePlatformSettingsWithSources } from '../../../services/effective-settings';
import { createSettingsManager } from '../../../utils/settings-manager';
import {
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  getCategoriesForScope,
  isCategoryAvailableAtScope,
  settingsParentScopes,
} from '../catalog';
import {
  BULK_APPLY_CATEGORY_META,
  BULK_APPLY_DEFAULTS,
  BULK_APPLY_MAX_KEYS_KEY,
  BULK_APPLY_MAX_TENANTS_KEY,
  BULK_APPLY_SETTINGS_META,
  clampBulkApplyLimit,
} from '../bulk-apply';

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

describe('the bulk-apply category', () => {
  it('is registered, and is the platform’s alone', () => {
    expect(ALL_CATEGORY_META['bulk-apply']).toBe(BULK_APPLY_CATEGORY_META);
    expect(CATEGORY_SCOPE_CONFIG['bulk-apply'].allowedScopes).toEqual(['platform']);
    expect(isCategoryAvailableAtScope('bulk-apply', 'tenant')).toBe(false);
    expect(isCategoryAvailableAtScope('bulk-apply', 'client')).toBe(false);
    expect(getCategoriesForScope('platform')).toContain('bulk-apply');
    expect(getCategoriesForScope('tenant')).not.toContain('bulk-apply');
    expect(settingsParentScopes('bulk-apply', { type: 'platform' })).toEqual([]);
  });

  it('holds two limits, 25 tenants and 20 settings by default, with their environment variables', () => {
    expect(Object.keys(BULK_APPLY_SETTINGS_META)).toEqual([
      BULK_APPLY_MAX_TENANTS_KEY,
      BULK_APPLY_MAX_KEYS_KEY,
    ]);
    expect(BULK_APPLY_DEFAULTS).toEqual({
      [BULK_APPLY_MAX_TENANTS_KEY]: 25,
      [BULK_APPLY_MAX_KEYS_KEY]: 20,
    });
    expect(BULK_APPLY_SETTINGS_META[BULK_APPLY_MAX_TENANTS_KEY]).toMatchObject({
      type: 'number',
      envKey: 'BULK_APPLY_MAX_TENANTS_PER_REQUEST',
      min: 1,
      max: 100,
      integer: true,
      scopes: ['platform'],
    });
    expect(BULK_APPLY_SETTINGS_META[BULK_APPLY_MAX_KEYS_KEY]).toMatchObject({
      envKey: 'BULK_APPLY_MAX_KEYS_PER_REQUEST',
      min: 1,
      max: 100,
    });
  });

  it('takes a whole number from 1 to 100, and nothing else', () => {
    const manager = createSettingsManager({ env: {}, kv: null });
    manager.registerCategory(BULK_APPLY_CATEGORY_META);
    for (const value of [1, 25, 100]) {
      expect(manager.validate('bulk-apply', { [BULK_APPLY_MAX_TENANTS_KEY]: value }).valid).toBe(
        true
      );
    }
    for (const value of [0, 101, -1, 2.5, '5', true, null]) {
      expect(
        manager.validate('bulk-apply', { [BULK_APPLY_MAX_TENANTS_KEY]: value }).valid,
        String(value)
      ).toBe(false);
    }
  });

  it('is read from KV first, then the environment, then the default', async () => {
    const read = (documents: Record<string, unknown>, env: Record<string, string> = {}) =>
      resolvePlatformSettingsWithSources(
        { SETTINGS: kv(documents), ...env } as never,
        'bulk-apply',
        { fresh: true }
      );
    expect((await read({})).values[BULK_APPLY_MAX_TENANTS_KEY]).toBe(25);
    expect(
      (await read({}, { BULK_APPLY_MAX_TENANTS_PER_REQUEST: '40' })).values[
        BULK_APPLY_MAX_TENANTS_KEY
      ]
    ).toBe(40);
    const saved = await read(
      { 'settings:platform:bulk-apply': { [BULK_APPLY_MAX_TENANTS_KEY]: 7 } },
      { BULK_APPLY_MAX_TENANTS_PER_REQUEST: '40' }
    );
    expect(saved.values[BULK_APPLY_MAX_TENANTS_KEY]).toBe(7);
    expect(saved.sources[BULK_APPLY_MAX_TENANTS_KEY]).toBe('kv');
  });

  it('holds a value between 1 and 100 when it is read, and falls back to the default for a non-number', () => {
    expect(clampBulkApplyLimit(1000, 25)).toBe(100);
    expect(clampBulkApplyLimit(0, 25)).toBe(1);
    expect(clampBulkApplyLimit(-5, 25)).toBe(1);
    expect(clampBulkApplyLimit(7.9, 25)).toBe(7);
    expect(clampBulkApplyLimit('abc', 25)).toBe(25);
    expect(clampBulkApplyLimit(undefined, 25)).toBe(25);
    expect(clampBulkApplyLimit(Number.NaN, 25)).toBe(25);
    expect(clampBulkApplyLimit(Number.POSITIVE_INFINITY, 25)).toBe(25);
  });
});
