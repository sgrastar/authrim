import { readFileSync } from 'node:fs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import { generateVersion } from '@authrim/ar-lib-core/utils/settings-manager';

type SqlValue = string | number | null;

const database = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: () => database.current,
}));

import { processPendingSettingsProjections } from '../settings-canonical-projection';

/** Longer than the recent window, so only the least-recently-reconciled pass applies. */
const RECONCILE_STEP_MS = 60 * 60 * 1000;

function adapter(db: DatabaseSync) {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SqlValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SqlValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
  };
}

describe('processPendingSettingsProjections', () => {
  const scope = { type: 'tenant' as const, id: 'tenant-a' };
  const storageKey = 'settings:tenant:tenant-a:security';
  let db: DatabaseSync;
  let values: Map<string, string>;
  let env: Env;
  let store: DatabaseSettingsCanonicalStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(
        new URL(
          '../../../../migrations/admin/d1/028_tenant_settings_documents.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    db.exec(
      readFileSync(
        new URL(
          '../../../../migrations/admin/d1/038_tenant_settings_reconciled_at.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    db.exec(
      readFileSync(
        new URL(
          '../../../../migrations/admin/d1/039_platform_settings_documents.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    database.current = adapter(db);
    store = new DatabaseSettingsCanonicalStore(adapter(db), () => 1_000);
    values = new Map();
    env = {
      SETTINGS: {
        get: vi.fn(async (key: string) => values.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => void values.set(key, value)),
      },
    } as unknown as Env;
  });

  afterEach(() => db.close());

  async function projected(data: Record<string, unknown>) {
    const document = { data, version: generateVersion(data) };
    await store.create('security', scope, document);
    await store.markProjected('security', scope, document.version);
    return document;
  }

  it('repairs a projected document whose KV copy was overwritten by an older write', async () => {
    await projected({ 'security.enabled': true });
    // A slow projection of the previous version landed after this one was marked projected.
    values.set(storageKey, JSON.stringify({ 'security.enabled': false }));

    const result = await processPendingSettingsProjections(env, 25, () => 2_000);

    expect(result.repaired).toBe(1);
    expect(JSON.parse(values.get(storageKey)!)).toEqual({ 'security.enabled': true });
  });

  it('leaves a projected document alone when KV already holds it', async () => {
    await projected({ 'security.enabled': true });
    values.set(storageKey, JSON.stringify({ 'security.enabled': true }));

    const result = await processPendingSettingsProjections(env, 25, () => 2_000);

    expect(result.repaired).toBe(0);
    expect(env.SETTINGS!.put).not.toHaveBeenCalledWith(storageKey, expect.anything());
  });

  it('sweeps every projected document, however long ago it changed', async () => {
    await projected({ 'security.enabled': true });
    values.set(storageKey, JSON.stringify({ 'security.enabled': false }));

    // Long after the recent window: only the sweep can find it.
    const result = await processPendingSettingsProjections(env, 25, () => 1_000 + 60 * 60 * 1000);

    expect(result.repaired).toBe(1);
    expect(JSON.parse(values.get(storageKey)!)).toEqual({ 'security.enabled': true });
  });

  it('reaches every document across runs when more are stale than one batch holds', async () => {
    const later = () => 1_000 + 60 * 60 * 1000;
    const tenants = ['t1', 't2', 't3', 't4', 't5'];
    for (const tenant of tenants) {
      const data = { 'security.enabled': true };
      const tenantScope = { type: 'tenant' as const, id: tenant };
      await store.create('security', tenantScope, { data, version: generateVersion(data) });
      await store.markProjected('security', tenantScope, generateVersion(data));
      values.set(`settings:tenant:${tenant}:security`, JSON.stringify({ stale: true }));
    }

    for (let run = 0; run < 3; run++) await processPendingSettingsProjections(env, 2, later);

    for (const tenant of tenants) {
      expect(JSON.parse(values.get(`settings:tenant:${tenant}:security`)!)).toEqual({
        'security.enabled': true,
      });
    }
  });

  it('hands a document it cannot compare to the pending retry and keeps sweeping', async () => {
    const later = () => 1_000 + 60 * 60 * 1000;
    for (const tenant of ['t1', 't2']) {
      const data = { 'security.enabled': true };
      const tenantScope = { type: 'tenant' as const, id: tenant };
      await store.create('security', tenantScope, { data, version: generateVersion(data) });
      await store.markProjected('security', tenantScope, generateVersion(data));
    }
    values.set('settings:tenant:t2:security', JSON.stringify({ stale: true }));
    const get = env.SETTINGS!.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async (key: string) => {
      if (key === 'settings:tenant:t1:security') throw new Error('kv unavailable');
      return values.get(key) ?? null;
    });

    const result = await processPendingSettingsProjections(env, 25, later);

    expect(result.failures).toBe(1);
    expect((await store.pending()).map(({ storageKey: key }) => key)).toEqual([
      'settings:tenant:t1:security',
    ]);
    expect(JSON.parse(values.get('settings:tenant:t2:security')!)).toEqual({
      'security.enabled': true,
    });
  });

  it('reaches a recovered pending document even while earlier pending ones keep failing', async () => {
    const later = () => 1_000 + 60 * 60 * 1000;
    const data = { 'security.enabled': true };
    for (const tenant of ['t1', 't2', 't3']) {
      // Saved but never projected: pending.
      await store.create(
        'security',
        { type: 'tenant', id: tenant },
        {
          data,
          version: generateVersion(data),
        }
      );
    }
    const put = env.SETTINGS!.put as ReturnType<typeof vi.fn>;
    put.mockImplementation(async (key: string, value: string) => {
      if (key === 'settings:tenant:t1:security' || key === 'settings:tenant:t2:security') {
        throw new Error('kv unavailable');
      }
      values.set(key, value);
    });

    // The pending retry takes the two oldest (which keep failing); the sweep moves on.
    for (let run = 0; run < 2; run++) await processPendingSettingsProjections(env, 2, later);

    expect(JSON.parse(values.get('settings:tenant:t3:security')!)).toEqual(data);
    expect((await store.pending()).map(({ storageKey: key }) => key)).toEqual([
      'settings:tenant:t1:security',
      'settings:tenant:t2:security',
    ]);
  });

  it('comes back round to compared documents even while new ones keep being added', async () => {
    let clock = 10_000;
    const timed = new DatabaseSettingsCanonicalStore(adapter(db), () => clock);
    const data = { 'security.enabled': true };
    const add = async (tenant: string) => {
      const tenantScope = { type: 'tenant' as const, id: tenant };
      await timed.create('security', tenantScope, { data, version: generateVersion(data) });
      await timed.markProjected('security', tenantScope, generateVersion(data));
      values.set(`settings:tenant:${tenant}:security`, JSON.stringify(data));
    };
    await add('a0');
    await add('a1');

    let next = 0;
    for (let run = 0; run < 8; run++) {
      clock += RECONCILE_STEP_MS;
      await processPendingSettingsProjections(env, 1, () => clock);
      if (run === 0) {
        // After a0 was compared, its KV copy is overwritten by an older write.
        values.set('settings:tenant:a0:security', JSON.stringify({ stale: true }));
      }
      // More documents than one batch holds arrive on every run.
      clock += 1;
      await add(`b${String(next++).padStart(2, '0')}`);
      await add(`b${String(next++).padStart(2, '0')}`);
    }

    expect(JSON.parse(values.get('settings:tenant:a0:security')!)).toEqual(data);
  });

  it('takes the documents compared least recently first; new ones queue behind', async () => {
    let clock = 10_000;
    const timed = new DatabaseSettingsCanonicalStore(adapter(db), () => clock);
    const data = { 'security.enabled': true };
    const add = async (tenant: string) => {
      const tenantScope = { type: 'tenant' as const, id: tenant };
      await timed.create('security', tenantScope, { data, version: generateVersion(data) });
      await timed.markProjected('security', tenantScope, generateVersion(data));
      values.set(`settings:tenant:${tenant}:security`, JSON.stringify(data));
    };
    await add('a0');
    await add('z0');
    const compared: string[] = [];
    const get = env.SETTINGS!.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async (key: string) => {
      compared.push(key.replace('settings:tenant:', '').replace(':security', ''));
      return values.get(key) ?? null;
    });

    for (let run = 0; run < 4; run++) {
      clock += RECONCILE_STEP_MS;
      await processPendingSettingsProjections(env, 1, () => clock);
      // Sorts between a0 and z0, added after a0 was compared: it queues behind a0.
      if (run === 0) {
        clock += 1;
        await add('b0');
      }
    }

    expect(compared).toEqual(['a0', 'z0', 'a0', 'b0']);
  });

  it('moves a document that keeps failing to the back, so the ones behind it get their turn', async () => {
    let clock = 10_000;
    const timed = new DatabaseSettingsCanonicalStore(adapter(db), () => clock);
    const data = { 'security.enabled': true };
    for (const tenant of ['a0', 'z0']) {
      const tenantScope = { type: 'tenant' as const, id: tenant };
      await timed.create('security', tenantScope, { data, version: generateVersion(data) });
      await timed.markProjected('security', tenantScope, generateVersion(data));
    }
    values.set('settings:tenant:z0:security', JSON.stringify({ stale: true }));
    // a0 can be neither compared nor handed to the pending retry, on every run.
    const get = env.SETTINGS!.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async (key: string) => {
      if (key === 'settings:tenant:a0:security') throw new Error('kv unavailable');
      return values.get(key) ?? null;
    });
    vi.spyOn(DatabaseSettingsCanonicalStore.prototype, 'markPending').mockRejectedValue(
      new Error('d1 unavailable')
    );

    // One document per run: a0 first, then z0 behind it.
    for (let run = 0; run < 2; run++) {
      clock += RECONCILE_STEP_MS;
      await processPendingSettingsProjections(env, 1, () => clock);
    }
    vi.restoreAllMocks();

    expect(JSON.parse(values.get('settings:tenant:z0:security')!)).toEqual(data);
    // a0 comes round again after the rest.
    const [front] = await timed.leastRecentlyReconciled(1);
    expect(front.storageKey).toBe('settings:tenant:a0:security');
  });
});
