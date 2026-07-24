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
import { getRequiredR2Buckets, provisionR2Buckets } from '../../core/cloudflare.js';
import { buildResourceIdsFromLock } from '../../core/wrangler.js';
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

  const targetProductVersion = await getRootProductVersion(baseDir);
  const deploymentGuard = evaluateReleaseDeploymentGuard(
    lock,
    targetProductVersion,
    'topology_change'
  );
  if (!deploymentGuard.allowed) {
    console.error(chalk.red(releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion)));
    console.log(chalk.yellow(`Run authrim-setup update --env ${env} before provisioning R2.`));
    process.exit(1);
  }

  const configText = await readFile(envPaths.config, 'utf-8');
  const diskConfig = AuthrimConfigSchema.parse(JSON.parse(configText)) as AuthrimConfig;
  const config = await readEffectiveTopologyConfig(lock, envPaths.config);
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

  console.log(chalk.bold('\nDedicated R2 bucket provisioning\n'));
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
      chalk.yellow('\nDry run only. No bucket, lock, config, or deployment changes made.')
    );
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message: 'Create missing R2 buckets, update bindings, and deploy workers?',
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
    if (
      !lockedEnvironment.lock ||
      JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(lock) ||
      JSON.stringify(lockedConfig) !== JSON.stringify(diskConfig)
    ) {
      throw new Error('environment_changed_while_waiting_for_r2_provision_lock');
    }
    const provisionedBuckets = await provisionR2Buckets(env, {
      existing: lock.r2,
      onProgress: (message) => console.log(chalk.gray(message)),
    });
    const resourceLock = mergeLockFiles(lock, {
      r2: Object.fromEntries(
        provisionedBuckets.map((bucket) => [bucket.binding, { name: bucket.name }])
      ),
    });

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

    const wranglerResult = await saveMasterWranglerConfigs(
      updatedConfig,
      buildResourceIdsFromLock(topologyLock, updatedConfig),
      {
        baseDir,
        env,
        onProgress: (message) => console.log(chalk.gray(message)),
      }
    );
    if (!wranglerResult.success) {
      console.error(chalk.red('Failed to refresh generated wrangler configs:'));
      for (const error of wranglerResult.errors) {
        console.error(chalk.red(`  • ${error}`));
      }
      process.exit(1);
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
