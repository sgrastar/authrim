import { describe, expect, it, vi } from 'vitest';
import { hashIpAddress } from '../../../utils/consent-statements';

function fixtureStore(values: Record<string, string>) {
  const rows = new Map(Object.entries(values));
  const get = vi.fn(async (key: string) => rows.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    rows.set(key, value);
  });
  return { kv: { get, put } as unknown as KVNamespace, get, put };
}

describe('consent hashing portability dependency', () => {
  it('preserves existing hashes only when the tenant salt is retained', async () => {
    const source = fixtureStore({ 'consent:ip_salt:tenant-a': 'fixture-original-salt' });
    const original = await hashIpAddress('192.0.2.10', 'tenant-a', source.kv);
    const restored = fixtureStore({ 'consent:ip_salt:tenant-a': 'fixture-original-salt' });
    expect(await hashIpAddress('192.0.2.10', 'tenant-a', restored.kv)).toBe(original);
    expect(restored.put).not.toHaveBeenCalled();
    // The normal no-KV fallback is not an equivalent replacement for the source salt.
    expect(await hashIpAddress('192.0.2.10', 'tenant-a', null)).not.toBe(original);
  });

  it('does not substitute another tenant salt for the selected tenant', async () => {
    const store = fixtureStore({
      'consent:ip_salt:tenant-a': 'fixture-a',
      'consent:ip_salt:tenant-b': 'fixture-b',
    });
    const first = await hashIpAddress('192.0.2.10', 'tenant-a', store.kv);
    expect(store.get).toHaveBeenLastCalledWith('consent:ip_salt:tenant-a');
    const second = await hashIpAddress('192.0.2.10', 'tenant-b', store.kv);
    expect(store.get).toHaveBeenLastCalledWith('consent:ip_salt:tenant-b');
    expect(second).not.toBe(first);
    expect(store.put).not.toHaveBeenCalled();
  });
});
