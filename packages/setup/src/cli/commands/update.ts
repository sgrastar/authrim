/**
 * Update Command
 *
 * Updates workers for an existing environment without full init.
 * Compares local package versions with deployed versions and updates only changed workers.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { loadLockFileAuto, saveLockFile, type AuthrimLock } from '../../core/lock.js';
import {
  deployAll,
  buildApiPackages,
  type DeployOptions,
  type DeployResult,
} from '../../core/deploy.js';
import { isWranglerInstalled, checkAuth, getWorkersSubdomain } from '../../core/cloudflare.js';
import { CORE_WORKER_COMPONENTS, type WorkerComponent } from '../../core/naming.js';
import {
  getLocalPackageVersions,
  compareVersions,
  getComponentsToUpdate,
  type VersionComparison,
} from '../../core/version.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { syncWranglerConfigs } from '../../core/wrangler-sync.js';
import { generateWranglerConfig, toToml, type ResourceIds } from '../../core/wrangler.js';
import { AuthrimConfigSchema } from '../../core/config.js';
import { readFile } from 'node:fs/promises';

// =============================================================================
// Types
// =============================================================================

export interface UpdateCommandOptions {
  env?: string;
  all?: boolean;
  dryRun?: boolean;
  skipBuild?: boolean;
  yes?: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Display version comparison table
 */
function displayVersionTable(comparisons: VersionComparison[]): void {
  console.log(chalk.bold('\nVersion Comparison:'));
  console.log('─'.repeat(70));
  console.log(
    chalk.gray(`${'Worker'.padEnd(18)} ${'Deployed'.padEnd(14)} ${'Local'.padEnd(14)} Status`)
  );
  console.log('─'.repeat(70));

  for (const c of comparisons) {
    let status: string;
    if (c.needsUpdate) {
      if (!c.deployedVersion) {
        status = chalk.red('● not deployed');
      } else {
        status = chalk.yellow('⬆ update');
      }
    } else {
      status = chalk.green('✓ current');
    }

    // Pad with actual string lengths (accounting for chalk)
    const deployedPadded = c.deployedVersion
      ? c.deployedVersion.padEnd(14)
      : chalk.gray('-').padStart(1) + ' '.repeat(13);
    const localPadded = c.localVersion
      ? c.localVersion.padEnd(14)
      : chalk.gray('-').padStart(1) + ' '.repeat(13);

    console.log(`  ${c.component.padEnd(16)} ${deployedPadded} ${localPadded} ${status}`);
  }

  console.log('─'.repeat(70));
}

/**
 * Update lock file with deployment results AND version info
 */
