import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import type { StorageProfile } from '../../types/runtime-profile';
import { checkStorageProfileTargetHealth } from '../storage-profile-health';

function createMockAdapter(healthy = true): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue({
      healthy,
      latencyMs: healthy ? 7 : 42,
      backendType: 'MOCK',
      ...(healthy ? {} : { error: 'mock_unhealthy' }),
    }),
    getType: vi.fn().mockReturnValue('postgres'),
    close: vi.fn(),
  };
}

describe('checkStorageProfileTargetHealth', () => {
  it('checks storage slice health through the resolved database adapter', async () => {
    const coreDb = createMockAdapter(true);
    const profile: StorageProfile = {
      id: 'external-test',
      kind: 'storage',
      label: 'External Test',
      slices: {
        users_core: {
          driver: 'postgres',
          bindingRef: 'CORE_DB',
          role: 'core',
        },
      },
    };

    const result = await checkStorageProfileTargetHealth(
      { CORE_DB: coreDb },
      profile,
      'slice',
      'users_core',
      '2026-05-16T00:00:00.000Z'
    );

    expect(coreDb.isHealthy).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      profileId: 'external-test',
      targetKind: 'slice',
      targetName: 'users_core',
      driver: 'postgres',
      role: 'core',
      bindingRef: 'CORE_DB',
      healthy: true,
      latencyMs: 7,
      checkedAt: '2026-05-16T00:00:00.000Z',
    });
  });

  it('reports unhealthy adapter state for logical source targets', async () => {
    const piiDb = createMockAdapter(false);
    const profile: StorageProfile = {
      id: 'external-test',
      kind: 'storage',
      label: 'External Test',
      slices: {},
      logicalSources: {
        users_pii: {
          driver: 'postgres',
          bindingRef: 'PII_DB',
          role: 'pii',
          logicalSource: 'users_pii',
        },
      },
    };

    const result = await checkStorageProfileTargetHealth(
      { PII_DB: piiDb },
      profile,
      'logical_source',
      'users_pii',
      '2026-05-16T00:00:00.000Z'
    );

    expect(result.healthy).toBe(false);
    expect(result.sourceHealth.error).toBe('mock_unhealthy');
  });
});
