/**
 * Deploy Command
 *
 * Handles deployment of Authrim workers to Cloudflare.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm, select } from '@inquirer/prompts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { loadLockFile, saveLockFile } from '../../core/lock.js';
import {
  deployAll,
  deployWorker,
  uploadSecrets,
  deployPages,
  updateLockWithDeployments,
  type DeployOptions,
} from '../../core/deploy.js';
import { isWranglerInstalled, checkAuth } from '../../core/cloudflare.js';
import { type WorkerComponent } from '../../core/naming.js';
import { completeInitialSetup, displaySetupInstructions } from '../../core/admin.js';

// =============================================================================
// Types
// =============================================================================

export interface DeployCommandOptions {
  config?: string;
  env?: string;
  component?: string;
  dryRun?: boolean;
  skipSecrets?: boolean;
  skipUi?: boolean;
  parallel?: boolean;
  yes?: boolean;
  keysDir?: string;
}

// =============================================================================
// Helpers
// =============================================================================

async function loadConfig(configPath: string): Promise<AuthrimConfig | null> {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const data = JSON.parse(content);
    return AuthrimConfigSchema.parse(data);
  } catch (error) {
    console.error(chalk.red(`Failed to load config: ${error}`));
    return null;
  }
}

async function loadSecretsFromKeys(keysDir: string): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  const secretFiles = [
    { file: 'private.pem', name: 'PRIVATE_KEY_PEM' },
    { file: 'rp_token_encryption_key.txt', name: 'RP_TOKEN_ENCRYPTION_KEY' },
    { file: 'admin_api_secret.txt', name: 'ADMIN_API_SECRET' },
    { file: 'key_manager_secret.txt', name: 'KEY_MANAGER_SECRET' },
  ];

  for (const { file, name } of secretFiles) {
    const filePath = join(keysDir, file);
    if (existsSync(filePath)) {
      secrets[name] = await readFile(filePath, 'utf-8');
    }
  }

  return secrets;
}

// =============================================================================
// Deploy Command
// =============================================================================

export async function deployCommand(options: DeployCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🚀 Authrim Deploy\n'));

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

  // Find config file
  const configPath = options.config || 'authrim-config.json';
  const config = await loadConfig(configPath);

  if (!config) {
    console.error(chalk.red(`\nConfig file not found: ${configPath}`));
    console.log(chalk.yellow('Run "authrim-setup init" first to create a config.'));
    process.exit(1);
  }

  const env = options.env || config.environment.prefix;
  const rootDir = resolve('.');

  console.log(chalk.cyan(`\nEnvironment: ${env}`));
  console.log(chalk.cyan(`Config: ${configPath}`));

  // Load lock file
  const lockPath = 'authrim-lock.json';
  const lock = await loadLockFile(lockPath);

  if (!lock) {
    console.error(chalk.red(`\nLock file not found: ${lockPath}`));
    console.log(chalk.yellow('Run "authrim-setup init" first to provision resources.'));
    process.exit(1);
  }

  // Determine what to deploy
  let componentsToDeply: WorkerComponent[] | undefined;

  if (options.component) {
    // Deploy single component
    componentsToDeply = [options.component as WorkerComponent];
    console.log(chalk.cyan(`\nDeploying single component: ${options.component}`));
  } else {
    // Deploy all enabled components
    const enabledComponents: WorkerComponent[] = ['ar-lib-core', 'ar-discovery'];

    // Always include core components
    enabledComponents.push('ar-auth', 'ar-token', 'ar-userinfo', 'ar-management');

    // Add optional components based on config
    if (config.components.saml) enabledComponents.push('ar-saml');
    if (config.components.async) enabledComponents.push('ar-async');
    if (config.components.vc) enabledComponents.push('ar-vc');
    if (config.components.bridge) enabledComponents.push('ar-bridge');

    // Router is always last
    enabledComponents.push('ar-router');

    componentsToDeply = enabledComponents;

    console.log(chalk.cyan(`\nComponents to deploy: ${enabledComponents.length}`));
    for (const comp of enabledComponents) {
      console.log(chalk.gray(`  • ${comp}`));
    }
  }

  // Confirm deployment
  if (!options.yes) {
    const confirmed = await confirm({
      message: options.dryRun ? 'Run deployment in dry-run mode?' : 'Start deployment?',
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow('Deployment cancelled.'));
      return;
    }
  }

  console.log('');

  // Upload secrets first (if not skipped)
  if (!options.skipSecrets && !options.component) {
    const keysDir = config.keys.secretsPath || '.keys';

    if (existsSync(keysDir)) {
      console.log(chalk.bold('📦 Uploading secrets...\n'));

      const secrets = await loadSecretsFromKeys(keysDir);

      if (Object.keys(secrets).length > 0) {
        const secretResult = await uploadSecrets(secrets, {
          env,
          rootDir,
          dryRun: options.dryRun,
          onProgress: (msg) => console.log(msg),
        });

        if (!secretResult.success) {
          console.log(chalk.yellow('\n⚠️  Some secrets failed to upload'));
          for (const error of secretResult.errors) {
            console.log(chalk.red(`  • ${error}`));
          }
        }
      } else {
        console.log(chalk.yellow('No secrets found in .keys directory'));
      }

      console.log('');
    }
  }

  // Deploy workers
  console.log(chalk.bold('🔨 Deploying workers...\n'));

  const deployOptions: DeployOptions = {
    env,
    rootDir,
    dryRun: options.dryRun,
    maxRetries: 3,
    retryDelayMs: 5000,
    onProgress: (msg) => console.log(msg),
    onError: (component, error) => {
      console.error(chalk.red(`Error in ${component}: ${error.message}`));
    },
  };

  const summary = await deployAll(deployOptions, componentsToDeply);

  // Update lock file with deployment results
  if (!options.dryRun && summary.successCount > 0) {
    const updatedLock = updateLockWithDeployments(lock, summary.results);
    await saveLockFile(updatedLock, lockPath);
    console.log(chalk.gray(`\nLock file updated: ${lockPath}`));
  }

  // Deploy Pages UI (if enabled and not skipped)
  if (
    !options.skipUi &&
    !options.component &&
    (config.components.loginUi || config.components.adminUi)
  ) {
    console.log(chalk.bold('\n📱 Deploying UI to Cloudflare Pages...\n'));

    const pagesResult = await deployPages({
      ...deployOptions,
      projectName: `${env}-ar-ui`,
    });

    if (pagesResult.success) {
      console.log(chalk.green(`\n✓ UI deployed: ${pagesResult.projectName}`));
    } else {
      console.log(chalk.yellow(`\n⚠️  UI deployment failed: ${pagesResult.error}`));
    }
  }

  // Final summary
  console.log(chalk.bold('\n━━━ Deployment Complete ━━━\n'));

  if (summary.failedCount === 0) {
    console.log(chalk.green('✅ All components deployed successfully!\n'));
  } else {
    console.log(
      chalk.yellow(`⚠️  ${summary.successCount}/${summary.totalComponents} components deployed\n`)
    );
  }

  // Print URLs
  if (!options.dryRun && config.urls) {
    console.log(chalk.bold('URLs:'));

    const apiUrl = config.urls.api?.custom || config.urls.api?.auto;
    const loginUrl = config.urls.loginUi?.custom || config.urls.loginUi?.auto;
    const adminUrl = config.urls.adminUi?.custom || config.urls.adminUi?.auto;

    if (apiUrl) console.log(chalk.cyan(`  API:       ${apiUrl}`));
    if (loginUrl) console.log(chalk.cyan(`  Login UI:  ${loginUrl}`));
    if (adminUrl) console.log(chalk.cyan(`  Admin UI:  ${adminUrl}`));

    console.log('');
  }

  // Initial admin setup (only if all components deployed successfully)
  if (!options.dryRun && summary.failedCount === 0) {
    const baseUrl = config.urls?.api?.custom || config.urls?.api?.auto;

    if (baseUrl) {
      const setupSpinner = ora('Setting up initial admin...').start();

      try {
        const setupResult = await completeInitialSetup({
          env,
          baseUrl,
          keysDir: options.keysDir || '.keys',
          onProgress: (msg) => {
            setupSpinner.text = msg;
          },
        });

        if (setupResult.alreadyCompleted) {
          setupSpinner.succeed('Initial admin setup already completed');
        } else if (setupResult.success && setupResult.setupUrl) {
          setupSpinner.succeed('Setup token stored');
          displaySetupInstructions(setupResult.setupUrl, {
            color: true,
            onOutput: console.log,
          });
        } else if (!setupResult.success) {
          setupSpinner.warn(`Initial admin setup skipped: ${setupResult.error}`);
          console.log(chalk.gray('  You can run this manually later with the setup token.'));
        }
      } catch (error) {
        setupSpinner.warn('Initial admin setup skipped');
        console.log(
          chalk.gray(`  Error: ${error instanceof Error ? error.message : String(error)}`)
        );
        console.log(chalk.gray('  You can run this manually later with the setup token.'));
      }
    }
  }
}

// =============================================================================
// Status Command
// =============================================================================

export async function statusCommand(options: { config?: string }): Promise<void> {
  console.log(chalk.bold('\n📊 Authrim Deployment Status\n'));

  const configPath = options.config || 'authrim-config.json';
  const config = await loadConfig(configPath);

  if (!config) {
    console.log(chalk.yellow(`Config not found: ${configPath}`));
    return;
  }

  const lockPath = 'authrim-lock.json';
  const lock = await loadLockFile(lockPath);

  if (!lock) {
    console.log(chalk.yellow('No deployment found (authrim-lock.json not found)'));
    return;
  }

  console.log(chalk.bold('Environment:'), lock.env);
  console.log(chalk.bold('Created:'), lock.createdAt);
  console.log(chalk.bold('Updated:'), lock.updatedAt || 'N/A');

  // D1 Databases
  console.log(chalk.bold('\nD1 Databases:'));
  for (const [binding, db] of Object.entries(lock.d1)) {
    console.log(chalk.cyan(`  ${binding}: ${db.name}`));
    console.log(chalk.gray(`    ID: ${db.id}`));
  }

  // KV Namespaces
  console.log(chalk.bold('\nKV Namespaces:'));
  for (const [binding, kv] of Object.entries(lock.kv)) {
    console.log(chalk.cyan(`  ${binding}: ${kv.name}`));
    console.log(chalk.gray(`    ID: ${kv.id}`));
  }

  // Workers
  if (lock.workers && Object.keys(lock.workers).length > 0) {
    console.log(chalk.bold('\nWorkers:'));
    for (const [name, worker] of Object.entries(lock.workers)) {
      const status = worker.deployedAt ? chalk.green('✓') : chalk.yellow('○');
      console.log(`${status} ${chalk.cyan(name)}: ${worker.name}`);
      if (worker.deployedAt) {
        console.log(chalk.gray(`    Deployed: ${worker.deployedAt}`));
      }
      if (worker.version) {
        console.log(chalk.gray(`    Version: ${worker.version}`));
      }
    }
  } else {
    console.log(chalk.yellow('\nNo workers deployed yet.'));
  }

  console.log('');
}
