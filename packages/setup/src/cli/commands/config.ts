/**
 * Config Command - Manage Authrim configuration
 *
 * Provides options to show, validate, and modify Authrim configuration.
 */

import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AuthrimConfigSchema, safeParseConfig, type AuthrimConfig } from '../../core/config.js';
import { loadLockFile, getLockFileSummary } from '../../core/lock.js';

// =============================================================================
// Types
// =============================================================================

export interface ConfigCommandOptions {
  show?: boolean;
  validate?: boolean;
  json?: boolean;
  config?: string;
}

// =============================================================================
// Config Command
// =============================================================================

export async function configCommand(options: ConfigCommandOptions): Promise<void> {
  const configPath = options.config || 'authrim-config.json';

  // Default to --show if no options provided
  if (!options.show && !options.validate) {
    options.show = true;
  }

  if (options.validate) {
    await validateConfig(configPath, options.json);
  } else if (options.show) {
    await showConfig(configPath, options.json);
  }
}

// =============================================================================
// Show Config
// =============================================================================

async function showConfig(configPath: string, jsonOutput?: boolean): Promise<void> {
  if (!existsSync(configPath)) {
    console.error(chalk.red(`Configuration file not found: ${configPath}`));
    console.log(chalk.yellow('\nRun "authrim-setup init" first to create a configuration.'));
    process.exitCode = 1;
    return;
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const data = JSON.parse(content);
    const config = AuthrimConfigSchema.parse(data);

    if (jsonOutput) {
      // Output raw JSON for scripting
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    // Pretty print configuration
    console.log(chalk.bold('\n📋 Authrim Configuration\n'));
    console.log(chalk.blue('━'.repeat(50)));

    // Basic info
    console.log(chalk.bold('\n📌 Basic Information'));
    console.log(`  Version:     ${chalk.cyan(config.version)}`);
    console.log(`  Created:     ${chalk.gray(config.createdAt || 'N/A')}`);
    console.log(`  Updated:     ${chalk.gray(config.updatedAt || 'N/A')}`);

    // Environment
    console.log(chalk.bold('\n🌍 Environment'));
    console.log(`  Prefix:      ${chalk.cyan(config.environment.prefix)}`);
    console.log(`  Profile:     ${chalk.cyan(config.profile)}`);

    // URLs
    if (config.urls) {
      console.log(chalk.bold('\n🌐 URLs'));
      const apiUrl = config.urls.api?.custom || config.urls.api?.auto || 'Not configured';
      const loginUrl = config.urls.loginUi?.custom || config.urls.loginUi?.auto || 'Not configured';
      const adminUrl = config.urls.adminUi?.custom || config.urls.adminUi?.auto || 'Not configured';

      console.log(`  API:         ${chalk.cyan(apiUrl)}`);
      console.log(`  Login UI:    ${chalk.cyan(loginUrl)}`);
      console.log(`  Admin UI:    ${chalk.cyan(adminUrl)}`);
    }

    // Tenant
    console.log(chalk.bold('\n👥 Tenant'));
    console.log(`  Name:        ${chalk.cyan(config.tenant.name)}`);
    console.log(`  Display:     ${chalk.cyan(config.tenant.displayName)}`);

    // Components
    console.log(chalk.bold('\n📦 Components'));
    const components = config.components;
    const componentStatus = (enabled: boolean) =>
      enabled ? chalk.green('✓ Enabled') : chalk.gray('○ Disabled');
    console.log(`  API:         ${componentStatus(components.api)}`);
    console.log(`  Login UI:    ${componentStatus(components.loginUi)}`);
    console.log(`  Admin UI:    ${componentStatus(components.adminUi)}`);
    console.log(`  SAML:        ${componentStatus(components.saml)}`);
    console.log(`  Async:       ${componentStatus(components.async)}`);
    console.log(`  VC:          ${componentStatus(components.vc)}`);
    console.log(`  Bridge:      ${componentStatus(components.bridge)}`);
    console.log(`  Policy:      ${componentStatus(components.policy)}`);

    // OIDC Settings
    console.log(chalk.bold('\n🔐 OIDC Settings'));
    console.log(`  Access Token TTL:   ${chalk.cyan(formatDuration(config.oidc.accessTokenTtl))}`);
    console.log(`  Refresh Token TTL:  ${chalk.cyan(formatDuration(config.oidc.refreshTokenTtl))}`);
    console.log(`  Auth Code TTL:      ${chalk.cyan(formatDuration(config.oidc.authCodeTtl))}`);
    console.log(
      `  PKCE Required:      ${config.oidc.pkceRequired ? chalk.green('Yes') : chalk.yellow('No')}`
    );
    console.log(`  Response Types:     ${chalk.cyan(config.oidc.responseTypes.join(', '))}`);
    console.log(`  Grant Types:        ${chalk.cyan(config.oidc.grantTypes.join(', '))}`);

    // Sharding
    console.log(chalk.bold('\n⚙️  Sharding'));
    console.log(`  Auth Code Shards:   ${chalk.cyan(config.sharding.authCodeShards)}`);
    console.log(`  Refresh Token Shards: ${chalk.cyan(config.sharding.refreshTokenShards)}`);

    // Features
    console.log(chalk.bold('\n🎛️  Features'));
    console.log(
      `  Queue:       ${config.features.queue?.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
    );
    console.log(
      `  R2:          ${config.features.r2?.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
    );
    console.log(`  Email:       ${chalk.cyan(config.features.email?.provider || 'none')}`);

    // Keys
    console.log(chalk.bold('\n🔑 Keys'));
    console.log(`  Key ID:      ${chalk.cyan(config.keys.keyId || 'Not configured')}`);
    console.log(`  Secrets Path: ${chalk.gray(config.keys.secretsPath)}`);

    // Cloudflare
    if (config.cloudflare?.accountId) {
      console.log(chalk.bold('\n☁️  Cloudflare'));
      console.log(`  Account ID:  ${chalk.cyan(config.cloudflare.accountId.slice(0, 8) + '...')}`);
    }

    // Lock file summary
    const lockPath = configPath.replace('authrim-config.json', 'authrim-lock.json');
    const lock = await loadLockFile(lockPath);
    if (lock) {
      console.log(chalk.bold('\n📦 Provisioned Resources'));
      console.log(`  D1 Databases:     ${chalk.cyan(Object.keys(lock.d1).length)}`);
      console.log(`  KV Namespaces:    ${chalk.cyan(Object.keys(lock.kv).length)}`);
      if (lock.queues) {
        console.log(`  Queues:           ${chalk.cyan(Object.keys(lock.queues).length)}`);
      }
      if (lock.r2) {
        console.log(`  R2 Buckets:       ${chalk.cyan(Object.keys(lock.r2).length)}`);
      }
      if (lock.workers) {
        const deployedWorkers = Object.values(lock.workers).filter((w) => w.deployedAt).length;
        console.log(`  Workers Deployed: ${chalk.cyan(deployedWorkers)}`);
      }
    }

    console.log(chalk.blue('\n' + '━'.repeat(50)));
    console.log('');
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(chalk.red(`Invalid JSON in configuration file: ${configPath}`));
    } else {
      console.error(chalk.red(`Failed to read configuration: ${error}`));
    }
    process.exitCode = 1;
  }
}

// =============================================================================
// Validate Config
// =============================================================================

async function validateConfig(configPath: string, jsonOutput?: boolean): Promise<void> {
  const spinner = ora(`Validating configuration: ${configPath}`).start();

  if (!existsSync(configPath)) {
    spinner.fail(`Configuration file not found: ${configPath}`);
    process.exitCode = 1;
    return;
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    let data: unknown;

    try {
      data = JSON.parse(content);
    } catch {
      spinner.fail('Invalid JSON format');
      console.error(chalk.red('\nThe configuration file is not valid JSON.'));
      process.exitCode = 1;
      return;
    }

    const result = safeParseConfig(data);

    if (result.success) {
      spinner.succeed('Configuration is valid');

      if (jsonOutput) {
        console.log(JSON.stringify({ valid: true, config: result.data }, null, 2));
      } else {
        console.log(chalk.green('\n✓ Configuration passed all validation checks'));
        console.log('');

        // Show some key info
        console.log(chalk.bold('Summary:'));
        console.log(`  Environment: ${chalk.cyan(result.data.environment.prefix)}`);
        console.log(`  Profile:     ${chalk.cyan(result.data.profile)}`);
        console.log(`  Version:     ${chalk.cyan(result.data.version)}`);
        console.log('');
      }
    } else {
      spinner.fail('Configuration validation failed');

      if (jsonOutput) {
        console.log(
          JSON.stringify(
            {
              valid: false,
              errors: result.error.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
              })),
            },
            null,
            2
          )
        );
      } else {
        console.log(chalk.red('\n✗ Configuration has validation errors:\n'));

        for (const error of result.error.errors) {
          const path = error.path.length > 0 ? error.path.join('.') : '(root)';
          console.log(chalk.red(`  • ${path}: ${error.message}`));
        }

        console.log('');
        console.log(chalk.yellow('Fix the errors above and run validation again.'));
        console.log('');
      }

      process.exitCode = 1;
    }
  } catch (error) {
    spinner.fail('Failed to validate configuration');
    console.error(chalk.red(`\nError: ${error}`));
    process.exitCode = 1;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  } else {
    const days = Math.floor(seconds / 86400);
    return `${days}d`;
  }
}
