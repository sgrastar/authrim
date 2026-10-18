/**
 * Four settings are gone: `plugin.memory_limit_mb` (the platform fixes the memory of a plugin),
 * `plugin.notifier_console_enabled` (a notifier that prints secrets is never a tenant switch),
 * `plugin.execution_timeout_ms` (ar-plugin-runner reads the run time limit from the policy of each
 * installation, never from the tenant, so a tenant value would mislead) and
 * `diagnostic-logging.filter_tokens` (tokens are never stored in clear text in any mode, so there
 * is nothing to switch). Documents saved before that, and environment variables, still hold them:
 * they must read, save and resolve as before, and none of them is a setting any more.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSettingsManager } from '../utils/settings-manager';
import {
  PLUGIN_CATEGORY_META,
  PLUGIN_DEFAULTS,
  PLUGIN_SETTINGS_META,
} from '../types/settings/plugin';
import {
  DIAGNOSTIC_LOGGING_CATEGORY_META,
  DIAGNOSTIC_LOGGING_DEFAULTS,
  DIAGNOSTIC_LOGGING_SETTINGS_META,
} from '../types/settings/diagnostic-logging';
import { ALL_CATEGORY_META } from '../types/settings/catalog';
import { TENANT_SETTING_FIELD_POLICIES } from '../services/tenant-portability/settings-field-registry';
import { resolveEffectiveSettings } from '../services/effective-settings';

const RETIRED_PLUGIN = {
  'plugin.memory_limit_mb': 256,
  'plugin.notifier_console_enabled': true,
  'plugin.execution_timeout_ms': 30000,
};
const RETIRED_DIAGNOSTIC = { 'diagnostic-logging.filter_tokens': false };
const RETIRED_ENV_KEYS = [
  'PLUGIN_MEMORY_LIMIT_MB',
  'PLUGIN_NOTIFIER_CONSOLE_ENABLED',
  'PLUGIN_EXECUTION_TIMEOUT_MS',
  'DIAGNOSTIC_LOGGING_FILTER_TOKENS',
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
  'settings:tenant:t1:plugin': JSON.stringify({
    ...RETIRED_PLUGIN,
    'plugin.notifier_resend_enabled': false,
  }),
  'settings:tenant:t1:diagnostic-logging': JSON.stringify({
    ...RETIRED_DIAGNOSTIC,
    'diagnostic-logging.retention_days': 7,
  }),
};

describe('the retired plugin and diagnostic logging settings', () => {
  it('are no longer settings', () => {
    const keys = [...Object.keys(RETIRED_PLUGIN), ...Object.keys(RETIRED_DIAGNOSTIC)];
    for (const key of keys) {
      expect(Object.keys(PLUGIN_SETTINGS_META)).not.toContain(key);
      expect(Object.keys(PLUGIN_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(PLUGIN_DEFAULTS)).not.toContain(key);
      expect(Object.keys(DIAGNOSTIC_LOGGING_SETTINGS_META)).not.toContain(key);
      expect(Object.keys(DIAGNOSTIC_LOGGING_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(DIAGNOSTIC_LOGGING_DEFAULTS)).not.toContain(key);
      expect(TENANT_SETTING_FIELD_POLICIES.map((policy) => policy.key)).not.toContain(key);
      for (const meta of Object.values(ALL_CATEGORY_META)) {
        expect(Object.keys(meta.settings), key).not.toContain(key);
      }
    }
    const envKeys = Object.values(ALL_CATEGORY_META).flatMap((meta) =>
      Object.values(meta.settings).map((setting) => (setting as { envKey?: string }).envKey)
    );
    for (const envKey of RETIRED_ENV_KEYS) expect(envKeys).not.toContain(envKey);
  });

  it('keep the other plugin and diagnostic logging settings', () => {
    expect(Object.keys(PLUGIN_SETTINGS_META).sort()).toEqual([
      'plugin.auto_update_check',
      'plugin.enabled',
      'plugin.notifier_resend_enabled',
    ]);
    expect(Object.keys(DIAGNOSTIC_LOGGING_SETTINGS_META)).toEqual(
      expect.arrayContaining([
        'diagnostic-logging.filter_pii',
        'diagnostic-logging.merged_output_enabled',
        'diagnostic-logging.token_hash_prefix_length',
      ])
    );
  });

  it('in a saved document do not break reading, and are not returned', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(PLUGIN_CATEGORY_META);
    manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);

    const plugin = await manager.getAll('plugin', { type: 'tenant', id: 't1' });
    expect(plugin.values['plugin.notifier_resend_enabled']).toBe(false);
    for (const key of Object.keys(RETIRED_PLUGIN)) {
      expect(plugin.values).not.toHaveProperty(key);
      expect(plugin.sources).not.toHaveProperty(key);
    }

    const diagnostic = await manager.getAll('diagnostic-logging', { type: 'tenant', id: 't1' });
    expect(diagnostic.values['diagnostic-logging.retention_days']).toBe(7);
    expect(diagnostic.values).not.toHaveProperty('diagnostic-logging.filter_tokens');
    expect(diagnostic.sources).not.toHaveProperty('diagnostic-logging.filter_tokens');
  });

  it('in a saved document do not break saving another setting', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(PLUGIN_CATEGORY_META);
    manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);

    const plugin = await manager.getAll('plugin', { type: 'tenant', id: 't1' });
    const pluginResult = await manager.patch(
      'plugin',
      { type: 'tenant', id: 't1' },
      { ifMatch: plugin.version, set: { 'plugin.enabled': true } },
      'admin'
    );
    expect(pluginResult.applied).toEqual(['plugin.enabled']);
    expect(pluginResult.rejected).toEqual({});

    const diagnostic = await manager.getAll('diagnostic-logging', { type: 'tenant', id: 't1' });
    const diagnosticResult = await manager.patch(
      'diagnostic-logging',
      { type: 'tenant', id: 't1' },
      { ifMatch: diagnostic.version, set: { 'diagnostic-logging.filter_pii': false } },
      'admin'
    );
    expect(diagnosticResult.applied).toEqual(['diagnostic-logging.filter_pii']);
    expect(diagnosticResult.rejected).toEqual({});
  });

  it('are rejected as unknown keys when set again', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV({}), cacheTTL: 0 });
    manager.registerCategory(PLUGIN_CATEGORY_META);
    manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);

    const plugin = await manager.getAll('plugin', { type: 'tenant', id: 't1' });
    const pluginResult = await manager.patch(
      'plugin',
      { type: 'tenant', id: 't1' },
      { ifMatch: plugin.version, set: RETIRED_PLUGIN },
      'admin'
    );
    expect(pluginResult.applied).toEqual([]);
    expect(Object.values(pluginResult.rejected)).toEqual(Array(3).fill('Unknown setting key'));

    const diagnostic = await manager.getAll('diagnostic-logging', { type: 'tenant', id: 't1' });
    const diagnosticResult = await manager.patch(
      'diagnostic-logging',
      { type: 'tenant', id: 't1' },
      { ifMatch: diagnostic.version, set: RETIRED_DIAGNOSTIC },
      'admin'
    );
    expect(diagnosticResult.applied).toEqual([]);
    expect(diagnosticResult.rejected).toEqual({
      'diagnostic-logging.filter_tokens': 'Unknown setting key',
    });
  });

  it('are ignored by the runtime reader, stored in a document or set in the environment', async () => {
    const env = {
      SETTINGS: createMockKV(SAVED),
      PLUGIN_MEMORY_LIMIT_MB: '512',
      PLUGIN_NOTIFIER_CONSOLE_ENABLED: 'true',
      PLUGIN_EXECUTION_TIMEOUT_MS: '30000',
      DIAGNOSTIC_LOGGING_FILTER_TOKENS: 'false',
    };

    const plugin = await resolveEffectiveSettings(env, 'plugin', { tenantId: 't1' });
    expect(plugin['plugin.notifier_resend_enabled']).toBe(false);
    for (const key of Object.keys(RETIRED_PLUGIN)) expect(plugin).not.toHaveProperty(key);

    const diagnostic = await resolveEffectiveSettings(env, 'diagnostic-logging', {
      tenantId: 't1',
    });
    expect(diagnostic['diagnostic-logging.retention_days']).toBe(7);
    expect(diagnostic).not.toHaveProperty('diagnostic-logging.filter_tokens');
  });
});
