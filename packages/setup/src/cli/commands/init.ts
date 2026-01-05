/**
 * Init Command - Setup wizard for Authrim
 *
 * Provides both CLI and Web UI modes for setting up Authrim.
 */

import { input, select, confirm, password } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDefaultConfig, parseConfig, type AuthrimConfig } from '../../core/config.js';
import { generateAllSecrets, saveKeysToDirectory, generateKeyId } from '../../core/keys.js';
import { generateWranglerConfig, toToml } from '../../core/wrangler.js';
import {
  getEnabledComponents,
  CORE_WORKER_COMPONENTS,
  type WorkerComponent,
} from '../../core/naming.js';
import {
  isWranglerInstalled,
  checkAuth,
  provisionResources,
  toResourceIds,
  uploadSecret,
  getAccountId,
} from '../../core/cloudflare.js';
import {
  createLockFile,
  saveLockFile,
  loadLockFile,
  lockToResourceIds,
  getLockFileSummary,
} from '../../core/lock.js';
import {
  downloadSource,
  verifySourceStructure,
} from '../../core/source.js';

// =============================================================================
// Types
// =============================================================================

interface InitOptions {
  cli?: boolean;
  config?: string;
  keep?: string;
  env?: string;
}

// =============================================================================
// Banner
// =============================================================================

function printBanner(): void {
  console.log('');
  console.log(chalk.blue('╔═══════════════════════════════════════════════════════════╗'));
  console.log(
    chalk.blue('║') +
      chalk.bold.white('           🔐 Authrim Setup v0.1.0                        ') +
      chalk.blue('║')
  );
  console.log(
    chalk.blue('║') +
      chalk.gray('     OIDC Provider on Cloudflare Workers                  ') +
      chalk.blue('║')
  );
  console.log(chalk.blue('╚═══════════════════════════════════════════════════════════╝'));
  console.log('');
}

// =============================================================================
// Source Directory Detection
// =============================================================================

/**
 * Check if we're in a valid Authrim source directory
 */
function isAuthrimSourceDir(dir: string = '.'): boolean {
  const requiredPaths = [
    'packages/ar-auth',
    'packages/ar-token',
    'packages/ar-lib-core',
    'package.json',
  ];

  for (const path of requiredPaths) {
    if (!existsSync(join(dir, path))) {
      return false;
    }
  }
  return true;
}

/**
 * Ensure Authrim source is available, downloading if necessary
 */
async function ensureAuthrimSource(options: InitOptions): Promise<string> {
  const currentDir = resolve('.');

  // Check if we're already in an Authrim source directory
  if (isAuthrimSourceDir(currentDir)) {
    return currentDir;
  }

  // Check if --keep path exists and is valid
  if (options.keep && isAuthrimSourceDir(options.keep)) {
    return resolve(options.keep);
  }

  // Need to download source
  console.log('');
  console.log(chalk.yellow('⚠️  Authrim source code not found'));
  console.log('');

  const targetDir = options.keep || './authrim';

  const shouldDownload = await confirm({
    message: `Download source code to ${targetDir}?`,
    default: true,
  });

  if (!shouldDownload) {
    console.log(chalk.gray('\nCancelled.'));
    console.log(chalk.gray('To clone manually:'));
    console.log(chalk.cyan('  git clone https://github.com/sgrastar/authrim'));
    console.log('');
    process.exit(0);
  }

  // Download source
  const spinner = ora('Downloading source code...').start();

  try {
    const result = await downloadSource({
      targetDir,
      onProgress: (msg) => {
        spinner.text = msg;
      },
    });

    spinner.succeed(`Source code downloaded (${result.gitRef})`);

    // Verify structure
    const verification = await verifySourceStructure(targetDir);
    if (!verification.valid) {
      console.log(chalk.yellow('\n⚠️  Source structure verification warnings:'));
      for (const error of verification.errors) {
        console.log(chalk.yellow(`  • ${error}`));
      }
    }

    return resolve(targetDir);
  } catch (error) {
    spinner.fail('Download failed');
    console.error(chalk.red(`\nError: ${error}`));
    process.exit(1);
  }
}

// =============================================================================
// Main Command
// =============================================================================

