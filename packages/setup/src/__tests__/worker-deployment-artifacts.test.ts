import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import type { AuthrimLock } from '../core/lock.js';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveLock: vi.fn(),
  buildDeploymentResourceIds: vi.fn(),
  saveMaster: vi.fn(),
  compileInventory: vi.fn(),
  registerInventory: vi.fn(),
  discoverExternal: vi.fn(),
  publishBundles: vi.fn(),
  registerExternal: vi.fn(),
  sync: vi.fn(),
  checkStatus: vi.fn(),
}));

vi.mock('../core/control-generated-state.js', () => ({
  refreshLockFromControlGeneratedState: mocks.refresh,
}));
vi.mock('../core/lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/lock.js')>()),
  saveLockFile: mocks.saveLock,
}));
vi.mock('../core/deployment-resource-ids.js', () => ({
  buildWorkerDeploymentResourceIds: mocks.buildDeploymentResourceIds,
}));
vi.mock('../core/wrangler-sync.js', () => ({
  checkWranglerStatus: mocks.checkStatus,
  saveMasterWranglerConfigs: mocks.saveMaster,
  syncWranglerConfigs: mocks.sync,
}));
vi.mock('../core/control-worker-inventory.js', () => ({
  compileControlWorkerInventoryFromArtifacts: mocks.compileInventory,
  registerControlWorkerInventory: mocks.registerInventory,
}));
vi.mock('../core/external-capability-registration.js', () => ({
  discoverExternalCapabilities: mocks.discoverExternal,
  registerExternalCapabilities: mocks.registerExternal,
}));
vi.mock('../core/dynamic-plugin-publication.js', () => ({
  publishDynamicPluginWorkerBundles: mocks.publishBundles,
}));

import { refreshWorkerDeploymentArtifacts } from '../core/worker-deployment-artifacts.js';

function lock(): AuthrimLock {
  return {
    d1: {
      CONTROL_DB: { name: 'test-control', id: 'control-id' },
      PLUGIN_RUNNER_DB: { name: 'test-plugin-runner', id: 'plugin-id' },
    },
    r2: { PLUGIN_BUNDLES: { name: 'test-plugin-bundles' } },
  } as AuthrimLock;
}

describe('Worker deployment artifact refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refresh.mockImplementation(async ({ lock: current }) => ({
      lock: current,
      added: [],
      changed: [],
      removed: [],
    }));
    mocks.buildDeploymentResourceIds.mockResolvedValue({});
    mocks.saveMaster.mockResolvedValue({
      success: true,
      files: ['/repo/.authrim/test/wrangler/ar-plugin-runner.toml'],
      errors: [],
    });
    mocks.compileInventory.mockResolvedValue([{ workerScriptName: 'test-ar-plugin-runner' }]);
    mocks.discoverExternal.mockResolvedValue([]);
    mocks.sync.mockResolvedValue({
      success: true,
      synced: ['ar-plugin-runner'],
      manualEdits: [],
      skipped: [],
      errors: [],
    });
    mocks.checkStatus.mockResolvedValue([
      {
        component: 'ar-plugin-runner',
        masterExists: true,
        deployExists: true,
        inSync: true,
        masterPath: '/repo/.authrim/test/wrangler/ar-plugin-runner.toml',
        deployPath: '/repo/packages/ar-plugin-runner/wrangler.toml',
      },
    ]);
  });

  it('regenerates, registers, and syncs a focused Plugin Runner deployment before deploy', async () => {
    const config = createDefaultConfig('test');
    config.features.r2.enabled = true;
    config.features.pluginDynamicWorkers.enabled = true;
    const currentLock = lock();

    await expect(
      refreshWorkerDeploymentArtifacts({
        baseDir: '/repo',
        env: 'test',
        config,
        lock: currentLock,
        lockPath: '/repo/.authrim/test/lock.json',
        components: ['ar-plugin-runner'],
        registeredBy: 'setup:upgrade',
      })
    ).resolves.toMatchObject({ syncedComponents: ['ar-plugin-runner'] });

    expect(mocks.saveMaster).toHaveBeenCalledWith(
      config,
      {},
      expect.objectContaining({ components: ['ar-plugin-runner'] })
    );
    expect(mocks.registerInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        controlDatabaseName: 'test-control',
        registeredBy: 'setup:upgrade',
        disableMissing: false,
      })
    );
    expect(mocks.publishBundles).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        bucketName: 'test-plugin-bundles',
        pluginRunnerDatabaseName: 'test-plugin-runner',
      })
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({ components: ['ar-plugin-runner'], force: true })
    );
    expect(mocks.checkStatus).toHaveBeenCalledWith(
      expect.objectContaining({ components: ['ar-plugin-runner'], env: 'test' })
    );
    expect(mocks.registerInventory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0]!
    );
  });

  it('fails closed when the generated and package deployment configs differ after sync', async () => {
    mocks.checkStatus.mockResolvedValue([
      {
        component: 'ar-plugin-runner',
        masterExists: true,
        deployExists: true,
        inSync: false,
        masterPath: '/repo/.authrim/test/wrangler/ar-plugin-runner.toml',
        deployPath: '/repo/packages/ar-plugin-runner/wrangler.toml',
      },
    ]);

    await expect(
      refreshWorkerDeploymentArtifacts({
        baseDir: '/repo',
        env: 'test',
        config: createDefaultConfig('test'),
        lock: lock(),
        lockPath: '/repo/.authrim/test/lock.json',
        components: ['ar-plugin-runner'],
        registeredBy: 'setup:upgrade',
      })
    ).rejects.toThrow('wrangler_config_post_sync_mismatch:ar-plugin-runner');
  });

  it('fails before sync when generated configuration cannot be validated', async () => {
    mocks.saveMaster.mockResolvedValue({
      success: false,
      files: [],
      errors: ['worker_loader_binding_missing'],
    });

    await expect(
      refreshWorkerDeploymentArtifacts({
        baseDir: '/repo',
        env: 'test',
        config: createDefaultConfig('test'),
        lock: lock(),
        lockPath: '/repo/.authrim/test/lock.json',
        components: ['ar-plugin-runner'],
        registeredBy: 'setup:upgrade',
      })
    ).rejects.toThrow('wrangler_config_generation_failed:worker_loader_binding_missing');
    expect(mocks.registerInventory).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
