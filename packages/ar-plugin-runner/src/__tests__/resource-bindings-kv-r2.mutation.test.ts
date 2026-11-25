import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginKvResourceAccess,
  PluginR2ResourceAccess,
  type PluginResourceBindingProps,
} from '../resource-bindings';
import {
  createResourceWorld,
  entrypoint,
  HOST,
  insertResource,
  propsFor,
} from './helpers/resource-fixture';

vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredOperation: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
}));

const MIB = 1024 * 1024;
const noop = (): undefined => undefined;
let world: ReturnType<typeof createResourceWorld>;

async function arrange(kind: 'kv_namespace' | 'r2_bucket', access: 'read_only' | 'read_write') {
  world = createResourceWorld();
  const props: PluginResourceBindingProps = await propsFor(kind, access);
  insertResource(world.runner, props);
  return props;
}
async function kv(access: 'read_only' | 'read_write' = 'read_write') {
  const props = await arrange('kv_namespace', access);
  return entrypoint(PluginKvResourceAccess, world.env, props);
}
async function r2(access: 'read_only' | 'read_write' = 'read_write') {
  const props = await arrange('r2_bucket', access);
  return entrypoint(PluginR2ResourceAccess, world.env, props);
}

const KEY_INVALID = /^plugin_dynamic_resource_key_invalid$/u;
const LIST_INVALID = /^plugin_dynamic_resource_list_input_invalid$/u;
const WRITE_DENIED = /^plugin_dynamic_resource_write_denied$/u;
const VALUE_INVALID = /^plugin_dynamic_resource_value_invalid$/u;
const TOO_LARGE = /^plugin_dynamic_resource_result_too_large$/u;
const UNAVAILABLE = /^plugin_dynamic_resource_binding_unavailable$/u;
const LIST = { prefix: null, cursor: null, limit: 10 };

describe('shared key and list validation', () => {
  it.each([
    ['KV', kv],
    ['R2', r2],
  ])('%s rejects malformed keys everywhere', async (_name, make) => {
    const access = (await make()) as unknown as Record<
      string,
      (input: unknown) => Promise<unknown>
    >;
    for (const method of ['get', 'delete']) {
      for (const bad of ['', 'a'.repeat(1025), 'a\0b', 5, null, undefined]) {
        await expect(access[method]?.(bad)).rejects.toThrow(KEY_INVALID);
      }
    }
  });
  it('accepts a one-character and a 1024-character key', async () => {
    const access = await kv();
    await expect(access.get('k')).resolves.toBeNull();
    await expect(access.get('k'.repeat(1024))).resolves.toBeNull();
    expect(world.kv.get).toHaveBeenNthCalledWith(1, 'k', 'text');
    expect(world.kv.get).toHaveBeenNthCalledWith(2, 'k'.repeat(1024), 'text');
  });
  it.each([
    ['KV', kv],
    ['R2', r2],
  ])('%s validates list input', async (_name, make) => {
    const access = (await make()) as unknown as { list(input: unknown): Promise<unknown> };
    for (const bad of [
      null,
      [],
      {},
      { prefix: null, cursor: null },
      { ...LIST, extra: 1 },
      { ...LIST, prefix: 5 },
      { ...LIST, prefix: undefined },
      { ...LIST, prefix: 'a'.repeat(1025) },
      { ...LIST, cursor: 5 },
      { ...LIST, cursor: 'a'.repeat(4097) },
      { ...LIST, limit: 0 },
      { ...LIST, limit: 101 },
      { ...LIST, limit: 1.5 },
      { ...LIST, limit: '10' },
      { ...LIST, limit: null },
      { ...LIST, limit: -1 },
    ]) {
      await expect(access.list(bad)).rejects.toThrow(LIST_INVALID);
    }
  });
  it.each([
    ['KV', kv, () => world.kv.list],
    ['R2', r2, () => world.r2.list],
  ])('%s passes only the supplied list options', async (_name, make, spy) => {
    const access = (await make()) as unknown as { list(input: unknown): Promise<unknown> };
    await access.list(LIST);
    await access.list({ prefix: 'p/', cursor: 'c', limit: 100 });
    await access.list({ prefix: '', cursor: 'c'.repeat(4096), limit: 1 });
    await access.list({ prefix: 'a'.repeat(1024), cursor: null, limit: 1 });
    expect(spy().mock.calls).toEqual([
      [{ limit: 10 }],
      [{ prefix: 'p/', cursor: 'c', limit: 100 }],
      [{ prefix: '', cursor: 'c'.repeat(4096), limit: 1 }],
      [{ prefix: 'a'.repeat(1024), limit: 1 }],
    ]);
  });
});

