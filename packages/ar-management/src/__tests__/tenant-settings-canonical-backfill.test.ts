import { expect, it, vi } from 'vitest';
import type {
  CanonicalSettingsDocument,
  SettingScope,
  SettingsCanonicalStore,
} from '@authrim/ar-lib-core/utils/settings-manager';
import { generateVersion, settingsStorageKey } from '@authrim/ar-lib-core/utils/settings-manager';
import {
  backfillTenantSettingsCanonicalPage,
  CLIENT_SETTINGS_BACKFILL_CATEGORIES,
  TENANT_SETTINGS_BACKFILL_CATEGORIES,
} from '../tenant-settings-canonical-backfill';

type ScopedSetting = Exclude<SettingScope, { type: 'platform' }>;

function canonicalFixture() {
  const values = new Map<string, CanonicalSettingsDocument>();
  const key = (category: string, scope: ScopedSetting) => settingsStorageKey(category, scope);
  const store: SettingsCanonicalStore = {
    load: vi.fn(async (category, scope) => values.get(key(category, scope)) ?? null),
    create: vi.fn(async (category, scope, value) => {
      const storageKey = key(category, scope);
      if (!values.has(storageKey)) values.set(storageKey, structuredClone(value));
      return structuredClone(values.get(storageKey)!);
    }),
    compareAndSet: vi.fn(async () => false),
    markProjected: vi.fn(async () => {}),
  };
  return { store, values };
}

function kv(values: Record<string, string>) {
  return { get: vi.fn(async (key: string) => values[key] ?? null) };
}

it('backfills only exact reviewed tenant and existing client keys across durable pages', async () => {
  const canonical = canonicalFixture();
  const primary = kv({
    'settings:tenant:tenant-a:security': JSON.stringify({ enabled: true }),
    'settings:client:tenant-a:client-a:client': JSON.stringify({ name: 'A' }),
    'settings:client:tenant-a:unknown:client': JSON.stringify({ name: 'unknown' }),
  });
  const fallback = kv({
    'settings:tenant:tenant-a:security': JSON.stringify({ enabled: false }),
    'settings:tenant:tenant-a:email-settings': JSON.stringify({ strategy: 'priority' }),
  });
  const clientDatabase = {
    queryOne: vi.fn(async (_sql: string, params?: unknown[]) => {
      const after = String(params?.[1] ?? '');
      return after < 'client-a' ? { client_id: 'client-a' } : null;
    }),
  };

  let cursor: string | null = null;
  let pages = 0;
  while (true) {
    const result = await backfillTenantSettingsCanonicalPage({
      tenantId: 'tenant-a',
      canonical: canonical.store,
      sources: [primary, fallback],
      clientDatabase,
      cursor,
      limit: 7,
    });
    pages++;
    if (result.done) break;
    cursor = result.cursor;
  }

  expect(pages).toBeGreaterThan(1);
  expect(canonical.values.get('settings:tenant:tenant-a:security')?.data).toEqual({
    enabled: true,
  });
  expect(canonical.values.get('settings:tenant:tenant-a:email-settings')?.data).toEqual({
    strategy: 'priority',
  });
  expect(canonical.values.get('settings:client:tenant-a:client-a:client')?.data).toEqual({
    name: 'A',
  });
  expect(canonical.values.has('settings:client:tenant-a:unknown:client')).toBe(false);
  expect(primary.get).not.toHaveBeenCalledWith(expect.stringContaining(':unknown:'));
  expect(canonical.store.markProjected).toHaveBeenCalledTimes(3);
  expect(primary.get.mock.calls.length + fallback.get.mock.calls.length).toBeLessThanOrEqual(
    TENANT_SETTINGS_BACKFILL_CATEGORIES.length * 2 + CLIENT_SETTINGS_BACKFILL_CATEGORIES.length * 2
  );
});

it('does not overwrite a canonical value with stale KV data', async () => {
  const canonical = canonicalFixture();
  const scope = { type: 'tenant', id: 'tenant-a' } as const;
  const current = { enabled: true };
  canonical.values.set(settingsStorageKey('security', scope), {
    data: current,
    version: generateVersion(current),
  });
  const source = kv({
    'settings:tenant:tenant-a:security': JSON.stringify({ enabled: false }),
  });

  await backfillTenantSettingsCanonicalPage({
    tenantId: 'tenant-a',
    canonical: canonical.store,
    sources: [source],
    clientDatabase: { queryOne: vi.fn(async () => null) },
    cursor: null,
    limit: 100,
  });

  expect(canonical.values.get('settings:tenant:tenant-a:security')?.data).toEqual(current);
  expect(source.get).not.toHaveBeenCalledWith('settings:tenant:tenant-a:security');
});

it('fails closed for malformed documents and forged cursors', async () => {
  const canonical = canonicalFixture();
  const source = kv({
    [`settings:tenant:tenant-a:${TENANT_SETTINGS_BACKFILL_CATEGORIES[0]}`]: '[]',
  });
  const input = {
    tenantId: 'tenant-a',
    canonical: canonical.store,
    sources: [source],
    clientDatabase: { queryOne: vi.fn(async () => null) },
    cursor: null,
    limit: 1,
  };
  await expect(backfillTenantSettingsCanonicalPage(input)).rejects.toThrow(
    'tenant_settings_backfill_invalid'
  );
  await expect(
    backfillTenantSettingsCanonicalPage({ ...input, cursor: '{"version":1}' })
  ).rejects.toThrow('tenant_settings_backfill_invalid');
  await expect(
    backfillTenantSettingsCanonicalPage({
      ...input,
      cursor: JSON.stringify({
        version: 1,
        stage: 'clients',
        tenantCategoryIndex: TENANT_SETTINGS_BACKFILL_CATEGORIES.length,
        afterClientId: 'client-z',
        clientId: 'client-a',
        clientCategoryIndex: 0,
      }),
    })
  ).rejects.toThrow('tenant_settings_backfill_invalid');
});

it('rejects an invalid client identity instead of omitting its settings', async () => {
  const canonical = canonicalFixture();
  await expect(
    backfillTenantSettingsCanonicalPage({
      tenantId: 'tenant-a',
      canonical: canonical.store,
      sources: [kv({})],
      clientDatabase: { queryOne: vi.fn(async () => ({ client_id: 'invalid:client' })) },
      cursor: JSON.stringify({
        version: 1,
        stage: 'clients',
        tenantCategoryIndex: TENANT_SETTINGS_BACKFILL_CATEGORIES.length,
        afterClientId: '',
        clientId: null,
        clientCategoryIndex: 0,
      }),
      limit: 1,
    })
  ).rejects.toThrow('tenant_settings_backfill_invalid');
});
