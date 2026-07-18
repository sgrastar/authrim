import { describe, expect, it, vi } from 'vitest';
import { buildTenantSystemSettingsKey, getTenantSystemSettings } from '../tenant-settings';

function kvWithGet(get: ReturnType<typeof vi.fn>): KVNamespace {
  return { get } as unknown as KVNamespace;
}

describe('getTenantSystemSettings', () => {
  it('preserves the compatibility behavior of returning null on KV failure by default', async () => {
    const kv = kvWithGet(vi.fn().mockRejectedValue(new Error('KV unavailable')));

    await expect(getTenantSystemSettings(kv, 'tenant-a')).resolves.toBeNull();
  });

  it('propagates KV failures when a security-sensitive caller requests fail-closed behavior', async () => {
    const kv = kvWithGet(vi.fn().mockRejectedValue(new Error('KV unavailable')));

    await expect(getTenantSystemSettings(kv, 'tenant-a', { failOnError: true })).rejects.toThrow(
      'KV unavailable'
    );
  });

  it('propagates malformed profile JSON in fail-closed mode', async () => {
    const get = vi.fn(async (key: string) =>
      key === buildTenantSystemSettingsKey('tenant-a') ? '{not-json' : null
    );

    await expect(
      getTenantSystemSettings(kvWithGet(get), 'tenant-a', { failOnError: true })
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it('rejects non-object profile JSON in fail-closed mode', async () => {
    const get = vi.fn(async (key: string) =>
      key === buildTenantSystemSettingsKey('tenant-a') ? '[]' : null
    );

    await expect(
      getTenantSystemSettings(kvWithGet(get), 'tenant-a', { failOnError: true })
    ).rejects.toThrow('Tenant system settings must be a JSON object');
  });

  it('still overlays valid tenant settings on global defaults in fail-closed mode', async () => {
    const get = vi.fn(async (key: string) => {
      if (key === 'system_settings') {
        return JSON.stringify({ oidc: { requirePar: false }, fapi: { enabled: false } });
      }
      if (key === buildTenantSystemSettingsKey('tenant-a')) {
        return JSON.stringify({ fapi: { enabled: true } });
      }
      return null;
    });

    await expect(
      getTenantSystemSettings(kvWithGet(get), 'tenant-a', { failOnError: true })
    ).resolves.toEqual({
      oidc: { requirePar: false },
      fapi: { enabled: true },
    });
  });
});