describe('KV resource', () => {
  it('reads text values and misses as null', async () => {
    const access = await kv('read_only');
    world.kv.values.set('present', 'value');
    await expect(access.get('present')).resolves.toBe('value');
    await expect(access.get('absent')).resolves.toBeNull();
  });
  it('refuses a value larger than 1 MiB but returns one of exactly 1 MiB', async () => {
    const access = await kv('read_only');
    world.kv.values.set('exact', 'x'.repeat(MIB));
    world.kv.values.set('big', 'x'.repeat(MIB + 1));
    world.kv.values.set('wide', '€'.repeat(MIB / 2));
    await expect(access.get('exact')).resolves.toHaveLength(MIB);
    await expect(access.get('big')).rejects.toThrow(TOO_LARGE);
    await expect(access.get('wide')).rejects.toThrow(TOO_LARGE);
  });
  it('writes and deletes on a read-write resource', async () => {
    const access = await kv();
    await expect(access.put('k', 'v')).resolves.toBeUndefined();
    expect(world.kv.put).toHaveBeenCalledWith('k', 'v');
    await expect(access.delete('k')).resolves.toBeUndefined();
    expect(world.kv.delete).toHaveBeenCalledWith('k');
  });
  it('denies writes and deletes on a read-only resource without touching the namespace', async () => {
    const access = await kv('read_only');
    await expect(access.put('k', 'v')).rejects.toThrow(WRITE_DENIED);
    await expect(access.delete('k')).rejects.toThrow(WRITE_DENIED);
    expect(world.kv.put).not.toHaveBeenCalled();
    expect(world.kv.delete).not.toHaveBeenCalled();
  });
  it('validates the key and value of a put', async () => {
    const access = await kv();
    await expect(access.put('', 'v')).rejects.toThrow(KEY_INVALID);
    await expect(access.put('k', 5)).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', new Uint8Array(1) as never)).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', 'x'.repeat(MIB + 1))).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', '€'.repeat(MIB / 2))).rejects.toThrow(VALUE_INVALID);
    expect(world.kv.put).not.toHaveBeenCalled();
    await expect(access.put('k', 'x'.repeat(MIB))).resolves.toBeUndefined();
    await expect(access.put('k', '')).resolves.toBeUndefined();
    expect(world.kv.put).toHaveBeenCalledTimes(2);
  });
  it('checks the value before the key when both are bad', async () => {
    const access = await kv();
    await expect(access.put('', 5)).rejects.toThrow(VALUE_INVALID);
  });
  it('lists names with expiration defaults and the paging cursor', async () => {
    const access = await kv('read_only');
    world.kv.list.mockResolvedValueOnce({
      keys: [{ name: 'a', expiration: 1_700_000_000 }, { name: 'b' }],
      list_complete: false,
      cursor: 'next',
    });
    await expect(access.list(LIST)).resolves.toEqual({
      keys: [
        { name: 'a', expiration: 1_700_000_000 },
        { name: 'b', expiration: null },
      ],
      listComplete: false,
      cursor: 'next',
    });
    world.kv.list.mockResolvedValueOnce({
      keys: [{ name: 'c', expiration: 0 }],
      list_complete: true,
      cursor: 'ignored',
    });
    await expect(access.list(LIST)).resolves.toEqual({
      keys: [{ name: 'c', expiration: 0 }],
      listComplete: true,
      cursor: null,
    });
  });
  it('bounds the serialized list size', async () => {
    const access = await kv('read_only');
    world.kv.list.mockResolvedValueOnce({
      keys: Array.from({ length: 20_000 }, (_, i) => ({ name: `${'k'.repeat(60)}${i}` })),
      list_complete: true,
      cursor: undefined,
    });
    await expect(access.list(LIST)).rejects.toThrow(TOO_LARGE);
  });
  it.each([
    ['missing', undefined],
    ['not a record', 'x'],
    ['without get', { put: noop, delete: noop, list: noop }],
    ['without put', { get: noop, delete: noop, list: noop }],
    ['without delete', { get: noop, put: noop, list: noop }],
    ['without list', { get: noop, put: noop, delete: noop }],
  ])('refuses a namespace binding that is %s', async (_label, binding) => {
    const access = await kv();
    (world.env as unknown as Record<string, unknown>)[HOST.kv_namespace] = binding;
    await expect(access.get('k')).rejects.toThrow(UNAVAILABLE);
    await expect(access.put('k', 'v')).rejects.toThrow(UNAVAILABLE);
    await expect(access.delete('k')).rejects.toThrow(UNAVAILABLE);
    await expect(access.list(LIST)).rejects.toThrow(UNAVAILABLE);
  });
  it('denies a D1 resource on the KV entrypoint and a missing row', async () => {
    world = createResourceWorld();
    const d1Props = await propsFor('d1');
    insertResource(world.runner, d1Props);
    await expect(entrypoint(PluginKvResourceAccess, world.env, d1Props).get('k')).rejects.toThrow(
      /^plugin_dynamic_resource_kind_denied$/u
    );
    const kvProps = await propsFor('kv_namespace');
    await expect(entrypoint(PluginKvResourceAccess, world.env, kvProps).get('k')).rejects.toThrow(
      /^plugin_dynamic_resource_scope_denied$/u
    );
  });
});

