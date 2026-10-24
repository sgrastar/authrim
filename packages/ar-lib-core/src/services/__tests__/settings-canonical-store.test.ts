import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from './sqlite-history-fixture';
import type { PreparedStatement } from '../../db/adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSettingsCanonicalStore } from '../settings-canonical-store';
import { IDENTITY_MAPPING_CATEGORY_META } from '../../types/settings/identity-mapping';
import type {
  IdentityMappingLevelHistoryMetadata,
  IdentityMappingLevelHistoryRow,
} from '../identity-mapping-level-history';
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
    async batch(statements: PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const result = db.prepare(sql).run(...(params as SQLInputValue[]));
          return { success: true, rowsAffected: Number(result.changes) };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
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
  let put: ReturnType<typeof vi.fn<(key: string, value: string) => Promise<Map<string, string>>>>;
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
    db.exec(
      readFileSync(
        new URL(
          '../../../../../migrations/admin/d1/039_platform_settings_documents.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    now = 100;
    db.exec(
      readFileSync(
        new URL(
          '../../../../../migrations/admin/d1/050_identity_mapping_level_history.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
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

  it('keeps platform documents too: bootstrap, compare-and-set and the projection listings', async () => {
    values.set('settings:platform:security', JSON.stringify({ 'security.enabled': true }));
    const platform = { type: 'platform' } as const;
    const first = manager();
    const initial = await first.getAll('security', platform);
    expect(initial.values).toEqual({ 'security.enabled': true });
    expect(
      db.prepare('SELECT category,projection_state FROM platform_settings_documents').all()
    ).toEqual([{ category: 'security', projection_state: 'applied' }]);

    put.mockRejectedValue(new Error('kv unavailable'));
    const changed = await first.patch(
      'security',
      platform,
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );
    expect(changed.projection).toBe('pending');
    await expect(
      first.patch(
        'security',
        platform,
        { ifMatch: initial.version, set: { 'security.enabled': true } },
        'admin'
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.pending()).toEqual([
      expect.objectContaining({
        tenantId: null,
        scope: platform,
        storageKey: 'settings:platform:security',
      }),
    ]);
    expect((await store.leastRecentlyReconciled()).map(({ storageKey }) => storageKey)).toEqual(
      expect.arrayContaining(['settings:platform:security'])
    );

    put.mockReset();
    put.mockImplementation(async (key: string, value: string) => values.set(key, value));
    await expect(
      projectLatestSettingsDocument(
        store,
        { put } as unknown as KVNamespace,
        'security',
        platform,
        'settings:platform:security'
      )
    ).resolves.toBe('applied');
    expect(JSON.parse(values.get('settings:platform:security')!)).toEqual({
      'security.enabled': false,
    });
    expect(await store.pending()).toEqual([]);
  });

  it('removes its own KV write when the document is deleted while it is written', async () => {
    const scope = { type: 'tenant' as const, id: 'discarded' };
    const data = { 'security.enabled': true };
    await store.create('security', scope, { data, version: generateVersion(data) });
    const kv = new Map<string, string>();
    const storageKey = 'settings:tenant:discarded:security';
    const result = await projectLatestSettingsDocument(
      store,
      {
        async put(key: string, value: string) {
          kv.set(key, value);
          // A discarded restore removes the document and its key while this write is in flight.
          db.prepare("DELETE FROM tenant_settings_documents WHERE tenant_id='discarded'").run();
          kv.delete(key);
          kv.set(key, value);
        },
        async delete(key: string) {
          kv.delete(key);
        },
      } as unknown as KVNamespace,
      'security',
      scope,
      storageKey
    );
    expect(result).toBe('applied');
    expect(kv.has(storageKey)).toBe(false);
  });

  it('retries removing its own KV write when the first delete fails', async () => {
    const scope = { type: 'tenant' as const, id: 'discarded' };
    const data = { 'security.enabled': true };
    await store.create('security', scope, { data, version: generateVersion(data) });
    const kv = new Map<string, string>();
    const storageKey = 'settings:tenant:discarded:security';
    let deletes = 0;
    await projectLatestSettingsDocument(
      store,
      {
        async put(key: string, value: string) {
          kv.set(key, value);
          db.prepare("DELETE FROM tenant_settings_documents WHERE tenant_id='discarded'").run();
        },
        async delete(key: string) {
          if (++deletes === 1) throw new Error('kv unavailable');
          kv.delete(key);
        },
      } as unknown as KVNamespace,
      'security',
      scope,
      storageKey
    );
    expect(deletes).toBe(2);
    expect(kv.has(storageKey)).toBe(false);
  });

  it("reads a tenant's documents and the platform's copy state as one snapshot", async () => {
    const scope = { type: 'tenant' as const, id: 'acme' };
    const data = { 'security.enabled': true };
    const version = generateVersion(data);
    await store.create('security', scope, { data, version });
    await store.create('oauth', { type: 'tenant', id: 'other' }, { data, version });
    await store.create('oauth', { type: 'platform' }, { data, version });

    await expect(store.snapshot(['security', 'oauth'], scope)).resolves.toEqual({
      documents: new Map([
        ['security', { version, pending: true }],
        ['oauth', null],
      ]),
      platformPending: ['oauth'],
    });
    await store.markProjected('security', scope, version);
    await store.markProjected('oauth', { type: 'platform' }, version);
    await expect(store.snapshot(['security', 'oauth'], scope)).resolves.toEqual({
      documents: new Map([
        ['security', { version, pending: false }],
        ['oauth', null],
      ]),
      platformPending: [],
    });
    await expect(store.snapshot([], scope)).resolves.toEqual({
      documents: new Map(),
      platformPending: [],
    });
  });

  it('reads without creating anything when read-only', async () => {
    const readOnly = category(
      new SettingsManager({
        env: {},
        kv: { get: async (key: string) => values.get(key) ?? null, put } as unknown as KVNamespace,
        canonicalStore: store,
        cacheTTL: 0,
        strictReads: true,
        readOnly: true,
      })
    );
    const result = await readOnly.getAll('security', { type: 'tenant', id: 'tenant-a' });
    expect(result.values).toEqual({ 'security.enabled': true });
    expect(db.prepare('SELECT count(*) AS n FROM tenant_settings_documents').get()).toEqual({
      n: 0,
    });
    await expect(
      readOnly.patch(
        'security',
        { type: 'tenant', id: 'tenant-a' },
        { ifMatch: result.version, set: { 'security.enabled': false } },
        'admin'
      )
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
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
  describe('atomic tenant Mapping Set choice history', () => {
    const key = 'identity_mapping.oidc_default_set_id';
    const scope = { type: 'tenant', id: 'tenant-a' } as const;
    const history = () =>
      db
        .prepare('SELECT * FROM identity_mapping_level_history ORDER BY created_at,id')
        .all() as unknown as IdentityMappingLevelHistoryRow[];
    function mappingManager(metadata: Partial<IdentityMappingLevelHistoryMetadata> = {}) {
      const m = new SettingsManager({
        env: {},
        kv: { get: async (k: string) => values.get(k) ?? null, put } as unknown as KVNamespace,
        canonicalStore: store,
        cacheTTL: 0,
        identityMappingHistory: {
          actorId: 'admin-1',
          actorType: 'human',
          via: 'settings',
          ...metadata,
        },
      });
      m.registerCategory(IDENTITY_MAPPING_CATEGORY_META);
      return m;
    }
    it('commits one raw before/after row with the canonical CAS, and omits a no-op', async () => {
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      const saved = await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: initial.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      expect(history()).toMatchObject([
        {
          tenant_id: 'tenant-a',
          tier: 'tenant_default',
          client_id: null,
          before_json: 'null',
          after_json: '"set-a"',
          actor_id: 'admin-1',
          actor_type: 'human',
          via: 'settings',
          source_version: saved.version,
          status: 'committed',
        },
      ]);
      expect(history()[0].committed_at).toBe(history()[0].created_at);
      await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: saved.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      expect(history()).toHaveLength(1);
    });
    it('records clear as null even when the platform default is inherited', async () => {
      values.set('settings:platform:identity-mapping', JSON.stringify({ [key]: 'set-platform' }));
      values.set('settings:tenant:tenant-a:identity-mapping', JSON.stringify({ [key]: 'set-a' }));
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope, {
        parents: [{ type: 'platform' }],
      });
      await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: initial.version, clear: [key] },
        'admin-1',
        { parents: [{ type: 'platform' }] }
      );
      expect(history()).toMatchObject([{ before_json: '"set-a"', after_json: 'null' }]);
      expect(
        (await m.getAll('identity-mapping', scope, { parents: [{ type: 'platform' }] })).values[key]
      ).toBe('set-platform');
    });
    it('does not leave history for a stale CAS', async () => {
      const first = mappingManager();
      const stale = await first.getAll('identity-mapping', scope);
      await first.patch(
        'identity-mapping',
        scope,
        { ifMatch: stale.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      await expect(
        mappingManager().patch(
          'identity-mapping',
          scope,
          { ifMatch: stale.version, set: { [key]: 'set-b' } },
          'admin-1'
        )
      ).rejects.toBeInstanceOf(ConflictError);
      expect(history()).toHaveLength(1);
      expect((await store.load('identity-mapping', scope))?.data[key]).toBe('set-a');
    });
    it('refuses a restore after A to B to A even when the raw settings hash has returned', async () => {
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      const first = await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: initial.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      const expectedLatestHistoryId = history()[0].id;
      const second = await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: first.version, set: { [key]: 'set-b' } },
        'admin-1'
      );
      const third = await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: second.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      expect(third.version).toBe(first.version);
      await expect(
        mappingManager({ via: 'restore', expectedLatestHistoryId }).patch(
          'identity-mapping',
          scope,
          { ifMatch: first.version, set: { [key]: 'set-restore' } },
          'admin-1'
        )
      ).rejects.toBeInstanceOf(ConflictError);
      expect(history()).toHaveLength(3);
      expect((await store.load('identity-mapping', scope))?.data[key]).toBe('set-a');
      await mappingManager({ via: 'restore', expectedLatestHistoryId: history()[2].id }).patch(
        'identity-mapping',
        scope,
        { ifMatch: third.version, set: { [key]: 'set-restore' } },
        'admin-1'
      );
      expect(history()).toHaveLength(4);
      expect(history()[3]).toMatchObject({ via: 'restore', after_json: '"set-restore"' });
    });
    it('does not insert history if another writer wins between the read and the atomic CAS', async () => {
      const original = store;
      const sql = adapter(db);
      store = new DatabaseSettingsCanonicalStore(
        {
          ...sql,
          async batch(statements) {
            const current = await original.load('identity-mapping', scope);
            if (!current) throw new Error('fixture_missing_canonical_document');
            const data = { [key]: 'set-winner' };
            expect(
              await original.compareAndSet('identity-mapping', scope, current.version, {
                data,
                version: generateVersion(data),
              })
            ).toBe(true);
            return sql.batch(statements);
          },
        },
        () => now++
      );
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      await expect(
        m.patch(
          'identity-mapping',
          scope,
          { ifMatch: initial.version, set: { [key]: 'set-loser' } },
          'admin-1'
        )
      ).rejects.toBeInstanceOf(ConflictError);
      expect(history()).toEqual([]);
      expect((await original.load('identity-mapping', scope))?.data[key]).toBe('set-winner');
    });
    it('confirms its committed history when the successful atomic batch response is lost', async () => {
      const sql = adapter(db);
      store = new DatabaseSettingsCanonicalStore(
        {
          ...sql,
          async batch(statements) {
            await sql.batch(statements);
            throw new Error('response_lost');
          },
        },
        () => now++
      );
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      const result = await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: initial.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      expect(history()).toMatchObject([{ status: 'committed', source_version: result.version }]);
      expect((await store.load('identity-mapping', scope))?.data[key]).toBe('set-a');
    });
    it('rolls history back when the source update fails, and keeps the original document', async () => {
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      db.exec(
        `CREATE TRIGGER refuse_mapping_update BEFORE UPDATE ON tenant_settings_documents WHEN NEW.category='identity-mapping' BEGIN SELECT RAISE(ABORT,'source_write_failed'); END`
      );
      await expect(
        m.patch(
          'identity-mapping',
          scope,
          { ifMatch: initial.version, set: { [key]: 'set-a' } },
          'admin-1'
        )
      ).rejects.toThrow('source_write_failed');
      expect(history()).toEqual([]);
      expect((await store.load('identity-mapping', scope))?.data).toEqual({});
    });
    it('keeps the source unchanged when the history insert fails', async () => {
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      db.exec(
        `CREATE TRIGGER refuse_mapping_history BEFORE INSERT ON identity_mapping_level_history BEGIN SELECT RAISE(ABORT,'history_write_failed'); END`
      );
      await expect(
        m.patch(
          'identity-mapping',
          scope,
          { ifMatch: initial.version, set: { [key]: 'set-a' } },
          'admin-1'
        )
      ).rejects.toThrow('history_write_failed');
      expect(history()).toEqual([]);
      expect((await store.load('identity-mapping', scope))?.data).toEqual({});
    });
    it.each(['bulk_apply', 'restore'] as const)(
      'preserves %s provenance independently of the audit',
      async (via) => {
        const m = mappingManager({
          via,
          bulkId: via === 'bulk_apply' ? 'bulk-1' : undefined,
          actorType: 'machine',
        });
        const initial = await m.getAll('identity-mapping', scope);
        await m.patch(
          'identity-mapping',
          scope,
          { ifMatch: initial.version, set: { [key]: 'none' } },
          'admin-1'
        );
        expect(history()).toMatchObject([
          {
            via,
            actor_type: 'machine',
            bulk_id: via === 'bulk_apply' ? 'bulk-1' : null,
            after_json: '"none"',
          },
        ]);
      }
    );
    it('keeps history committed when only the KV projection fails', async () => {
      const m = mappingManager();
      const initial = await m.getAll('identity-mapping', scope);
      put.mockRejectedValue(new Error('kv_unavailable'));
      const result = await m.patch(
        'identity-mapping',
        scope,
        { ifMatch: initial.version, set: { [key]: 'set-a' } },
        'admin-1'
      );
      expect(result.projection).toBe('pending');
      expect(history()).toMatchObject([{ status: 'committed', after_json: '"set-a"' }]);
    });
  });
});
