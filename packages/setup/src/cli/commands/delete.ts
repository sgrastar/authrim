/**
 * Delete Command
 *
 * Deletes an Authrim environment and its resources.
 * Designed for both interactive and CI use.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { join } from 'node:path';
import { t } from '../../i18n/index.js';
import {
  isWranglerInstalled,
  checkAuth,
  detectEnvironments,
  deleteEnvironment,
} from '../../core/cloudflare.js';
import { cleanupLocalEnvironmentArtifacts } from '../../core/environment-cleanup.js';
import { findAuthrimBaseDir } from '../../core/paths.js';
import { loadLockFileAuto } from '../../core/lock.js';

// =============================================================================
// Types
// =============================================================================

export interface DeleteCommandOptions {
  env?: string;
  yes?: boolean;
  workers?: boolean;
  d1?: boolean;
  kv?: boolean;
  queues?: boolean;
  r2?: boolean;
  all?: boolean;
}

// =============================================================================
// Delete Command
// =============================================================================

export async function deleteCommand(options: DeleteCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🗑️  Authrim Environment Delete\n'));

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

  // Get environment name
  let env = options.env;

  if (!env) {
    // Detect environments
    const detectSpinner = ora('Detecting environments...').start();
    const environments = await detectEnvironments();
    detectSpinner.stop();

    if (environments.length === 0) {
      console.log(chalk.yellow('\nNo Authrim environments found.'));
      process.exit(0);
    }

    console.log(chalk.cyan('\nDetected environments:'));
    for (const e of environments) {
      console.log(
        chalk.gray(
          `  • ${e.env} (${e.workers.length} workers, ${e.d1.length} D1, ${e.kv.length} KV)`
        )
      );
    }

    if (!options.yes) {
      // Interactive mode: ask which environment to delete
      const { select } = await import('@inquirer/prompts');
      env = await select({
        message: t('delete.selectEnv'),
        choices: environments.map((e) => ({
          name: `${e.env} (${e.workers.length} workers, ${e.d1.length} D1, ${e.kv.length} KV)`,
          value: e.env,
        })),
      });
    } else {
      console.error(chalk.red('\nError: --env is required when using --yes flag'));
      process.exit(1);
    }
  }

  console.log(chalk.cyan(`\nEnvironment: ${env}`));

  // Determine what to delete
  const deleteWorkers = options.all || options.workers !== false;
  const deleteD1 = options.all || options.d1 !== false;
  const deleteKV = options.all || options.kv !== false;
  const deleteQueues = options.all || options.queues !== false;
  const deleteR2 = options.all || options.r2 !== false;

  console.log(chalk.gray('\nResources to delete:'));
  console.log(chalk.gray(`  Workers: ${deleteWorkers ? '✓' : '✗'}`));
  console.log(chalk.gray(`  D1:      ${deleteD1 ? '✓' : '✗'}`));
  console.log(chalk.gray(`  KV:      ${deleteKV ? '✓' : '✗'}`));
  console.log(chalk.gray(`  Queues:  ${deleteQueues ? '✓' : '✗'}`));
  console.log(chalk.gray(`  R2:      ${deleteR2 ? '✓' : '✗'}`));

  // Confirm deletion
  if (!options.yes) {
    console.log('');
    const confirmed = await confirm({
      message: chalk.red(t('delete.confirmPermanent', { env })),
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\n' + t('delete.cancelled')));
      return;
    }
  }

  console.log('');

  const baseDir = findAuthrimBaseDir(process.cwd());
  const { lock } = await loadLockFileAuto(baseDir, env);
  const knownD1Names = lock ? Object.values(lock.d1).map((entry) => entry.name) : [];
  const knownQueueNames = lock?.queues ? Object.values(lock.queues).map((entry) => entry.name) : [];

  // Delete environment
  const result = await deleteEnvironment({
    env,
    deleteWorkers,
    deleteD1,
    deleteKV,
    deleteQueues,
    deleteR2,
    knownD1Names,
    knownQueueNames,
    onProgress: (msg) => console.log(msg),
  });

  const cleanupResult = await cleanupLocalEnvironmentArtifacts({
    baseDir,
    env,
    packagesDir: join(baseDir, 'packages'),
    keysBaseDir: process.cwd(),
    onProgress: (msg) => console.log(msg),
  });
  if (cleanupResult.errors.length > 0) {
    result.errors.push(...cleanupResult.errors);
  }
  result.success = result.errors.length === 0;

  // Summary
  console.log(chalk.bold('\n━━━ Deletion Summary ━━━\n'));

  if (result.deleted.workers.length > 0) {
    console.log(chalk.green(`Workers deleted: ${result.deleted.workers.length}`));
  }
  if (result.deleted.d1.length > 0) {
    console.log(chalk.green(`D1 databases deleted: ${result.deleted.d1.length}`));
  }
  if (result.deleted.kv.length > 0) {
    console.log(chalk.green(`KV namespaces deleted: ${result.deleted.kv.length}`));
  }
  if (result.deleted.queues.length > 0) {
    console.log(chalk.green(`Queues deleted: ${result.deleted.queues.length}`));
  }
  if (result.deleted.r2.length > 0) {
    console.log(chalk.green(`R2 buckets deleted: ${result.deleted.r2.length}`));
  }

  if (result.errors.length > 0) {
    console.log(chalk.yellow(`\nErrors (${result.errors.length}):`));
    for (const error of result.errors) {
      console.log(chalk.red(`  • ${error}`));
    }
  }

  if (result.success) {
    console.log(chalk.green('\n✅ Environment deleted successfully!'));
  } else {
    console.log(chalk.yellow('\n⚠️  Environment deletion completed with errors.'));
    process.exit(1);
  }
}
