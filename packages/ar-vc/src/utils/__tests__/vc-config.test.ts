import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VC_CONFIG, createVCConfigManager } from '../vc-config';
import type { Env } from '../../types';

interface MockKV {
  namespace: KVNamespace;
  values: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockKV(initialValues: Record<string, string> = {}): MockKV {
  const values = new Map(Object.entries(initialValues));
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const deleteMock = vi.fn(async (key: string) => {
    values.delete(key);
  });

  return {
    namespace: { get, put, delete: deleteMock } as unknown as KVNamespace,
    values,
    get,
    put,
    delete: deleteMock,
  };
}

describe('VCConfigManager', () => {
  it('resolves numeric config by KV, then cached value, then env after cache clear', async () => {
    const kv = createMockKV({ 'vc:config:POP_VALIDITY_SECONDS': '120' });
    const manager = createVCConfigManager(
      {
        AUTHRIM_CONFIG: kv.namespace,
        POP_VALIDITY_SECONDS: '240',
      } as unknown as Partial<Env>,
      60_000
    );

    await expect(manager.getPopValiditySeconds()).resolves.toBe(120);

    kv.values.set('vc:config:POP_VALIDITY_SECONDS', '180');
    await expect(manager.getPopValiditySeconds()).resolves.toBe(120);

    manager.clearCache();
    await expect(manager.getPopValiditySeconds()).resolves.toBe(180);
  });

  it('falls back from invalid numeric KV and env values to the safe default', async () => {
    const kv = createMockKV({ 'vc:config:POP_CLOCK_SKEW_SECONDS': 'not-a-number' });
    const manager = createVCConfigManager({
      AUTHRIM_CONFIG: kv.namespace,
      POP_CLOCK_SKEW_SECONDS: 'also-invalid',
    } as unknown as Partial<Env>);

    await expect(manager.getPopClockSkewSeconds()).resolves.toBe(
      DEFAULT_VC_CONFIG.POP_CLOCK_SKEW_SECONDS
    );
  });

  it('uses boolean environment values when KV does not override them', async () => {
    const manager = createVCConfigManager({
      REQUIRE_HOLDER_BINDING: 'false',
      REQUIRE_ISSUER_TRUST: '0',
      REQUIRE_STATUS_CHECK: 'true',
    } as unknown as Partial<Env>);

    await expect(manager.isHolderBindingRequired()).resolves.toBe(false);
    await expect(manager.isIssuerTrustRequired()).resolves.toBe(false);
    await expect(manager.isStatusCheckRequired()).resolves.toBe(true);
  });

  it('lets KV boolean values override environment values', async () => {
    const kv = createMockKV({
      'vc:config:REQUIRE_STATUS_CHECK': '0',
    });
    const manager = createVCConfigManager({
      AUTHRIM_CONFIG: kv.namespace,
      REQUIRE_STATUS_CHECK: 'true',
    } as unknown as Partial<Env>);

    await expect(manager.isStatusCheckRequired()).resolves.toBe(false);
  });

  it('validates dynamic config updates before writing to KV', async () => {
    const kv = createMockKV();
    const manager = createVCConfigManager({ AUTHRIM_CONFIG: kv.namespace });

    await expect(manager.setConfig('POP_VALIDITY_SECONDS', 30)).rejects.toThrow(
      'POP_VALIDITY_SECONDS must be >= 60'
    );
    await expect(manager.setConfig('HAIP_POLICY_VERSION', 'unknown')).rejects.toThrow(
      'HAIP_POLICY_VERSION must be one of'
    );

    await manager.setConfig('POP_VALIDITY_SECONDS', 300);
    expect(kv.put).toHaveBeenCalledWith('vc:config:POP_VALIDITY_SECONDS', '300');
    await expect(manager.getPopValiditySeconds()).resolves.toBe(300);
  });

  it('reports config sources with parsed values', async () => {
    const kv = createMockKV({ 'vc:config:HAIP_POLICY_VERSION': 'final-1.0' });
    const manager = createVCConfigManager({
      AUTHRIM_CONFIG: kv.namespace,
      VP_REQUEST_EXPIRY_SECONDS: '600',
      REQUIRE_STATUS_CHECK: 'false',
    } as unknown as Partial<Env>);

    const sources = await manager.getConfigSources();

    expect(sources.HAIP_POLICY_VERSION).toEqual({ value: 'final-1.0', source: 'kv' });
    expect(sources.VP_REQUEST_EXPIRY_SECONDS).toEqual({ value: 600, source: 'env' });
    expect(sources.REQUIRE_STATUS_CHECK).toEqual({ value: false, source: 'env' });
    expect(sources.NONCE_EXPIRY_SECONDS).toEqual({
      value: DEFAULT_VC_CONFIG.NONCE_EXPIRY_SECONDS,
      source: 'default',
    });
  });
});
