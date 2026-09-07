import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuthrimConfigSchema } from '../../core/config.js';
import {
  previewSetupControlCapacity,
  requestSetupControlCapacity,
  retrySetupControlOperationStep,
  listSetupExclusiveCapacityTenants,
} from '../../core/control-capacity-client.js';
import {
  executeSetupControlOperatorCreate,
  executeSetupControlOperatorMigration,
  executeSetupControlOperatorWorkerBindings,
} from '../../core/control-operator-executor.js';
import {
  listPendingControlOperatorOperations,
  listPendingPluginControlCleanupOperations,
  listPendingPluginControlOperatorOperations,
  listPendingTenantDisasterRecoveryOperatorOperations,
} from '../../core/control-operator-operations.js';
import { executeSetupPluginCleanupOperator } from '../../core/plugin-control-cleanup-operator-executor.js';
import { executeSetupPluginControlOperator } from '../../core/plugin-control-operator-executor.js';
import {
  acquireDeployConfigLock,
  acquireEnvironmentOperationForEnvironment,
  loadLockFileAuto,
} from '../../core/lock.js';
import { assertR2BucketOwnershipForUse, listD1Databases } from '../../core/cloudflare.js';
import { assertFixedD1ResourceIdentities } from '../../core/fixed-d1-identity.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { resolveDownstreamIntrospectionKeysDir } from '../../core/downstream-introspection-deploy.js';
import { runEphemeralSetupMachineAccess } from '../../core/setup-machine-access-lifecycle.js';
import { resolveIssuerUrl } from '../../core/url-config.js';
import { refreshWorkerDeploymentArtifacts } from '../../core/worker-deployment-artifacts.js';
import {
  assertControlProvisionMutationState,
  CONTROL_WORKER_BINDING_INTER_TARGET_DELAY_MS,
} from '../../core/control-provision-policy.js';

interface ControlProvisionCommandOptions {
  env?: string;
  operationId?: string;
  capacityProfile?: string;
  scope?: string;
  tenantId?: string;
  keysDir?: string;
  dryRun?: boolean;
  yes?: boolean;
}

async function loadLockedControlProvisionContext(baseDir: string, env: string) {
  const paths = getEnvironmentPaths({ baseDir, env });
  const loaded = await loadLockFileAuto(baseDir, env);
  const lock = loaded.lock;
  const controlDatabase = lock?.d1.CONTROL_DB;
  const adminDatabase = lock?.d1.DB_ADMIN;
  if (!lock || !controlDatabase || !adminDatabase) {
    throw new Error(`Control and Admin databases are not configured for ${env}`);
  }
  if (lock.env !== env) throw new Error('control_provision_lock_environment_mismatch');
  assertControlProvisionMutationState(lock);
  const config = existsSync(paths.config)
    ? AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf-8')))
    : null;
  if (config && config.environment.prefix !== env) {
    throw new Error('control_provision_config_environment_mismatch');
  }
  return {
    paths,
    lock,
    lockPath: loaded.path ?? paths.lock,
    controlDatabase,
    adminDatabase,
    config,
  };
}

async function withControlProvisionMutationLocks<T>(input: {
  baseDir: string;
  env: string;
  operation: string;
  requiresDeployConfigLock: boolean;
  action: (context: Awaited<ReturnType<typeof loadLockedControlProvisionContext>>) => Promise<T>;
}): Promise<T> {
  const environmentLock = await acquireEnvironmentOperationForEnvironment({
    baseDir: input.baseDir,
    env: input.env,
    operation: input.operation,
    requireExisting: true,
  });
  let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
  try {
    if (input.requiresDeployConfigLock) {
      deployConfigLock = await acquireDeployConfigLock({
        baseDir: input.baseDir,
        env: input.env,
        operation: input.operation,
      });
    }
    const context = await loadLockedControlProvisionContext(input.baseDir, input.env);
    if (JSON.stringify(context.lock) !== JSON.stringify(environmentLock.lock)) {
      throw new Error('environment_changed_while_waiting_for_control_provision_lock');
    }
    assertFixedD1ResourceIdentities({
      environment: input.env,
      lock: context.lock,
      databases: await listD1Databases(),
    });
    return await input.action(context);
  } finally {
    try {
      await deployConfigLock?.release();
    } finally {
      await environmentLock.release();
    }
  }
}

