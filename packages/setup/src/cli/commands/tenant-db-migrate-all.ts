import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { findMigrationsRoot, runD1Migrations } from '../../core/cloudflare.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  saveLockFile,
} from '../../core/lock.js';
import { findAuthrimBaseDir } from '../../core/paths.js';
import { getRootProductVersion } from '../../core/version.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../../core/release-deployment-guard.js';
import {
  buildTenantD1ReleaseMigrationTarget,
  calculateReleaseManifestChecksum,
  loadInstalledReleaseMigrationManifest,
  type ReleaseMigrationManifest,
} from '../../core/release-migrations.js';
import { withRecordedReleaseSchemaTargets } from '../../core/release-state.js';
import {
  buildTenantDatabaseMigrationPlan,
  listTenantDatabaseMigrationTargets,
  type TenantDatabaseMigrationTarget,
  type TenantDatabaseRole,
} from '../../core/tenant-database.js';

interface TenantDatabaseMigrateAllOptions {
  env?: string;
  role?: string;
  binding?: string;
  concurrency?: string;
  canaryBinding?: string;
  canaryCount?: string;
  dryRun?: boolean;
  skipFailed?: boolean;
  yes?: boolean;
}

interface MigrationTargetResult {
  target: TenantDatabaseMigrationTarget;
  success: boolean;
  appliedCount: number;
  skippedCount: number;
  error?: string;
}

