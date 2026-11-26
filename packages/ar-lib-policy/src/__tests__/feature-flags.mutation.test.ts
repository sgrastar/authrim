import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FLAGS,
  FLAG_NAMES,
  FeatureFlagsManager,
  createFeatureFlagsManager,
  getFlagsFromEnv,
  type FlagName,
  type KVNamespace,
} from '../feature-flags';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const kv: KVNamespace = { get, put, delete: del };
  return { kv, store, get, put, del };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('flag defaults and environment', () => {
  it('lists the flags and their defaults', () => {
    expect([...FLAG_NAMES]).toEqual([
      'ENABLE_ABAC',
      'ENABLE_REBAC',
      'ENABLE_POLICY_LOGGING',
      'ENABLE_VERIFIED_ATTRIBUTES',
      'ENABLE_CUSTOM_RULES',
      'ENABLE_SD_JWT',
      'ENABLE_POLICY_EMBEDDING',
    ]);
    expect(DEFAULT_FLAGS).toStrictEqual({
      ENABLE_ABAC: false,
      ENABLE_REBAC: false,
      ENABLE_POLICY_LOGGING: false,
      ENABLE_VERIFIED_ATTRIBUTES: false,
      ENABLE_CUSTOM_RULES: true,
      ENABLE_SD_JWT: false,
      ENABLE_POLICY_EMBEDDING: false,
    });
    expect(getFlagsFromEnv({})).toStrictEqual(DEFAULT_FLAGS);
  });

  it('reads each flag from its own variable', () => {
    for (const name of FLAG_NAMES) {
      const flipped = !DEFAULT_FLAGS[name];
      const flags = getFlagsFromEnv({ [name]: flipped ? 'true' : 'false' });
      for (const other of FLAG_NAMES) {
        expect(flags[other]).toBe(other === name ? flipped : DEFAULT_FLAGS[other]);
      }
    }
  });

  it('reads true, TRUE and 1 as on, other text as off, and nothing as the default', () => {
    for (const on of ['true', 'TRUE', 'True', '1']) {
      expect(getFlagsFromEnv({ ENABLE_ABAC: on, ENABLE_CUSTOM_RULES: on }).ENABLE_ABAC).toBe(true);
    }
    for (const off of ['false', '0', 'yes', 'on', ' true', '2']) {
      expect(getFlagsFromEnv({ ENABLE_ABAC: off }).ENABLE_ABAC).toBe(false);
      expect(getFlagsFromEnv({ ENABLE_CUSTOM_RULES: off }).ENABLE_CUSTOM_RULES).toBe(false);
    }
    expect(getFlagsFromEnv({ ENABLE_ABAC: '' }).ENABLE_ABAC).toBe(false);
    expect(getFlagsFromEnv({ ENABLE_CUSTOM_RULES: '' }).ENABLE_CUSTOM_RULES).toBe(true);
    expect(getFlagsFromEnv({ ENABLE_CUSTOM_RULES: undefined }).ENABLE_CUSTOM_RULES).toBe(true);
  });
});

