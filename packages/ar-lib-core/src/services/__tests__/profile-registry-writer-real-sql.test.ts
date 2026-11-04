import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { DatabaseProfileRegistryBackend, PROFILE_REGISTRY_TOMBSTONE } from '../profile-registry';
import { RuntimeProfileWriter } from '../profile-registry-writer';
import type { RuntimeProfile } from '../../types/runtime-profile';

function memoryKV() {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace;
  return { kv, store };
}

const residency = (jurisdiction: string): RuntimeProfile =>
  ({
    kind: 'residency',
    id: 'res-a',
    builtin: false,
    label: 'A',
    version: 1,
    locationHint: 'auto',
    jurisdiction,
  }) as unknown as RuntimeProfile;

describe('RuntimeProfileWriter (real SQL)', () => {
  let backend: DatabaseProfileRegistryBackend;
  let kv: ReturnType<typeof memoryKV>;
  let writer: RuntimeProfileWriter;

  beforeEach(() => {
    const fixture = sqliteAdapter('core');
    backend = new DatabaseProfileRegistryBackend(fixture.adapter);
    kv = memoryKV();
    writer = new RuntimeProfileWriter(backend, kv.kv);
  });

  it('a deleted profile leaves a tombstone, so a stale KV copy is never adopted back', async () => {
    const created = await writer.readForWrite('residency', 'res-a');
    expect((await writer.putIfUnchanged(residency('eu'), created.expected)).committed).toBe(true);

    const current = await writer.readForWrite('residency', 'res-a');
    expect(
      (await writer.deleteIfUnchanged('residency', 'res-a', current.expected as string)).committed
    ).toBe(true);
    expect(await backend.get('residency', 'res-a')).toBeNull();
    expect(await backend.list('residency')).toEqual([]);
    expect((await backend.getStored('residency', 'res-a'))?.payload).toBe(
      PROFILE_REGISTRY_TOMBSTONE
    );

    // Another location still serves the old projection (KV is eventually consistent).
    kv.store.set('profile-registry:residency:res-a', JSON.stringify(residency('eu')));
    await expect(writer.readForWrite('residency', 'res-a')).rejects.toThrow(
      'profile_registry_projection_disagrees'
    );
    // The stale copy was not adopted, and the projection was corrected to "absent".
    expect(await backend.get('residency', 'res-a')).toBeNull();
    expect(kv.store.has('profile-registry:residency:res-a')).toBe(false);

    // Creating it again replaces the tombstone conditionally.
    const again = await writer.readForWrite('residency', 'res-a');
    expect(again.profile).toBeNull();
    expect((await writer.putIfUnchanged(residency('us'), again.expected)).committed).toBe(true);
    expect((await backend.get('residency', 'res-a')) as unknown).toMatchObject({
      jurisdiction: 'us',
    });
  });

  it('reading a KV-only profile for a write writes nothing; the write creates the D1 row', async () => {
    kv.store.set('profile-registry:residency:res-a', JSON.stringify(residency('eu')));
    const read = await writer.readForWrite('residency', 'res-a');
    expect(read.profile as unknown).toMatchObject({ jurisdiction: 'eu' });
    // Nothing was adopted by reading (a request that is refused leaves no trace).
    expect(await backend.getStored('residency', 'res-a')).toBeNull();
    expect((await writer.putIfUnchanged(residency('us'), read.expected)).committed).toBe(true);
    expect((await backend.get('residency', 'res-a')) as unknown).toMatchObject({
      jurisdiction: 'us',
    });
    // A second writer that read the KV-only profile too loses.
    expect((await writer.putIfUnchanged(residency('jp'), read.expected)).committed).toBe(false);
  });

  it('deleting a KV-only profile records a tombstone, once', async () => {
    kv.store.set('profile-registry:residency:res-a', JSON.stringify(residency('eu')));
    const read = await writer.readForWrite('residency', 'res-a');
    expect((await writer.deleteIfUnchanged('residency', 'res-a', read.expected)).committed).toBe(
      true
    );
    expect(kv.store.has('profile-registry:residency:res-a')).toBe(false);
    expect((await writer.deleteIfUnchanged('residency', 'res-a', read.expected)).committed).toBe(
      false
    );
  });

  it('commits only if the guarded profile is unchanged', async () => {
    const source = await writer.readForWrite('residency', 'res-src');
    const target = await writer.readForWrite('residency', 'res-a');
    // Someone creates the source after it was read as absent.
    const raw = JSON.stringify({ ...residency('eu'), id: 'res-src' });
    await backend.insertRawIfAbsent('residency', 'res-src', raw);
    kv.store.set('profile-registry:residency:res-src', raw);
    expect(
      (await writer.putIfUnchanged(residency('us'), target.expected, { guards: [source.guard] }))
        .committed
    ).toBe(false);
    expect(await backend.getStored('residency', 'res-a')).toBeNull();

    const fresh = await writer.readForWrite('residency', 'res-src');
    expect(
      (await writer.putIfUnchanged(residency('us'), target.expected, { guards: [fresh.guard] }))
        .committed
    ).toBe(true);
  });

  it('defers the projection when asked, and flushes it later', async () => {
    const created = await writer.readForWrite('residency', 'res-a');
    await writer.putIfUnchanged(residency('eu'), created.expected, { deferProjection: true });
    expect(kv.store.has('profile-registry:residency:res-a')).toBe(false);
    expect(await writer.flushProjection('residency', 'res-a')).toEqual({});
    expect(kv.store.has('profile-registry:residency:res-a')).toBe(true);
  });

  it('a projection that failed is repaired by the scheduled reconcile, tombstones included', async () => {
    const failing = new Set<string>();
    const flaky = {
      get: kv.kv.get.bind(kv.kv),
      put: async (key: string, value: string) => {
        if (failing.has(key)) throw new Error('kv down');
        kv.store.set(key, value);
      },
      delete: async (key: string) => {
        if (failing.has(key)) throw new Error('kv down');
        kv.store.delete(key);
      },
    } as unknown as KVNamespace;
    const flakyWriter = new RuntimeProfileWriter(backend, flaky);
    failing.add('profile-registry:residency:res-a');
    const created = await flakyWriter.readForWrite('residency', 'res-a');
    const result = await flakyWriter.putIfUnchanged(residency('eu'), created.expected);
    expect(result).toEqual({ committed: true, projection: 'pending' });
    expect(kv.store.has('profile-registry:residency:res-a')).toBe(false);

    failing.clear();
    expect(await flakyWriter.reconcileProjection()).toMatchObject({ repaired: 1, failures: 0 });
    expect(JSON.parse(kv.store.get('profile-registry:residency:res-a') ?? '{}')).toMatchObject({
      jurisdiction: 'eu',
    });

    // A delete whose KV delete failed leaves the old copy; the reconcile removes it.
    failing.add('profile-registry:residency:res-a');
    const current = await flakyWriter.readForWrite('residency', 'res-a');
    expect(
      await flakyWriter.deleteIfUnchanged('residency', 'res-a', current.expected)
    ).toMatchObject({ committed: true, projection: 'pending' });
    failing.clear();
    expect(await flakyWriter.reconcileProjection()).toMatchObject({ repaired: 1 });
    expect(kv.store.has('profile-registry:residency:res-a')).toBe(false);
    // Nothing left to repair.
    expect(await flakyWriter.reconcileProjection()).toMatchObject({ repaired: 0 });
  });
});