async function listPendingControlProvisionOperations(input: {
  controlDatabaseId: string;
  operationId?: string;
}) {
  const [shardPending, pluginPending, pluginCleanupPending, tenantDrPending] = await Promise.all([
    listPendingControlOperatorOperations({
      controlDatabaseName: input.controlDatabaseId,
      operationId: input.operationId,
    }),
    listPendingPluginControlOperatorOperations({
      controlDatabaseName: input.controlDatabaseId,
      operationId: input.operationId,
    }),
    listPendingPluginControlCleanupOperations({
      controlDatabaseName: input.controlDatabaseId,
      operationId: input.operationId,
    }),
    listPendingTenantDisasterRecoveryOperatorOperations({
      controlDatabaseName: input.controlDatabaseId,
      operationId: input.operationId,
    }),
  ]);
  return [...shardPending, ...pluginPending, ...pluginCleanupPending, ...tenantDrPending].sort(
    (left, right) =>
      left.updatedAt - right.updatedAt || left.operationId.localeCompare(right.operationId)
  );
}

export async function controlProvisionCommand(
  options: ControlProvisionCommandOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const { lock } = await loadLockFileAuto(baseDir, env);
  const controlDatabase = lock?.d1.CONTROL_DB;
  if (!controlDatabase) throw new Error(`Control database is not configured for ${env}`);
  if (lock.env !== env) throw new Error('control_provision_lock_environment_mismatch');

  const paths = getEnvironmentPaths({ baseDir, env });
  const config = existsSync(paths.config)
    ? AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf-8')))
    : null;
  if (config && config.environment.prefix !== env) {
    throw new Error('control_provision_config_environment_mismatch');
  }

  if (options.capacityProfile) {
    if (!config) throw new Error(`Control environment config is not available for ${env}`);
    if (!['minimum', 'recommended', 'extra_headroom'].includes(options.capacityProfile)) {
      throw new Error('control_capacity_profile_invalid');
    }
    const scope = options.scope ?? 'shared_pool';
    if (!['shared_pool', 'tenant_exclusive'].includes(scope)) {
      throw new Error('control_capacity_scope_invalid');
    }
    let tenantId = scope === 'tenant_exclusive' ? options.tenantId?.trim() || null : null;
    if (scope === 'tenant_exclusive' && !tenantId && !options.yes) {
      const tenants = await listSetupExclusiveCapacityTenants({
        controlDatabaseName: controlDatabase.id,
        environmentId: env,
      });
      if (tenants.length > 0) {
        tenantId = await select({
          message: 'Select the dedicated tenant capacity target',
          choices: tenants.map((value) => ({ name: value, value })),
        });
      }
    }
    if (scope === 'tenant_exclusive' && !tenantId) {
      throw new Error('control_capacity_tenant_required');
    }
    if (scope === 'shared_pool' && options.tenantId) {
      throw new Error('control_capacity_shared_tenant_forbidden');
    }
    const request = {
      profile: options.capacityProfile as 'minimum' | 'recommended' | 'extra_headroom',
      scope: scope as 'shared_pool' | 'tenant_exclusive',
      tenantId,
    };
    await withControlProvisionMutationLocks({
      baseDir,
      env,
      operation: `control-capacity:${request.profile}`,
      requiresDeployConfigLock: false,
      action: async (locked) => {
        if (!locked.config) {
          throw new Error(`Control environment config is not available for ${env}`);
        }
        const keysDir = resolveDownstreamIntrospectionKeysDir({
          env,
          rootDir: baseDir,
          keysDir:
            options.keysDir ??
            (locked.config.keys.secretsPath &&
            existsSync(resolve(baseDir, locked.config.keys.secretsPath))
              ? locked.config.keys.secretsPath
              : undefined),
          keysBaseDir: process.cwd(),
        });
        const apiBaseUrl = resolveIssuerUrl(locked.config, { env });
        const capacityInput = { apiBaseUrl, keysDir, request };
        const preview = await runEphemeralSetupMachineAccess({
          env,
          config: locked.config,
          keysDir,
          databaseIdentifier: locked.adminDatabase.id,
          action: () => previewSetupControlCapacity(capacityInput),
        });
        console.log(chalk.bold('\nControl capacity plan\n'));
        console.log(`Environment: ${chalk.cyan(env)}`);
        console.log(`Scope:       ${chalk.cyan(preview.scope)}`);
        if (preview.tenantId) console.log(`Tenant:      ${chalk.cyan(preview.tenantId)}`);
        console.log(`Profile:     ${chalk.cyan(preview.profile)}`);
        console.log(`Units:       ${chalk.cyan(preview.capacityUnitsAdded)}`);
        console.log(`D1 count:    ${chalk.cyan(preview.d1DatabasesAdded)}`);
        console.log(`Projected:   ${chalk.cyan(preview.projectedEnvironmentD1Count)}`);
        for (const target of preview.targets) {
          console.log(
            `  ${target.dataRole} / ${target.residencyPartition}: ${target.databaseName} -> ${target.workerScripts.join(', ')}`
          );
        }
        if (!preview.available) {
          throw new Error(preview.reasonCode ?? 'control_capacity_unavailable');
        }
        if (options.dryRun || preview.targets.length === 0) {
          console.log(
            chalk.yellow(
              preview.targets.length === 0
                ? '\nCurrent capacity already satisfies this profile.'
                : '\nDry run only. No canonical Control operations were created.'
            )
          );
          return;
        }
        if (!options.yes) {
          const approved = await confirm({
            message: 'Create these canonical Control provisioning operations?',
            default: false,
          });
          if (!approved) {
            console.log(chalk.yellow('Cancelled.'));
            return;
          }
        }
        const response = await runEphemeralSetupMachineAccess({
          env,
          config: locked.config,
          keysDir,
          databaseIdentifier: locked.adminDatabase.id,
          action: () => requestSetupControlCapacity(capacityInput),
        });
        console.log(
          chalk.green(
            `Created ${response.result.operations.length} canonical Control operation(s). Run control-provision to execute pending operator steps.`
          )
        );
      },
    });
    return;
  }

  const pending = await listPendingControlProvisionOperations({
    controlDatabaseId: controlDatabase.id,
    operationId: options.operationId,
  });
  const selected = options.operationId
    ? pending.find((operation) => operation.operationId === options.operationId)
    : pending[0];
  if (!selected) {
    throw new Error(
      options.operationId
        ? `Pending Control operation was not found: ${options.operationId}`
        : `No pending Control operator operation exists for ${env}`
    );
  }
  if (selected.environmentId !== env) throw new Error('control_operator_environment_mismatch');

  console.log(chalk.bold('\nControl provisioning operation\n'));
  console.log(`Environment: ${chalk.cyan(selected.environmentId)}`);
  console.log(`Operation:   ${chalk.cyan(selected.operationId)}`);
  if (selected.operationKind === 'provision_plugin_resources') {
    console.log(`Tenant:      ${chalk.cyan(selected.tenantId)}`);
    console.log(`Plugin:      ${chalk.cyan(selected.pluginId)}`);
    console.log(`Step:        ${chalk.cyan(selected.currentStep)}`);
    console.log(`Resources:   ${chalk.cyan(selected.resources.length)}`);
  } else if (selected.operationKind === 'cleanup_plugin_resources') {
    console.log(`Tenant:      ${chalk.cyan(selected.tenantId)}`);
    console.log(`Plugin:      ${chalk.cyan(selected.pluginId)}`);
    console.log(`Step:        ${chalk.cyan(selected.currentStep)}`);
    console.log(`Resources:   ${chalk.cyan(selected.resources.length)}`);
    if (selected.drainNotBefore) {
      console.log(
        `Quarantine:  ${chalk.cyan(new Date(selected.drainNotBefore * 1000).toISOString())}`
      );
    }
  } else if (selected.operationKind === 'tenant_disaster_recovery') {
    console.log(`Tenant:      ${chalk.cyan(selected.tenantId)}`);
    console.log(`Step:        ${chalk.cyan(selected.currentStep)}`);
    console.log(`Bindings:    ${chalk.cyan(selected.bindingTargets.length)}`);
  } else {
    console.log(`Scope:       ${chalk.cyan(selected.scope)}`);
    if (selected.tenantId) console.log(`Tenant:      ${chalk.cyan(selected.tenantId)}`);
    console.log(`Data role:   ${chalk.cyan(selected.dataRole)}`);
    console.log(`Step:        ${chalk.cyan(selected.currentStep ?? 'unknown')}`);
    if (selected.lastErrorCode === 'control_worker_settings_request_rejected') {
      console.log(`Repair:      ${chalk.cyan('safe Worker settings request retry')}`);
    }
    console.log(`D1:          ${chalk.cyan(selected.databaseName)}`);
    console.log(`Binding:     ${chalk.cyan(selected.bindingRef)}`);
  }

  if (options.dryRun) {
    console.log(chalk.yellow('\nDry run only. The canonical Control operation was not claimed.'));
    return;
  }
  if (
    selected.operationKind !== 'provision_plugin_resources' &&
    selected.operationKind !== 'cleanup_plugin_resources' &&
    selected.currentStep !== 'create_d1' &&
    selected.currentStep !== 'apply_migrations' &&
    selected.currentStep !== 'reconcile_worker_bindings'
  ) {
    throw new Error('control_operator_step_not_supported_by_this_setup_version');
  }
  if (!options.yes) {
    const approved = await confirm({
      message: 'Run this server-owned provisioning operation with Wrangler OAuth?',
      default: false,
    });
    if (!approved) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  await withControlProvisionMutationLocks({
    baseDir,
    env,
    operation: `control-provision:${selected.operationId}`,
    requiresDeployConfigLock: true,
    action: async (locked) => {
      const currentPending = await listPendingControlProvisionOperations({
        controlDatabaseId: locked.controlDatabase.id,
        operationId: selected.operationId,
      });
      const current = currentPending.find(
        (operation) =>
          operation.operationId === selected.operationId && operation.environmentId === env
      );
      if (!current) {
        throw new Error(`Pending Control operation was not found: ${selected.operationId}`);
      }
      if (
        current.operationKind !== 'provision_plugin_resources' &&
        current.operationKind !== 'cleanup_plugin_resources' &&
        current.currentStep !== 'create_d1' &&
        current.currentStep !== 'apply_migrations' &&
        current.currentStep !== 'reconcile_worker_bindings'
      ) {
        throw new Error('control_operator_step_not_supported_by_this_setup_version');
      }

      const spinner = ora('Executing canonical Control operation...').start();
      try {
        if (
          current.operationKind === 'provision_shard' &&
          current.lastErrorCode === 'control_worker_settings_request_rejected'
        ) {
          if (!locked.config) {
            throw new Error(`Control environment config is not available for ${env}`);
          }
          const keysDir = resolveDownstreamIntrospectionKeysDir({
            env,
            rootDir: baseDir,
            keysDir:
              options.keysDir ??
              (locked.config.keys.secretsPath &&
              existsSync(resolve(baseDir, locked.config.keys.secretsPath))
                ? locked.config.keys.secretsPath
                : undefined),
            keysBaseDir: process.cwd(),
          });
          await runEphemeralSetupMachineAccess({
            env,
            config: locked.config,
            keysDir,
            databaseIdentifier: locked.adminDatabase.id,
            action: () =>
              retrySetupControlOperationStep({
                apiBaseUrl: resolveIssuerUrl(locked.config, { env }),
                keysDir,
                operationId: current.operationId,
                stepKey: 'reconcile_worker_bindings',
              }),
          });
          spinner.text = 'Safe retry recorded; executing canonical Control operation...';
        }
        const needsMigrationReleaseBucket =
          current.operationKind === 'provision_plugin_resources' ||
          current.currentStep === 'apply_migrations';
        const migrationReleaseBucket = locked.lock.r2?.MIGRATION_RELEASES;
        const verifyMigrationReleaseBucketOwnership = migrationReleaseBucket
          ? () =>
              assertR2BucketOwnershipForUse({
                ...migrationReleaseBucket,
                environment: env,
                binding: 'MIGRATION_RELEASES',
              })
          : undefined;
        if (needsMigrationReleaseBucket) {
          if (!migrationReleaseBucket) throw new Error('migration_release_bucket_required');
          await verifyMigrationReleaseBucketOwnership!();
        }
        const result =
          current.operationKind === 'provision_plugin_resources'
            ? await executeSetupPluginControlOperator({
                controlDatabaseId: locked.controlDatabase.id,
                migrationReleaseBucketName: migrationReleaseBucket!.name,
                operation: current,
                expectedAccountId: locked.config?.cloudflare?.accountId,
                verifyMigrationReleaseBucketOwnership,
              })
            : current.operationKind === 'cleanup_plugin_resources'
              ? await executeSetupPluginCleanupOperator({
                  controlDatabaseId: locked.controlDatabase.id,
                  operation: current,
                  expectedAccountId: locked.config?.cloudflare?.accountId,
                })
              : current.currentStep === 'create_d1'
                ? await executeSetupControlOperatorCreate({
                    controlDatabaseId: locked.controlDatabase.id,
                    operation: current,
                    expectedAccountId: locked.config?.cloudflare?.accountId,
                  })
                : current.currentStep === 'apply_migrations'
                  ? await executeSetupControlOperatorMigration({
                      controlDatabaseId: locked.controlDatabase.id,
                      migrationReleaseBucketName: migrationReleaseBucket!.name,
                      operation: current,
                      expectedAccountId: locked.config?.cloudflare?.accountId,
                      verifyMigrationReleaseBucketOwnership,
                    })
                  : await executeSetupControlOperatorWorkerBindings({
                      controlDatabaseId: locked.controlDatabase.id,
                      operation: current,
                      expectedAccountId: locked.config?.cloudflare?.accountId,
                      interTargetDelayMs: CONTROL_WORKER_BINDING_INTER_TARGET_DELAY_MS,
                    });
        if (
          current.operationKind === 'cleanup_plugin_resources' ||
          (current.operationKind === 'provision_plugin_resources' &&
            result.state === 'awaiting_smoke')
        ) {
          if (!locked.config) {
            throw new Error(`Control environment config is not available for ${env}`);
          }
          spinner.text = 'Synchronizing Plugin Runner deployment artifacts...';
          await refreshWorkerDeploymentArtifacts({
            baseDir,
            env,
            config: locked.config,
            lock: locked.lock,
            lockPath: locked.lockPath,
            components: ['ar-plugin-runner'],
            registeredBy: 'setup:control-provision-plugin-resources',
            onProgress: (message) => {
              spinner.text = message;
            },
          });
        }
        if (result.state === 'awaiting_migration') {
          spinner.succeed('D1 creation completed; the same operation is awaiting migration.');
          return;
        }
        if (result.state === 'awaiting_worker_bindings') {
          spinner.succeed(
            'Migration completed; the same operation is awaiting Worker binding reconciliation.'
          );
          return;
        }
        if (result.state === 'awaiting_smoke') {
          spinner.succeed('Worker bindings patched; private smoke and stabilization are running.');
          return;
        }
        if (result.state === 'awaiting_quarantine') {
          spinner.succeed('Plugin bindings removed; cleanup is waiting for the quarantine drain.');
          return;
        }
        if (result.state === 'succeeded') {
          spinner.succeed('Plugin resource cleanup completed.');
          return;
        }
        if (result.state === 'retry_required' || result.state === 'lease_unavailable') {
          spinner.warn(
            `Provisioning requires another attempt (${result.errorCode ?? result.state}).`
          );
          return;
        }
        spinner.fail(`Provisioning blocked (${result.errorCode ?? 'unknown_error'}).`);
        process.exitCode = 1;
      } catch (error) {
        spinner.fail('Control provisioning operation failed.');
        throw error;
      }
    },
  });
}
