import { join } from 'node:path';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import { saveLockFile } from './lock.js';
import type { WorkerComponent } from './naming.js';
import {
  checkWranglerStatus,
  saveMasterWranglerConfigs,
  syncWranglerConfigs,
} from './wrangler-sync.js';
import {
  compileControlWorkerInventoryFromArtifacts,
  registerControlWorkerInventory,
} from './control-worker-inventory.js';
import { refreshLockFromControlGeneratedState } from './control-generated-state.js';
import {
  discoverExternalCapabilities,
  registerExternalCapabilities,
} from './external-capability-registration.js';
import { publishDynamicPluginWorkerBundles } from './dynamic-plugin-publication.js';
import { buildWorkerDeploymentResourceIds } from './deployment-resource-ids.js';
import { assertR2BucketOwnershipForUse } from './cloudflare.js';

export interface RefreshedWorkerDeploymentArtifacts {
  lock: AuthrimLock;
  generatedFiles: string[];
  syncedComponents: string[];
}

export async function refreshWorkerDeploymentArtifacts(input: {
  baseDir: string;
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  lockPath: string;
  components: WorkerComponent[];
  registeredBy: string;
  onProgress?: (message: string) => void;
}): Promise<RefreshedWorkerDeploymentArtifacts> {
  const controlDatabaseIdBeforeRefresh = input.lock.d1?.CONTROL_DB?.id;
  if (!controlDatabaseIdBeforeRefresh) {
    throw new Error('control_database_required_for_worker_inventory');
  }
  const pluginRunnerDatabaseId = input.components.includes('ar-plugin-runner')
    ? input.lock.d1?.PLUGIN_RUNNER_DB?.id
    : undefined;
  if (input.components.includes('ar-plugin-runner') && !pluginRunnerDatabaseId) {
    throw new Error('plugin_runner_database_required');
  }
  const projected = await refreshLockFromControlGeneratedState({
    lock: input.lock,
    environmentId: input.env,
  });
  const lock = projected.lock;
  await saveLockFile(lock, input.lockPath);
  input.onProgress?.(
    `Loaded Control DB bindings (+${projected.added.length} ~${projected.changed.length} -${projected.removed.length})`
  );

  const controlDatabaseId = lock.d1?.CONTROL_DB?.id;
  if (!controlDatabaseId) throw new Error('control_database_required_for_worker_inventory');
  const resourceIds = await buildWorkerDeploymentResourceIds({
    lock,
    config: input.config,
    environmentId: input.env,
    components: input.components,
    onProgress: input.onProgress,
  });

  const generated = await saveMasterWranglerConfigs(input.config, resourceIds, {
    baseDir: input.baseDir,
    env: input.env,
    components: input.components,
    onProgress: input.onProgress,
  });
  if (!generated.success) {
    throw new Error(`wrangler_config_generation_failed:${generated.errors.join(',')}`);
  }

  const inventory = await compileControlWorkerInventoryFromArtifacts({
    baseDir: input.baseDir,
    environmentId: input.env,
    environmentName: input.env,
    components: input.components,
    artifactPaths: generated.files,
  });
  await registerControlWorkerInventory({
    controlDatabaseName: controlDatabaseId,
    records: inventory,
    environmentBootstrap: {
      defaultResidencyPolicyId: input.config.profiles.defaults.residency,
      automaticProvisioning: input.config.controlPlane?.automaticProvisioning === true,
    },
    registeredBy: input.registeredBy,
    disableMissing: false,
    onProgress: input.onProgress,
  });

  if (input.components.includes('ar-plugin-runner')) {
    const externalSources = await discoverExternalCapabilities({ baseDir: input.baseDir });
    const pluginBundleBucket = lock.r2?.PLUGIN_BUNDLES;
    const verifyPluginBundleOwnership = pluginBundleBucket
      ? () =>
          assertR2BucketOwnershipForUse({
            ...pluginBundleBucket,
            environment: input.env,
            binding: 'PLUGIN_BUNDLES',
          })
      : undefined;
    if (input.config.features.pluginDynamicWorkers.enabled) {
      if (!pluginBundleBucket) throw new Error('plugin_bundle_bucket_required');
      await verifyPluginBundleOwnership!();
    }
    await publishDynamicPluginWorkerBundles({
      baseDir: input.baseDir,
      enabled: input.config.features.pluginDynamicWorkers.enabled,
      sources: externalSources,
      bucketName: pluginBundleBucket?.name,
      pluginRunnerDatabaseId: pluginRunnerDatabaseId!,
      verifyBucketOwnership: verifyPluginBundleOwnership,
      onProgress: input.onProgress,
    });
    await registerExternalCapabilities({
      controlDatabaseName: controlDatabaseId,
      environmentId: input.env,
      sources: externalSources,
      registeredBy: input.registeredBy,
    });
  }

  const synced = await syncWranglerConfigs({
    baseDir: input.baseDir,
    env: input.env,
    packagesDir: join(input.baseDir, 'packages'),
    components: input.components,
    force: true,
    dryRun: false,
    onProgress: input.onProgress,
  });
  if (!synced.success) {
    throw new Error(`wrangler_config_sync_failed:${synced.errors.join(',')}`);
  }
  const statuses = await checkWranglerStatus({
    baseDir: input.baseDir,
    env: input.env,
    packagesDir: join(input.baseDir, 'packages'),
    components: input.components,
  });
  const mismatches = statuses.filter(
    (status) => !status.masterExists || !status.deployExists || !status.inSync
  );
  if (mismatches.length > 0) {
    throw new Error(
      `wrangler_config_post_sync_mismatch:${mismatches.map((status) => status.component).join(',')}`
    );
  }
  return {
    lock,
    generatedFiles: generated.files,
    syncedComponents: synced.synced,
  };
}