export async function initCommand(options: InitOptions): Promise<void> {
  printBanner();

  // Load existing config if provided
  if (options.config) {
    await handleExistingConfig(options.config);
    return;
  }

  // If --cli flag is provided, skip the startup menu
  if (options.cli) {
    const sourceDir = await ensureAuthrimSource(options);
    process.chdir(sourceDir);
    await runCliSetup(options);
    return;
  }

  // Show startup menu
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log('  Set up Authrim OIDC Provider on Cloudflare Workers.');
  console.log('');
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  const startupChoice = await select({
    message: 'Choose setup method',
    choices: [
      {
        value: 'webui',
        name: '🌐 Web UI (Recommended)',
        description: 'Interactive setup in your browser',
      },
      {
        value: 'cli',
        name: '⌨️  CLI Mode',
        description: 'Interactive setup in terminal',
      },
      {
        value: 'cancel',
        name: '❌ Cancel',
        description: 'Exit setup',
      },
    ],
  });

  if (startupChoice === 'cancel') {
    console.log('');
    console.log(chalk.gray('Setup cancelled.'));
    console.log('');
    console.log(chalk.gray('To resume later:'));
    console.log(chalk.cyan('  npx @authrim/setup'));
    console.log('');
    return;
  }

  // Ensure source is available
  const sourceDir = await ensureAuthrimSource(options);
  process.chdir(sourceDir);

  if (startupChoice === 'cli') {
    await runCliSetup(options);
  } else {
    // Start Web UI
    console.log('');
    console.log(chalk.cyan('🌐 Starting Web UI...'));
    console.log('');

    const { startWebServer } = await import('../../web/server.js');
    await startWebServer({ openBrowser: true });
  }
}

// =============================================================================
// CLI Setup Flow
// =============================================================================

async function runCliSetup(options: InitOptions): Promise<void> {
  // Step 1: Choose setup mode
  const setupMode = await select({
    message: 'Choose setup mode',
    choices: [
      {
        value: 'quick',
        name: '⚡ Quick Setup (5 minutes)',
        description: 'Deploy Authrim with minimal configuration',
      },
      {
        value: 'normal',
        name: '🔧 Custom Setup',
        description: 'Configure all options step by step',
      },
    ],
  });

  if (setupMode === 'quick') {
    await runQuickSetup(options);
  } else {
    await runNormalSetup(options);
  }
}

// =============================================================================
// Quick Setup
// =============================================================================

