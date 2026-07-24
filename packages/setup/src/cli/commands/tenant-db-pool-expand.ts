import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  saveLockFile,
} from '../../core/lock.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
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

interface TenantDatabasePoolExpandOptions {
  env?: string;
  addSlots?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const MAX_TENANT_D1_SLOTS = 500;

export async function tenantDatabasePoolExpandCommand(
  options: TenantDatabasePoolExpandOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const requestedAddSlots = Number.parseInt(options.addSlots ?? '0', 10);

  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(envPaths.config)) {
    console.error(chalk.red(`Config file not found: ${envPaths.config}`));
    process.exit(1);
  }

  const configText = await readFile(envPaths.config, 'utf-8');
  const diskConfig = AuthrimConfigSchema.parse(JSON.parse(configText)) as AuthrimConfig;
  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);
  if (!lock) {
    console.error(chalk.red(`Lock file not found for environment "${env}".`));
    process.exit(1);
  }
  const config = await readEffectiveTopologyConfig(lock, envPaths.config);
  const targetProductVersion = await getRootProductVersion(baseDir);
  const deploymentGuard = evaluateReleaseDeploymentGuard(
    lock,
    targetProductVersion,
    'topology_change'
  );
  if (!deploymentGuard.allowed) {
    console.error(chalk.red(releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion)));
    console.log(chalk.yellow(`Run authrim-setup update --env ${env} before expanding the pool.`));
    process.exit(1);
  }
  if (config.profiles?.defaults?.storage !== 'builtin:storage:tenant-d1') {
    console.error(
      chalk.red(
        `Tenant D1 pool is not enabled for environment "${env}" ` +
          `(storage: ${config.profiles?.defaults?.storage ?? 'unknown'}).`
      )
    );
    console.log(chalk.gray('Shared D1 tenants can be added from Admin UI without pool expansion.'));
    process.exit(1);
  }

  const currentSlots = config.tenantD1?.preallocatedSlots ?? 3;
  const resuming = lock.topologyUpdate !== undefined;
  if (resuming) {
    assertPendingTopologyUpdate(lock, {
      kind: 'tenant_d1_pool',
      targetProductVersion,
      config,
    });
  }
  if (!resuming && (!Number.isInteger(requestedAddSlots) || requestedAddSlots < 1)) {
    console.error(chalk.red('Missing or invalid required option: --add-slots <n>'));
    process.exit(1);
  }
  const addSlots = resuming ? 0 : requestedAddSlots;
  const nextSlots = resuming ? currentSlots : currentSlots + addSlots;
  if (nextSlots > MAX_TENANT_D1_SLOTS) {
    console.error(
      chalk.red(
        `Tenant D1 slot hard limit exceeded: ${nextSlots}/${MAX_TENANT_D1_SLOTS}. ` +
          'Use Tenant DB Shard Worker design for larger installations.'
      )
    );
    process.exit(1);
  }

  console.log(chalk.bold('\nTenant D1 pool expansion\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Current slots: ${chalk.cyan(currentSlots)}`);
  console.log(`Add slots:     ${chalk.cyan(addSlots)}`);
  console.log(`Next slots:    ${chalk.cyan(nextSlots)}`);
  if (resuming) console.log(chalk.yellow('Resuming the pending Worker binding deployment.'));

  if (options.dryRun) {
    console.log(
      chalk.yellow('\nDry run only. No config, D1, binding, or deployment changes made.')
    );
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message:
        'Update config, create additional tenant D1 slots, refresh bindings, and deploy workers?',
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const operationLock = await acquireEnvironmentOperationLock(lockPath, 'tenant-db-pool-expand');
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
      throw new Error('environment_changed_while_waiting_for_tenant_pool_lock');
    }
    if (!resuming) {
      const updatedConfig: AuthrimConfig = {
        ...config,
        tenantD1: {
          ...(config.tenantD1 ?? { preallocatedSlots: currentSlots }),
          preallocatedSlots: nextSlots,
        },
        updatedAt: new Date().toISOString(),
      };
      await commitTopologyConfigTransaction({
        lock,
        lockPath,
        configPath: envPaths.config,
        kind: 'tenant_d1_pool',
        targetProductVersion,
        config: updatedConfig,
      });
      console.log(
        chalk.green(`✓ Updated preallocated tenant slots: ${currentSlots} -> ${nextSlots}`)
      );
    } else if (lockedEnvironment.lock.topologyUpdate?.phase === 'config_staged') {
      await recoverTopologyConfigTransaction({
        lock: lockedEnvironment.lock,
        lockPath,
        configPath: envPaths.config,
        kind: 'tenant_d1_pool',
        targetProductVersion,
      });
    } else {
      const pending = prepareTopologyUpdate(lockedEnvironment.lock, {
        kind: 'tenant_d1_pool',
        targetProductVersion,
        config,
      });
      await saveLockFile(pending.lock, lockPath);
    }
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