describe('FeatureFlagsManager.getFlag', () => {
  it('reads the environment when there is no KV', async () => {
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' });
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    expect(await manager.getFlag('ENABLE_REBAC')).toBe(false);
    expect(await manager.getFlag('ENABLE_CUSTOM_RULES')).toBe(true);
  });

  it('lets a KV override win over the environment, reading true, TRUE and 1 as on', async () => {
    const { kv, get } = fakeKv({
      'policy:flags:ENABLE_ABAC': 'TRUE',
      'policy:flags:ENABLE_REBAC': '1',
      'policy:flags:ENABLE_SD_JWT': 'false',
      'policy:flags:ENABLE_CUSTOM_RULES': '0',
      'policy:flags:ENABLE_POLICY_LOGGING': 'yes',
    });
    const manager = new FeatureFlagsManager({ ENABLE_SD_JWT: 'true' }, kv);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    expect(await manager.getFlag('ENABLE_REBAC')).toBe(true);
    expect(await manager.getFlag('ENABLE_SD_JWT')).toBe(false);
    expect(await manager.getFlag('ENABLE_CUSTOM_RULES')).toBe(false);
    expect(await manager.getFlag('ENABLE_POLICY_LOGGING')).toBe(false);
    expect(get).toHaveBeenCalledWith('policy:flags:ENABLE_ABAC');
  });

  it('serves a read from the cache for the TTL, and reads again from its end', async () => {
    const { kv, store, get } = fakeKv({ 'policy:flags:ENABLE_ABAC': 'true' });
    const manager = new FeatureFlagsManager({}, kv, 1000);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    store.set('policy:flags:ENABLE_ABAC', 'false');
    vi.advanceTimersByTime(999);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('caches the environment value for the TTL too', async () => {
    const { kv, store, get } = fakeKv();
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv, 1000);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    store.set('policy:flags:ENABLE_ABAC', 'false');
    vi.advanceTimersByTime(999);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(false);
  });

  it('caches for a minute by default', async () => {
    const { kv, get } = fakeKv();
    const manager = new FeatureFlagsManager({}, kv);
    await manager.getFlag('ENABLE_ABAC');
    vi.advanceTimersByTime(59_999);
    await manager.getFlag('ENABLE_ABAC');
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await manager.getFlag('ENABLE_ABAC');
    expect(get).toHaveBeenCalledTimes(2);
    const viaFactory = createFeatureFlagsManager({}, kv);
    await viaFactory.getFlag('ENABLE_REBAC');
    vi.advanceTimersByTime(59_999);
    await viaFactory.getFlag('ENABLE_REBAC');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('falls back to the environment when the KV read fails', async () => {
    const { kv, get } = fakeKv();
    get.mockRejectedValue(new Error('kv down'));
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
  });
});

describe('FeatureFlagsManager other reads', () => {
  it('getAllFlags reads every flag', async () => {
    const { kv } = fakeKv({ 'policy:flags:ENABLE_REBAC': 'true' });
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv);
    expect(await manager.getAllFlags()).toStrictEqual({
      ...DEFAULT_FLAGS,
      ENABLE_ABAC: true,
      ENABLE_REBAC: true,
    });
  });

  it('getFlagsSync uses live cache entries and the environment otherwise', async () => {
    const { kv } = fakeKv({
      'policy:flags:ENABLE_ABAC': 'false',
      'policy:flags:ENABLE_REBAC': 'true',
    });
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv, 1000);
    expect(manager.getFlagsSync()).toStrictEqual({ ...DEFAULT_FLAGS, ENABLE_ABAC: true });
    await manager.getFlag('ENABLE_ABAC');
    await manager.getFlag('ENABLE_REBAC');
    expect(manager.getFlagsSync()).toStrictEqual({
      ...DEFAULT_FLAGS,
      ENABLE_ABAC: false,
      ENABLE_REBAC: true,
    });
    vi.advanceTimersByTime(999);
    expect(manager.getFlagsSync()).toStrictEqual({
      ...DEFAULT_FLAGS,
      ENABLE_ABAC: false,
      ENABLE_REBAC: true,
    });
    vi.advanceTimersByTime(1);
    expect(manager.getFlagsSync()).toStrictEqual({ ...DEFAULT_FLAGS, ENABLE_ABAC: true });
  });

  it('each shortcut reads its own flag', async () => {
    const shortcuts: Array<[keyof FeatureFlagsManager, FlagName]> = [
      ['isAbacEnabled', 'ENABLE_ABAC'],
      ['isRebacEnabled', 'ENABLE_REBAC'],
      ['isLoggingEnabled', 'ENABLE_POLICY_LOGGING'],
      ['isSdJwtEnabled', 'ENABLE_SD_JWT'],
      ['isPolicyEmbeddingEnabled', 'ENABLE_POLICY_EMBEDDING'],
    ];
    for (const [method, flag] of shortcuts) {
      const on = new FeatureFlagsManager({ [flag]: 'true' }) as unknown as Record<
        string,
        () => Promise<boolean>
      >;
      const off = new FeatureFlagsManager({}) as unknown as Record<string, () => Promise<boolean>>;
      expect(await on[method]?.()).toBe(true);
      expect(await off[method]?.()).toBe(false);
      for (const other of shortcuts) {
        if (other[1] === flag) continue;
        const unrelated = new FeatureFlagsManager({ [flag]: 'true' }) as unknown as Record<
          string,
          () => Promise<boolean>
        >;
        expect(await unrelated[other[0]]?.()).toBe(false);
      }
    }
  });

  it('clearCache makes the next read go to the KV', async () => {
    const { kv, store, get } = fakeKv({ 'policy:flags:ENABLE_ABAC': 'true' });
    const manager = new FeatureFlagsManager({}, kv, 60_000);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    store.set('policy:flags:ENABLE_ABAC', 'false');
    manager.clearCache();
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
    expect(manager.getFlagsSync().ENABLE_ABAC).toBe(false);
    store.set('policy:flags:ENABLE_ABAC', 'true');
    manager.clearCache();
    expect(manager.getFlagsSync().ENABLE_ABAC).toBe(false);
  });
});

describe('FeatureFlagsManager overrides', () => {
  it('setFlag stores the override and caches it for the TTL', async () => {
    const { kv, put, store } = fakeKv();
    const manager = new FeatureFlagsManager({}, kv, 1000);
    await manager.setFlag('ENABLE_ABAC', true);
    await manager.setFlag('ENABLE_CUSTOM_RULES', false);
    expect(put).toHaveBeenCalledWith('policy:flags:ENABLE_ABAC', 'true');
    expect(put).toHaveBeenCalledWith('policy:flags:ENABLE_CUSTOM_RULES', 'false');
    store.set('policy:flags:ENABLE_ABAC', 'false');
    vi.advanceTimersByTime(999);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(false);
  });

  it('setFlag, clearFlag and clearAllFlags need a KV', async () => {
    const manager = new FeatureFlagsManager({});
    await expect(manager.setFlag('ENABLE_ABAC', true)).rejects.toThrow(
      'KV not configured - cannot set dynamic flag override'
    );
    await expect(manager.clearFlag('ENABLE_ABAC')).rejects.toThrow(
      'KV not configured - cannot clear flag override'
    );
    await expect(manager.clearAllFlags()).rejects.toThrow('KV not configured - cannot clear flags');
  });

  it('clearFlag deletes the override and forgets the cached value', async () => {
    const { kv, del } = fakeKv({ 'policy:flags:ENABLE_ABAC': 'true' });
    const manager = new FeatureFlagsManager({}, kv);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    await manager.clearFlag('ENABLE_ABAC');
    expect(del).toHaveBeenCalledWith('policy:flags:ENABLE_ABAC');
    expect(manager.getFlagsSync().ENABLE_ABAC).toBe(false);
    expect(await manager.getFlag('ENABLE_ABAC')).toBe(false);
  });

  it('clearAllFlags deletes every override and forgets every cached value', async () => {
    const { kv, del } = fakeKv({
      'policy:flags:ENABLE_ABAC': 'true',
      'policy:flags:ENABLE_REBAC': 'true',
    });
    const manager = new FeatureFlagsManager({}, kv);
    await manager.getAllFlags();
    expect(manager.getFlagsSync()).toMatchObject({ ENABLE_ABAC: true, ENABLE_REBAC: true });
    await manager.clearAllFlags();
    expect(del.mock.calls.map((call) => call[0])).toEqual(
      FLAG_NAMES.map((name) => `policy:flags:${name}`)
    );
    expect(manager.getFlagsSync()).toStrictEqual(DEFAULT_FLAGS);
  });
});

describe('FeatureFlagsManager.getFlagSources', () => {
  it('reports where each flag comes from', async () => {
    const { kv } = fakeKv({
      'policy:flags:ENABLE_REBAC': 'TRUE',
      'policy:flags:ENABLE_SD_JWT': '1',
      'policy:flags:ENABLE_CUSTOM_RULES': 'false',
      'policy:flags:ENABLE_POLICY_LOGGING': '0',
    });
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv);
    expect(await manager.getFlagSources()).toStrictEqual({
      ENABLE_ABAC: { value: true, source: 'env' },
      ENABLE_REBAC: { value: true, source: 'kv' },
      ENABLE_POLICY_LOGGING: { value: false, source: 'kv' },
      ENABLE_VERIFIED_ATTRIBUTES: { value: false, source: 'default' },
      ENABLE_CUSTOM_RULES: { value: false, source: 'kv' },
      ENABLE_SD_JWT: { value: true, source: 'kv' },
      ENABLE_POLICY_EMBEDDING: { value: false, source: 'default' },
    });
  });

  it('lets a KV value override an environment one', async () => {
    const { kv } = fakeKv({ 'policy:flags:ENABLE_ABAC': 'false' });
    const manager = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv);
    expect((await manager.getFlagSources()).ENABLE_ABAC).toStrictEqual({
      value: false,
      source: 'kv',
    });
  });

  it('ignores KV failures and works without a KV', async () => {
    const { kv, get } = fakeKv();
    get.mockRejectedValue(new Error('kv down'));
    const failing = new FeatureFlagsManager({ ENABLE_ABAC: 'true' }, kv);
    expect((await failing.getFlagSources()).ENABLE_ABAC).toStrictEqual({
      value: true,
      source: 'env',
    });
    const without = new FeatureFlagsManager({});
    const sources = await without.getFlagSources();
    expect(Object.keys(sources)).toEqual([...FLAG_NAMES]);
    expect(sources.ENABLE_CUSTOM_RULES).toStrictEqual({ value: true, source: 'default' });
  });
});
