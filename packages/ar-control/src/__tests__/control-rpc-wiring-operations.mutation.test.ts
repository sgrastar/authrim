import { describe, expect, it, vi } from 'vitest';
import { fn, invoke, make } from './support/control-rpc-harness';
import { RESULT } from './support/rpc-wiring-table';
import { defineWiringSuite, useWiringEnvironment } from './support/rpc-wiring-suite';
import { OPERATION_ROWS as ROWS } from './support/operation-wiring-rows';

vi.mock('../service', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), { ControlService: [] })
);
vi.mock('../repository', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    D1ControlRepository: [],
  })
);
vi.mock('../tenant-disaster-recovery', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    TenantDisasterRecoveryService: [],
  })
);
vi.mock('../tenant-placement-migration', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    TenantPlacementMigrationService: [],
  })
);
vi.mock('../tenant-placement-migration-reconciler', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    TenantPlacementMigrationReconciler: [],
  })
);
vi.mock('../shard-cleanup', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    ShardCleanupService: ['fromEnv'],
  })
);
vi.mock('../shard-cleanup-repository', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    D1ShardCleanupRepository: [],
  })
);
vi.mock('../plugin-dynamic-worker-desired-state', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    PluginDynamicWorkerDesiredStateService: [],
  })
);
vi.mock('../plugin-resource-cleanup', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    PluginResourceCleanupService: [],
  })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await import('./support/control-rpc-recorder');
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

const OP = 'op-1';

useWiringEnvironment();
defineWiringSuite('Control operation RPC', ROWS);

describe('Control RPC wiring: environment id bounds', () => {
  it('accepts a 128 character environment id and refuses 129', async () => {
    const id = `a${'b'.repeat(127)}`;
    fn('ControlService.reconcilePending').mockResolvedValue(RESULT);
    await expect(invoke(make({ environmentId: id }).control, 'reconcilePending')).resolves.toBe(
      RESULT
    );
    await expect(
      invoke(make({ environmentId: `${id}c` }).control, 'reconcilePending')
    ).rejects.toThrow('control_rpc_caller_unauthorized');
  });
});

describe('Control RPC wiring: optional results', () => {
  it.each([
    ['getTenantDisasterRecovery', 'TenantDisasterRecoveryService.get', OP],
    ['getTenantPlacementPolicy', 'ControlService.getTenantPlacementPolicy', 'tenant-1'],
    [
      'getPluginDynamicWorkerResourcePreparation',
      'PluginDynamicWorkerDesiredStateService.getPreparation',
      {},
    ],
  ] as const)(
    '%s returns null results without running the secret check',
    async (rpc, call, input) => {
      fn(call).mockResolvedValue(null);
      await expect(invoke(make().control, rpc, input)).resolves.toBeNull();
    }
  );

  it('claimNextTenantDisasterRecoveryLookupReprojection returns null when nothing is claimable', async () => {
    fn('TenantDisasterRecoveryService.claimNextLookupReprojection').mockResolvedValue(null);
    await expect(
      invoke(make().control, 'claimNextTenantDisasterRecoveryLookupReprojection', {
        ownerId: 'o',
        registryDigest: 'd',
        lookupShardCount: 1,
      })
    ).resolves.toBeNull();
  });
});
