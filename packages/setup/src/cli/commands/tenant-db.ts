import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  createD1Database,
  executeD1Migration,
  findMigrationsRoot,
  listD1Databases,
  runD1Migrations,
  validateD1MigrationVersion,
} from '../../core/cloudflare.js';
import { AuthrimConfigSchema } from '../../core/config.js';
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
import {
  buildTenantD1ReleaseMigrationTarget,
  loadInstalledReleaseMigrationManifest,
} from '../../core/release-migrations.js';
import { withRecordedReleaseSchemaTargets } from '../../core/release-state.js';
import { assertPendingTopologyUpdate, prepareTopologyUpdate } from '../../core/topology-update.js';
import {
  buildTenantDatabaseProvisioningPlan,
  buildTenantDatabaseAdminJobSql,
  buildTenantDatabaseRegistrySql,
  evaluateTenantDatabaseBindingCapacity,
  getLatestMigrationVersionFromFilenames,
  isTenantDatabaseBinding,
  loadTenantDatabaseRegistrySignatureConfigFromEnv,
  reconcileTenantDatabaseDerivedBindings,
  signTenantDatabaseRegistryResources,
} from '../../core/tenant-database.js';

interface TenantDatabaseCommandOptions {
  env?: string;
  tenantId?: string;
  tenantSlug?: string;
  generation?: string;
  activate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

async function executeTenantDatabaseAdminSql(input: {
  adminDbName: string;
  tenantId: string;
  sql: string;
}): Promise<void> {
  const sqlPath = join(
    tmpdir(),
    `authrim-tenant-db-${input.tenantId.replace(/[^A-Za-z0-9_-]+/g, '-')}-${Date.now()}.sql`
  );
  await writeFile(sqlPath, input.sql, 'utf-8');
  try {
    const result = await executeD1Migration(input.adminDbName, sqlPath);
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to write tenant database registry rows');
    }
  } finally {
    await unlink(sqlPath).catch(() => {});
  }
}

