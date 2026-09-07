import { describe, expect, it, vi } from 'vitest';
import type { CloudflareWorkerSettings } from '@authrim/ar-lib-core/control-plane';
import type { ControlRepository, DesiredWorkerInventoryRow } from '../repository';
import { GuardedWorkerControlClient } from '../worker-mutation-guard';

function desiredWorker(
  overrides: Partial<DesiredWorkerInventoryRow> = {}
): DesiredWorkerInventoryRow {
  return {
    environment_id: 'env-test',
    worker_script_name: 'test-ar-auth',
    package_name: '@authrim/ar-auth',
    deployment_target: 'default',
    capability_manifest_digest: 'a'.repeat(64),
    source_kind: 'core_manifest',
    status: 'active',
    ...overrides,
  };
}

function repository(result: DesiredWorkerInventoryRow | null) {
  const getActiveDesiredWorker = vi.fn(async () => result);
  return {
    value: { getActiveDesiredWorker } as unknown as ControlRepository,
    getActiveDesiredWorker,
  };
}

function api() {
  const getWorkerSettings = vi.fn(async () => ({ bindings: [] }));
  const patchWorkerSettings = vi.fn(
    async (_scriptName: string, settings: CloudflareWorkerSettings) => settings
  );
  const deleteWorkerScript = vi.fn(async () => undefined);
  const listWorkerVersions = vi.fn(async () => []);
  const listWorkerDeployments = vi.fn(async () => []);
  const createWorkerDeployment = vi.fn(async () => ({
    id: 'deployment-1',
    created_on: '2026-07-29T00:00:00.000Z',
    source: 'api',
    strategy: 'percentage' as const,
    versions: [{ percentage: 100, version_id: 'version-1' }],
  }));
  return {
    value: {
      getWorkerSettings,
      patchWorkerSettings,
      deleteWorkerScript,
      listWorkerVersions,
      listWorkerDeployments,
      createWorkerDeployment,
    },
    getWorkerSettings,
    patchWorkerSettings,
    deleteWorkerScript,
    listWorkerVersions,
    listWorkerDeployments,
    createWorkerDeployment,
  };
}

describe('GuardedWorkerControlClient', () => {
  it('authorizes every script-scoped Workers API operation before provider access', async () => {
    const repo = repository(desiredWorker());
    const rawApi = api();
    const guarded = new GuardedWorkerControlClient(repo.value, rawApi.value);

    await guarded.getWorkerSettings('env-test', 'test-ar-auth');
    await guarded.patchWorkerSettings('env-test', 'test-ar-auth', { bindings: [] });
    await guarded.listWorkerVersions('env-test', 'test-ar-auth');
    await guarded.listWorkerDeployments('env-test', 'test-ar-auth');
    await guarded.createWorkerDeployment('env-test', 'test-ar-auth', 'version-1', 'binding update');
    await guarded.deleteWorkerScript('env-test', 'test-ar-auth');

    expect(repo.getActiveDesiredWorker).toHaveBeenCalledTimes(6);
    expect(rawApi.patchWorkerSettings).toHaveBeenCalledWith('test-ar-auth', { bindings: [] });
    expect(rawApi.deleteWorkerScript).toHaveBeenCalledWith('test-ar-auth');
  });

  it('rejects unknown, disabled, or cross-environment Workers before provider access', async () => {
    for (const row of [
      null,
      desiredWorker({ environment_id: 'other-env' }),
      desiredWorker({ worker_script_name: 'test-ar-token' }),
    ]) {
      const rawApi = api();
      const guarded = new GuardedWorkerControlClient(repository(row).value, rawApi.value);
      await expect(
        guarded.patchWorkerSettings('env-test', 'test-ar-auth', { bindings: [] })
      ).rejects.toThrow(
        row === null
          ? 'control_worker_not_in_desired_inventory'
          : 'control_worker_inventory_boundary_violation'
      );
      expect(rawApi.patchWorkerSettings).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed identifiers without querying inventory or Cloudflare', async () => {
    const repo = repository(desiredWorker());
    const rawApi = api();
    const guarded = new GuardedWorkerControlClient(repo.value, rawApi.value);

    await expect(guarded.getWorkerSettings('../env', 'test-ar-auth')).rejects.toThrow(
      'invalid_environment_id'
    );
    await expect(guarded.getWorkerSettings('env-test', '../script')).rejects.toThrow(
      'invalid_worker_script_name'
    );
    expect(repo.getActiveDesiredWorker).not.toHaveBeenCalled();
    expect(rawApi.getWorkerSettings).not.toHaveBeenCalled();
  });
});
