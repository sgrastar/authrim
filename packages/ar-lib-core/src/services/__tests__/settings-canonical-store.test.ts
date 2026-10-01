import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSettingsCanonicalStore } from '../settings-canonical-store';
import {
  ConflictError,
  generateVersion,
  projectLatestSettingsDocument,
  SettingsManager,
} from '../../utils/settings-manager';

function adapter(db: DatabaseSync) {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
  };
}

function category(manager: SettingsManager) {
  manager.registerCategory({
    category: 'security',
    label: 'Security',
    description: 'fixture',
    settings: {
      'security.enabled': {
        key: 'security.enabled',
        type: 'boolean',
        default: false,
        label: 'Enabled',
        description: 'fixture',
      },
    },
  });
  return manager;
}

describe('DatabaseSettingsCanonicalStore', () => {
  let db: DatabaseSync;
  let now: number;
  let values: Map<string, string>;
  let put: ReturnType<typeof vi.fn>;
  let store: DatabaseSettingsCanonicalStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(
        new URL(
          '../../../../../migrations/admin/d1/028_tenant_settings_documents.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    db.exec(
      readFileSync(
        new URL(
          '../../../../../migrations/admin/d1/038_tenant_settings_reconciled_at.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    now = 100;
    values = new Map([
      ['settings:tenant:tenant-a:security', JSON.stringify({ 'security.enabled': true })],
    ]);
    put = vi.fn(async (key: string, value: string) => values.set(key, value));
    store = new DatabaseSettingsCanonicalStore(adapter(db), () => now++);
  });

  afterEach(() => db.close());

  function manager() {
    return category(
      new SettingsManager({
        env: {},
        kv: {
          get: async (key: string) => values.get(key) ?? null,
          put,
        } as unknown as KVNamespace,
        canonicalStore: store,
        cacheTTL: 0,
        strictReads: true,
      })
    );
  }

  it('bootstraps once from KV and then reads the canonical document', async () => {
    const first = manager();
    expect((await first.getAll('security', { type: 'tenant', id: 'tenant-a' })).values).toEqual({
      'security.enabled': true,
    });
    expect(db.prepare('SELECT projection_state FROM tenant_settings_documents').get()).toEqual({
      projection_state: 'applied',
    });
    values.set('settings:tenant:tenant-a:security', JSON.stringify({ 'security.enabled': false }));
    expect((await manager().getAll('security', { type: 'tenant', id: 'tenant-a' })).values).toEqual(
      {
        'security.enabled': true,
      }
    );
  });

  it('commits with CAS and leaves a retryable projection when KV fails', async () => {
    const first = manager();
    const initial = await first.getAll('security', { type: 'tenant', id: 'tenant-a' });
    // The manager tries the projection three times before leaving it to the scheduled retry.
    put.mockRejectedValueOnce(new Error('kv unavailable'));
    put.mockRejectedValueOnce(new Error('kv unavailable'));
    put.mockRejectedValueOnce(new Error('kv unavailable'));
    const changed = await first.patch(
      'security',
      { type: 'tenant', id: 'tenant-a' },
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );
    expect(changed.applied).toEqual(['security.enabled']);
    expect(changed.projection).toBe('pending');
    expect((await store.pending()).map(({ storageKey }) => storageKey)).toEqual([
      'settings:tenant:tenant-a:security',
    ]);
    expect((await manager().getAll('security', { type: 'tenant', id: 'tenant-a' })).values).toEqual(
      {
        'security.enabled': false,
      }
    );
    const [pending] = await store.pending();
    const backwardsClockStore = new DatabaseSettingsCanonicalStore(adapter(db), () => 1);
    await backwardsClockStore.markProjected(pending.category, pending.scope, pending.version);
    const timestamps = db
      .prepare('SELECT updated_at,projected_at FROM tenant_settings_documents')
      .get();
    expect(timestamps).toEqual({ updated_at: 102, projected_at: 102 });
  });

  it('projects on the retry when the first KV write fails', async () => {
    const first = manager();
    const initial = await first.getAll('security', { type: 'tenant', id: 'tenant-a' });
    put.mockRejectedValueOnce(new Error('kv unavailable'));
    const changed = await first.patch(
      'security',
      { type: 'tenant', id: 'tenant-a' },
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );
    expect(changed.projection).toBeUndefined();
    expect(await store.pending()).toEqual([]);
  });

  it('re-projects the latest document when a save lands after the pending list was read', async () => {
    const scope = { type: 'tenant' as const, id: 'tenant-a' };
    const first = manager();
    const initial = await first.getAll('security', scope);
    put.mockRejectedValue(new Error('kv unavailable'));
    const stale = await first.patch(
      'security',
      scope,
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );
    expect(stale.projection).toBe('pending');
    const [item] = await store.pending();

    // A newer save projects itself after the scheduled retry listed the older one.
    put.mockImplementation(async (key: string, value: string) => values.set(key, value));
    const latest = await manager().getAll('security', scope);
    await manager().patch(
      'security',
      scope,
      { ifMatch: latest.version, set: { 'security.enabled': true } },
      'admin'
    );

    const result = await projectLatestSettingsDocument(
      store,
      { put } as unknown as KVNamespace,
      item.category,
      item.scope,
      item.storageKey
    );
    expect(result).toBe('applied');
    expect(JSON.parse(values.get(item.storageKey)!)).toEqual({ 'security.enabled': true });
    expect(await store.pending()).toEqual([]);
  });

  it('lists recently projected documents for reconciliation', async () => {
    const scope = { type: 'tenant' as const, id: 'tenant-a' };
    const first = manager();
    const initial = await first.getAll('security', scope);
    await first.patch(
      'security',
      scope,
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );

    const recent = await store.recentlyProjected(0);
    expect(recent.map(({ storageKey }) => storageKey)).toEqual([
      'settings:tenant:tenant-a:security',
    ]);
    expect(await store.recentlyProjected(now + 1_000)).toEqual([]);
  });

  it('reports pending instead of failing when the canonical copy cannot be read after writing', async () => {
    const scope = { type: 'tenant' as const, id: 'tenant-a' };
    await manager().getAll('security', scope);
    const [initial] = await store.recentlyProjected(0);
    const flaky = {
      load: vi
        .fn()
        .mockImplementationOnce((c: string, s: typeof scope) => store.load(c, s))
        .mockRejectedValue(new Error('d1 unavailable')),
      markProjected: vi.fn(),
      markPending: vi.fn(async () => {}),
    };

    const result = await projectLatestSettingsDocument(
      flaky as never,
      { put } as unknown as KVNamespace,
      'security',
      scope,
      initial.storageKey
    );

    expect(result).toBe('pending');
    expect(flaky.markProjected).not.toHaveBeenCalled();
    expect(flaky.markPending).toHaveBeenCalledWith('security', scope, initial.version);
  });

  it('lists documents by when they were last reconciled, pending ones included', async () => {
    const data = { 'security.enabled': true };
    for (const tenant of ['tenant-b', 'tenant-a']) {
      const scope = { type: 'tenant' as const, id: tenant };
      now += 10;
      await store.create('security', scope, { data, version: generateVersion(data) });
    }
    await store.markProjected(
      'security',
      { type: 'tenant', id: 'tenant-a' },
      generateVersion(data)
    );

    // Created first, so reconciled least recently.
    let order = await store.leastRecentlyReconciled(5);
    expect(order.map(({ storageKey, projectionState }) => [storageKey, projectionState])).toEqual([
      ['settings:tenant:tenant-b:security', 'pending'],
      ['settings:tenant:tenant-a:security', 'applied'],
    ]);

    now += 10;
    await store.markReconciled('security', { type: 'tenant', id: 'tenant-b' });
    order = await store.leastRecentlyReconciled(5);
    expect(order.map(({ storageKey }) => storageKey)).toEqual([
      'settings:tenant:tenant-a:security',
      'settings:tenant:tenant-b:security',
    ]);
  });

  it('bootstraps a tenant document from the creation-time copy when SETTINGS has none', async () => {
    values.delete('settings:tenant:tenant-a:security');
    const legacy = new Map([
      ['settings:tenant:tenant-a:security', JSON.stringify({ 'security.enabled': false })],
    ]);
    const withLegacy = category(
      new SettingsManager({
        env: {},
        kv: { get: async (key: string) => values.get(key) ?? null, put } as unknown as KVNamespace,
        legacyKv: { get: async (key: string) => legacy.get(key) ?? null } as unknown as KVNamespace,
        canonicalStore: store,
        cacheTTL: 0,
        strictReads: true,
      })
    );

    const result = await withLegacy.getAll('security', { type: 'tenant', id: 'tenant-a' });

    expect(result.values).toEqual({ 'security.enabled': false });
    // Left pending, so the scheduled retry copies it to SETTINGS.
    expect((await store.pending()).map(({ storageKey }) => storageKey)).toEqual([
      'settings:tenant:tenant-a:security',
    ]);
  });

  it('marks only the given version pending again', async () => {
    const scope = { type: 'tenant' as const, id: 'tenant-a' };
    const first = manager();
    const initial = await first.getAll('security', scope);
    const saved = await first.patch(
      'security',
      scope,
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );
    expect(await store.pending()).toEqual([]);

    await store.markPending('security', scope, initial.version);
    expect(await store.pending()).toEqual([]);
    await store.markPending('security', scope, saved.version);
    expect((await store.pending()).map(({ version }) => version)).toEqual([saved.version]);
  });

  it('rejects a stale concurrent patch without replacing the canonical winner', async () => {
    const left = manager();
    const right = manager();
    const version = (await left.getAll('security', { type: 'tenant', id: 'tenant-a' })).version;
    await right.getAll('security', { type: 'tenant', id: 'tenant-a' });
    await left.patch(
      'security',
      { type: 'tenant', id: 'tenant-a' },
      { ifMatch: version, set: { 'security.enabled': false } },
      'left'
    );
    await expect(
      right.patch(
        'security',
        { type: 'tenant', id: 'tenant-a' },
        { ifMatch: version, set: { 'security.enabled': true } },
        'right'
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await store.load('security', { type: 'tenant', id: 'tenant-a' }))?.data).toEqual({
      'security.enabled': false,
    });
  });

  it('rejects a canonical JSON document larger than one MiB in UTF-8 bytes', async () => {
    const data = { label: 'あ'.repeat(400_000) };
    await expect(
      store.create(
        'custom',
        { type: 'tenant', id: 'tenant-b' },
        {
          data,
          version: generateVersion(data),
        }
      )
    ).rejects.toThrow('settings_canonical_store_invalid');
  });

  it('replaces bootstrap settings while retaining a pending projection revision', async () => {
    const scope = { type: 'tenant', id: 'tenant-bootstrap' } as const;
    const first = { enabled: false };
    const second = { enabled: true };
    await store.replace('bootstrap', scope, { data: first, version: generateVersion(first) });
    await store.replace('bootstrap', scope, { data: second, version: generateVersion(second) });

    expect(await store.load('bootstrap', scope)).toEqual({
      data: second,
      version: generateVersion(second),
    });
    expect(
      db
        .prepare(
          `SELECT revision,projection_state,projected_at FROM tenant_settings_documents
          WHERE tenant_id='tenant-bootstrap'`
        )
        .get()
    ).toEqual({ revision: 2, projection_state: 'pending', projected_at: null });
  });

  it('enforces storage identity and digest constraints during direct restore writes', () => {
    const insert = db.prepare(
      `INSERT INTO tenant_settings_documents
      (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at,projected_at)
      VALUES(?,?,?,?,?,?,1,'pending',0,NULL)`
    );
    expect(() =>
      insert.run(null, 'tenant', 'tenant-a', 'security', '{}', 'sha256:44136fa355b3678a')
    ).toThrow();
    expect(() =>
      insert.run('tenant-a', 'tenant', 'different', 'security', '{}', 'sha256:44136fa355b3678a')
    ).toThrow();
    expect(() =>
      insert.run('tenant-a', 'tenant', 'tenant-a', 'security', '{}', 'sha256:GGGGGGGGGGGGGGGG')
    ).toThrow();
  });
});
