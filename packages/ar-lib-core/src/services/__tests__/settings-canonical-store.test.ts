import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSettingsCanonicalStore } from '../settings-canonical-store';
import { ConflictError, generateVersion, SettingsManager } from '../../utils/settings-manager';

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
    put.mockRejectedValueOnce(new Error('kv unavailable'));
    const changed = await first.patch(
      'security',
      { type: 'tenant', id: 'tenant-a' },
      { ifMatch: initial.version, set: { 'security.enabled': false } },
      'admin'
    );
    expect(changed.applied).toEqual(['security.enabled']);
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