describe('R2 resource', () => {
  it('describes an object by size, etag and ISO upload time', async () => {
    const access = await r2('read_only');
    world.r2.values.set('o', new Uint8Array([1, 2, 3]));
    await expect(access.head('o')).resolves.toEqual({
      size: 3,
      etag: 'etag-o',
      uploaded: '1970-01-02T00:00:00.000Z',
    });
    await expect(access.head('missing')).resolves.toBeNull();
    expect(world.r2.head).toHaveBeenCalledWith('o');
  });
  it('returns object bytes and null for a miss', async () => {
    const access = await r2('read_only');
    world.r2.values.set('o', new Uint8Array([1, 2, 3]));
    const bytes = await access.get('o');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...(bytes ?? [])]).toEqual([1, 2, 3]);
    await expect(access.get('missing')).resolves.toBeNull();
  });
  it('cancels the body of an oversized object and refuses it, but reads one of exactly 1 MiB', async () => {
    const access = await r2('read_only');
    world.r2.values.set('exact', new Uint8Array(MIB));
    world.r2.values.set('big', new Uint8Array(MIB + 1));
    await expect(access.get('exact')).resolves.toHaveLength(MIB);
    expect(world.r2.cancel).not.toHaveBeenCalled();
    await expect(access.get('big')).rejects.toThrow(TOO_LARGE);
    expect(world.r2.cancel).toHaveBeenCalledTimes(1);
  });
  it('stores strings and bytes and returns the etag', async () => {
    const access = await r2();
    await expect(access.put('s', 'text')).resolves.toEqual({ etag: 'etag-s' });
    const bytes = new Uint8Array([9, 8]);
    await expect(access.put('b', bytes)).resolves.toEqual({ etag: 'etag-b' });
    expect(world.r2.put.mock.calls).toEqual([
      ['s', 'text'],
      ['b', bytes],
    ]);
  });
  it('rejects values of the wrong type or size and a missing write receipt', async () => {
    const access = await r2();
    await expect(access.put('k', 5)).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', null)).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', {})).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', new ArrayBuffer(1))).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', 'x'.repeat(MIB + 1))).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', new Uint8Array(MIB + 1))).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('k', '€'.repeat(MIB / 2))).rejects.toThrow(VALUE_INVALID);
    await expect(access.put('', 'v')).rejects.toThrow(KEY_INVALID);
    expect(world.r2.put).not.toHaveBeenCalled();
    await expect(access.put('k', new Uint8Array(MIB))).resolves.toEqual({ etag: 'etag-k' });
    await expect(access.put('k', 'x'.repeat(MIB))).resolves.toEqual({ etag: 'etag-k' });
    world.r2.put.mockResolvedValueOnce(null);
    await expect(access.put('k', 'v')).rejects.toThrow(/^plugin_dynamic_resource_write_failed$/u);
  });
  it('deletes on a read-write resource only', async () => {
    const writable = await r2();
    await expect(writable.delete('k')).resolves.toBeUndefined();
    expect(world.r2.delete).toHaveBeenCalledWith('k');
    const readOnly = await r2('read_only');
    await expect(readOnly.delete('k')).rejects.toThrow(WRITE_DENIED);
    await expect(readOnly.put('k', 'v')).rejects.toThrow(WRITE_DENIED);
    expect(world.r2.delete).not.toHaveBeenCalled();
    expect(world.r2.put).not.toHaveBeenCalled();
  });
  it('lists objects with the truncation cursor', async () => {
    const access = await r2('read_only');
    world.r2.list.mockResolvedValueOnce({
      objects: [
        { key: 'a', size: 1, etag: 'ea', uploaded: new Date(0) },
        { key: 'b', size: 2, etag: 'eb', uploaded: new Date(1000) },
      ],
      truncated: true,
      cursor: 'next',
    });
    await expect(access.list(LIST)).resolves.toEqual({
      objects: [
        { key: 'a', size: 1, etag: 'ea', uploaded: '1970-01-01T00:00:00.000Z' },
        { key: 'b', size: 2, etag: 'eb', uploaded: '1970-01-01T00:00:01.000Z' },
      ],
      truncated: true,
      cursor: 'next',
    });
    world.r2.list.mockResolvedValueOnce({ objects: [], truncated: true, cursor: undefined });
    await expect(access.list(LIST)).resolves.toEqual({
      objects: [],
      truncated: true,
      cursor: null,
    });
    world.r2.list.mockResolvedValueOnce({ objects: [], truncated: false, cursor: 'ignored' });
    await expect(access.list(LIST)).resolves.toEqual({
      objects: [],
      truncated: false,
      cursor: null,
    });
  });
  it('bounds the serialized list size', async () => {
    const access = await r2('read_only');
    world.r2.list.mockResolvedValueOnce({
      objects: Array.from({ length: 6_000 }, (_, i) => ({
        key: `${'k'.repeat(100)}${i}`,
        size: i,
        etag: 'e'.repeat(32),
        uploaded: new Date(0),
      })),
      truncated: false,
      cursor: undefined,
    });
    await expect(access.list(LIST)).rejects.toThrow(TOO_LARGE);
  });
  it.each([
    ['missing', undefined],
    ['not a record', 'x'],
    ['without get', { head: noop, put: noop, delete: noop, list: noop }],
    ['without head', { get: noop, put: noop, delete: noop, list: noop }],
    ['without put', { get: noop, head: noop, delete: noop, list: noop }],
    ['without delete', { get: noop, head: noop, put: noop, list: noop }],
    ['without list', { get: noop, head: noop, put: noop, delete: noop }],
  ])('refuses a bucket binding that is %s', async (_label, binding) => {
    const access = await r2();
    (world.env as unknown as Record<string, unknown>)[HOST.r2_bucket] = binding;
    await expect(access.head('k')).rejects.toThrow(UNAVAILABLE);
    await expect(access.get('k')).rejects.toThrow(UNAVAILABLE);
    await expect(access.put('k', 'v')).rejects.toThrow(UNAVAILABLE);
    await expect(access.delete('k')).rejects.toThrow(UNAVAILABLE);
    await expect(access.list(LIST)).rejects.toThrow(UNAVAILABLE);
  });
  it('denies the wrong kind and a missing row', async () => {
    world = createResourceWorld();
    const kvProps = await propsFor('kv_namespace');
    insertResource(world.runner, kvProps);
    await expect(entrypoint(PluginR2ResourceAccess, world.env, kvProps).head('k')).rejects.toThrow(
      /^plugin_dynamic_resource_kind_denied$/u
    );
    const r2Props = await propsFor('r2_bucket');
    await expect(entrypoint(PluginR2ResourceAccess, world.env, r2Props).head('k')).rejects.toThrow(
      /^plugin_dynamic_resource_scope_denied$/u
    );
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
