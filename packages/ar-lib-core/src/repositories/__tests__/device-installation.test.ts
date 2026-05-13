import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { DeviceInstallationRepository } from '../core/device-installation';
import type { DeviceSecret } from '../../types/oidc';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as DatabaseAdapter;
}

const sourceDeviceSecret: DeviceSecret = {
  id: 'ds-source',
  installation_id: 'inst-source',
  tenant_id: 'default',
  client_id: 'source-client',
  trust_group_id: 'tg-wallet',
  user_id: 'user-001',
  session_id: 'sid-001',
  secret_hash: 'hash',
  device_name: 'iPhone',
  device_platform: 'ios',
  created_at: 1_777_000_000_000,
  updated_at: 1_777_000_000_000,
  expires_at: 1_779_000_000_000,
  use_count: 1,
  is_active: 1,
};

describe('DeviceInstallationRepository', () => {
  it('creates a canonical installation row with explicit metadata', async () => {
    const adapter = createAdapter();
    const repo = new DeviceInstallationRepository(adapter, 'default');

    const installation = await repo.createInstallation({
      id: 'inst-explicit',
      tenant_id: 'default',
      user_id: 'user-001',
      client_id: 'native-client',
      trust_group_id: 'tg-wallet',
      linked_device_secret_id: 'ds-001',
      session_id: 'sid-001',
      display_name: '  My   Phone  ',
      device_platform: 'ios',
      last_seen_at: 1_778_000_000_000,
    });

    expect(installation).toMatchObject({
      id: 'inst-explicit',
      user_id: 'user-001',
      client_id: 'native-client',
      trust_group_id: 'tg-wallet',
      linked_device_secret_id: 'ds-001',
      display_name: 'My Phone',
      device_platform: 'ios',
      last_seen_at: 1_778_000_000_000,
      is_active: 1,
    });
    expect(adapter.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO device_installations'), [
      'inst-explicit',
      'default',
      'user-001',
      'native-client',
      'tg-wallet',
      null,
      null,
      'ds-001',
      'sid-001',
      'My Phone',
      'ios',
      expect.any(Number),
      expect.any(Number),
      1_778_000_000_000,
      null,
      null,
      1,
    ]);
  });

  it('creates a target-side installation for cross-client Native SSO', async () => {
    const adapter = createAdapter();
    const repo = new DeviceInstallationRepository(adapter, 'default');

    const installation = await repo.ensureForNativeSSOTokenExchange({
      sourceDeviceSecret,
      targetClientId: 'target-client',
      targetTrustGroupId: 'tg-wallet',
      sourceClientId: 'source-client',
      sameClient: false,
      lastSeenAt: 1_778_000_000_000,
    });

    expect(installation).toMatchObject({
      user_id: 'user-001',
      client_id: 'target-client',
      trust_group_id: 'tg-wallet',
      source_installation_id: 'inst-source',
      source_client_id: 'source-client',
      session_id: 'sid-001',
      device_platform: 'ios',
      last_seen_at: 1_778_000_000_000,
    });
    expect(adapter.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO device_installations'), [
      expect.stringMatching(/^inst_/),
      'default',
      'user-001',
      'target-client',
      'tg-wallet',
      'inst-source',
      'source-client',
      null,
      'sid-001',
      'iPhone',
      'ios',
      expect.any(Number),
      expect.any(Number),
      1_778_000_000_000,
      null,
      null,
      1,
    ]);
  });

  it('falls back without throwing when the canonical table is not migrated yet', async () => {
    const adapter = createAdapter({
      queryOne: vi.fn().mockRejectedValue(new Error('no such table: device_installations')),
    });
    const repo = new DeviceInstallationRepository(adapter, 'default');

    await expect(repo.findById('inst-missing', 'default')).resolves.toBeNull();
  });
});