function updateLockWithDeploymentsAndVersions(
  lock: AuthrimLock,
  results: DeployResult[],
  localVersions: Partial<Record<WorkerComponent, string>>
): AuthrimLock {
  const workers = { ...lock.workers };

  for (const result of results) {
    if (result.success && result.deployedAt) {
      workers[result.component] = {
        name: result.workerName,
        deployedAt: result.deployedAt,
        version: localVersions[result.component] || result.version,
      };
    }
  }

  return {
    ...lock,
    workers,
    updatedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Update Command
// =============================================================================

export async function updateCommand(options: UpdateCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🔄 Authrim Worker Update\n'));

  const baseDir = findAuthrimBaseDir(process.cwd());
  const env = options.env;

  // Validate required options
  if (!env) {
    console.error(chalk.red('Error: --env is required'));
    console.log(chalk.yellow('\nUsage:'));
    console.log('  authrim-setup update --env <name>');
    console.log('  authrim-setup update --env prod --all      # Update all workers');
    console.log('  authrim-setup update --env prod --dry-run  # Preview changes');
    process.exit(1);
  }

  // Check prerequisites
  const spinner = ora('Checking prerequisites...').start();

  if (!(await isWranglerInstalled())) {
    spinner.fail('Wrangler is not installed');
    console.log(chalk.yellow('\nInstall wrangler:'));
    console.log('  npm install -g wrangler');
    process.exit(1);
  }

  const auth = await checkAuth();
  if (!auth.isLoggedIn) {
    spinner.fail('Not logged in to Cloudflare');
    console.log(chalk.yellow('\nLogin with:'));
    console.log('  wrangler login');
    process.exit(1);
  }

  spinner.succeed(`Logged in as ${auth.email || 'unknown'}`);

  // Load lock file
  spinner.start('Loading environment...');

  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);

  if (!lock) {
    spinner.fail('Lock file not found');
    console.log(chalk.yellow(`\nEnvironment "${env}" not found.`));
    console.log(chalk.yellow('Run "authrim-setup init" first to create the environment.'));
    process.exit(1);
  }

  spinner.succeed(`Environment loaded: ${env}`);
  console.log(chalk.gray(`  Lock file: ${lockPath}`));

  // Get version comparison
  spinner.start('Comparing versions...');

  const localVersions = await getLocalPackageVersions(baseDir);

  // Build deployed versions from lock file
  const deployedVersions: Record<string, { version?: string; deployedAt?: string }> = {};
  if (lock.workers) {
    for (const [component, info] of Object.entries(lock.workers)) {
      deployedVersions[component] = {
        version: info.version,
        deployedAt: info.deployedAt,
      };
    }
  }

  const comparisons = compareVersions(localVersions, deployedVersions);

  spinner.succeed('Version comparison complete');

  // Display version table
  displayVersionTable(comparisons);

  // Get components to update
  const componentsToUpdate = getComponentsToUpdate(comparisons, options.all || false);

  if (componentsToUpdate.length === 0) {
    console.log(chalk.green('\n✅ All workers are up to date!'));
    return;
  }

  const updateCount = componentsToUpdate.length;
  console.log(
    chalk.cyan(`\n${updateCount} worker(s) ${options.all ? 'to deploy' : 'need updating'}`)
  );

  // Confirm update
  if (!options.yes) {
    const confirmed = await confirm({
      message: options.dryRun ? 'Show what would be updated?' : `Update ${updateCount} worker(s)?`,
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nUpdate cancelled.'));
      return;
    }
  }

  // Dry run mode
  if (options.dryRun) {
    console.log(chalk.bold('\n[DRY RUN] Would update:'));
    for (const component of componentsToUpdate) {
      const c = comparisons.find((x) => x.component === component);
      if (c) {
        const from = c.deployedVersion || 'new';
        console.log(`  • ${component}: ${from} → ${c.localVersion}`);
      }
    }
    console.log(chalk.gray('\nNo changes made.'));
    return;
  }

  // Sync wrangler configs before building (if master configs exist)
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (existsSync(envPaths.wrangler)) {
    const syncSpinner = ora('Syncing wrangler configs...').start();
    const syncResult = await syncWranglerConfigs({
      baseDir,
      env,
      packagesDir: join(baseDir, 'packages'),
      force: true,
      dryRun: options.dryRun,
      onProgress: (msg) => {
        syncSpinner.text = msg;
      },
    });

    if (!syncResult.success && syncResult.errors.length > 0) {
      syncSpinner.fail('Wrangler config sync failed');
      console.error(chalk.red(`\nErrors: ${syncResult.errors.join(', ')}`));
      process.exit(1);
    }

    syncSpinner.succeed(`Synced ${syncResult.synced.length} wrangler config(s)`);
  } else {
    // Check if wrangler.toml exists in packages, if not generate them
    const sampleWranglerPath = join(baseDir, 'packages', 'ar-lib-core', 'wrangler.toml');
    if (!existsSync(sampleWranglerPath)) {
      // Generate wrangler configs from lock file and config
      const genSpinner = ora('Generating wrangler configs from lock file...').start();

      try {
        // Load config
        const configPath = envPaths.config;
        if (!existsSync(configPath)) {
          genSpinner.fail('Config file not found');
          console.error(chalk.red(`\nConfig file not found: ${configPath}`));
          console.log(chalk.yellow('Run "authrim-setup deploy" instead to regenerate configs.'));
          process.exit(1);
        }

        const configContent = await readFile(configPath, 'utf-8');
        const config = AuthrimConfigSchema.parse(JSON.parse(configContent));

        // Build resource IDs from lock file
        const resourceIds: ResourceIds = {
          d1: {},
          kv: {},
        };

        for (const [key, value] of Object.entries(lock.d1)) {
          resourceIds.d1[key] = { id: value.id, name: value.name };
        }
        for (const [key, value] of Object.entries(lock.kv)) {
          resourceIds.kv[key] = { id: value.id, name: value.name };
        }

        // Get workers subdomain
        const workersSubdomain = await getWorkersSubdomain();

        // Generate wrangler.toml for each component
        let generatedCount = 0;
        for (const component of CORE_WORKER_COMPONENTS) {
          const componentDir = join(baseDir, 'packages', component);
          if (!existsSync(componentDir)) {
            continue;
          }

          const wranglerConfig = generateWranglerConfig(
            component,
            config,
            resourceIds,
            workersSubdomain ?? undefined
          );
          const tomlContent = toToml(wranglerConfig, env);
          const tomlPath = join(componentDir, 'wrangler.toml');

          if (!options.dryRun) {
            await writeFile(tomlPath, tomlContent, 'utf-8');
          }
          generatedCount++;
        }

        genSpinner.succeed(`Generated ${generatedCount} wrangler config(s)`);
      } catch (error) {
        genSpinner.fail('Failed to generate wrangler configs');
        console.error(chalk.red(`\nError: ${error}`));
        process.exit(1);
      }
    } else {
      console.log(chalk.gray('  Using existing wrangler configs in packages/'));
    }
  }

  // Build packages (unless skipped)
  if (!options.skipBuild) {
    const buildSpinner = ora('Building packages...').start();

    const buildResult = await buildApiPackages({
      rootDir: resolve(baseDir),
      onProgress: (msg) => {
        buildSpinner.text = msg;
      },
    });

    if (!buildResult.success) {
      buildSpinner.fail('Build failed');
      console.error(chalk.red(`\nError: ${buildResult.error}`));
      process.exit(1);
    }

    buildSpinner.succeed('Build complete');
  }

  // Deploy workers
  console.log(chalk.bold('\n🚀 Deploying workers...\n'));

  const deployOptions: DeployOptions = {
    env,
    rootDir: resolve(baseDir),
    maxRetries: 3,
    retryDelayMs: 5000,
    onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
    onError: (component, error) => {
      console.error(chalk.red(`  ❌ Error in ${component}: ${error.message}`));
    },
  };

  const summary = await deployAll(deployOptions, componentsToUpdate);

  // Update lock file with new versions
  if (summary.successCount > 0) {
    const updatedLock = updateLockWithDeploymentsAndVersions(lock, summary.results, localVersions);
    await saveLockFile(updatedLock, lockPath);
    console.log(chalk.gray(`\n  Lock file updated: ${lockPath}`));
  }

  // Display summary
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('  Update Summary'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  if (summary.failedCount === 0) {
    console.log(chalk.green(`  ✅ ${summary.successCount} worker(s) updated successfully!`));
  } else {
    console.log(
      chalk.yellow(
        `  ⚠️  ${summary.successCount}/${summary.totalComponents} updated, ${summary.failedCount} failed`
      )
    );

    console.log(chalk.bold('\n  Failed:'));
    for (const result of summary.results.filter((r) => !r.success)) {
      console.log(chalk.red(`    • ${result.component}: ${result.error}`));
    }
  }

  console.log('');
}
