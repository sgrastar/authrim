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
  hasControlManagedResourcesForEnvironment,
} from '../../core/cloudflare.js';
import { cleanupLocalEnvironmentArtifacts } from '../../core/environment-cleanup.js';
import { findAuthrimBaseDir } from '../../core/paths.js';
import {
  acquireEnvironmentOperationForEnvironment,
  reconcileLockAfterResourceDeletion,
  saveLockFile,
} from '../../core/lock.js';
import {
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from '../../core/environment-operation-policy.js';

function updateOraSpinner(spinner: ReturnType<typeof ora>, message: string): void {
  if (spinner.isSpinning === false) {
    console.log(message);
    return;
  }
  spinner.text = message;
}

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
  pages?: boolean;
  all?: boolean;
}

// =============================================================================
// Delete Command
// =============================================================================

export async function deleteCommand(options: DeleteCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🗑️  Authrim Environment Delete\n'));

  // Check prerequisites
  const spinner = ora(t('prereq.checking')).start();
  let prerequisiteSpinnerSettled = false;
  try {
    if (!(await isWranglerInstalled())) {
      spinner.fail(t('prereq.wranglerNotInstalled'));
      prerequisiteSpinnerSettled = true;
      console.log(chalk.yellow('\n' + t('prereq.wranglerInstallHint')));
      console.log('  npm install -g wrangler');
      process.exit(1);
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      spinner.fail(t('prereq.notLoggedIn'));
      prerequisiteSpinnerSettled = true;
      console.log(chalk.yellow('\n' + t('prereq.loginHint')));
      console.log('  wrangler login');
      process.exit(1);
    }

    spinner.succeed(t('prereq.loggedInAs', { email: auth.email || '-' }));
    prerequisiteSpinnerSettled = true;
  } catch (error) {
    if (!prerequisiteSpinnerSettled) {
      spinner.fail(t('error.generic'));
    }
    throw error;
  }

  // Get environment name
  let env = options.env;
  let detectedEnvironments: Awaited<ReturnType<typeof detectEnvironments>> | undefined;

  if (!env) {
    // Detect environments
    const detectSpinner = ora(t('manage.detecting')).start();
    let environments: Awaited<ReturnType<typeof detectEnvironments>>;
    try {
      environments = await detectEnvironments();
      detectedEnvironments = environments;
      detectSpinner.succeed(t('manage.detected'));
    } catch (error) {
      detectSpinner.fail(t('error.generic'));
      throw error;
    }

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
  const deletePages = options.all || options.pages !== false;
  const deletesEntireEnvironment =
    deleteWorkers && deleteD1 && deleteKV && deleteQueues && deleteR2 && deletePages;

  console.log(chalk.gray('\nResources to delete:'));
  console.log(chalk.gray(`  Workers: ${deleteWorkers ? '✓' : '✗'}`));
  console.log(chalk.gray(`  D1:      ${deleteD1 ? '✓' : '✗'}`));
  console.log(chalk.gray(`  KV:      ${deleteKV ? '✓' : '✗'}`));
  console.log(chalk.gray(`  Queues:  ${deleteQueues ? '✓' : '✗'}`));
  console.log(chalk.gray(`  R2:      ${deleteR2 ? '✓' : '✗'}`));
  console.log(chalk.gray(`  ${t('delete.pages')}: ${deletePages ? '✓' : '✗'}`));

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
  const operationLock = await acquireEnvironmentOperationForEnvironment({
    baseDir,
    env,
    operation: 'delete',
    requireExisting: false,
  });
  let result: Awaited<ReturnType<typeof deleteEnvironment>>;
  let deleteSpinner: ReturnType<typeof ora> | undefined;
  try {
    const lock = operationLock.lock;
    if (!lock && !detectedEnvironments) {
      const detectSpinner = ora('Confirming remote environment resources...').start();
      try {
        detectedEnvironments = await detectEnvironments();
        detectSpinner.succeed('Remote environment resources confirmed');
      } catch (error) {
        detectSpinner.fail('Remote environment scan failed');
        throw error;
      }
    }
    const environmentObservedByBaseline = detectedEnvironments?.some(
      (candidate) => candidate.env === env
    );
    const environmentObservedRemotely =
      environmentObservedByBaseline || (await hasControlManagedResourcesForEnvironment(env));
    const decision = evaluateEnvironmentOperation({
      operation: 'delete',
      lock,
      environmentObservedRemotely,
    });
    if (!decision.allowed) {
      throw new Error(environmentOperationBlockMessage(decision));
    }
    const knownD1Names = lock ? Object.values(lock.d1).map((entry) => entry.name) : [];
    const knownQueueNames = lock?.queues
      ? Object.values(lock.queues).map((entry) => entry.name)
      : [];

    deleteSpinner = ora('Deleting environment resources...').start();
    const updateDeleteSpinner = (message: string) => {
      const clean = message
        .replace(/\uFE0F/gu, '')
        .replace(/^\s*(?:\p{Extended_Pictographic}|✓)+\s*/u, '')
        .trim();
      if (clean && deleteSpinner) updateOraSpinner(deleteSpinner, clean);
    };
    result = await deleteEnvironment({
      env,
      environmentKnownLocally: Boolean(lock),
      deleteWorkers,
      deleteD1,
      deleteKV,
      deleteQueues,
      deleteR2,
      deletePages,
      knownD1Names,
      knownQueueNames,
      onProgress: updateDeleteSpinner,
      onResourceProgress: ({ current, total }) => {
        if (deleteSpinner) {
          updateOraSpinner(
            deleteSpinner,
            `Deleting environment resources (${current}/${total})...`
          );
        }
      },
    });

    const deletedLockResourceCount =
      result.deleted.workers.length +
      result.deleted.d1.length +
      result.deleted.kv.length +
      result.deleted.queues.length +
      result.deleted.r2.length;
    if (lock && deletedLockResourceCount > 0) {
      await saveLockFile(
        reconcileLockAfterResourceDeletion(lock, result.deleted),
        operationLock.lockFilePath
      );
    }

    if (result.success && deletesEntireEnvironment) {
      const cleanupResult = await cleanupLocalEnvironmentArtifacts({
        baseDir,
        env,
        packagesDir: join(baseDir, 'packages'),
        keysBaseDir: process.cwd(),
        onProgress: updateDeleteSpinner,
      });
      if (cleanupResult.errors.length > 0) {
        result.errors.push(...cleanupResult.errors);
      }
    } else if (!result.success) {
      updateDeleteSpinner('Preserving local environment state for deletion retry...');
    } else {
      updateDeleteSpinner('Preserving local environment state for resources not selected...');
    }
    result.success = result.errors.length === 0;
    result.completion = result.success
      ? result.manualR2.length > 0
        ? 'manual_action_required'
        : 'complete'
      : 'failed';
    if (result.completion === 'complete') {
      deleteSpinner.succeed(
        deletesEntireEnvironment ? 'Environment resources deleted' : t('delete.partialSuccess')
      );
    } else if (result.completion === 'manual_action_required') {
      deleteSpinner.warn('Cloud resources deleted; R2 cleanup requires a manual action');
    } else {
      deleteSpinner.fail('Environment deletion encountered errors');
    }
  } catch (error) {
    deleteSpinner?.fail('Environment deletion failed unexpectedly');
    throw error;
  } finally {
    await operationLock.release();
  }

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
  if (result.deleted.pages.length > 0) {
    console.log(chalk.green(`Pages projects deleted: ${result.deleted.pages.length}`));
  }

  if (result.manualR2.length > 0) {
    console.log(chalk.yellow('\nR2 buckets requiring manual cleanup:'));
    for (const target of result.manualR2) {
      console.log(chalk.yellow(`  • ${target.bucketName} (${target.objectCount} objects)`));
      if (target.dashboardUrl) {
        console.log(chalk.cyan(`    ${target.dashboardUrl}`));
      }
    }
  }

  if (result.errors.length > 0) {
    console.log(chalk.yellow(`\nErrors (${result.errors.length}):`));
    for (const error of result.errors) {
      console.log(chalk.red(`  • ${error}`));
    }
  }

  if (result.completion === 'manual_action_required') {
    console.log(
      chalk.yellow(
        '\n⚠️  Environment resources were deleted. Complete the R2 actions above to finish cleanup.'
      )
    );
  } else if (result.success && deletesEntireEnvironment) {
    console.log(chalk.green('\n✅ Environment deleted successfully!'));
  } else if (result.success) {
    console.log(chalk.green(`\n✅ ${t('delete.partialSuccess')}`));
  } else {
    console.log(chalk.yellow('\n⚠️  Environment deletion completed with errors.'));
    process.exit(1);
  }
}