function parseCsv(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function parseRoles(value: string | undefined): TenantDatabaseRole[] | undefined {
  const roles = parseCsv(value);
  if (roles.length === 0) {
    return undefined;
  }

  const allowed = new Set<TenantDatabaseRole>(['tenant_core', 'tenant_pii']);
  const parsed = roles.map((role) => {
    if (!allowed.has(role as TenantDatabaseRole)) {
      throw new Error(`Unsupported tenant DB migration role: ${role}`);
    }
    return role as TenantDatabaseRole;
  });
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function migrationDirectoryForTarget(
  migrationsRoot: string,
  target: TenantDatabaseMigrationTarget
) {
  return target.role === 'tenant_pii' ? join(migrationsRoot, 'pii') : migrationsRoot;
}

async function migrateTargets(
  targets: TenantDatabaseMigrationTarget[],
  options: {
    migrationsRoot: string;
    concurrency: number;
    skipFailed: boolean;
    manifest: ReleaseMigrationManifest;
    productVersion: string;
  }
): Promise<MigrationTargetResult[]> {
  const results: MigrationTargetResult[] = [];
  const failures: string[] = [];

  await runWithConcurrency(targets, options.concurrency, async (target) => {
    const streamId = target.role === 'tenant_pii' ? 'd1-pii' : 'd1-core';
    const stream = options.manifest.streams.find((candidate) => candidate.id === streamId);
    if (!stream) throw new Error(`release_migration_stream_not_found:${streamId}`);
    const result = await runD1Migrations(
      target.databaseName,
      migrationDirectoryForTarget(options.migrationsRoot, target),
      undefined,
      {
        manifestFiles: stream.files,
        releaseVersion: options.productVersion,
        backfillLegacyChecksums: true,
      }
    );
    const targetResult: MigrationTargetResult = {
      target,
      success: result.success,
      appliedCount: result.appliedCount,
      skippedCount: result.skippedCount,
      error: result.error,
    };
    results.push(targetResult);
    if (!result.success) {
      failures.push(`${target.binding}: ${result.error ?? 'unknown error'}`);
      if (!options.skipFailed) {
        throw new Error(failures[failures.length - 1]);
      }
    }
  });

  return results.sort((a, b) => a.target.binding.localeCompare(b.target.binding));
}

function printResults(results: MigrationTargetResult[]) {
  for (const result of results) {
    const status = result.success ? chalk.green('ok') : chalk.red('failed');
    console.log(
      `${status} ${result.target.binding} (${result.target.databaseName}) applied=${result.appliedCount} skipped=${result.skippedCount}`
    );
    if (result.error) {
      console.log(chalk.red(`  ${result.error}`));
    }
  }
}

export async function tenantDatabaseMigrateAllCommand(
  options: TenantDatabaseMigrateAllOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);
  if (!lock) {
    console.error(chalk.red(`No Authrim lock file found for environment "${env}".`));
    process.exit(1);
  }
  const targetProductVersion = await getRootProductVersion(baseDir);
  const deploymentGuard = evaluateReleaseDeploymentGuard(
    lock,
    targetProductVersion,
    'manual_migration'
  );
  if (!deploymentGuard.allowed) {
    console.error(chalk.red(releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion)));
    console.log(chalk.yellow(`Run authrim-setup update --env ${env} for release migrations.`));
    process.exit(1);
  }

  const migrationsRoot = await findMigrationsRoot(baseDir);
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

  const targets = listTenantDatabaseMigrationTargets(lock, {
    roles: parseRoles(options.role),
    bindings: parseCsv(options.binding),
  });
  const plan = buildTenantDatabaseMigrationPlan(targets, {
    concurrency: parsePositiveInteger(options.concurrency, 2),
    canaryBindings: parseCsv(options.canaryBinding),
    canaryCount: parsePositiveInteger(options.canaryCount, 0),
  });

  console.log(chalk.bold('\nTenant D1 migration plan\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Targets:     ${chalk.cyan(String(targets.length))}`);
  console.log(`Concurrency: ${chalk.cyan(String(plan.concurrency))}`);
  console.log(`Canaries:    ${chalk.cyan(String(plan.canaryTargets.length))}`);

  if (targets.length === 0) {
    console.log(chalk.yellow('No tenant D1 bindings matched the requested filters.'));
    return;
  }

  if (options.dryRun) {
    for (const target of [...plan.canaryTargets, ...plan.remainingTargets]) {
      console.log(`${target.binding} -> ${target.databaseName} (${target.role})`);
    }
    console.log(chalk.yellow('\nDry run only. No migrations were executed.'));
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message: `Run tenant D1 migrations for ${targets.length} database(s)?`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const operationLock = await acquireEnvironmentOperationLock(lockPath, 'tenant-db-migrate-all');

  const spinner = ora('Running tenant D1 migrations...').start();
  const allResults: MigrationTargetResult[] = [];
  try {
    const lockedEnvironment = await loadLockFileAuto(baseDir, env);
    if (
      !lockedEnvironment.lock ||
      JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(lock)
    ) {
      throw new Error('environment_changed_while_waiting_for_tenant_migration_lock');
    }
    const lockedRelease = loadInstalledReleaseMigrationManifest({
      migrationsRoot: migrationsRoot.path,
      productVersion: targetProductVersion,
      lock: lockedEnvironment.lock,
    });
    if (
      calculateReleaseManifestChecksum(lockedRelease.manifest) !==
      calculateReleaseManifestChecksum(release.manifest)
    ) {
      throw new Error('release_manifest_changed_while_waiting_for_tenant_migration_lock');
    }
    if (plan.canaryTargets.length > 0) {
      spinner.text = 'Running tenant D1 canary migrations...';
      const canaryResults = await migrateTargets(plan.canaryTargets, {
        migrationsRoot: migrationsRoot.path,
        concurrency: 1,
        skipFailed: options.skipFailed ?? false,
        manifest: lockedRelease.manifest,
        productVersion: targetProductVersion,
      });
      allResults.push(...canaryResults);
      if (canaryResults.some((result) => !result.success) && !options.skipFailed) {
        throw new Error('Canary migration failed');
      }
    }

    spinner.text = 'Running tenant D1 broad migrations...';
    allResults.push(
      ...(await migrateTargets(plan.remainingTargets, {
        migrationsRoot: migrationsRoot.path,
        concurrency: plan.concurrency,
        skipFailed: options.skipFailed ?? false,
        manifest: lockedRelease.manifest,
        productVersion: targetProductVersion,
      }))
    );
    const successfulTargets = allResults
      .filter((result) => result.success)
      .map((result) => result.target);
    const recordedLock = withRecordedReleaseSchemaTargets(lock, {
      productVersion: targetProductVersion,
      manifest: lockedRelease.manifest,
      targets: successfulTargets.map((target) => buildTenantD1ReleaseMigrationTarget(target)),
    });
    await saveLockFile(recordedLock, { path: lockPath });
    spinner.succeed('Tenant D1 migrations completed and schema target state recorded.');
  } catch (error) {
    spinner.fail('Tenant D1 migrations failed.');
    printResults(allResults);
    throw error;
  } finally {
    await operationLock.release();
  }

  printResults(allResults);
}
