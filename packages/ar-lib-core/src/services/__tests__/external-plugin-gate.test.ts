/**
 * `plugin.enabled` decides whether the code of external (custom) plugins may run for a tenant.
 * The gate is fail-closed: anything but an explicit "on" reads as "not allowed".
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_PLUGIN_EXECUTION_NOT_ALLOWED,
  getExternalPluginExecutionState,
  isExternalPluginExecutionAllowed,
} from '../external-plugin-gate';

function kvWith(data: Record<string, string>) {
  const store = new Map(Object.entries(data));
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  };
  return { kv: kv as unknown as KVNamespace, store, get: kv.get };
}

const doc = (tenantId: string, values: Record<string, unknown>) => ({
  [`settings:tenant:${tenantId}:plugin`]: JSON.stringify(values),
});

describe('isExternalPluginExecutionAllowed', () => {
  it('is off for a tenant that never set it, without an environment variable', async () => {
    const { kv } = kvWith({});
    expect(await isExternalPluginExecutionAllowed({ SETTINGS: kv }, 'tenant-a')).toBe(false);
    expect(await isExternalPluginExecutionAllowed({}, 'tenant-a')).toBe(false);
  });

  it('is on when the tenant turned it on', async () => {
    const { kv } = kvWith(doc('tenant-a', { 'plugin.enabled': true }));
    expect(await isExternalPluginExecutionAllowed({ SETTINGS: kv }, 'tenant-a')).toBe(true);
  });

  it('is off when the tenant turned it off', async () => {
    const { kv } = kvWith(doc('tenant-a', { 'plugin.enabled': false }));
    expect(await isExternalPluginExecutionAllowed({ SETTINGS: kv }, 'tenant-a')).toBe(false);
  });

  it('keeps one tenant out of another tenant on-switch', async () => {
    const { kv } = kvWith(doc('tenant-a', { 'plugin.enabled': true }));
    expect(await isExternalPluginExecutionAllowed({ SETTINGS: kv }, 'tenant-b')).toBe(false);
  });

  it('falls back to PLUGIN_ENABLED when the tenant set nothing', async () => {
    // One environment per KV: the reader keeps the environment it first saw for a KV.
    expect(
      await isExternalPluginExecutionAllowed(
        { SETTINGS: kvWith({}).kv, PLUGIN_ENABLED: 'true' },
        't'
      )
    ).toBe(true);
    expect(
      await isExternalPluginExecutionAllowed(
        { SETTINGS: kvWith({}).kv, PLUGIN_ENABLED: 'false' },
        't'
      )
    ).toBe(false);
    expect(await isExternalPluginExecutionAllowed({ PLUGIN_ENABLED: 'true' }, 't')).toBe(true);
  });

  it('prefers the tenant value over PLUGIN_ENABLED, in both directions', async () => {
    const on = kvWith(doc('t', { 'plugin.enabled': true }));
    const off = kvWith(doc('t', { 'plugin.enabled': false }));
    expect(
      await isExternalPluginExecutionAllowed({ SETTINGS: on.kv, PLUGIN_ENABLED: 'false' }, 't')
    ).toBe(true);
    expect(
      await isExternalPluginExecutionAllowed({ SETTINGS: off.kv, PLUGIN_ENABLED: 'true' }, 't')
    ).toBe(false);
  });

  it('is not turned on by the retired Resend switch or its environment variable', async () => {
    const { kv } = kvWith(doc('t', { 'plugin.notifier_resend_enabled': true }));
    expect(
      await isExternalPluginExecutionAllowed(
        { SETTINGS: kv, PLUGIN_NOTIFIER_RESEND_ENABLED: 'true' } as never,
        't'
      )
    ).toBe(false);
  });

  it('is off when the settings cannot be read (the KV throws)', async () => {
    const { kv, get } = kvWith(doc('t', { 'plugin.enabled': true }));
    get.mockRejectedValue(new Error('kv down'));
    expect(
      await isExternalPluginExecutionAllowed({ SETTINGS: kv, PLUGIN_ENABLED: 'true' }, 't')
    ).toBe(false);
  });

  it('is off when the stored document is not valid JSON', async () => {
    const { kv } = kvWith({ 'settings:tenant:t:plugin': '{not json' });
    expect(
      await isExternalPluginExecutionAllowed({ SETTINGS: kv, PLUGIN_ENABLED: 'true' }, 't')
    ).toBe(false);
  });

  it('is off for a tenant id that cannot be a settings key', async () => {
    const { kv } = kvWith({});
    expect(
      await isExternalPluginExecutionAllowed({ SETTINGS: kv, PLUGIN_ENABLED: 'true' }, 'a:b/c')
    ).toBe(false);
  });

  it('reads past the short cache only when asked to', async () => {
    const { kv, store } = kvWith({});
    const env = { SETTINGS: kv };
    expect(await isExternalPluginExecutionAllowed(env, 'tenant-cache')).toBe(false);
    store.set('settings:tenant:tenant-cache:plugin', JSON.stringify({ 'plugin.enabled': true }));
    expect(await isExternalPluginExecutionAllowed(env, 'tenant-cache')).toBe(false);
    expect(await isExternalPluginExecutionAllowed(env, 'tenant-cache', { fresh: true })).toBe(true);
  });

  it('names its refusal with a stable error code', () => {
    expect(EXTERNAL_PLUGIN_EXECUTION_NOT_ALLOWED).toBe('external_plugin_execution_not_allowed');
  });

  describe('getExternalPluginExecutionState tells "not on" from "cannot be read"', () => {
    it('is allowed only for an explicit on', async () => {
      const { kv } = kvWith(doc('t', { 'plugin.enabled': true }));
      expect(await getExternalPluginExecutionState({ SETTINGS: kv }, 't')).toBe('allowed');
    });

    it('is denied when the settings were read and it is not on (off, unset, other tenant)', async () => {
      const off = kvWith(doc('t', { 'plugin.enabled': false }));
      expect(await getExternalPluginExecutionState({ SETTINGS: off.kv }, 't')).toBe('denied');
      expect(await getExternalPluginExecutionState({ SETTINGS: kvWith({}).kv }, 't')).toBe(
        'denied'
      );
      const other = kvWith(doc('other', { 'plugin.enabled': true }));
      expect(await getExternalPluginExecutionState({ SETTINGS: other.kv }, 't')).toBe('denied');
    });

    it('is unreadable when the KV throws, a document is not valid JSON, or the tenant id is malformed', async () => {
      const broken = kvWith(doc('t', { 'plugin.enabled': true }));
      broken.get.mockRejectedValue(new Error('kv down'));
      expect(await getExternalPluginExecutionState({ SETTINGS: broken.kv }, 't')).toBe(
        'unreadable'
      );
      const garbage = kvWith({ 'settings:tenant:t:plugin': '{not json' });
      expect(await getExternalPluginExecutionState({ SETTINGS: garbage.kv }, 't')).toBe(
        'unreadable'
      );
      expect(await getExternalPluginExecutionState({ SETTINGS: kvWith({}).kv }, 'a:b/c')).toBe(
        'unreadable'
      );
    });
  });
});
