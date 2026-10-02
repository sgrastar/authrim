import { describe, expect, it, vi } from 'vitest';
import { getTenantSettingsDocument, TenantSettingsUnavailableError } from '../tenant-settings';

function kvWithGet(get: ReturnType<typeof vi.fn>): KVNamespace {
  return { get } as unknown as KVNamespace;
}

describe('getTenantSettingsDocument', () => {
  function kvWith(data: Record<string, unknown>): KVNamespace {
    return kvWithGet(
      vi.fn(async (key: string) => (key in data ? JSON.stringify(data[key]) : null))
    );
  }

  it('reads what the Settings API saved, not the copy written at tenant creation', async () => {
    const stores = {
      SETTINGS: kvWith({
        'settings:tenant:acme:tenant': { 'tenant.allowed_origins': 'https://edited.example' },
      }),
      AUTHRIM_CONFIG: kvWith({
        'settings:tenant:acme:tenant': { 'tenant.allowed_origins': 'https://seeded.example' },
      }),
    };

    await expect(getTenantSettingsDocument(stores, 'acme', 'tenant')).resolves.toEqual({
      'tenant.allowed_origins': 'https://edited.example',
    });
  });

  it('falls back to the AUTHRIM_CONFIG copy only when SETTINGS has nothing', async () => {
    const stores = {
      SETTINGS: kvWith({}),
      AUTHRIM_CONFIG: kvWith({
        'settings:tenant:acme:tenant': { 'tenant.allowed_origins': 'https://seeded.example' },
      }),
    };

    await expect(getTenantSettingsDocument(stores, 'acme', 'tenant')).resolves.toEqual({
      'tenant.allowed_origins': 'https://seeded.example',
    });
    await expect(getTenantSettingsDocument({}, 'acme', 'tenant')).resolves.toBeNull();
  });

  it('does not bring back the stale copy when SETTINGS cannot be read', async () => {
    const legacy = kvWith({
      'settings:tenant:acme:tenant': { 'tenant.allowed_origins': 'https://seeded.example' },
    });
    const failing = {
      SETTINGS: kvWithGet(vi.fn().mockRejectedValue(new Error('KV down'))),
      AUTHRIM_CONFIG: legacy,
    };
    const malformed = {
      SETTINGS: kvWithGet(vi.fn().mockResolvedValue('{not-json')),
      AUTHRIM_CONFIG: legacy,
    };
    const notAnObject = {
      SETTINGS: kvWithGet(vi.fn().mockResolvedValue('[]')),
      AUTHRIM_CONFIG: legacy,
    };

    // Fails closed by default.
    for (const stores of [failing, malformed, notAnObject]) {
      await expect(getTenantSettingsDocument(stores, 'acme', 'tenant')).rejects.toBeInstanceOf(
        TenantSettingsUnavailableError
      );
    }
    // Callers whose fallback is at least as strict may carry on without the settings.
    for (const stores of [failing, malformed, notAnObject]) {
      await expect(
        getTenantSettingsDocument(stores, 'acme', 'tenant', { onUnreadable: 'empty' })
      ).resolves.toBeNull();
    }
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('treats a legacy copy that cannot be read the same way', async () => {
    const stores = {
      SETTINGS: kvWith({}),
      AUTHRIM_CONFIG: kvWithGet(vi.fn().mockResolvedValue('{not-json')),
    };

    await expect(getTenantSettingsDocument(stores, 'acme', 'tenant')).rejects.toBeInstanceOf(
      TenantSettingsUnavailableError
    );
    await expect(
      getTenantSettingsDocument(stores, 'acme', 'tenant', { onUnreadable: 'empty' })
    ).resolves.toBeNull();
  });

  it('puts the platform values underneath when the category can be set for the platform', async () => {
    const stores = {
      SETTINGS: kvWith({
        'settings:platform:feature-flags': {
          'feature.enable_login_runtime_flow': true,
          'feature.enable_abac': true,
        },
        'settings:tenant:acme:feature-flags': { 'feature.enable_abac': false },
      }),
    };

    await expect(getTenantSettingsDocument(stores, 'acme', 'feature-flags')).resolves.toEqual({
      'feature.enable_login_runtime_flow': true,
      'feature.enable_abac': false,
    });
    await expect(getTenantSettingsDocument(stores, 'other', 'feature-flags')).resolves.toEqual({
      'feature.enable_login_runtime_flow': true,
      'feature.enable_abac': true,
    });
  });

  it('does not read a platform document for a tenant-only category', async () => {
    const get = vi.fn(async () => null);
    await getTenantSettingsDocument({ SETTINGS: kvWithGet(get) }, 'acme', 'ciba');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('settings:tenant:acme:ciba');
  });
});
