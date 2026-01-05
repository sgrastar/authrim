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
import { initCommand } from './cli/commands/init.js';
import { deployCommand, statusCommand } from './cli/commands/deploy.js';
import { configCommand } from './cli/commands/config.js';

const program = new Command();

program
  .name('authrim-setup')
  .description('CLI tool for setting up Authrim OIDC Provider on Cloudflare Workers')
  .version('0.1.0');

program
  .command('init', { isDefault: true })
  .description('Initialize a new Authrim setup')
  .option('--cli', 'Use CLI mode instead of Web UI')
  .option('--config <path>', 'Load existing configuration file')
  .option('--keep <path>', 'Keep source files at specified path')
  .option('--env <name>', 'Environment name (prod, staging, dev)', 'prod')
  .action(initCommand);

program
  .command('deploy')
  .description('Deploy Authrim to Cloudflare')
  .option('--env <name>', 'Environment name')
  .option('--config <path>', 'Configuration file path', 'authrim-config.json')
  .option('--component <name>', 'Deploy a single component')
  .option('--dry-run', 'Show what would be deployed without actually deploying')
  .option('--skip-secrets', 'Skip uploading secrets')
  .option('--skip-ui', 'Skip UI deployment to Cloudflare Pages')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(deployCommand);

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
  .option('--config <path>', 'Configuration file path', 'authrim-config.json')
  .action(configCommand);

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

program.parse();
