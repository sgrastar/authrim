/**
 * Feature Flags Tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FeatureFlagsManager,
  createFeatureFlagsManager,
  getFlagsFromEnv,
  DEFAULT_FLAGS,
  FLAG_NAMES,
  type KVNamespace,
  type PolicyFeatureFlags,
} from '../feature-flags';

describe('Feature Flags', () => {
  describe('getFlagsFromEnv', () => {
    it('should return default values when env is empty', () => {
      const flags = getFlagsFromEnv({});
      expect(flags).toEqual(DEFAULT_FLAGS);
    });

    it('should parse true values correctly', () => {
      const flags = getFlagsFromEnv({
        ENABLE_ABAC: 'true',
        ENABLE_REBAC: 'TRUE',
        ENABLE_POLICY_LOGGING: '1',
      });
      expect(flags.ENABLE_ABAC).toBe(true);
      expect(flags.ENABLE_REBAC).toBe(true);
      expect(flags.ENABLE_POLICY_LOGGING).toBe(true);
    });

    it('should parse false values correctly', () => {
      const flags = getFlagsFromEnv({
        ENABLE_ABAC: 'false',
        ENABLE_REBAC: 'FALSE',
        ENABLE_POLICY_LOGGING: '0',
        ENABLE_CUSTOM_RULES: 'no', // anything not true/1 is false
      });
      expect(flags.ENABLE_ABAC).toBe(false);
      expect(flags.ENABLE_REBAC).toBe(false);
      expect(flags.ENABLE_POLICY_LOGGING).toBe(false);
      expect(flags.ENABLE_CUSTOM_RULES).toBe(false);
    });

    it('should use defaults for undefined values', () => {
      const flags = getFlagsFromEnv({
        ENABLE_ABAC: undefined,
        ENABLE_CUSTOM_RULES: '', // empty string also uses default
      });
      expect(flags.ENABLE_ABAC).toBe(DEFAULT_FLAGS.ENABLE_ABAC);
      expect(flags.ENABLE_CUSTOM_RULES).toBe(DEFAULT_FLAGS.ENABLE_CUSTOM_RULES);
    });
  });

  describe('FeatureFlagsManager (without KV)', () => {
    it('should return env flags when KV is not provided', async () => {
      const manager = createFeatureFlagsManager({
        ENABLE_ABAC: 'true',
        ENABLE_REBAC: 'false',
      });

      expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
      expect(await manager.getFlag('ENABLE_REBAC')).toBe(false);
    });

    it('should return all flags', async () => {
      const manager = createFeatureFlagsManager({
        ENABLE_ABAC: 'true',
      });

      const flags = await manager.getAllFlags();
      expect(flags.ENABLE_ABAC).toBe(true);
      expect(flags.ENABLE_REBAC).toBe(false);
      expect(flags.ENABLE_CUSTOM_RULES).toBe(true); // default
    });

    it('should return flags synchronously', () => {
      const manager = createFeatureFlagsManager({
        ENABLE_POLICY_LOGGING: 'true',
      });

      const flags = manager.getFlagsSync();
      expect(flags.ENABLE_POLICY_LOGGING).toBe(true);
    });

    it('should throw when trying to set flag without KV', async () => {
      const manager = createFeatureFlagsManager({});

      await expect(manager.setFlag('ENABLE_ABAC', true)).rejects.toThrow('KV not configured');
    });

    it('should throw when trying to clear flag without KV', async () => {
      const manager = createFeatureFlagsManager({});

      await expect(manager.clearFlag('ENABLE_ABAC')).rejects.toThrow('KV not configured');
    });
  });

  describe('FeatureFlagsManager (with KV)', () => {
    let mockKV: KVNamespace;
    let kvStore: Map<string, string>;

    beforeEach(() => {
      kvStore = new Map();
      mockKV = {
        get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
        put: vi.fn((key: string, value: string) => {
          kvStore.set(key, value);
          return Promise.resolve();
        }),
        delete: vi.fn((key: string) => {
          kvStore.delete(key);
          return Promise.resolve();
        }),
      };
    });

    it('should prioritize KV over env', async () => {
      // Set env to false
      const manager = createFeatureFlagsManager({ ENABLE_ABAC: 'false' }, mockKV);

      // Set KV to true
      kvStore.set('policy:flags:ENABLE_ABAC', 'true');

      // Should return KV value
      expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    });

    it('should fall back to env when KV has no override', async () => {
      const manager = createFeatureFlagsManager({ ENABLE_REBAC: 'true' }, mockKV);

      // No KV override set
      expect(await manager.getFlag('ENABLE_REBAC')).toBe(true);
    });

    it('should cache KV values', async () => {
      const manager = createFeatureFlagsManager({}, mockKV, 60000);
      kvStore.set('policy:flags:ENABLE_ABAC', 'true');

      // First call - reads from KV
      await manager.getFlag('ENABLE_ABAC');
      expect(mockKV.get).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      await manager.getFlag('ENABLE_ABAC');
      expect(mockKV.get).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should update cache when setting flag', async () => {
      const manager = createFeatureFlagsManager({}, mockKV);

      await manager.setFlag('ENABLE_ABAC', true);

      // Cache should be updated
      expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
      expect(mockKV.put).toHaveBeenCalledWith('policy:flags:ENABLE_ABAC', 'true');
    });

    it('should clear flag from KV', async () => {
      const manager = createFeatureFlagsManager(
        { ENABLE_ABAC: 'false' }, // env default
        mockKV
      );
      kvStore.set('policy:flags:ENABLE_ABAC', 'true'); // KV override

      // Clear the override
      await manager.clearFlag('ENABLE_ABAC');

      expect(mockKV.delete).toHaveBeenCalledWith('policy:flags:ENABLE_ABAC');

      // Should now use env value
      manager.clearCache(); // Clear cache to force re-read
      expect(await manager.getFlag('ENABLE_ABAC')).toBe(false);
    });

    it('should clear all flags', async () => {
      const manager = createFeatureFlagsManager({}, mockKV);
      kvStore.set('policy:flags:ENABLE_ABAC', 'true');
      kvStore.set('policy:flags:ENABLE_REBAC', 'true');

      await manager.clearAllFlags();

      expect(mockKV.delete).toHaveBeenCalledTimes(FLAG_NAMES.length);
    });

    it('should handle KV errors gracefully', async () => {
      const errorKV: KVNamespace = {
        get: vi.fn(() => Promise.reject(new Error('KV error'))),
        put: vi.fn(() => Promise.resolve()),
        delete: vi.fn(() => Promise.resolve()),
      };

      const manager = createFeatureFlagsManager({ ENABLE_ABAC: 'true' }, errorKV);

      // Should fall back to env value when KV fails
      expect(await manager.getFlag('ENABLE_ABAC')).toBe(true);
    });
  });

  describe('FeatureFlagsManager convenience methods', () => {
    it('should check ABAC enabled', async () => {
      const manager = createFeatureFlagsManager({ ENABLE_ABAC: 'true' });
      expect(await manager.isAbacEnabled()).toBe(true);
    });

    it('should check ReBAC enabled', async () => {
      const manager = createFeatureFlagsManager({ ENABLE_REBAC: 'true' });
      expect(await manager.isRebacEnabled()).toBe(true);
    });

    it('should check logging enabled', async () => {
      const manager = createFeatureFlagsManager({ ENABLE_POLICY_LOGGING: 'true' });
      expect(await manager.isLoggingEnabled()).toBe(true);
    });
  });

  describe('getFlagSources', () => {
    it('should identify default source', async () => {
      const manager = createFeatureFlagsManager({});

      const sources = await manager.getFlagSources();
      expect(sources.ENABLE_ABAC.source).toBe('default');
      expect(sources.ENABLE_ABAC.value).toBe(false);
    });

    it('should identify env source', async () => {
      const manager = createFeatureFlagsManager({ ENABLE_ABAC: 'true' });

      const sources = await manager.getFlagSources();
      expect(sources.ENABLE_ABAC.source).toBe('env');
      expect(sources.ENABLE_ABAC.value).toBe(true);
    });

    it('should identify KV source', async () => {
      const kvStore = new Map<string, string>();
      kvStore.set('policy:flags:ENABLE_ABAC', 'true');

      const mockKV: KVNamespace = {
        get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
        put: vi.fn(() => Promise.resolve()),
        delete: vi.fn(() => Promise.resolve()),
      };

      const manager = createFeatureFlagsManager(
        { ENABLE_ABAC: 'false' }, // env says false
        mockKV
      );

      const sources = await manager.getFlagSources();
      expect(sources.ENABLE_ABAC.source).toBe('kv');
      expect(sources.ENABLE_ABAC.value).toBe(true);
    });
  });

  describe('Cache expiration', () => {
    it('should expire cache after TTL', async () => {
      vi.useFakeTimers();

      const kvStore = new Map<string, string>();
      kvStore.set('policy:flags:ENABLE_ABAC', 'true');

      const mockKV: KVNamespace = {
        get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
        put: vi.fn(() => Promise.resolve()),
        delete: vi.fn(() => Promise.resolve()),
      };

      const manager = createFeatureFlagsManager({}, mockKV, 1000); // 1 second TTL

      // First call
      await manager.getFlag('ENABLE_ABAC');
      expect(mockKV.get).toHaveBeenCalledTimes(1);

      // Within TTL - should use cache
      vi.advanceTimersByTime(500);
      await manager.getFlag('ENABLE_ABAC');
      expect(mockKV.get).toHaveBeenCalledTimes(1);

      // After TTL - should re-fetch from KV
      vi.advanceTimersByTime(600);
      await manager.getFlag('ENABLE_ABAC');
      expect(mockKV.get).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});
