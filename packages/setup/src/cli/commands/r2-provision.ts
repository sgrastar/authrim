import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  mergeLockFiles,
  saveLockFile,
} from '../../core/lock.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import {
  adoptR2BucketOwnership,
  getAccountId,
  getRequiredR2Buckets,
  hasExactR2BucketOwnership,
  listR2Buckets,
  provisionR2Buckets,
} from '../../core/cloudflare.js';
import { buildWorkerDeploymentResourceIds } from '../../core/deployment-resource-ids.js';
import { saveMasterWranglerConfigs } from '../../core/wrangler-sync.js';
import { getRootProductVersion } from '../../core/version.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../../core/release-deployment-guard.js';
import { deployCommand } from './deploy.js';
import { assertPendingTopologyUpdate, prepareTopologyUpdate } from '../../core/topology-update.js';
import {
  commitTopologyConfigTransaction,
  readEffectiveTopologyConfig,
  recoverTopologyConfigTransaction,
} from '../../core/topology-config-transaction.js';

interface R2ProvisionOptions {
  env?: string;
  dryRun?: boolean;
  yes?: boolean;
  adoptLegacyR2Ownership?: boolean;
}

export async function r2ProvisionCommand(options: R2ProvisionOptions): Promise<void> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });

  if (!existsSync(envPaths.config)) {
    console.error(chalk.red(`Config file not found: ${envPaths.config}`));
    process.exit(1);
  }

  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);
  if (!lock || !lockPath) {
    console.error(chalk.red(`Lock file not found for environment "${env}".`));
    console.log(chalk.gray('Run authrim-setup init before provisioning R2 buckets.'));
    process.exit(1);
  }
  if (lock.env !== env) throw new Error('r2_provision_lock_environment_mismatch');

  const configText = await readFile(envPaths.config, 'utf-8');
  const diskConfig = AuthrimConfigSchema.parse(JSON.parse(configText)) as AuthrimConfig;
  if (diskConfig.environment.prefix !== env) {
    throw new Error('r2_provision_config_environment_mismatch');
  }
  const config = await readEffectiveTopologyConfig(lock, envPaths.config);
  if (config.environment.prefix !== env) {
    throw new Error('r2_provision_effective_config_environment_mismatch');
  }
  const targetProductVersion = await getRootProductVersion(baseDir);
  if (!options.adoptLegacyR2Ownership) {
    const deploymentGuard = evaluateReleaseDeploymentGuard(
      lock,
      targetProductVersion,
      'topology_change'
    );
    if (!deploymentGuard.allowed) {
      console.error(
        chalk.red(releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion))
      );
      console.log(chalk.yellow(`Run authrim-setup update --env ${env} before provisioning R2.`));
      process.exit(1);
    }
  }
  const resuming = lock.topologyUpdate !== undefined;
  if (resuming) {
    assertPendingTopologyUpdate(lock, {
      kind: 'r2',
      targetProductVersion,
      config,
    });
  }
  const requiredBuckets = getRequiredR2Buckets(env);
  const missingBuckets = requiredBuckets.filter((bucket) => !lock.r2?.[bucket.binding]?.name);
  const legacyBuckets = requiredBuckets.filter((bucket) => {
    const recorded = lock.r2?.[bucket.binding];
    return recorded !== undefined && !hasExactR2BucketOwnership(recorded);
  });

  if (options.adoptLegacyR2Ownership) {
    if (lock.topologyUpdate) {
      throw new Error('r2_legacy_ownership_adoption_blocked_by_topology_update');
    }
    if (missingBuckets.length > 0) {
      throw new Error(
        'r2_legacy_ownership_adoption_requires_all_required_buckets_in_lock; ' +
          'this recovery mode never creates buckets'
      );
    }
    const expectedBindings = new Set(requiredBuckets.map((bucket) => bucket.binding));
    const unexpectedBindings = Object.keys(lock.r2 ?? {}).filter(
      (binding) => !expectedBindings.has(binding as (typeof requiredBuckets)[number]['binding'])
    );
    if (unexpectedBindings.length > 0) {
      throw new Error(
        `r2_legacy_ownership_adoption_unexpected_bindings: ${unexpectedBindings.join(', ')}`
      );
    }
    for (const bucket of requiredBuckets) {
      if (lock.r2?.[bucket.binding]?.name !== bucket.name) {
        throw new Error(`r2_legacy_ownership_adoption_name_mismatch: ${bucket.binding}`);
      }
    }
  } else if (legacyBuckets.length > 0) {
    throw new Error(
      'legacy_r2_ownership_requires_explicit_adoption; rerun r2-provision with ' +
        '--adopt-legacy-r2-ownership --yes'
    );
  }

  console.log(
    chalk.bold(
      options.adoptLegacyR2Ownership
        ? '\nLegacy R2 ownership adoption\n'
        : '\nDedicated R2 bucket provisioning\n'
    )
  );
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Required buckets: ${chalk.cyan(requiredBuckets.length)}`);
  console.log(`Missing buckets:  ${chalk.cyan(missingBuckets.length)}`);

  if (missingBuckets.length > 0) {
    for (const bucket of missingBuckets) {
      console.log(`  • ${bucket.binding}: ${bucket.name}`);
    }
  }

  if (options.dryRun) {
    console.log(
      chalk.yellow(
        options.adoptLegacyR2Ownership
          ? '\nDry run only. No ownership markers or lock entries were changed.'
          : '\nDry run only. No bucket, lock, config, or deployment changes made.'
      )
    );
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message: options.adoptLegacyR2Ownership
        ? 'Claim only the lock-recorded existing R2 buckets and persist exact ownership markers?'
        : 'Create missing R2 buckets, update bindings, and deploy workers?',
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const operationLock = await acquireEnvironmentOperationLock(lockPath, 'r2-provision');
  try {
    const lockedEnvironment = await loadLockFileAuto(baseDir, env);
    const lockedConfig = AuthrimConfigSchema.parse(
      JSON.parse(await readFile(envPaths.config, 'utf-8'))
    );
    if (lockedEnvironment.lock && lockedEnvironment.lock.env !== env) {
      throw new Error('r2_provision_lock_environment_mismatch_after_operation_lock');
    }
    if (lockedConfig.environment.prefix !== env) {
      throw new Error('r2_provision_config_environment_mismatch_after_operation_lock');
    }
    if (lockedEnvironment.lock?.r2?.AVATARS) {
      throw new Error(
        'legacy_avatar_bucket_is_not_supported; recreate this pre-1.0 environment with PUBLIC_ASSETS'
      );
    }
    if (
      !lockedEnvironment.lock ||
      JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(lock) ||
      JSON.stringify(lockedConfig) !== JSON.stringify(diskConfig)
    ) {
      throw new Error('environment_changed_while_waiting_for_r2_provision_lock');
    }
    let resourceBaseLock = lock;
    if (options.adoptLegacyR2Ownership) {
      const configuredAccountId = lockedConfig.cloudflare?.accountId;
      const authenticatedAccountId = await getAccountId();
      if (!configuredAccountId || !authenticatedAccountId) {
        throw new Error('r2_legacy_ownership_adoption_requires_exact_account_id');
      }
      if (configuredAccountId !== authenticatedAccountId) {
        throw new Error('r2_legacy_ownership_adoption_account_id_mismatch');
      }

      // Verify the complete provider inventory before the first marker write. This prevents a
      // later missing or duplicate deterministic name from leaving a partially adopted lock.
      const providerBuckets = await listR2Buckets({ throwOnError: true, requireIdentity: true });
      const providerByName = new Map<string, (typeof providerBuckets)[number]>();
      for (const providerBucket of providerBuckets) {
        if (providerByName.has(providerBucket.name)) {
          throw new Error(
            `r2_legacy_ownership_adoption_duplicate_provider_name: ${providerBucket.name}`
          );
        }
        providerByName.set(providerBucket.name, providerBucket);
      }
      for (const bucket of requiredBuckets) {
        const recorded = resourceBaseLock.r2?.[bucket.binding];
        const provider = recorded ? providerByName.get(recorded.name) : undefined;
        if (!recorded || !provider?.creationDate) {
          throw new Error(
            `r2_legacy_ownership_adoption_provider_bucket_missing: ${bucket.binding}`
          );
        }
        if (recorded.creationDate && recorded.creationDate !== provider.creationDate) {
          throw new Error(
            `r2_legacy_ownership_adoption_provider_identity_mismatch: ${bucket.binding}`
          );
        }
      }

      for (const bucket of requiredBuckets) {
        const recorded = resourceBaseLock.r2?.[bucket.binding];
        if (!recorded) {
          throw new Error(`r2_legacy_ownership_adoption_lock_entry_missing: ${bucket.binding}`);
        }
        const adopted = await adoptR2BucketOwnership({
          environment: env,
          binding: bucket.binding,
          name: recorded.name,
          prepared: recorded,
          onPrepared: async (identity) => {
            resourceBaseLock = {
              ...mergeLockFiles(resourceBaseLock, {}),
              r2: {
                ...resourceBaseLock.r2,
                [bucket.binding]: {
                  name: identity.name,
                  creationDate: identity.creationDate,
                  ownershipMarkerKey: identity.ownershipMarkerKey,
                  ownershipId: identity.ownershipId,
                },
              },
            };
            await saveLockFile(resourceBaseLock, lockPath);
          },
        });
        resourceBaseLock = {
          ...mergeLockFiles(resourceBaseLock, {}),
          r2: {
            ...resourceBaseLock.r2,
            [bucket.binding]: {
              name: adopted.name,
              creationDate: adopted.creationDate,
              ownershipMarkerKey: adopted.ownershipMarkerKey,
              ownershipId: adopted.ownershipId,
            },
          },
        };
        await saveLockFile(resourceBaseLock, lockPath);
      }
      console.log(chalk.green('✓ Exact ownership markers verified for every required R2 bucket.'));
      console.log(chalk.green('✓ Exact provider identities saved to the environment lock file.'));
      return;
    }
    for (const bucket of requiredBuckets) {
      const recorded = resourceBaseLock.r2?.[bucket.binding];
      if (!recorded) continue;
      const adopted = await adoptR2BucketOwnership({
        environment: env,
        binding: bucket.binding,
        name: recorded.name,
        prepared: recorded,
        onPrepared: async (identity) => {
          resourceBaseLock = {
            ...mergeLockFiles(resourceBaseLock, {}),
            r2: {
              ...resourceBaseLock.r2,
              [bucket.binding]: {
                name: identity.name,
                creationDate: identity.creationDate,
                ownershipMarkerKey: identity.ownershipMarkerKey,
                ownershipId: identity.ownershipId,
              },
            },
          };
          await saveLockFile(resourceBaseLock, lockPath);
        },
      });
      resourceBaseLock = {
        ...resourceBaseLock,
        r2: {
          ...resourceBaseLock.r2,
          [bucket.binding]: {
            name: adopted.name,
            creationDate: adopted.creationDate,
            ownershipMarkerKey: adopted.ownershipMarkerKey,
            ownershipId: adopted.ownershipId,
          },
        },
      };
      await saveLockFile(resourceBaseLock, lockPath);
    }
    const provisionedBuckets = await provisionR2Buckets(env, {
      existing: resourceBaseLock.r2,
      onProgress: (message) => console.log(chalk.gray(message)),
    });
    const resourceLock = {
      ...mergeLockFiles(resourceBaseLock, {}),
      r2: Object.fromEntries(
        provisionedBuckets.map((bucket) => [
          bucket.binding,
          {
            name: bucket.name,
            ...(bucket.creationDate ? { creationDate: bucket.creationDate } : {}),
            ...(bucket.ownershipMarkerKey ? { ownershipMarkerKey: bucket.ownershipMarkerKey } : {}),
            ...(bucket.ownershipId ? { ownershipId: bucket.ownershipId } : {}),
          },
        ])
      ),
    };

    const updatedConfig: AuthrimConfig = resuming
      ? config
      : {
          ...config,
          features: {
            ...config.features,
            r2: { enabled: true },
          },
          updatedAt: new Date().toISOString(),
        };
    let topologyLock;
    if (!resuming) {
      topologyLock = (
        await commitTopologyConfigTransaction({
          lock: resourceLock,
          lockPath,
          configPath: envPaths.config,
          kind: 'r2',
          targetProductVersion,
          config: updatedConfig,
        })
      ).lock;
    } else if (lock.topologyUpdate?.phase === 'config_staged') {
      topologyLock = (
        await recoverTopologyConfigTransaction({
          lock: resourceLock,
          lockPath,
          configPath: envPaths.config,
          kind: 'r2',
          targetProductVersion,
        })
      ).lock;
    } else {
      const pending = prepareTopologyUpdate(resourceLock, {
        kind: 'r2',
        targetProductVersion,
        config: updatedConfig,
      });
      await saveLockFile(pending.lock, lockPath);
      topologyLock = pending.lock;
    }

    console.log(chalk.green('✓ R2 buckets are recorded in the environment lock file.'));
    console.log(chalk.green('✓ R2 feature flag is enabled in config.'));

    const deploymentResourceIds = await buildWorkerDeploymentResourceIds({
      lock: topologyLock,
      config: updatedConfig,
      environmentId: env,
      onProgress: (message) => console.log(chalk.gray(message)),
    });
    const wranglerResult = await saveMasterWranglerConfigs(updatedConfig, deploymentResourceIds, {
      baseDir,
      env,
      onProgress: (message) => console.log(chalk.gray(message)),
    });
    if (!wranglerResult.success) {
      throw new Error(
        `Failed to refresh generated wrangler configs: ${wranglerResult.errors.join('; ')}`
      );
    }
    console.log(
      chalk.green(`✓ Refreshed ${wranglerResult.files.length} generated wrangler config(s).`)
    );
  } finally {
    await operationLock.release();
  }

  await deployCommand({
    env,
    config: envPaths.config,
    source: baseDir,
    yes: true,
    operationKind: 'topology_change',
  });
}
