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
import { loadLockFileAuto, saveLockFile } from '../../core/lock.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import {
  buildTenantDatabaseProvisioningPlan,
  buildTenantDatabaseAdminJobSql,
  buildTenantDatabaseRegistrySql,
  evaluateTenantDatabaseBindingCapacity,
  getLatestMigrationVersionFromDirectory,
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
  if (existsSync(envPaths.config)) {
    const config = AuthrimConfigSchema.parse(JSON.parse(await readFile(envPaths.config, 'utf-8')));
    if (config.profiles?.defaults?.storage === 'builtin:storage:tenant-d1') {
      console.error(
        chalk.red(
          'This environment uses the slot-based Tenant D1 pool. tenant-db creates legacy tenant-id D1 databases and is not supported here.'
        )
      );
      console.log(
        chalk.gray(
          'Use Admin UI while preallocated slots are available, or tenant-db-pool-expand to add capacity.'
        )
      );
      console.log(
        chalk.gray(
          'Automatic migration from legacy tenant-id D1 databases to slot-based D1 pool is intentionally out of scope.'
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
    addedBindings: plan.resources.length,
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

  const spinner = ora('Creating tenant D1 databases...').start();
  const created: Array<(typeof plan.resources)[number] & { databaseId: string }> = [];
  try {
    for (const resource of plan.resources) {
      const database = await createD1Database(resource.databaseName);
      lock.d1[resource.binding] = {
        id: database.id,
        name: database.name,
      };
      created.push({
        ...resource,
        databaseId: database.id,
      });
    }
    await saveLockFile(lock, { path: lockPath });
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
      }
    );
    if (!piiResult.success) {
      throw new Error(`PII tenant D1 migration failed: ${piiResult.error}`);
    }
    coreSchemaVersion = getLatestMigrationVersionFromDirectory(migrationsRoot.path);
    piiSchemaVersion = getLatestMigrationVersionFromDirectory(join(migrationsRoot.path, 'pii'));
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
    console.log(
      chalk.yellow('DB_ADMIN is missing from the lock file; registry rows were not written.')
    );
    return;
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
}