export async function tenantDatabaseCommand(options: TenantDatabaseCommandOptions): Promise<void> {
  const env = options.env ?? 'prod';
  const tenantId = options.tenantId?.trim();
  if (!tenantId) {
    console.error(chalk.red('Missing required option: --tenant-id'));
    process.exit(1);
  }
  const generation = options.generation ? Number.parseInt(options.generation, 10) : 1;
  if (!Number.isInteger(generation) || generation < 1) {
    console.error(chalk.red('--generation must be a positive integer'));
    process.exit(1);
  }

  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });
  const plannedConfigText = existsSync(envPaths.config)
    ? await readFile(envPaths.config, 'utf-8')
    : null;
  const config = plannedConfigText
    ? AuthrimConfigSchema.parse(JSON.parse(plannedConfigText))
    : null;
  if (config) {
    if (config.profiles?.defaults?.storage === 'builtin:storage:tenant-d1') {
      console.error(
        chalk.red(
          'This environment uses Control Plane-managed Tenant D1. The legacy tenant-db command is not supported here.'
        )
      );
      console.log(
        chalk.gray(
          'Create tenants in Admin UI; shard provisioning and capacity expansion are automatic.'
        )
      );
      process.exit(1);
    }
  }
  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);
  if (!lock) {
    console.error(chalk.red(`No Authrim lock file found for environment "${env}".`));
    console.log(chalk.yellow('Run authrim-setup init/deploy first.'));
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
    console.log(chalk.yellow(`Run authrim-setup update --env ${env} before creating tenant D1.`));
    process.exit(1);
  }
  if (!config) throw new Error(`Config file not found: ${envPaths.config}`);
  if (lock.topologyUpdate) {
    assertPendingTopologyUpdate(lock, {
      kind: 'tenant_database',
      subject: `${tenantId}:${generation}`,
      targetProductVersion,
      config,
    });
    if (lock.topologyUpdate.phase === 'pending_deploy') {
      console.log(chalk.yellow('Resuming the pending tenant database Worker binding deployment.'));
      if (options.dryRun) return;
      const { deployCommand } = await import('./deploy.js');
      await deployCommand({
        env,
        config: envPaths.config,
        source: baseDir,
        yes: options.yes === true,
        operationKind: 'topology_change',
      });
      return;
    }
    console.log(chalk.yellow('Resuming interrupted tenant database preparation.'));
  }

  const plan = buildTenantDatabaseProvisioningPlan({
    env,
    tenantId,
    tenantSlug: options.tenantSlug,
    generation,
  });

  console.log(chalk.bold('\nTenant D1 provisioning plan\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Tenant ID:   ${chalk.cyan(tenantId)}`);
  for (const resource of plan.resources) {
    console.log(
      `  ${resource.role}: ${chalk.cyan(resource.databaseName)} -> ${chalk.cyan(resource.binding)}`
    );
  }
  const capacity = evaluateTenantDatabaseBindingCapacity({
    currentBindings: Object.keys(lock.d1).filter(isTenantDatabaseBinding).length,
    addedBindings: plan.resources.filter((resource) => !lock.d1[resource.binding]).length,
  });
  if (capacity.state !== 'ok') {
    console.log(
      chalk.yellow(
        `\nTenant D1 binding count warning: ${capacity.projectedBindings}/${capacity.hardLimit} projected bindings.`
      )
    );
  }

  if (options.dryRun) {
    console.log(chalk.yellow('\nDry run only. No D1 databases or lock entries were created.'));
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message: 'Create tenant core/PII D1 databases and update the lock file?',
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const operationLock = await acquireEnvironmentOperationLock(lockPath, 'tenant-db-provision');
  try {
    const lockedEnvironment = await loadLockFileAuto(baseDir, env);
    const lockedConfigText = existsSync(envPaths.config)
      ? await readFile(envPaths.config, 'utf-8')
      : null;
    if (
      !lockedEnvironment.lock ||
      JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(lock) ||
      lockedConfigText !== plannedConfigText
    ) {
      throw new Error('environment_changed_while_waiting_for_tenant_db_lock');
    }
    const preparing = prepareTopologyUpdate(lock, {
      kind: 'tenant_database',
      phase: 'preparing',
      subject: `${tenantId}:${generation}`,
      targetProductVersion,
      config,
    });
    Object.assign(lock, preparing.lock);
    await saveLockFile(lock, { path: lockPath });

    const spinner = ora('Creating tenant D1 databases...').start();
    const created: Array<(typeof plan.resources)[number] & { databaseId: string }> = [];
    try {
      for (const resource of plan.resources) {
        const recordedDatabase = lock.d1[resource.binding];
        if (recordedDatabase && recordedDatabase.name !== resource.databaseName) {
          throw new Error(
            `tenant_database_binding_conflict:${resource.binding}:${recordedDatabase.name}`
          );
        }
        const database = recordedDatabase ?? (await createD1Database(resource.databaseName));
        lock.d1[resource.binding] = {
          id: database.id,
          name: database.name,
        };
        created.push({
          ...resource,
          databaseId: database.id,
        });
        await saveLockFile(lock, { path: lockPath });
      }
      spinner.succeed('Tenant D1 databases created and lock file updated.');
    } catch (error) {
      spinner.fail('Failed to create tenant D1 databases.');
      throw error;
    }

    const reconciliationSpinner = ora('Reconciling generated tenant D1 bindings...').start();
    try {
      const cloudflareD1Databases = await listD1Databases();
      const reconciliation = reconcileTenantDatabaseDerivedBindings({
        lock,
        cloudflareD1Databases,
        expectedBindings: created.map((resource) => resource.binding),
      });
      if (reconciliation.status === 'drift_detected') {
        reconciliationSpinner.warn(
          `Tenant D1 reconciliation found ${reconciliation.issues.length} generated binding issue(s).`
        );
        for (const issue of reconciliation.issues) {
          console.log(chalk.yellow(`  ${issue.type}: ${issue.binding}`));
        }
      } else {
        reconciliationSpinner.succeed('Generated tenant D1 bindings reconciled.');
      }
    } catch (error) {
      reconciliationSpinner.warn(
        `Tenant D1 reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const migrationSpinner = ora('Running tenant D1 migrations...').start();
    let coreSchemaVersion = 1;
    let piiSchemaVersion = 1;
    let provisionedRegistryResources: Array<
      (typeof created)[number] & {
        schemaVersion: number;
      }
    > = [];
    try {
      const migrationsRoot = await findMigrationsRoot(baseDir, (message) => {
        migrationSpinner.text = message;
      });
      if (!migrationsRoot.path) {
        throw new Error(
          `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
        );
      }
      const release = loadInstalledReleaseMigrationManifest({
        migrationsRoot: migrationsRoot.path,
        productVersion: targetProductVersion,
        lock,
      });
      const coreStream = release.manifest.streams.find((stream) => stream.id === 'd1-core');
      const piiStream = release.manifest.streams.find((stream) => stream.id === 'd1-pii');
      if (!coreStream || !piiStream) {
        throw new Error('Tenant D1 release migration streams are incomplete.');
      }

      const coreResource = created.find((resource) => resource.role === 'tenant_core');
      const piiResource = created.find((resource) => resource.role === 'tenant_pii');
      if (!coreResource || !piiResource) {
        throw new Error('Tenant database provisioning plan is missing core or PII resources');
      }

      const coreResult = await runD1Migrations(
        coreResource.databaseName,
        migrationsRoot.path,
        (message) => {
          migrationSpinner.text = message;
        },
        {
          manifestFiles: coreStream.files,
          releaseVersion: targetProductVersion,
          backfillLegacyChecksums: true,
        }
      );
      if (!coreResult.success) {
        throw new Error(`Core tenant D1 migration failed: ${coreResult.error}`);
      }

      const piiResult = await runD1Migrations(
        piiResource.databaseName,
        join(migrationsRoot.path, 'pii'),
        (message) => {
          migrationSpinner.text = message;
        },
        {
          manifestFiles: piiStream.files,
          releaseVersion: targetProductVersion,
          backfillLegacyChecksums: true,
        }
      );
      if (!piiResult.success) {
        throw new Error(`PII tenant D1 migration failed: ${piiResult.error}`);
      }
      coreSchemaVersion = getLatestMigrationVersionFromFilenames(
        coreStream.files.map((file) => file.path)
      );
      piiSchemaVersion = getLatestMigrationVersionFromFilenames(
        piiStream.files.map((file) => file.path)
      );
      provisionedRegistryResources = created.map((resource) => ({
        ...resource,
        schemaVersion: resource.role === 'tenant_core' ? coreSchemaVersion : piiSchemaVersion,
      }));

      if (options.activate) {
        migrationSpinner.text = 'Validating tenant D1 activation checks...';
        for (const resource of provisionedRegistryResources) {
          const validation = await validateD1MigrationVersion(
            resource.databaseName,
            resource.schemaVersion
          );
          if (!validation.success) {
            throw new Error(
              validation.error ?? `Tenant D1 health check failed for ${resource.binding}`
            );
          }
        }
      }

      migrationSpinner.succeed(
        `Tenant D1 migrations completed - core: ${coreResult.appliedCount} applied, PII: ${piiResult.appliedCount} applied.`
      );
      const recordedLock = withRecordedReleaseSchemaTargets(lock, {
        productVersion: targetProductVersion,
        manifest: release.manifest,
        targets: created.map((resource) =>
          buildTenantD1ReleaseMigrationTarget({
            binding: resource.binding,
            databaseId: resource.databaseId,
            databaseName: resource.databaseName,
            role: resource.role,
          })
        ),
      });
      await saveLockFile(recordedLock, { path: lockPath });
    } catch (error) {
      migrationSpinner.fail('Failed to run tenant D1 migrations.');
      const adminDbName = lock.d1.DB_ADMIN?.name;
      if (adminDbName && created.length > 0) {
        const failedResources = signTenantDatabaseRegistryResources({
          tenantId,
          signatureConfig: loadTenantDatabaseRegistrySignatureConfigFromEnv(),
          resources: created.map((resource) => ({
            ...resource,
            schemaVersion: resource.role === 'tenant_core' ? coreSchemaVersion : piiSchemaVersion,
            status: 'failed',
          })),
        });
        const failedRegistrySql = buildTenantDatabaseRegistrySql({
          tenantId,
          tenantSlug: options.tenantSlug,
          resources: failedResources,
          activate: false,
        });
        const failedJobSql = buildTenantDatabaseAdminJobSql({
          jobId: `tenant-db-provision:${tenantId}:${plan.generation}`,
          tenantId,
          jobType: 'tenant-database/provision',
          status: 'failed',
          createdBy: 'setup',
          progress: {
            total: plan.resources.length,
            processed: created.length,
            succeeded: 0,
            failed: created.length,
            stage: 'failed',
          },
          config: {
            env,
            tenant_slug: options.tenantSlug ?? null,
            generation: plan.generation,
            activate: options.activate ?? false,
          },
          result: {
            resources: created.map((resource) => ({
              role: resource.role,
              database_name: resource.databaseName,
              binding: resource.binding,
              database_id: resource.databaseId,
            })),
          },
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        try {
          await executeTenantDatabaseAdminSql({
            adminDbName,
            tenantId,
            sql: `${failedRegistrySql}\n\n${failedJobSql}`,
          });
          console.log(chalk.yellow('Failed tenant database generation was recorded in DB_ADMIN.'));
        } catch (recordError) {
          console.log(
            chalk.yellow(
              `Failed to record failed tenant database generation: ${
                recordError instanceof Error ? recordError.message : String(recordError)
              }`
            )
          );
        }
      }
      throw error;
    }

    const adminDbName = lock.d1.DB_ADMIN?.name;
    if (!adminDbName) {
      throw new Error('DB_ADMIN is missing from the lock file; registry rows cannot be written.');
    }

    const registryResources = signTenantDatabaseRegistryResources({
      tenantId,
      signatureConfig: loadTenantDatabaseRegistrySignatureConfigFromEnv(),
      resources: provisionedRegistryResources,
    });
    const registrySql = buildTenantDatabaseRegistrySql({
      tenantId,
      tenantSlug: options.tenantSlug,
      resources: registryResources,
      activate: options.activate ?? false,
    });
    const jobSql = buildTenantDatabaseAdminJobSql({
      jobId: `tenant-db-provision:${tenantId}:${plan.generation}`,
      tenantId,
      jobType: 'tenant-database/provision',
      status: 'completed',
      createdBy: 'setup',
      progress: {
        total: created.length,
        processed: created.length,
        succeeded: created.length,
        failed: 0,
        stage: options.activate ? 'activated' : 'ready',
      },
      config: {
        env,
        tenant_slug: options.tenantSlug ?? null,
        generation: plan.generation,
        activate: options.activate ?? false,
      },
      result: {
        resources: created.map((resource) => ({
          role: resource.role,
          database_name: resource.databaseName,
          binding: resource.binding,
          database_id: resource.databaseId,
          schema_version: resource.role === 'tenant_core' ? coreSchemaVersion : piiSchemaVersion,
        })),
      },
    });
    const postActivationHealthJobSql = options.activate
      ? buildTenantDatabaseAdminJobSql({
          jobId: `tenant-db-health:${tenantId}:${plan.generation}`,
          tenantId,
          jobType: 'tenant-database/health-check',
          status: 'pending',
          createdBy: 'setup',
          progress: {
            total: created.length,
            processed: 0,
            succeeded: 0,
            failed: 0,
            stage: 'requested',
          },
          config: {
            reason: 'post_activation',
            generation: plan.generation,
            roles: ['tenant_core', 'tenant_pii'],
          },
        })
      : null;
    await executeTenantDatabaseAdminSql({
      adminDbName,
      tenantId,
      sql: [registrySql, jobSql, postActivationHealthJobSql].filter(Boolean).join('\n\n'),
    });
    console.log(chalk.green('Tenant database registry rows written to DB_ADMIN.'));

    const latestEnvironment = await loadLockFileAuto(baseDir, env);
    if (!latestEnvironment.lock) throw new Error('tenant_database_lock_disappeared');
    const prepared = prepareTopologyUpdate(latestEnvironment.lock, {
      kind: 'tenant_database',
      phase: 'pending_deploy',
      subject: `${tenantId}:${generation}`,
      targetProductVersion,
      config,
    });
    await saveLockFile(prepared.lock, { path: lockPath });
  } finally {
    await operationLock.release();
  }

  const { deployCommand } = await import('./deploy.js');
  await deployCommand({
    env,
    config: envPaths.config,
    source: baseDir,
    yes: true,
    operationKind: 'topology_change',
  });
}
