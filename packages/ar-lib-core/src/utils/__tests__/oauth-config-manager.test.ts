import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_NAMES,
  DEFAULT_CONFIG,
  OAuthConfigManager,
  getConfigFromEnv,
} from '../oauth-config';

function kv(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    data,
  };
}

describe('OAuthConfigManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses all supported environment values and falls back on malformed numbers', () => {
    expect(
      getConfigFromEnv({
        ACCESS_TOKEN_EXPIRY: '7200',
        AUTH_CODE_EXPIRY: 'invalid',
        STATE_EXPIRY: '600',
        NONCE_EXPIRY: '',
        REFRESH_TOKEN_EXPIRY: '10000',
        ENABLE_REFRESH_TOKEN_ROTATION: 'false',
        MAX_CODES_PER_USER: '200',
        AUTHRIM_CODE_SHARDS: '8',
        ENABLE_STATE_REQUIRED: '1',
        ENABLE_USERINFO_REQUIRE_OPENID_SCOPE: '0',
        USER_CACHE_TTL: '120',
        CONSENT_CACHE_TTL: '240',
        CONFIG_CACHE_TTL: '30',
      } as never)
    ).toEqual({
      TOKEN_EXPIRY: 7200,
      AUTH_CODE_TTL: DEFAULT_CONFIG.AUTH_CODE_TTL,
      STATE_EXPIRY: 600,
      NONCE_EXPIRY: DEFAULT_CONFIG.NONCE_EXPIRY,
      REFRESH_TOKEN_EXPIRY: 10000,
      REFRESH_TOKEN_ROTATION_ENABLED: false,
      MAX_CODES_PER_USER: 200,
      CODE_SHARDS: 8,
      STATE_REQUIRED: true,
      USERINFO_REQUIRE_OPENID_SCOPE: false,
      USER_CACHE_TTL: 120,
      CONSENT_CACHE_TTL: 240,
      CONFIG_CACHE_TTL: 30,
    });
  });

  it('prefers valid KV values, caches them, and refreshes after expiry', async () => {
    const store = kv({
      'oauth:config:TOKEN_EXPIRY': '900',
      'oauth:config:STATE_REQUIRED': 'true',
    });
    const manager = new OAuthConfigManager(
      { ACCESS_TOKEN_EXPIRY: '600', ENABLE_STATE_REQUIRED: 'false' } as never,
      store as never,
      1000
    );
    await expect(manager.getNumber('TOKEN_EXPIRY')).resolves.toBe(900);
    await expect(manager.getBoolean('STATE_REQUIRED')).resolves.toBe(true);
    await expect(manager.getNumber('TOKEN_EXPIRY')).resolves.toBe(900);
    expect(store.get).toHaveBeenCalledTimes(2);
    store.data.set('oauth:config:TOKEN_EXPIRY', '1200');
    vi.advanceTimersByTime(1001);
    await expect(manager.getNumber('TOKEN_EXPIRY')).resolves.toBe(1200);
  });

  it('falls back to environment for missing, malformed, or failed KV reads', async () => {
    const missing = kv({ 'oauth:config:TOKEN_EXPIRY': 'not-a-number' });
    const manager = new OAuthConfigManager(
      { ACCESS_TOKEN_EXPIRY: '700', ENABLE_STATE_REQUIRED: 'true' } as never,
      missing as never
    );
    await expect(manager.getNumber('TOKEN_EXPIRY')).resolves.toBe(700);
    await expect(manager.getBoolean('STATE_REQUIRED')).resolves.toBe(true);

    const failing = kv();
    failing.get.mockRejectedValue(new Error('KV unavailable'));
    const fallback = new OAuthConfigManager(
      { ACCESS_TOKEN_EXPIRY: '800' } as never,
      failing as never
    );
    await expect(fallback.getNumber('TOKEN_EXPIRY')).resolves.toBe(800);
    await expect(fallback.getBoolean('STATE_REQUIRED')).resolves.toBe(false);
  });

  it('loads all values and exposes warmed values synchronously', async () => {
    const manager = new OAuthConfigManager({ ACCESS_TOKEN_EXPIRY: '999' } as never, null);
    const all = await manager.getAllConfig();
    expect(all).toMatchObject({ TOKEN_EXPIRY: 999, STATE_REQUIRED: false });
    expect(manager.getConfigSync()).toEqual(all);
    expect(Object.keys(all)).toEqual([...CONFIG_NAMES]);
  });

  it('validates numeric bounds before persisting dynamic overrides', async () => {
    const store = kv();
    const manager = new OAuthConfigManager({}, store as never);
    await expect(manager.setConfig('TOKEN_EXPIRY', 59)).rejects.toThrow('must be >= 60');
    await expect(manager.setConfig('TOKEN_EXPIRY', 86401)).rejects.toThrow('must be <= 86400');
    await manager.setConfig('TOKEN_EXPIRY', 3600);
    await manager.setConfig('STATE_REQUIRED', true);
    expect(store.put).toHaveBeenCalledWith('oauth:config:TOKEN_EXPIRY', '3600');
    await expect(manager.getTokenExpiry()).resolves.toBe(3600);
    await expect(manager.isStateRequired()).resolves.toBe(true);
  });

  it('requires KV for mutation operations', async () => {
    const manager = new OAuthConfigManager({}, null);
    await expect(manager.setConfig('TOKEN_EXPIRY', 3600)).rejects.toThrow('KV not configured');
    await expect(manager.clearConfig('TOKEN_EXPIRY')).rejects.toThrow('KV not configured');
    await expect(manager.clearAllConfig()).rejects.toThrow('KV not configured');
  });

  it('clears individual and all overrides and their cached values', async () => {
    const store = kv({ 'oauth:config:TOKEN_EXPIRY': '900' });
    const manager = new OAuthConfigManager({ ACCESS_TOKEN_EXPIRY: '700' } as never, store as never);
    await expect(manager.getTokenExpiry()).resolves.toBe(900);
    await manager.clearConfig('TOKEN_EXPIRY');
    await expect(manager.getTokenExpiry()).resolves.toBe(700);
    await manager.setConfig('STATE_REQUIRED', true);
    await manager.clearAllConfig();
    expect(store.delete).toHaveBeenCalledTimes(CONFIG_NAMES.length + 1);
    expect(manager.getConfigSync().STATE_REQUIRED).toBe(false);
  });

  it('reports KV, environment, and default sources without trusting malformed numeric KV', async () => {
    const store = kv({
      'oauth:config:TOKEN_EXPIRY': '1200',
      'oauth:config:STATE_REQUIRED': '1',
      'oauth:config:AUTH_CODE_TTL': 'invalid',
    });
    const manager = new OAuthConfigManager({ NONCE_EXPIRY: '600' } as never, store as never);
    const sources = await manager.getConfigSources();
    expect(sources.TOKEN_EXPIRY).toEqual({ value: 1200, source: 'kv' });
    expect(sources.STATE_REQUIRED).toEqual({ value: true, source: 'kv' });
    expect(sources.NONCE_EXPIRY).toEqual({ value: 600, source: 'env' });
    expect(sources.MAX_CODES_PER_USER).toEqual({
      value: DEFAULT_CONFIG.MAX_CODES_PER_USER,
      source: 'default',
    });
    expect(sources.AUTH_CODE_TTL).toEqual({
      value: DEFAULT_CONFIG.AUTH_CODE_TTL,
      source: 'kv',
    });
  });

  it('falls back when source inspection KV reads fail', async () => {
    const store = kv();
    store.get.mockRejectedValue(new Error('KV unavailable'));
    const manager = new OAuthConfigManager({ ACCESS_TOKEN_EXPIRY: '700' } as never, store as never);
    const sources = await manager.getConfigSources();
    expect(sources.TOKEN_EXPIRY).toEqual({ value: 700, source: 'env' });
  });

  it('clears the memory cache and exposes all convenience getters', async () => {
    const store = kv({ 'oauth:config:TOKEN_EXPIRY': '900' });
    const manager = new OAuthConfigManager({}, store as never, 1234);
    await manager.getTokenExpiry();
    store.data.set('oauth:config:TOKEN_EXPIRY', '1000');
    manager.clearCache();
    await expect(manager.getTokenExpiry()).resolves.toBe(1000);
    expect(manager.getCurrentCacheTTLMs()).toBe(1234);
    await Promise.all([
      manager.getAuthCodeTTL(),
      manager.getStateExpiry(),
      manager.getNonceExpiry(),
      manager.getRefreshTokenExpiry(),
      manager.isRefreshTokenRotationEnabled(),
      manager.getMaxCodesPerUser(),
      manager.getCodeShards(),
      manager.isUserInfoRequireOpenidScope(),
      manager.getUserCacheTTL(),
      manager.getConsentCacheTTL(),
      manager.getConfigCacheTTL(),
    ]);
  });
});