async function runQuickSetup(options: InitOptions): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('⚡ Quick Setup'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 1: Environment prefix
  const envPrefix = await select({
    message: 'Select environment',
    choices: [
      { value: 'prod', name: 'prod (Production)' },
      { value: 'staging', name: 'staging (Staging)' },
      { value: 'dev', name: 'dev (Development)' },
    ],
    default: options.env || 'prod',
  });

  // Step 2: Cloudflare API Token
  const cfApiToken = await password({
    message: 'Enter Cloudflare API Token',
    mask: '*',
    validate: (value) => {
      if (!value || value.length < 10) {
        return 'Please enter a valid API Token';
      }
      return true;
    },
  });

  // Step 3: Domain configuration
  const useCustomDomain = await confirm({
    message: 'Configure custom domain?',
    default: false,
  });

  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;

  if (useCustomDomain) {
    apiDomain = await input({
      message: 'API (issuer) domain',
      validate: (value) => {
        if (!value) return true; // Allow empty for workers.dev fallback
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
          return 'Please enter a valid domain (e.g., auth.example.com)';
        }
        return true;
      },
    });

    loginUiDomain = await input({
      message: 'Login UI domain (Enter to skip)',
      default: '',
    });

    adminUiDomain = await input({
      message: 'Admin UI domain (Enter to skip)',
      default: '',
    });
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.urls = {
    api: {
      custom: apiDomain || null,
      auto: `https://${envPrefix}-ar-router.workers.dev`, // Placeholder
    },
    loginUi: {
      custom: loginUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev`,
    },
    adminUi: {
      custom: adminUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev/admin`,
    },
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📋 Configuration Summary'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(`  Environment: ${chalk.cyan(envPrefix)}`);
  console.log(`  API URL:     ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`);
  console.log(
    `  Login UI:    ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  Admin UI:    ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');

  const proceed = await confirm({
    message: 'Start setup with this configuration?',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  // Run setup
  await executeSetup(config, cfApiToken, options.keep);
}

// =============================================================================
// Normal Setup
// =============================================================================

async function runNormalSetup(options: InitOptions): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('🔧 Custom Setup'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 1: Environment prefix
  const envPrefix = await input({
    message: 'Enter environment prefix',
    default: options.env || 'prod',
    validate: (value) => {
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        return 'Only lowercase alphanumeric and hyphens allowed (e.g., prod, staging, dev)';
      }
      return true;
    },
  });

  // Step 2: Cloudflare API Token
  const cfApiToken = await password({
    message: 'Enter Cloudflare API Token',
    mask: '*',
    validate: (value) => {
      if (!value || value.length < 10) {
        return 'Please enter a valid API Token';
      }
      return true;
    },
  });

  // Step 3: Profile selection
  const profile = await select({
    message: 'Select OIDC profile',
    choices: [
      {
        value: 'basic-op',
        name: 'Basic OP (Standard OIDC Provider)',
        description: 'Standard OIDC features',
      },
      {
        value: 'fapi-rw',
        name: 'FAPI Read-Write (Financial Grade)',
        description: 'FAPI 1.0 Read-Write Security Profile compliant',
      },
      {
        value: 'fapi2-security',
        name: 'FAPI 2.0 Security Profile',
        description: 'FAPI 2.0 Security Profile compliant (highest security)',
      },
    ],
    default: 'basic-op',
  });

  // Step 4: Domain configuration
  const useCustomDomain = await confirm({
    message: 'Configure custom domain?',
    default: false,
  });

  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;

  if (useCustomDomain) {
    apiDomain = await input({
      message: 'API (issuer) domain',
      validate: (value) => {
        if (!value) return true;
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
          return 'Please enter a valid domain';
        }
        return true;
      },
    });

    loginUiDomain = await input({
      message: 'Login UI domain (Enter to skip)',
      default: '',
    });

    adminUiDomain = await input({
      message: 'Admin UI domain (Enter to skip)',
      default: '',
    });
  }

  // Step 5: Optional components
  console.log('');
  console.log(chalk.blue('━━━ Optional Components ━━━'));
  console.log('');

  const enableSaml = await confirm({
    message: 'Enable SAML support?',
    default: false,
  });

  const enableVc = await confirm({
    message: 'Enable Verifiable Credentials?',
    default: false,
  });

  const enableBridge = await confirm({
    message: 'Enable External IdP Bridge?',
    default: false,
  });

  const enablePolicy = await confirm({
    message: 'Enable ReBAC Policy service?',
    default: false,
  });

  // Step 6: Feature flags
  console.log('');
  console.log(chalk.blue('━━━ Feature Flags ━━━'));
  console.log('');

  const enableQueue = await confirm({
    message: 'Enable Cloudflare Queues? (for audit logs)',
    default: false,
  });

  const enableR2 = await confirm({
    message: 'Enable Cloudflare R2? (for avatars)',
    default: false,
  });

  const emailProvider = await select({
    message: 'Select email provider',
    choices: [
      { value: 'none', name: 'None (email disabled)' },
      { value: 'resend', name: 'Resend' },
      { value: 'sendgrid', name: 'SendGrid' },
      { value: 'ses', name: 'AWS SES' },
    ],
    default: 'none',
  });

  // Step 7: Advanced OIDC settings
  const configureOidc = await confirm({
    message: 'Configure OIDC settings? (token TTL, etc.)',
    default: false,
  });

  let accessTokenTtl = 3600; // 1 hour
  let refreshTokenTtl = 604800; // 7 days
  let authCodeTtl = 600; // 10 minutes
  let pkceRequired = true;

  if (configureOidc) {
    console.log('');
    console.log(chalk.blue('━━━ OIDC Settings ━━━'));
    console.log('');

    const accessTokenTtlStr = await input({
      message: 'Access Token TTL (sec)',
      default: '3600',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
        return true;
      },
    });
    accessTokenTtl = parseInt(accessTokenTtlStr, 10);

    const refreshTokenTtlStr = await input({
      message: 'Refresh Token TTL (sec)',
      default: '604800',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
        return true;
      },
    });
    refreshTokenTtl = parseInt(refreshTokenTtlStr, 10);

    const authCodeTtlStr = await input({
      message: 'Authorization Code TTL (sec)',
      default: '600',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
        return true;
      },
    });
    authCodeTtl = parseInt(authCodeTtlStr, 10);

    pkceRequired = await confirm({
      message: 'Require PKCE?',
      default: true,
    });
  }

  // Step 8: Sharding settings
  const configureSharding = await confirm({
    message: 'Configure sharding? (for high-load environments)',
    default: false,
  });

  let authCodeShards = 64;
  let refreshTokenShards = 8;

  if (configureSharding) {
    console.log('');
    console.log(chalk.blue('━━━ Sharding Settings ━━━'));
    console.log(chalk.gray('  Note: Power of 2 recommended for shard count (8, 16, 32, 64, 128)'));
    console.log('');

    const authCodeShardsStr = await input({
      message: 'Auth Code shard count',
      default: '64',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
        return true;
      },
    });
    authCodeShards = parseInt(authCodeShardsStr, 10);

    const refreshTokenShardsStr = await input({
      message: 'Refresh Token shard count',
      default: '8',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
        return true;
      },
    });
    refreshTokenShards = parseInt(refreshTokenShardsStr, 10);
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.profile = profile as 'basic-op' | 'fapi-rw' | 'fapi2-security';
  config.components = {
    ...config.components,
    saml: enableSaml,
    async: enableQueue, // async is tied to queue
    vc: enableVc,
    bridge: enableBridge,
    policy: enablePolicy,
  };
  config.urls = {
    api: {
      custom: apiDomain || null,
      auto: `https://${envPrefix}-ar-router.workers.dev`,
    },
    loginUi: {
      custom: loginUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev`,
    },
    adminUi: {
      custom: adminUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev/admin`,
    },
  };
  config.oidc = {
    ...config.oidc,
    accessTokenTtl,
    refreshTokenTtl,
    authCodeTtl,
    pkceRequired,
  };
  config.sharding = {
    authCodeShards,
    refreshTokenShards,
  };
  config.features = {
    queue: { enabled: enableQueue },
    r2: { enabled: enableR2 },
    email: { provider: emailProvider as 'none' | 'resend' | 'sendgrid' | 'ses' },
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📋 Configuration Summary'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(chalk.bold('Basic Settings:'));
  console.log(`  Environment:          ${chalk.cyan(envPrefix)}`);
  console.log(`  Profile:   ${chalk.cyan(profile)}`);
  console.log('');
  console.log(chalk.bold('URL Settings:'));
  console.log(`  API URL:       ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`);
  console.log(
    `  Login UI:      ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  Admin UI:      ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');
  console.log(chalk.bold('Components:'));
  console.log(`  SAML:          ${enableSaml ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  VC:            ${enableVc ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  Bridge:        ${enableBridge ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  Policy:        ${enablePolicy ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log('');
  console.log(chalk.bold('Feature Flags:'));
  console.log(`  Queue:         ${enableQueue ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  R2:            ${enableR2 ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  Email:         ${chalk.cyan(emailProvider)}`);
  console.log('');
  console.log(chalk.bold('OIDC Settings:'));
  console.log(`  Access TTL:    ${chalk.cyan(accessTokenTtl + 'sec')}`);
  console.log(`  Refresh TTL:   ${chalk.cyan(refreshTokenTtl + 'sec')}`);
  console.log(`  Auth Code TTL: ${chalk.cyan(authCodeTtl + 'sec')}`);
  console.log(`  PKCE Required:      ${pkceRequired ? chalk.green('Yes') : chalk.yellow('No')}`);
  console.log('');
  console.log(chalk.bold('Sharding:'));
  console.log(`  Auth Code:     ${chalk.cyan(authCodeShards)} shards`);
  console.log(`  Refresh Token: ${chalk.cyan(refreshTokenShards)} shards`);
  console.log('');

  const proceed = await confirm({
    message: 'Start setup with this configuration?',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  await executeSetup(config, cfApiToken, options.keep);
}

// =============================================================================
// Execute Setup
// =============================================================================

async function executeSetup(
  config: AuthrimConfig,
  cfApiToken: string,
  keepPath?: string
): Promise<void> {
  const outputDir = keepPath || '.';
  const env = config.environment.prefix;
  let secrets: ReturnType<typeof generateAllSecrets> | null = null;

  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('🚀 Running Setup...'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 0: Check wrangler and auth
  const wranglerCheck = ora('Checking wrangler status...').start();
  try {
    const installed = await isWranglerInstalled();
    if (!installed) {
      wranglerCheck.fail('wrangler is not installed');
      console.log(chalk.yellow('  npm install -g wrangler  to install'));
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail('Not logged in to Cloudflare');
      console.log(chalk.yellow('  wrangler login  to install'));
      return;
    }

    wranglerCheck.succeed(`Connected to Cloudflare (${auth.email || 'authenticated'})`);

    // Get account ID and update auto URLs
    const accountId = await getAccountId();
    if (accountId) {
      config.cloudflare = { accountId };
    }
  } catch (error) {
    wranglerCheck.fail('Failed to check wrangler');
    console.error(error);
    return;
  }

  // Step 1: Generate keys
  const keysSpinner = ora('Generating cryptographic keys...').start();
  try {
    const keyId = generateKeyId(env);
    secrets = generateAllSecrets(keyId);
    const keysDir = join(outputDir, '.keys');
    await saveKeysToDirectory(secrets, keysDir);

    config.keys = {
      keyId: secrets.keyPair.keyId,
      publicKeyJwk: secrets.keyPair.publicKeyJwk as Record<string, unknown>,
      secretsPath: './.keys/',
      includeSecrets: false,
    };

    keysSpinner.succeed(`Keys generated (${keysDir})`);
  } catch (error) {
    keysSpinner.fail('Failed to generate keys');
    throw error;
  }

  // Step 2: Provision Cloudflare resources
  console.log('');
  console.log(chalk.blue('⏳ Creating Cloudflare resources...'));
  console.log('');

  let provisionedResources;
  try {
    provisionedResources = await provisionResources({
      env,
      createD1: true,
      createKV: true,
      createQueues: config.features.queue?.enabled,
      createR2: config.features.r2?.enabled,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
  } catch (error) {
    console.log(chalk.red('  ✗ Failed to create resources'));
    console.error(error);

    // Ask if user wants to continue without provisioning
    const continueWithoutProvisioning = await confirm({
      message: 'Continue without provisioning? (you will need to create resources manually)',
      default: false,
    });

    if (!continueWithoutProvisioning) {
      return;
    }

    // Create empty resources
    provisionedResources = { d1: [], kv: [], queues: [], r2: [] };
  }

  // Step 3: Create lock file
  const lockSpinner = ora('authrim-lock.json generating...').start();
  try {
    const lockFile = createLockFile(env, provisionedResources);
    const lockPath = join(outputDir, 'authrim-lock.json');
    await saveLockFile(lockFile, lockPath);
    lockSpinner.succeed(`authrim-lock.json saved (${lockPath})`);
  } catch (error) {
    lockSpinner.fail('authrim-lock.json save failed');
    console.error(error);
  }

  // Step 4: Save configuration
  const configSpinner = ora('Saving configuration...').start();
  try {
    const configPath = join(outputDir, 'authrim-config.json');
    config.updatedAt = new Date().toISOString();
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    configSpinner.succeed(`Configuration saved (${configPath})`);
  } catch (error) {
    configSpinner.fail('Configuration save failed');
    throw error;
  }

  // Step 5: Generate wrangler.toml files (if keeping source or in existing repo)
  const resourceIds = toResourceIds(provisionedResources);
  const packagesDir = join(outputDir, 'packages');

  if (existsSync(packagesDir)) {
    const wranglerSpinner = ora('Generating wrangler.toml files...').start();
    try {
      for (const component of CORE_WORKER_COMPONENTS) {
        const componentDir = join(packagesDir, component);
        if (!existsSync(componentDir)) {
          continue; // Skip if component directory doesn't exist
        }

        const wranglerConfig = generateWranglerConfig(component, config, resourceIds);
        const tomlContent = toToml(wranglerConfig);
        const tomlPath = join(componentDir, `wrangler.${env}.toml`);
        await writeFile(tomlPath, tomlContent, 'utf-8');
      }

      wranglerSpinner.succeed('wrangler.toml files generated');
    } catch (error) {
      wranglerSpinner.fail('wrangler.toml generation failed');
      console.error(error);
    }
  }

  // Summary
  console.log('');
  console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold.green('🎉 Setup Complete！'));
  console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Show provisioned resources
  if (provisionedResources.d1.length > 0 || provisionedResources.kv.length > 0) {
    console.log(chalk.bold('📦 Created Resources:'));
    console.log('');

    if (provisionedResources.d1.length > 0) {
      console.log('  D1 Databases:');
      for (const db of provisionedResources.d1) {
        console.log(`    ✓ ${db.name} (${db.id.slice(0, 8)}...)`);
      }
    }

    if (provisionedResources.kv.length > 0) {
      console.log('  KV Namespaces:');
      for (const kv of provisionedResources.kv) {
        console.log(`    ✓ ${kv.name} (${kv.id.slice(0, 8)}...)`);
      }
    }

    console.log('');
  }

  console.log(chalk.bold('📁 Generated Files:'));
  console.log(`  - ${join(outputDir, 'authrim-config.json')}`);
  console.log(`  - ${join(outputDir, 'authrim-lock.json')}`);
  console.log(`  - ${join(outputDir, '.keys/')} ${chalk.gray('(private keys - add to .gitignore)')}`);
  console.log('');

  // Show URLs
  console.log(chalk.bold('🌐 Endpoints:'));
  const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
  const loginUrl = config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || '';
  const adminUrl = config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || '';
  console.log(`  OIDC Provider: ${chalk.cyan(apiUrl)}`);
  console.log(`  Login UI:      ${chalk.cyan(loginUrl)}`);
  console.log(`  Admin UI:      ${chalk.cyan(adminUrl)}`);
  console.log('');

  // Next steps
  console.log(chalk.bold('📋 Next Steps:'));
  console.log('');
  console.log(`  1. Upload secrets to Cloudflare:`);
  console.log(chalk.cyan(`     npx @authrim/setup secrets --env=${env}`));
  console.log('');
  console.log(`  2. Deploy Workers:`);
  console.log(chalk.cyan(`     pnpm deploy --env=${env}`));
  console.log('');
}

// =============================================================================
// Handle Existing Config
// =============================================================================

async function handleExistingConfig(configPath: string): Promise<void> {
  const spinner = ora(`Loading configuration: ${configPath}`).start();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = parseConfig(JSON.parse(content));
    spinner.succeed('Configuration loaded');

    console.log('');
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('📋 Configuration Summary'));
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(`  Environment:        ${chalk.cyan(config.environment.prefix)}`);
    console.log(`  Profile: ${chalk.cyan(config.profile)}`);
    console.log(`  Version:   ${chalk.cyan(config.version)}`);
    if (config.urls?.api) {
      const apiUrl = config.urls.api.custom || config.urls.api.auto;
      console.log(`  API URL:     ${chalk.cyan(apiUrl || 'Not configured')}`);
    }
    console.log('');

    const action = await select({
      message: 'Select action',
      choices: [
        { value: 'deploy', name: '🚀 Redeploy' },
        { value: 'edit', name: '✏️  Edit config' },
        { value: 'show', name: '📋 Show config' },
        { value: 'cancel', name: '❌ Cancel' },
      ],
    });

    switch (action) {
      case 'deploy':
        await handleRedeploy(config, configPath);
        break;
      case 'edit':
        await handleEditConfig(config, configPath);
        break;
      case 'show':
        console.log('');
        console.log(JSON.stringify(config, null, 2));
        break;
      case 'cancel':
        console.log(chalk.yellow('Cancelled.'));
        break;
    }
  } catch (error) {
    spinner.fail('Failed to load configuration');
    console.error(error);
  }
}

// =============================================================================
// Redeploy from Existing Config
// =============================================================================

async function handleRedeploy(config: AuthrimConfig, configPath: string): Promise<void> {
  const env = config.environment.prefix;
  const lockPath = configPath.replace('authrim-config.json', 'authrim-lock.json');

  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('🚀 Redeploy'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Check prerequisites
  const wranglerCheck = ora('Checking wrangler status...').start();
  try {
    const installed = await isWranglerInstalled();
    if (!installed) {
      wranglerCheck.fail('wrangler is not installed');
      console.log(chalk.yellow('  npm install -g wrangler  to install'));
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail('Not logged in to Cloudflare');
      console.log(chalk.yellow('  wrangler login  to install'));
      return;
    }

    wranglerCheck.succeed(`Connected to Cloudflare (${auth.email || 'authenticated'})`);
  } catch (error) {
    wranglerCheck.fail('Failed to check wrangler');
    console.error(error);
    return;
  }

  // Load lock file
  const lock = await loadLockFile(lockPath);
  const hasLock = lock !== null;

  if (!hasLock) {
    console.log(chalk.yellow('\n⚠️  authrim-lock.json not found'));
    const createResources = await confirm({
      message: 'Create new Cloudflare resources?',
      default: true,
    });

    if (!createResources) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }

    // Provision new resources
    console.log('');
    console.log(chalk.blue('⏳ Creating Cloudflare resources...'));
    console.log('');

    try {
      const provisionedResources = await provisionResources({
        env,
        createD1: true,
        createKV: true,
        createQueues: config.features.queue?.enabled,
        createR2: config.features.r2?.enabled,
        onProgress: (msg) => console.log(`  ${msg}`),
      });

      // Create and save lock file
      const newLock = createLockFile(env, provisionedResources);
      await saveLockFile(newLock, lockPath);
      console.log(chalk.green(`\n✓ authrim-lock.json saved`));
    } catch (error) {
      console.log(chalk.red('  ✗ Failed to create resources'));
      console.error(error);
      return;
    }
  } else {
    // Show existing resources summary
    console.log(chalk.bold('\n📦 Existing Resources:'));
    console.log(`  D1 Databases:  ${chalk.cyan(Object.keys(lock.d1).length)}`);
    console.log(`  KV Namespaces: ${chalk.cyan(Object.keys(lock.kv).length)}`);
    if (lock.workers) {
      const deployedCount = Object.values(lock.workers).filter((w) => w.deployedAt).length;
      console.log(`  Workers:       ${chalk.cyan(deployedCount)} deployed`);
    }
  }

  // Determine components to deploy
  const enabledComponents: string[] = ['ar-lib-core', 'ar-discovery'];
  enabledComponents.push('ar-auth', 'ar-token', 'ar-userinfo', 'ar-management');

  if (config.components.saml) enabledComponents.push('ar-saml');
  if (config.components.async) enabledComponents.push('ar-async');
  if (config.components.vc) enabledComponents.push('ar-vc');
  if (config.components.bridge) enabledComponents.push('ar-bridge');
  if (config.components.policy) enabledComponents.push('ar-policy');

  enabledComponents.push('ar-router');

  console.log(chalk.bold('\n📋 Components to Deploy:'));
  for (const comp of enabledComponents) {
    console.log(chalk.cyan(`  • ${comp}`));
  }
  console.log('');

  // Confirm deployment
  const proceed = await confirm({
    message: 'Start deployment?',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('Cancelled.'));
    return;
  }

  // Run deploy using the deploy command
  console.log('');
  const { deployCommand } = await import('./deploy.js');
  await deployCommand({
    config: configPath,
    env,
    yes: true,
  });
}

// =============================================================================
// Edit Existing Config
// =============================================================================

async function handleEditConfig(config: AuthrimConfig, configPath: string): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('✏️  Edit Configuration'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  const editSection = await select({
    message: 'Select section to edit',
    choices: [
      { value: 'urls', name: '🌐 URL Settings' },
      { value: 'components', name: '📦 Components' },
      { value: 'profile', name: '🔐 OIDCProfile' },
      { value: 'oidc', name: '⚙️  OIDC Settings (TTL, etc.)' },
      { value: 'features', name: '🎛️  Feature Flags' },
      { value: 'sharding', name: '⚡ Sharding Settings' },
      { value: 'cancel', name: '❌ Cancel' },
    ],
  });

  if (editSection === 'cancel') {
    console.log(chalk.yellow('Cancelled.'));
    return;
  }

  let configModified = false;

  switch (editSection) {
    case 'urls':
      configModified = await editUrls(config);
      break;
    case 'components':
      configModified = await editComponents(config);
      break;
    case 'profile':
      configModified = await editProfile(config);
      break;
    case 'oidc':
      configModified = await editOidcSettings(config);
      break;
    case 'features':
      configModified = await editFeatures(config);
      break;
    case 'sharding':
      configModified = await editSharding(config);
      break;
  }

  if (configModified) {
    config.updatedAt = new Date().toISOString();

    const saveChanges = await confirm({
      message: 'Save changes?',
      default: true,
    });

    if (saveChanges) {
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log(chalk.green(`\n✓ Configuration saved: ${configPath}`));

      const redeploy = await confirm({
        message: 'Redeploy to apply changes?',
        default: false,
      });

      if (redeploy) {
        await handleRedeploy(config, configPath);
      }
    } else {
      console.log(chalk.yellow('Changes were not saved.'));
    }
  }
}

// =============================================================================
// Edit URL Configuration
// =============================================================================

async function editUrls(config: AuthrimConfig): Promise<boolean> {
  const env = config.environment.prefix;

  // Ensure urls object exists
  if (!config.urls) {
    config.urls = {
      api: { custom: null, auto: `https://${env}-ar-router.workers.dev` },
      loginUi: { custom: null, auto: `https://${env}-ar-ui.pages.dev` },
      adminUi: { custom: null, auto: `https://${env}-ar-ui.pages.dev/admin` },
    };
  }

  console.log(chalk.bold('\nCurrent URL Settings:'));
  console.log(
    `  API:      ${chalk.cyan(config.urls.api?.custom || config.urls.api?.auto || 'Not set')}`
  );
  console.log(
    `  Login UI: ${chalk.cyan(config.urls.loginUi?.custom || config.urls.loginUi?.auto || 'Not set')}`
  );
  console.log(
    `  Admin UI: ${chalk.cyan(config.urls.adminUi?.custom || config.urls.adminUi?.auto || 'Not set')}`
  );
  console.log('');

  const apiDomain = await input({
    message: 'API (issuer) domain (leave empty for workers.dev)',
    default: config.urls.api?.custom || '',
    validate: (value) => {
      if (!value) return true;
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
        return 'Please enter a valid domain';
      }
      return true;
    },
  });

  const loginUiDomain = await input({
    message: 'Login UI domain (leave empty for pages.dev)',
    default: config.urls.loginUi?.custom || '',
  });

  const adminUiDomain = await input({
    message: 'Admin UI domain (leave empty for pages.dev)',
    default: config.urls.adminUi?.custom || '',
  });

  config.urls.api = {
    custom: apiDomain || null,
    auto: config.urls.api?.auto || `https://${env}-ar-router.workers.dev`,
  };
  config.urls.loginUi = {
    custom: loginUiDomain || null,
    auto: config.urls.loginUi?.auto || `https://${env}-ar-ui.pages.dev`,
  };
  config.urls.adminUi = {
    custom: adminUiDomain || null,
    auto: config.urls.adminUi?.auto || `https://${env}-ar-ui.pages.dev/admin`,
  };

  return true;
}

// =============================================================================
// Edit Components
// =============================================================================

async function editComponents(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\nCurrent Component Settings:'));
  console.log(`  SAML:    ${config.components.saml ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  Async:   ${config.components.async ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  VC:      ${config.components.vc ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  Bridge:  ${config.components.bridge ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  Policy:  ${config.components.policy ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log('');

  config.components.saml = await confirm({
    message: 'Enable SAML support?',
    default: config.components.saml,
  });

  config.components.async = await confirm({
    message: 'Enable async processing (Queue)?',
    default: config.components.async,
  });

  config.components.vc = await confirm({
    message: 'Enable Verifiable Credentials?',
    default: config.components.vc,
  });

  config.components.bridge = await confirm({
    message: 'Enable External IdP Bridge?',
    default: config.components.bridge,
  });

  config.components.policy = await confirm({
    message: 'Enable ReBAC Policy service?',
    default: config.components.policy,
  });

  return true;
}

// =============================================================================
// Edit Profile
// =============================================================================

async function editProfile(config: AuthrimConfig): Promise<boolean> {
  console.log(`\nCurrent profile: ${chalk.cyan(config.profile)}`);
  console.log('');

  const profile = await select({
    message: 'Select OIDC profile',
    choices: [
      {
        value: 'basic-op',
        name: 'Basic OP (Standard OIDC Provider)',
        description: 'Standard OIDC features',
      },
      {
        value: 'fapi-rw',
        name: 'FAPI Read-Write (Financial Grade)',
        description: 'FAPI 1.0 Read-Write Security Profile compliant',
      },
      {
        value: 'fapi2-security',
        name: 'FAPI 2.0 Security Profile',
        description: 'FAPI 2.0 Security Profile compliant (highest security)',
      },
    ],
    default: config.profile,
  });

  config.profile = profile as 'basic-op' | 'fapi-rw' | 'fapi2-security';
  return true;
}

// =============================================================================
// Edit OIDC Settings
// =============================================================================

async function editOidcSettings(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\nCurrent OIDC Settings:'));
  console.log(`  Access Token TTL:  ${chalk.cyan(config.oidc.accessTokenTtl)}sec`);
  console.log(`  Refresh Token TTL: ${chalk.cyan(config.oidc.refreshTokenTtl)}sec`);
  console.log(`  Auth Code TTL:     ${chalk.cyan(config.oidc.authCodeTtl)}sec`);
  console.log(
    `  PKCE Required:     ${config.oidc.pkceRequired ? chalk.green('Yes') : chalk.yellow('No')}`
  );
  console.log('');

  const accessTokenTtl = await input({
    message: 'Access Token TTL (sec)',
    default: String(config.oidc.accessTokenTtl),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
      return true;
    },
  });

  const refreshTokenTtl = await input({
    message: 'Refresh Token TTL (sec)',
    default: String(config.oidc.refreshTokenTtl),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
      return true;
    },
  });

  const authCodeTtl = await input({
    message: 'Authorization Code TTL (sec)',
    default: String(config.oidc.authCodeTtl),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
      return true;
    },
  });

  const pkceRequired = await confirm({
    message: 'Require PKCE?',
    default: config.oidc.pkceRequired,
  });

  config.oidc.accessTokenTtl = parseInt(accessTokenTtl, 10);
  config.oidc.refreshTokenTtl = parseInt(refreshTokenTtl, 10);
  config.oidc.authCodeTtl = parseInt(authCodeTtl, 10);
  config.oidc.pkceRequired = pkceRequired;

  return true;
}

// =============================================================================
// Edit Features
// =============================================================================

async function editFeatures(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\nCurrent Feature Flags:'));
  console.log(
    `  Queue:  ${config.features.queue?.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
  );
  console.log(
    `  R2:     ${config.features.r2?.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
  );
  console.log(`  Email:  ${chalk.cyan(config.features.email?.provider || 'none')}`);
  console.log('');

  const queueEnabled = await confirm({
    message: 'Enable Cloudflare Queues? (for audit logs)',
    default: config.features.queue?.enabled || false,
  });

  const r2Enabled = await confirm({
    message: 'Enable Cloudflare R2? (for avatars)',
    default: config.features.r2?.enabled || false,
  });

  const emailProvider = await select({
    message: 'Select email provider',
    choices: [
      { value: 'none', name: 'None (email disabled)' },
      { value: 'resend', name: 'Resend' },
      { value: 'sendgrid', name: 'SendGrid' },
      { value: 'ses', name: 'AWS SES' },
    ],
    default: config.features.email?.provider || 'none',
  });

  config.features.queue = { enabled: queueEnabled };
  config.features.r2 = { enabled: r2Enabled };
  config.features.email = { provider: emailProvider as 'none' | 'resend' | 'sendgrid' | 'ses' };

  return true;
}

// =============================================================================
// Edit Sharding
// =============================================================================

async function editSharding(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\nCurrent Sharding Settings:'));
  console.log(`  Auth Code Shards:    ${chalk.cyan(config.sharding.authCodeShards)}`);
  console.log(`  Refresh Token Shards: ${chalk.cyan(config.sharding.refreshTokenShards)}`);
  console.log('');
  console.log(chalk.gray('  Note: Power of 2 recommended for shard count (8, 16, 32, 64, 128)'));
  console.log('');

  const authCodeShards = await input({
    message: 'Auth Code shard count',
    default: String(config.sharding.authCodeShards),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
      return true;
    },
  });

  const refreshTokenShards = await input({
    message: 'Refresh Token shard count',
    default: String(config.sharding.refreshTokenShards),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return 'Please enter a positive integer';
      return true;
    },
  });

  config.sharding.authCodeShards = parseInt(authCodeShards, 10);
  config.sharding.refreshTokenShards = parseInt(refreshTokenShards, 10);

  return true;
}
