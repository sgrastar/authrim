#!/usr/bin/env node
/**
 * @authrim/setup - CLI tool for setting up Authrim OIDC Provider
 *
 * Usage:
 *   npx @authrim/setup           # Start Web UI (default)
 *   npx @authrim/setup --cli     # Start CLI mode
 *   npx @authrim/setup --config ./authrim-config.json  # Load existing config
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
  .option('--config <path>', 'Configuration file path', 'authrim-config.json')
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
  .command('status')
  .description('Show deployment status')
  .option('--config <path>', 'Configuration file path', 'authrim-config.json')
  .action(statusCommand);

program
  .command('secrets')
  .description('Upload secrets to Cloudflare')
  .option('--env <name>', 'Environment name')
  .option('--config <path>', 'Configuration file path', 'authrim-config.json')
  .option('--keys-dir <path>', 'Keys directory', '.keys')
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
