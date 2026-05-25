import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { findMigrationsRoot, runD1Migrations } from '../../core/cloudflare.js';
import { loadLockFileAuto } from '../../core/lock.js';
import { findAuthrimBaseDir } from '../../core/paths.js';
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
  }
): Promise<MigrationTargetResult[]> {
  const results: MigrationTargetResult[] = [];
  const failures: string[] = [];

  await runWithConcurrency(targets, options.concurrency, async (target) => {
    const result = await runD1Migrations(
      target.databaseName,
      migrationDirectoryForTarget(options.migrationsRoot, target)
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
  const { lock } = await loadLockFileAuto(baseDir, env);
  if (!lock) {
    console.error(chalk.red(`No Authrim lock file found for environment "${env}".`));
    process.exit(1);
  }

  const migrationsRoot = await findMigrationsRoot(baseDir);
  if (!migrationsRoot.path) {
    throw new Error(
      `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
    );
  }

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

  const spinner = ora('Running tenant D1 migrations...').start();
  const allResults: MigrationTargetResult[] = [];
  try {
    if (plan.canaryTargets.length > 0) {
      spinner.text = 'Running tenant D1 canary migrations...';
      const canaryResults = await migrateTargets(plan.canaryTargets, {
        migrationsRoot: migrationsRoot.path,
        concurrency: 1,
        skipFailed: options.skipFailed ?? false,
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
      }))
    );
    spinner.succeed('Tenant D1 migrations completed.');
  } catch (error) {
    spinner.fail('Tenant D1 migrations failed.');
    printResults(allResults);
    throw error;
  }

  printResults(allResults);
}
