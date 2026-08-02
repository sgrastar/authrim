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
import { loadLockFileAuto } from '../../core/lock.js';
import {
  cleanupSetupMachineAccessInD1,
  ensureSetupMachineAccessInD1,
} from '../../core/cloudflare.js';
import { withEphemeralSetupMachineAccess } from '../../core/setup-machine-access-lifecycle.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { resolveDownstreamIntrospectionKeysDir } from '../../core/downstream-introspection-deploy.js';
import { resolveIssuerUrl } from '../../core/url-config.js';
import { refreshWorkerDeploymentArtifacts } from '../../core/worker-deployment-artifacts.js';

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

export async function controlProvisionCommand(
  options: ControlProvisionCommandOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const { lock } = await loadLockFileAuto(baseDir, env);
  const controlDatabase = lock?.d1.CONTROL_DB;
  if (!controlDatabase) throw new Error(`Control database is not configured for ${env}`);

  const paths = getEnvironmentPaths({ baseDir, env });
  const config = existsSync(paths.config)
    ? AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf-8')))
    : null;

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
    const keysDir = resolveDownstreamIntrospectionKeysDir({
      env,
      rootDir: baseDir,
      keysDir:
        options.keysDir ??
        (config.keys.secretsPath && existsSync(resolve(baseDir, config.keys.secretsPath))
          ? config.keys.secretsPath
          : undefined),
      keysBaseDir: process.cwd(),
    });
    const request = {
      profile: options.capacityProfile as 'minimum' | 'recommended' | 'extra_headroom',
      scope: scope as 'shared_pool' | 'tenant_exclusive',
      tenantId,
    };
    const apiBaseUrl = resolveIssuerUrl(config, { env });
    const preview = await withEphemeralSetupMachineAccess({
      baseDir,
      env,
      config,
      keysDir,
      action: () => previewSetupControlCapacity({ apiBaseUrl, keysDir, request }),
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
    if (!preview.available) throw new Error(preview.reasonCode ?? 'control_capacity_unavailable');
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
    const response = await withEphemeralSetupMachineAccess({
      baseDir,
      env,
      config,
      keysDir,
      action: () => requestSetupControlCapacity({ apiBaseUrl, keysDir, request }),
    });
    console.log(
      chalk.green(
        `Created ${response.result.operations.length} canonical Control operation(s). Run control-provision to execute pending operator steps.`
      )
    );
    return;
  }

  const [shardPending, pluginPending, pluginCleanupPending, tenantDrPending] = await Promise.all([
    listPendingControlOperatorOperations({
      controlDatabaseName: controlDatabase.id,
      operationId: options.operationId,
    }),
    listPendingPluginControlOperatorOperations({
      controlDatabaseName: controlDatabase.id,
      operationId: options.operationId,
    }),
    listPendingPluginControlCleanupOperations({
      controlDatabaseName: controlDatabase.id,
      operationId: options.operationId,
    }),
    listPendingTenantDisasterRecoveryOperatorOperations({
      controlDatabaseName: controlDatabase.id,
      operationId: options.operationId,
    }),
  ]);
  const pending = [
    ...shardPending,
    ...pluginPending,
    ...pluginCleanupPending,
    ...tenantDrPending,
  ].sort(
    (left, right) =>
      left.updatedAt - right.updatedAt || left.operationId.localeCompare(right.operationId)
  );
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

  const spinner = ora('Executing canonical Control operation...').start();
  try {
    if (
      selected.operationKind === 'provision_shard' &&
      selected.lastErrorCode === 'control_worker_settings_request_rejected'
    ) {
      if (!config) throw new Error(`Control environment config is not available for ${env}`);
      const keysDir = resolveDownstreamIntrospectionKeysDir({
        env,
        rootDir: baseDir,
        keysDir:
          options.keysDir ??
          (config.keys.secretsPath && existsSync(resolve(baseDir, config.keys.secretsPath))
            ? config.keys.secretsPath
            : undefined),
        keysBaseDir: process.cwd(),
      });
      const bootstrap = await ensureSetupMachineAccessInD1(env, config, keysDir);
      if (!bootstrap.success) {
        throw new Error(`control_setup_machine_bootstrap_failed:${bootstrap.error ?? 'unknown'}`);
      }
      let retryError: unknown;
      try {
        await retrySetupControlOperationStep({
          apiBaseUrl: resolveIssuerUrl(config, { env }),
          keysDir,
          operationId: selected.operationId,
          stepKey: 'reconcile_worker_bindings',
        });
      } catch (caught) {
        retryError = caught;
      }
      const cleanup = await cleanupSetupMachineAccessInD1(env, keysDir);
      if (!cleanup.success) {
        const cleanupError = new Error(
          `control_setup_machine_cleanup_failed:${cleanup.error ?? 'unknown'}`
        );
        if (retryError) {
          throw new AggregateError([retryError, cleanupError], 'control_operation_retry_failed');
        }
        throw cleanupError;
      }
      if (retryError) {
        if (retryError instanceof Error) throw retryError;
        throw new Error('control_operation_retry_failed', { cause: retryError });
      }
      spinner.text = 'Safe retry recorded; executing canonical Control operation...';
    }
    const result =
      selected.operationKind === 'provision_plugin_resources'
        ? await executeSetupPluginControlOperator({
            controlDatabaseId: controlDatabase.id,
            migrationReleaseBucketName:
              lock.r2?.MIGRATION_RELEASES?.name ?? `${env}-migration-releases`,
            operation: selected,
            expectedAccountId: config?.cloudflare?.accountId,
          })
        : selected.operationKind === 'cleanup_plugin_resources'
          ? await executeSetupPluginCleanupOperator({
              controlDatabaseId: controlDatabase.id,
              operation: selected,
              expectedAccountId: config?.cloudflare?.accountId,
            })
          : selected.currentStep === 'create_d1'
            ? await executeSetupControlOperatorCreate({
                controlDatabaseId: controlDatabase.id,
                operation: selected,
                expectedAccountId: config?.cloudflare?.accountId,
              })
            : selected.currentStep === 'apply_migrations'
              ? await executeSetupControlOperatorMigration({
                  controlDatabaseId: controlDatabase.id,
                  migrationReleaseBucketName:
                    lock.r2?.MIGRATION_RELEASES?.name ?? `${env}-migration-releases`,
                  operation: selected,
                  expectedAccountId: config?.cloudflare?.accountId,
                })
              : await executeSetupControlOperatorWorkerBindings({
                  controlDatabaseId: controlDatabase.id,
                  operation: selected,
                  expectedAccountId: config?.cloudflare?.accountId,
                  interTargetDelayMs: 15_000,
                });
    if (
      selected.operationKind === 'cleanup_plugin_resources' ||
      (selected.operationKind === 'provision_plugin_resources' && result.state === 'awaiting_smoke')
    ) {
      if (!config || !lock) {
        throw new Error(`Control environment config is not available for ${env}`);
      }
      spinner.text = 'Synchronizing Plugin Runner deployment artifacts...';
      await refreshWorkerDeploymentArtifacts({
        baseDir,
        env,
        config,
        lock,
        lockPath: paths.lock,
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
      spinner.warn(`Provisioning requires another attempt (${result.errorCode ?? result.state}).`);
      return;
    }
    spinner.fail(`Provisioning blocked (${result.errorCode ?? 'unknown_error'}).`);
    process.exitCode = 1;
  } catch (error) {
    spinner.fail('Control provisioning operation failed.');
    throw error;
  }
}
