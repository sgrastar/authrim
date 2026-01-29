#!/usr/bin/env node
/**
 * @authrim/setup - CLI tool for setting up Authrim OIDC Provider
 *
 * Usage (via npx):
 *   npx @authrim/setup           # Start Web UI (default)
 *   npx @authrim/setup --cli     # Start CLI mode
 *   npx @authrim/setup --config ./authrim-config.json  # Load existing config
 *
 * Usage (from source repository):
 *   pnpm setup                   # Start Web UI (default)
 *   pnpm setup:manage            # Manage existing environments
 *   pnpm setup:deploy            # Deploy to Cloudflare
 *   pnpm setup:status            # Show deployment status
 *   pnpm setup:info              # Display resource information
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { initCommand } from './cli/commands/init.js';
import { deployCommand, statusCommand } from './cli/commands/deploy.js';
import { updateCommand } from './cli/commands/update.js';
import { configCommand } from './cli/commands/config.js';
import { deleteCommand } from './cli/commands/delete.js';
import { infoCommand } from './cli/commands/info.js';
import { migrateCommand, migrateStatusCommand } from './cli/commands/migrate.js';

// Read version from package.json
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('authrim-setup')
  .description('CLI tool for setting up Authrim OIDC Provider on Cloudflare Workers')
  .version(pkg.version);

program
  .command('init', { isDefault: true })
  .description('Initialize a new Authrim setup')
  .option('--cli', 'Use CLI mode instead of Web UI')
  .option('--config <path>', 'Load existing configuration file')
  .option('--keep <path>', 'Keep source files at specified path')
  .option('--env <name>', 'Environment name (prod, staging, dev)', 'prod')
  .option('--lang <code>', 'Language (en, ja, zh-CN, etc.)')
  .action(initCommand);

program
  .command('deploy')
  .description('Deploy Authrim to Cloudflare')
  .option('--env <name>', 'Environment name')
  .option('--config <path>', 'Configuration file path')
  .option('--source <path>', 'Authrim source directory (containing packages/)')
  .option('--component <name>', 'Deploy a single component')
  .option('--dry-run', 'Show what would be deployed without actually deploying')
  .option('--skip-secrets', 'Skip uploading secrets')
  .option('--skip-build', 'Skip building packages')
  .option('--skip-ui', 'Skip UI deployment to Cloudflare Pages')
  .option('--skip-migrations', 'Skip D1 database migrations')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(deployCommand);

program
  .command('update')
  .description('Update workers for an existing environment')
  .option('--env <name>', 'Environment name (required)')
  .option('--all', 'Update all workers regardless of version')
  .option('--dry-run', 'Show what would be updated without deploying')
  .option('--skip-build', 'Skip building packages')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(updateCommand);

program
  .command('upgrade')
  .description('Upgrade individual component (worker or UI)')
  .requiredOption('--env <name>', 'Environment name')
  .requiredOption('--component <name>', 'Component name (e.g., ar-admin-ui, ar-login-ui, ar-auth)')
  .option('--skip-build', 'Skip building packages')
  .option('--dry-run', 'Show what would be upgraded without deploying')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (options) => {
    const chalk = await import('chalk').then((m) => m.default);
    const ora = await import('ora').then((m) => m.default);
    const { confirm } = await import('@inquirer/prompts');
    const { resolve, join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');

    const { isWranglerInstalled, checkAuth } = await import('./core/cloudflare.js');
    const { WORKER_COMPONENTS } = await import('./core/naming.js');
    const { deployWorker, deployPagesComponent, buildApiPackages, PAGES_COMPONENTS } =
      await import('./core/deploy.js');
    const { loadLockFileAuto, saveLockFile } = await import('./core/lock.js');
    const { findAuthrimBaseDir, getEnvironmentPaths, resolvePaths } =
      await import('./core/paths.js');

    console.log(chalk.bold('\n🔧 Authrim Component Upgrade\n'));

    const { env, component: componentName, skipBuild, dryRun, yes } = options;

    // Validate component name
    const isPagesComponent = (PAGES_COMPONENTS as readonly string[]).includes(componentName);
    const isWorkerComponent = (WORKER_COMPONENTS as readonly string[]).includes(componentName);

    if (!isPagesComponent && !isWorkerComponent) {
      console.error(chalk.red(`Unknown component: ${componentName}`));
      console.log(chalk.yellow('\nAvailable components:'));
      console.log(chalk.cyan('\n  Workers:'));
      for (const w of WORKER_COMPONENTS) {
        console.log(chalk.gray(`    • ${w}`));
      }
      console.log(chalk.cyan('\n  UI (Pages):'));
      for (const p of PAGES_COMPONENTS) {
        console.log(chalk.gray(`    • ${p}`));
      }
      process.exit(1);
    }

    // Check prerequisites
    const spinner = ora('Checking prerequisites...').start();

    if (!(await isWranglerInstalled())) {
      spinner.fail('Wrangler is not installed');
      console.log(chalk.yellow('\nInstall wrangler: npm install -g wrangler'));
      process.exit(1);
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      spinner.fail('Not logged in to Cloudflare');
      console.log(chalk.yellow('\nLogin with: wrangler login'));
      process.exit(1);
    }

    spinner.succeed(`Logged in as ${auth.email || 'unknown'}`);

    const baseDir = findAuthrimBaseDir(process.cwd());
    const componentType = isPagesComponent ? 'Pages UI' : 'Worker';

    console.log(chalk.cyan(`\nComponent:   ${componentName}`));
    console.log(chalk.cyan(`Type:        ${componentType}`));
    console.log(chalk.cyan(`Environment: ${env}`));

    // Confirm upgrade
    if (!yes) {
      const confirmed = await confirm({
        message: dryRun
          ? 'Show what would be upgraded?'
          : `Upgrade ${componentName} to environment ${env}?`,
        default: true,
      });

      if (!confirmed) {
        console.log(chalk.yellow('\nUpgrade cancelled.'));
        return;
      }
    }

    // Load config for API URL (needed for Pages deployment)
    const resolved = resolvePaths({ baseDir, env });
    let cfg: Record<string, unknown> | null = null;
    try {
      const configPath =
        resolved.type === 'new'
          ? (resolved.paths as { config: string }).config
          : (resolved.paths as { config: string }).config;
      if (existsSync(configPath)) {
        const configContent = await readFile(configPath, 'utf-8');
        cfg = JSON.parse(configContent);
      }
    } catch {
      // Config is optional for worker deployment
    }

    if (isPagesComponent) {
      // Deploy Pages component
      if (!skipBuild && !dryRun) {
        const buildSpinner = ora(`Building ${componentName}...`).start();
        const uiDir = join(baseDir, 'packages', componentName);

        if (!existsSync(uiDir)) {
          buildSpinner.fail(`Package not found: ${componentName}`);
          process.exit(1);
        }

        // Get API base URL
        const cfgUrls = (cfg as { urls?: { api?: { custom?: string; auto?: string } } })?.urls;
        const apiBaseUrl =
          cfgUrls?.api?.custom || cfgUrls?.api?.auto || `https://${env}-ar-router.workers.dev`;

        // Get ui.env path for new structure
        let uiEnvPath: string | undefined;
        if (resolved.type === 'new') {
          uiEnvPath = (resolved.paths as { uiEnv: string }).uiEnv;

          // Sync ui.env before build
          const cfgUrlsTyped = cfg as {
            urls?: {
              api?: { custom?: string };
              adminUi?: { custom?: string };
            };
          };
          const apiHasCustomDomain = !!cfgUrlsTyped?.urls?.api?.custom;
          const adminUiHasCustomDomain = !!cfgUrlsTyped?.urls?.adminUi?.custom;
          const useDirectMode = apiHasCustomDomain && adminUiHasCustomDomain;

          const { saveUiEnv } = await import('./core/ui-env.js');
          try {
            if (useDirectMode) {
              await saveUiEnv(uiEnvPath, {
                PUBLIC_API_BASE_URL: apiBaseUrl,
                API_BACKEND_URL: '',
              });
            } else {
              await saveUiEnv(uiEnvPath, {
                PUBLIC_API_BASE_URL: '',
                API_BACKEND_URL: apiBaseUrl,
              });
            }
          } catch {
            console.log(chalk.yellow('  Warning: Could not sync ui.env'));
          }
        }

        buildSpinner.succeed(`${componentName} ready for deployment`);

        const deploySpinner = ora(`Deploying ${componentName}...`).start();

        const result = await deployPagesComponent(componentName as 'ar-admin-ui' | 'ar-login-ui', {
          env,
          rootDir: resolve(baseDir),
          dryRun: dryRun || false,
          apiBaseUrl,
          uiEnvPath,
          onProgress: (msg) => {
            deploySpinner.text = msg;
          },
        });

        if (result.success) {
          deploySpinner.succeed(`${componentName} deployed successfully`);
          console.log(chalk.green(`\n✓ ${componentName} upgraded to ${env}`));
          console.log(chalk.gray(`  Project: ${result.projectName}`));
          console.log(chalk.gray(`  Deployed at: ${result.deployedAt}`));
        } else {
          deploySpinner.fail(`${componentName} deployment failed`);
          console.error(chalk.red(`\nError: ${result.error}`));
          process.exit(1);
        }
      } else if (dryRun) {
        console.log(chalk.bold('\n[DRY RUN] Would upgrade:'));
        console.log(`  • ${componentName} (${componentType})`);
        console.log(chalk.gray('\nNo changes made.'));
      }
    } else {
      // Deploy Worker component
      if (!skipBuild && !dryRun) {
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

      if (!dryRun) {
        const deploySpinner = ora(`Deploying ${componentName}...`).start();

        const result = await deployWorker(componentName as Parameters<typeof deployWorker>[0], {
          env,
          rootDir: resolve(baseDir),
          dryRun: dryRun || false,
          onProgress: (msg) => {
            deploySpinner.text = msg;
          },
        });

        if (result.success) {
          deploySpinner.succeed(`${componentName} deployed successfully`);

          // Update lock file
          try {
            const { lock: currentLock, path: lockPath } = await loadLockFileAuto(baseDir, env);
            if (currentLock && lockPath) {
              const workers = { ...currentLock.workers };
              workers[componentName] = {
                name: result.workerName,
                deployedAt: result.deployedAt,
                version: result.version,
              };

              const updatedLock = {
                ...currentLock,
                workers,
                updatedAt: new Date().toISOString(),
              };

              await saveLockFile(updatedLock, lockPath);
              console.log(chalk.gray(`  Lock file updated`));
            }
          } catch {
            console.log(chalk.yellow('  Warning: Could not update lock file'));
          }

          console.log(chalk.green(`\n✓ ${componentName} upgraded to ${env}`));
          console.log(chalk.gray(`  Worker: ${result.workerName}`));
          console.log(chalk.gray(`  Version: ${result.version || 'unknown'}`));
          console.log(chalk.gray(`  Deployed at: ${result.deployedAt}`));
        } else {
          deploySpinner.fail(`${componentName} deployment failed`);
          console.error(chalk.red(`\nError: ${result.error}`));
          process.exit(1);
        }
      } else {
        console.log(chalk.bold('\n[DRY RUN] Would upgrade:'));
        console.log(`  • ${componentName} (${componentType})`);
        console.log(chalk.gray('\nNo changes made.'));
      }
    }

    console.log('');
  });

program
  .command('status')
  .description('Show deployment status')
  .option('--config <path>', 'Configuration file path')
  .option('--env <name>', 'Environment name')
  .action(statusCommand);

program
  .command('secrets')
  .description('Upload secrets to Cloudflare')
  .option('--env <name>', 'Environment name')
  .option('--config <path>', 'Configuration file path')
  .option('--keys-dir <path>', 'Keys directory')
  .action(async (options) => {
    const { deployCommand: deploy } = await import('./cli/commands/deploy.js');
    await deploy({ ...options, skipUi: true });
  });

program
  .command('config')
  .description('Manage Authrim configuration')
  .option('--show', 'Show current configuration')
  .option('--validate', 'Validate configuration file')
  .option('--json', 'Output in JSON format for scripting')
  .option('--config <path>', 'Configuration file path')
  .option('--env <name>', 'Environment name (auto-detects config path)')
  .action(configCommand);

program
  .command('manage')
  .description('Manage existing Authrim environments (view, delete)')
  .option('--port <number>', 'Web UI port', '3456')
  .option('--no-browser', 'Do not open browser automatically')
  .action(async (options) => {
    const chalk = await import('chalk').then((m) => m.default);
    const { isWranglerInstalled, checkAuth } = await import('./core/cloudflare.js');
    const { startWebServer } = await import('./web/server.js');

    console.log(chalk.bold('\n🔐 Authrim Environment Manager\n'));

    // Check prerequisites
    const wranglerOk = await isWranglerInstalled();
    if (!wranglerOk) {
      console.log(chalk.red('❌ Wrangler is not installed'));
      console.log('');
      console.log(chalk.yellow('  Run the following command to install:'));
      console.log('');
      console.log(chalk.cyan('    npm install -g wrangler'));
      console.log('');
      process.exitCode = 1;
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      console.log(chalk.red('❌ Not logged in to Cloudflare'));
      console.log('');
      console.log(chalk.yellow('  Run the following command to authenticate:'));
      console.log('');
      console.log(chalk.cyan('    wrangler login'));
      console.log('');
      process.exitCode = 1;
      return;
    }

    console.log(chalk.green(`✓ Logged in as ${auth.email || 'Unknown'}`));
    console.log('');

    // Start Web UI in manage-only mode
    await startWebServer({
      port: parseInt(options.port, 10),
      openBrowser: options.browser !== false,
      manageOnly: true,
    });
  });

program
  .command('download')
  .description('Download Authrim source code')
  .option('-o, --output <path>', 'Output directory', './authrim')
  .option('--repo <repository>', 'GitHub repository', 'sgrastar/authrim')
  .option('--ref <gitRef>', 'Git tag or branch (default: latest release)')
  .option('--force', 'Overwrite existing directory')
  .action(async (options) => {
    const chalk = await import('chalk').then((m) => m.default);
    const ora = await import('ora').then((m) => m.default);
    const { downloadSource, verifySourceStructure } = await import('./core/source.js');

    console.log(chalk.bold('\n📦 Authrim Source Download\n'));

    const spinner = ora('Downloading source...').start();

    try {
      const result = await downloadSource({
        targetDir: options.output,
        repository: options.repo,
        gitRef: options.ref,
        force: options.force,
        onProgress: (msg) => {
          spinner.text = msg;
        },
      });

      spinner.succeed('Source downloaded successfully');

      console.log(chalk.bold('\nSource Information:'));
      console.log(`  Repository: ${chalk.cyan(result.repository)}`);
      console.log(`  Ref:        ${chalk.cyan(result.gitRef)}`);
      if (result.commitHash) {
        console.log(`  Commit:     ${chalk.gray(result.commitHash.slice(0, 8))}`);
      }
      console.log(`  Method:     ${chalk.gray(result.method)}`);
      console.log(`  Location:   ${chalk.cyan(options.output)}`);

      // Verify structure
      const verification = await verifySourceStructure(options.output);
      if (!verification.valid) {
        console.log(chalk.yellow('\n⚠️  Source verification warnings:'));
        for (const error of verification.errors) {
          console.log(chalk.yellow(`  • ${error}`));
        }
      } else {
        console.log(chalk.green('\n✓ Source structure verified'));
      }

      console.log(chalk.bold('\nNext steps:'));
      console.log(`  cd ${options.output}`);
      console.log('  pnpm install');
      console.log('  pnpm setup');
      console.log('');
    } catch (error) {
      spinner.fail('Download failed');
      console.error(chalk.red(`\nError: ${error}`));
      process.exitCode = 1;
    }
  });

program
  .command('delete')
  .description('Delete an Authrim environment and its resources')
  .option('--env <name>', 'Environment name to delete')
  .option('-y, --yes', 'Skip confirmation prompts (for CI)')
  .option('--no-workers', 'Keep Workers')
  .option('--no-d1', 'Keep D1 databases')
  .option('--no-kv', 'Keep KV namespaces')
  .option('--no-queues', 'Keep Queues')
  .option('--no-r2', 'Keep R2 buckets')
  .option('--all', 'Delete all resource types (default)')
  .action(deleteCommand);

program
  .command('info')
  .description('Display detailed information about Authrim resources')
  .option('--env <name>', 'Environment name')
  .option('--json', 'Output in JSON format (for scripting/CI)')
  .option('--d1', 'Show only D1 database information')
  .option('--workers', 'Show only Worker information')
  .action(infoCommand);

program
  .command('migrate')
  .description('Migrate from legacy flat file structure to new .authrim/{env}/ structure')
  .option('--env <name>', 'Migrate specific environment only')
  .option('--dry-run', 'Show what would be done without making changes')
  .option('--no-backup', 'Skip backup creation')
  .option('--delete-legacy', 'Delete legacy files after successful migration')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(migrateCommand);

program
  .command('migrate-status')
  .description('Show current directory structure status and migration recommendation')
  .action(migrateStatusCommand);

program.parse();
