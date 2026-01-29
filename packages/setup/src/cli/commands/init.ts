/**
 * Init Command - Setup wizard for Authrim
 *
 * Provides both CLI and Web UI modes for setting up Authrim.
 */

import { input, select, confirm, password } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  initI18n,
  t,
  getAvailableLocales,
  detectSystemLocale,
  getLocale,
  type Locale,
} from '../../i18n/index.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import { createDefaultConfig, parseConfig, type AuthrimConfig } from '../../core/config.js';
import {
  generateAllSecrets,
  saveKeysToDirectory,
  generateKeyId,
  keysExistForEnvironment,
} from '../../core/keys.js';
import { isRunningFromSource, getCommandPrefix } from '../../core/source-context.js';
import {
  isWranglerInstalled,
  checkAuth,
  provisionResources,
  toResourceIds,
  getAccountId,
  detectEnvironments,
  getWorkersSubdomain,
} from '../../core/cloudflare.js';
import { createLockFile, saveLockFile, loadLockFile } from '../../core/lock.js';
import {
  getEnvironmentPaths,
  getExternalKeysDir,
  getExternalKeysPathForConfig,
  AUTHRIM_DIR,
} from '../../core/paths.js';
import {
  downloadSource,
  verifySourceStructure,
  checkForUpdate,
  getLocalVersion,
} from '../../core/source.js';
import { saveUiEnv } from '../../core/ui-env.js';

// =============================================================================
// WSL Detection
// =============================================================================

/**
 * Detect if running in WSL (Windows Subsystem for Linux) environment
 */
async function isWSLEnvironment(): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises');
    const procVersion = await fs.readFile('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(procVersion);
  } catch {
    return false;
  }
}

// =============================================================================
// Types
// =============================================================================

interface InitOptions {
  cli?: boolean;
  config?: string;
  keep?: string;
  env?: string;
  lang?: string;
}

// =============================================================================
// Language Selection
// =============================================================================

/**
 * Show language selection prompt
 * This is shown before the banner, so we use hardcoded multilingual prompt
 */
async function selectLanguage(): Promise<Locale> {
  const locales = getAvailableLocales();

  const locale = await select<Locale>({
    message: 'Select language / 言語を選択 / 选择语言',
    choices: locales.map((l) => ({
      value: l.code,
      name: l.nativeName,
    })),
  });

  return locale;
}

// =============================================================================
// Version
// =============================================================================

const require = createRequire(import.meta.url);

function getVersion(): string {
  try {
    // package.json is at the root of the package (3 levels up from dist/cli/commands/)
    const pkg = require('../../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

// =============================================================================
// Banner
// =============================================================================

/**
 * Apply horizontal gradient to a line of text (left to right)
 * Interpolates between two colors based on character position
 */
function applyGradient(text: string, startColor: string, endColor: string): string {
  // Parse hex color to RGB
  const parseHex = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '');
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ];
  };

  // Convert RGB to hex
  const toHex = (r: number, g: number, b: number): string => {
    return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  };

  const [r1, g1, b1] = parseHex(startColor);
  const [r2, g2, b2] = parseHex(endColor);
  const len = text.length;

  if (len === 0) return text;

  let result = '';
  for (let i = 0; i < len; i++) {
    const char = text[i];
    if (char === ' ') {
      result += char;
      continue;
    }
    // Calculate interpolation ratio
    const ratio = len > 1 ? i / (len - 1) : 0;
    // Interpolate RGB values
    const r = r1 + (r2 - r1) * ratio;
    const g = g1 + (g2 - g1) * ratio;
    const b = b1 + (b2 - b1) * ratio;
    // Apply color to character
    result += chalk.hex(toHex(r, g, b))(char);
  }
  return result;
}

function printBanner(): void {
  const version = getVersion();
  const versionStr = `v${version}`;
  const subtitle = t('banner.subtitle');

  // ASCII Art Logo (mint gradient theme - inspired by oh-my-logo)
  // Mint palette: #00d2ff → #3a7bd5 (horizontal gradient, left to right)
  const mintStart = '#00d2ff'; // Cyan
  const mintEnd = '#3a7bd5'; // Blue

  const logo = [
    ' ╔═╗ ╦ ╦ ╔╦╗ ╦ ╦ ╦═╗ ╦ ╔╦╗',
    ' ╠═╣ ║ ║  ║  ╠═╣ ╠╦╝ ║ ║║║',
    ' ╩ ╩ ╚═╝  ╩  ╩ ╩ ╩╚═ ╩ ╩ ╩',
  ];

  console.log('');
  logo.forEach((line) => {
    console.log(applyGradient(line, mintStart, mintEnd));
  });
  console.log('');
  console.log(chalk.gray(` ${subtitle}`));
  console.log(chalk.gray(` ${versionStr}`));
  console.log('');
  console.log(chalk.gray(`  ${t('banner.exitHint')}`));
  console.log('');
}

// Store the workers.dev subdomain for URL generation
let workersSubdomain: string | null = null;

/**
 * Get the correct workers.dev URL with account subdomain
 * Format: {worker}.{subdomain}.workers.dev
 */
function getWorkersDevUrl(workerName: string): string {
  if (workersSubdomain) {
    return `https://${workerName}.${workersSubdomain}.workers.dev`;
  }
  return `https://${workerName}.workers.dev`;
}

/**
 * Get the correct pages.dev URL
 * Note: Pages uses {project}.pages.dev format (no account subdomain, unlike Workers)
 */
function getPagesDevUrl(projectName: string): string {
  return `https://${projectName}.pages.dev`;
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

  // If running from source repository (pnpm setup), skip update check entirely
  if (isRunningFromSource(currentDir)) {
    const localVersion = await getLocalVersion(currentDir);
    console.log(
      chalk.green(`✓ Using Authrim source (v${localVersion || 'unknown'}) [from source]`)
    );
    return currentDir;
  }

  // Check if we're already in an Authrim source directory
  if (isAuthrimSourceDir(currentDir)) {
    // Check for updates
    const spinner = ora('Checking for updates...').start();
    const updateInfo = await checkForUpdate(currentDir);
    spinner.stop();

    if (updateInfo.updateAvailable) {
      console.log('');
      console.log(
        chalk.yellow(
          `⬆️  Update available: ${updateInfo.localVersion} → ${updateInfo.remoteVersion}`
        )
      );
      console.log('');

      const updateChoice = await select({
        message: 'What would you like to do?',
        choices: [
          {
            value: 'continue',
            name: `Continue with current version (${updateInfo.localVersion})`,
            description: 'Use the existing source code',
          },
          {
            value: 'update',
            name: `Update to latest (${updateInfo.remoteVersion})`,
            description: 'Download and replace with new version',
          },
          { value: 'cancel', name: 'Cancel', description: 'Exit setup' },
        ],
      });

      if (updateChoice === 'cancel') {
        console.log(chalk.gray('\nCancelled.'));
        process.exit(0);
      }

      if (updateChoice === 'update') {
        // Update in place (backup and replace)
        return await updateExistingSource(currentDir, updateInfo.gitRef!);
      }
    } else {
      const localVersion = updateInfo.localVersion || 'unknown';
      console.log(chalk.green(`✓ Using Authrim source (v${localVersion})`));
    }

    return currentDir;
  }

  // Check if --keep path exists and is valid
  if (options.keep && isAuthrimSourceDir(options.keep)) {
    return resolve(options.keep);
  }

  // Check for existing authrim directory that's not a valid source
  const targetDir = options.keep || './authrim';

  if (existsSync(targetDir)) {
    if (isAuthrimSourceDir(targetDir)) {
      // Valid source exists at target location
      const spinner = ora('Checking for updates...').start();
      const updateInfo = await checkForUpdate(targetDir);
      spinner.stop();

      if (updateInfo.updateAvailable) {
        console.log('');
        console.log(
          chalk.yellow(
            `⬆️  Update available: ${updateInfo.localVersion} → ${updateInfo.remoteVersion}`
          )
        );
        console.log('');

        const updateChoice = await select({
          message: 'What would you like to do?',
          choices: [
            {
              value: 'continue',
              name: `Continue with current version (${updateInfo.localVersion})`,
              description: 'Use the existing source code',
            },
            {
              value: 'update',
              name: `Update to latest (${updateInfo.remoteVersion})`,
              description: 'Download and replace with new version',
            },
            { value: 'cancel', name: 'Cancel', description: 'Exit setup' },
          ],
        });

        if (updateChoice === 'cancel') {
          console.log(chalk.gray('\nCancelled.'));
          process.exit(0);
        }

        if (updateChoice === 'update') {
          return await updateExistingSource(targetDir, updateInfo.gitRef!);
        }
      } else {
        const localVersion = updateInfo.localVersion || 'unknown';
        console.log(chalk.green(`✓ Using existing Authrim source (v${localVersion})`));
      }

      return resolve(targetDir);
    } else {
      // Directory exists but is not valid Authrim source
      console.log('');
      console.log(
        chalk.yellow(`⚠️  Directory ${targetDir} exists but is not a valid Authrim source`)
      );
      console.log('');

      const existingChoice = await select({
        message: 'What would you like to do?',
        choices: [
          {
            value: 'replace',
            name: 'Replace with fresh download',
            description: `Remove ${targetDir} and download latest`,
          },
          {
            value: 'different',
            name: 'Use different directory',
            description: 'Specify another location',
          },
          { value: 'cancel', name: 'Cancel', description: 'Exit setup' },
        ],
      });

      if (existingChoice === 'cancel') {
        console.log(chalk.gray('\nCancelled.'));
        process.exit(0);
      }

      if (existingChoice === 'different') {
        const newDir = await input({
          message: 'Enter directory path:',
          default: './authrim-new',
        });
        return await downloadNewSource(newDir);
      }

      // Replace existing
      return await downloadNewSource(targetDir, true);
    }
  }

  // Need to download source
  console.log('');
  console.log(chalk.yellow('⚠️  Authrim source code not found'));
  console.log('');

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

  return await downloadNewSource(targetDir);
}

/**
 * Download source to a new or existing directory
 */
async function downloadNewSource(targetDir: string, force: boolean = false): Promise<string> {
  const spinner = ora('Downloading source code...').start();

  try {
    const result = await downloadSource({
      targetDir,
      force,
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

    // Install dependencies
    const installSpinner = ora('Installing dependencies (this may take a few minutes)...').start();
    try {
      await execa('pnpm', ['install'], {
        cwd: resolve(targetDir),
        stdio: 'pipe',
      });
      installSpinner.succeed('Dependencies installed');
    } catch (installError) {
      installSpinner.fail('Failed to install dependencies');
      console.error(chalk.red(`\nError: ${installError}`));
      console.log(chalk.yellow('\nYou can try installing manually:'));
      console.log(chalk.cyan(`  cd ${targetDir}`));
      console.log(chalk.cyan('  pnpm install'));
      process.exit(1);
    }

    return resolve(targetDir);
  } catch (error) {
    spinner.fail('Download failed');
    console.error(chalk.red(`\nError: ${error}`));
    process.exit(1);
  }
}

/**
 * Update existing source directory to new version
 */
async function updateExistingSource(sourceDir: string, gitRef: string): Promise<string> {
  const spinner = ora('Updating source code...').start();

  try {
    // Backup existing configuration files
    // Support both legacy (authrim-*.json, .keys/) and new (.authrim/) structures
    const configFiles = ['authrim-config.json', 'authrim-lock.json'];
    const backups: { file: string; content?: string }[] = [];

    for (const file of configFiles) {
      const filePath = join(sourceDir, file);
      if (existsSync(filePath)) {
        const { readFile: rf } = await import('node:fs/promises');
        const content = await rf(filePath, 'utf-8');
        backups.push({ file, content });
      }
    }

    spinner.text = 'Downloading new version...';

    // Download to temp directory first
    const { rm, rename, cp } = await import('node:fs/promises');
    const tempDir = `${sourceDir}.update-${Date.now()}`;

    const result = await downloadSource({
      targetDir: tempDir,
      gitRef,
      onProgress: (msg) => {
        spinner.text = msg;
      },
    });

    // Preserve .authrim directory if it exists (new structure)
    const authrimDir = join(sourceDir, AUTHRIM_DIR);
    const tempAuthrimDir = join(tempDir, AUTHRIM_DIR);
    if (existsSync(authrimDir)) {
      await cp(authrimDir, tempAuthrimDir, { recursive: true });
    }

    // Preserve .keys directory if it exists (legacy structure)
    const keysDir = join(sourceDir, '.keys');
    const tempKeysDir = join(tempDir, '.keys');
    if (existsSync(keysDir)) {
      await cp(keysDir, tempKeysDir, { recursive: true });
    }

    // Backup old directory
    const backupDir = `${sourceDir}.backup-${Date.now()}`;
    await rename(sourceDir, backupDir);

    // Move new directory into place
    await rename(tempDir, sourceDir);

    // Restore configuration files
    for (const backup of backups) {
      const filePath = join(sourceDir, backup.file);
      if (backup.content) {
        await writeFile(filePath, backup.content, 'utf-8');
      }
    }

    // Remove backup (optional - keep for safety)
    spinner.text = 'Cleaning up...';
    await rm(backupDir, { recursive: true });

    spinner.succeed(`Source code updated to ${result.gitRef}`);

    // Install dependencies for updated source
    const installSpinner = ora('Installing dependencies (this may take a few minutes)...').start();
    try {
      await execa('pnpm', ['install'], {
        cwd: resolve(sourceDir),
        stdio: 'pipe',
      });
      installSpinner.succeed('Dependencies installed');
    } catch (installError) {
      installSpinner.fail('Failed to install dependencies');
      console.error(chalk.red(`\nError: ${installError}`));
      console.log(chalk.yellow('\nYou can try installing manually:'));
      console.log(chalk.cyan(`  cd ${sourceDir}`));
      console.log(chalk.cyan('  pnpm install'));
      process.exit(1);
    }

    return resolve(sourceDir);
  } catch (error) {
    spinner.fail('Update failed');
    console.error(chalk.red(`\nError: ${error}`));
    console.log(chalk.yellow('Your original files should still be intact.'));
    process.exit(1);
  }
}

// =============================================================================
// Main Command
// =============================================================================

export async function initCommand(options: InitOptions): Promise<void> {
  // Immediately show startup message to indicate the tool is running
  const version = getVersion();
  console.log('');
  console.log(chalk.cyan(`  @authrim/setup v${version}`));
  console.log(chalk.gray('  Starting...'));
  console.log('');

  // Step 0: Language selection (before banner)
  // Priority: --lang option > env var > system locale > interactive selection
  let locale: Locale;

  if (options.lang) {
    // Use provided language option
    locale = options.lang as Locale;
  } else {
    // Check system locale first
    const systemLocale = detectSystemLocale();
    if (systemLocale !== 'en') {
      // Non-English system locale detected, use it
      locale = systemLocale;
    } else {
      // Show language selection prompt
      locale = await selectLanguage();
    }
  }

  // Initialize i18n with selected locale
  await initI18n(locale);

  // Now show the banner in the selected language
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

  // Check for WSL environment - Web UI not supported due to networking limitations
  const isWSL = await isWSLEnvironment();

  if (isWSL) {
    // WSL detected - skip Web UI option, go directly to CLI
    console.log(chalk.yellow(`⚠️  ${t('wsl.detected')}`));
    console.log(chalk.gray(`   ${t('wsl.cliOnly')}`));
    console.log('');

    const sourceDir = await ensureAuthrimSource(options);
    process.chdir(sourceDir);
    await runCliSetup(options);
    return;
  }

  // Show startup menu (non-WSL environments)
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(`  ${t('startup.description')}`);
  console.log('');
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  const startupChoice = await select({
    message: t('mode.prompt'),
    choices: [
      {
        value: 'webui',
        name: `🌐 ${t('mode.quick')}`,
        description: t('mode.quickDesc'),
      },
      {
        value: 'cli',
        name: `⌨️ ${t('mode.advanced')}`,
        description: t('mode.advancedDesc'),
      },
      {
        value: 'cancel',
        name: `❌ ${t('startup.cancel')}`,
        description: t('startup.cancelDesc'),
      },
    ],
  });

  if (startupChoice === 'cancel') {
    console.log('');
    console.log(chalk.gray(t('startup.cancelled')));
    console.log('');
    console.log(chalk.gray(t('startup.resumeLater')));
    console.log(chalk.cyan(`  ${getCommandPrefix()}`));
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
    console.log(chalk.cyan(`🌐 ${t('webUi.starting')}`));
    console.log('');

    const { startWebServer } = await import('../../web/server.js');
    await startWebServer({ openBrowser: true, lang: getLocale() });
  }
}

// =============================================================================
// CLI Setup Flow
// =============================================================================

async function runCliSetup(options: InitOptions): Promise<void> {
  // Main menu loop - keeps returning to menu until user exits
  while (true) {
    const setupMode = await select({
      message: t('menu.prompt'),
      choices: [
        {
          value: 'quick',
          name: `⚡ ${t('menu.quick')}`,
          description: t('menu.quickDesc'),
        },
        {
          value: 'normal',
          name: `🔧 ${t('menu.custom')}`,
          description: t('menu.customDesc'),
        },
        {
          value: 'manage',
          name: `📋 ${t('menu.manage')}`,
          description: t('menu.manageDesc'),
        },
        {
          value: 'load',
          name: `📂 ${t('menu.load')}`,
          description: t('menu.loadDesc'),
        },
        {
          value: 'exit',
          name: `❌ ${t('menu.exit')}`,
          description: t('menu.exitDesc'),
        },
      ],
    });

    if (setupMode === 'exit') {
      console.log('');
      console.log(chalk.gray(t('menu.goodbye')));
      console.log('');
      break;
    }

    if (setupMode === 'quick') {
      await runQuickSetup(options);
      break; // Exit after setup completes
    } else if (setupMode === 'normal') {
      await runNormalSetup(options);
      break; // Exit after setup completes
    } else if (setupMode === 'manage') {
      await runManageEnvironments();
      // Returns to main menu after manage
      console.log('');
    } else if (setupMode === 'load') {
      const shouldContinue = await runLoadConfig();
      if (!shouldContinue) {
        // Returns to main menu
        console.log('');
      } else {
        break; // Exit after deploy
      }
    }
  }
}

// =============================================================================
// Manage Existing Environments
// =============================================================================

async function runManageEnvironments(): Promise<void> {
  // Loop to allow multiple operations before returning to main menu
  while (true) {
    console.log('');
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('📋 Existing Environments'));
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');

    const spinner = ora('Detecting environments...').start();
    const environments = await detectEnvironments();
    spinner.stop();

    if (environments.length === 0) {
      console.log(chalk.yellow('No Authrim environments found.'));
      console.log('');
      return;
    }

    console.log(chalk.bold('Detected Environments:'));
    console.log('');
    for (const env of environments) {
      console.log(`  ${chalk.cyan(env.env)}`);
      console.log(
        chalk.gray(`    Workers: ${env.workers.length}, D1: ${env.d1.length}, KV: ${env.kv.length}`)
      );
    }
    console.log('');

    const action = await select({
      message: 'Select action',
      choices: [
        {
          value: 'info',
          name: '🔍 View Details',
          description: 'Show detailed resource information',
        },
        {
          value: 'delete',
          name: '🗑️  Delete Environment',
          description: 'Remove environment and resources',
        },
        { value: 'back', name: '← Back to Main Menu', description: 'Return to main menu' },
      ],
    });

    if (action === 'back') {
      return;
    }

    const envChoices = environments.map((e) => ({
      name: `${e.env} (${e.workers.length} workers, ${e.d1.length} D1, ${e.kv.length} KV)`,
      value: e.env,
    }));
    envChoices.push({ name: '← Back', value: '__back__' });

    const envName = await select({
      message: 'Select environment',
      choices: envChoices,
    });

    if (envName === '__back__') {
      continue; // Go back to action selection
    }

    if (action === 'info') {
      const { infoCommand } = await import('./info.js');
      await infoCommand({ env: envName });
    } else if (action === 'delete') {
      const { deleteCommand } = await import('./delete.js');
      await deleteCommand({ env: envName });
    }

    // After action, ask if user wants to continue managing
    console.log('');
    const continueManaging = await confirm({
      message: 'Continue managing environments?',
      default: true,
    });

    if (!continueManaging) {
      return;
    }
  }
}

// =============================================================================
// Load Existing Configuration
// =============================================================================

async function runLoadConfig(): Promise<boolean> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📂 Load Existing Configuration'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Check for config files in both new and legacy structures
  const baseDir = process.cwd();

  // Detect existing environments
  const { listEnvironments } = await import('../../core/paths.js');
  const environments = listEnvironments(baseDir);

  // Build list of found configs
  const foundConfigs: { path: string; env: string; type: 'new' | 'legacy' }[] = [];

  // Check new structure (.authrim/{env}/config.json)
  for (const env of environments) {
    const newPaths = getEnvironmentPaths({ baseDir, env });
    if (existsSync(newPaths.config)) {
      foundConfigs.push({ path: newPaths.config, env, type: 'new' });
    }
  }

  // Check legacy structure (authrim-config.json)
  const legacyConfigPath = './authrim-config.json';
  if (existsSync(legacyConfigPath) && !foundConfigs.some((c) => c.type === 'legacy')) {
    // Try to read env from legacy config
    try {
      const legacyContent = await readFile(legacyConfigPath, 'utf-8');
      const legacyConfig = JSON.parse(legacyContent);
      const legacyEnv = legacyConfig.environment?.prefix || 'unknown';
      foundConfigs.push({ path: legacyConfigPath, env: legacyEnv, type: 'legacy' });
    } catch {
      foundConfigs.push({ path: legacyConfigPath, env: 'unknown', type: 'legacy' });
    }
  }

  let configPath: string;

  if (foundConfigs.length > 0) {
    console.log(chalk.green(`✓ Found ${foundConfigs.length} configuration(s):`));
    for (const cfg of foundConfigs) {
      const typeLabel = cfg.type === 'new' ? chalk.blue('(new)') : chalk.yellow('(legacy)');
      console.log(`  • ${cfg.path} ${typeLabel} - env: ${cfg.env}`);
    }
    console.log('');

    // Check if there are legacy configs that could be migrated
    const legacyConfigs = foundConfigs.filter((c) => c.type === 'legacy');
    if (legacyConfigs.length > 0) {
      console.log(chalk.yellow('━━━ Legacy Structure Detected ━━━'));
      console.log(chalk.gray('Legacy files:'));
      console.log(chalk.gray('  • authrim-config.json'));
      console.log(chalk.gray('  • authrim-lock.json'));
      console.log(chalk.gray('  • .keys/{env}/'));
      console.log('');
      console.log(chalk.gray('New structure benefits:'));
      console.log(chalk.gray('  • Environment portability (zip .authrim/prod/)'));
      console.log(chalk.gray('  • Version tracking per environment'));
      console.log(chalk.gray('  • Cleaner project structure'));
      console.log('');

      const migrateAction = await select({
        message: 'Would you like to migrate to the new structure?',
        choices: [
          { value: 'migrate', name: '🔄 Migrate to new structure (.authrim/{env}/)' },
          { value: 'continue', name: '📂 Continue with legacy structure' },
          { value: 'back', name: '← Back to Main Menu' },
        ],
      });

      if (migrateAction === 'back') {
        return false;
      }

      if (migrateAction === 'migrate') {
        const { migrateToNewStructure, validateMigration } = await import('../../core/migrate.js');

        console.log('');
        const envToMigrate = legacyConfigs[0].env;

        const result = await migrateToNewStructure({
          baseDir,
          env: envToMigrate,
          onProgress: (msg) => console.log(msg),
        });

        if (result.success) {
          console.log('');
          console.log(chalk.green('✓ Migration completed successfully!'));

          // Validate
          const validation = await validateMigration(baseDir, envToMigrate);
          if (validation.valid) {
            console.log(chalk.green('✓ Validation passed'));
          } else {
            console.log(chalk.yellow('⚠ Validation issues:'));
            for (const issue of validation.issues) {
              console.log(chalk.yellow(`  • ${issue}`));
            }
          }

          console.log('');
          console.log(chalk.cyan('New configuration location:'));
          console.log(chalk.cyan(`  .authrim/${envToMigrate}/config.json`));
          console.log('');

          // Update foundConfigs to use new path
          const newPaths = getEnvironmentPaths({ baseDir, env: envToMigrate });
          foundConfigs.length = 0;
          foundConfigs.push({ path: newPaths.config, env: envToMigrate, type: 'new' });
        } else {
          console.log('');
          console.log(chalk.red('✗ Migration failed:'));
          for (const error of result.errors) {
            console.log(chalk.red(`  • ${error}`));
          }
          console.log('');
          console.log(chalk.yellow('Continuing with legacy structure...'));
        }
      }
    }

    if (foundConfigs.length === 1) {
      configPath = foundConfigs[0].path;

      const action = await select({
        message: 'What would you like to do?',
        choices: [
          { value: 'load', name: '📂 Load this configuration' },
          { value: 'other', name: '📁 Specify different file' },
          { value: 'back', name: '← Back to Main Menu' },
        ],
      });

      if (action === 'back') {
        return false; // Return to main menu
      }

      if (action === 'other') {
        configPath = await input({
          message: 'Enter configuration file path',
          validate: (value) => {
            if (!value) return 'Please enter a path';
            if (!existsSync(value)) return `File not found: ${value}`;
            return true;
          },
        });
      }
    } else {
      // Multiple configs found - let user select
      const choices = [
        ...foundConfigs.map((cfg) => ({
          value: cfg.path,
          name: `📂 ${cfg.env} (${cfg.path}) ${cfg.type === 'legacy' ? chalk.yellow('legacy') : ''}`,
        })),
        { value: '__other__', name: '📁 Specify different file' },
        { value: '__back__', name: '← Back to Main Menu' },
      ];

      const selected = await select({
        message: 'Select configuration to load',
        choices,
      });

      if (selected === '__back__') {
        return false;
      }

      if (selected === '__other__') {
        configPath = await input({
          message: 'Enter configuration file path',
          validate: (value) => {
            if (!value) return 'Please enter a path';
            if (!existsSync(value)) return `File not found: ${value}`;
            return true;
          },
        });
      } else {
        configPath = selected;
      }
    }
  } else {
    console.log(chalk.yellow('No configuration found in current directory.'));
    console.log('');
    console.log(chalk.gray('💡 Tip: You can specify a config file with:'));
    console.log(
      chalk.cyan(`   ${getCommandPrefix()} --config /path/to/.authrim/{env}/config.json`)
    );
    console.log('');

    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { value: 'specify', name: '📁 Specify file path' },
        { value: 'back', name: '← Back to Main Menu' },
      ],
    });

    if (action === 'back') {
      return false;
    }

    configPath = await input({
      message: 'Enter configuration file path',
      validate: (value) => {
        if (!value) return 'Please enter a path';
        if (!existsSync(value)) return `File not found: ${value}`;
        return true;
      },
    });
  }

  await handleExistingConfig(configPath);
  return true; // Config was loaded and processed
}

// =============================================================================
// Quick Setup
// =============================================================================

async function runQuickSetup(options: InitOptions): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold(t('quick.title')));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 1: Environment prefix
  const envPrefix = await input({
    message: t('env.prompt'),
    default: options.env || 'prod',
    validate: (value) => {
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        return t('env.customValidation');
      }
      return true;
    },
  });

  // Check if environment already exists
  const checkSpinner = ora(t('env.checking')).start();
  try {
    const existingEnvs = await detectEnvironments();
    const existingEnv = existingEnvs.find((e) => e.env === envPrefix);
    if (existingEnv) {
      checkSpinner.fail(t('env.alreadyExists', { env: envPrefix }));
      console.log('');
      console.log(chalk.yellow('  ' + t('env.existingResources')));
      console.log(`    ${t('env.workers', { count: String(existingEnv.workers.length) })}`);
      console.log(`    ${t('env.d1Databases', { count: String(existingEnv.d1.length) })}`);
      console.log(`    ${t('env.kvNamespaces', { count: String(existingEnv.kv.length) })}`);
      console.log('');
      console.log(chalk.yellow('  ' + t('env.chooseAnother', { command: getCommandPrefix() })));
      return;
    }
    checkSpinner.succeed(t('env.available'));
  } catch {
    checkSpinner.warn(t('env.checkFailed'));
  }

  // Step 2: Cloudflare API Token
  const cfApiToken = await password({
    message: t('cf.apiTokenPrompt'),
    mask: '*',
    validate: (value) => {
      if (!value || value.length < 10) {
        return t('cf.apiTokenValidation');
      }
      return true;
    },
  });

  // Step 3: Show infrastructure info
  console.log('');
  console.log(
    chalk.gray(
      '  ' +
        t('infra.workersToDeploy', {
          workers: envPrefix + '-ar-router, ' + envPrefix + '-ar-auth, ...',
        })
    )
  );
  console.log(
    chalk.gray('  ' + t('infra.defaultApi', { url: getWorkersDevUrl(envPrefix + '-ar-router') }))
  );
  console.log('');

  // Step 4: Domain configuration (single-tenant mode only in Quick Setup)
  const useCustomDomain = await confirm({
    message: t('domain.prompt'),
    default: false,
  });

  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;

  if (useCustomDomain) {
    console.log('');
    console.log(chalk.gray('  ' + t('domain.singleTenantNote')));
    console.log('');

    apiDomain = await input({
      message: t('domain.apiDomain'),
      validate: (value) => {
        if (!value) return true; // Allow empty for workers.dev fallback
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
          return t('domain.customValidation');
        }
        return true;
      },
    });

    loginUiDomain = await input({
      message: t('domain.loginUiDomain'),
      default: '',
    });

    adminUiDomain = await input({
      message: t('domain.adminUiDomain'),
      default: '',
    });
  }

  // Database Configuration
  console.log('');
  console.log(chalk.blue('━━━ ' + t('db.title') + ' ━━━'));
  console.log(chalk.yellow('⚠️  ' + t('db.regionWarning')));
  console.log('');

  const locationChoices = [
    { name: t('region.auto'), value: 'auto' },
    { name: '── ' + t('db.locationHints') + ' ──', value: '__separator1__', disabled: true },
    { name: t('region.wnam'), value: 'wnam' },
    { name: t('region.enam'), value: 'enam' },
    { name: t('region.weur'), value: 'weur' },
    { name: t('region.eeur'), value: 'eeur' },
    { name: t('region.apac'), value: 'apac' },
    { name: t('region.oceania'), value: 'oc' },
    {
      name: '── ' + t('db.jurisdictionCompliance') + ' ──',
      value: '__separator2__',
      disabled: true,
    },
    { name: t('region.euJurisdiction'), value: 'eu' },
  ];

  console.log(chalk.gray('  ' + t('db.coreDescription')));
  const coreDbLocation = await select({
    message: t('db.coreRegion'),
    choices: locationChoices,
    default: 'auto',
  });

  console.log('');
  console.log(chalk.gray('  ' + t('db.piiDescription')));
  const piiDbLocation = await select({
    message: t('db.piiRegion'),
    choices: locationChoices,
    default: 'auto',
  });

  // Parse location vs jurisdiction
  function parseDbLocation(value: string) {
    if (value === 'eu') {
      return { location: 'auto' as const, jurisdiction: 'eu' as const };
    }
    return {
      location: value as 'auto' | 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc',
      jurisdiction: 'none' as const,
    };
  }

  // Email Provider Configuration
  console.log('');
  console.log(chalk.blue('━━━ ' + t('email.title') + ' ━━━'));
  console.log(chalk.gray(t('email.description')));
  console.log('');

  const configureEmail = await confirm({
    message: t('email.prompt'),
    default: false,
  });

  let emailConfig: {
    provider: 'resend' | 'none';
    fromAddress?: string;
    fromName?: string;
    apiKey?: string;
  } = { provider: 'none' };

  if (configureEmail) {
    console.log('');
    console.log(chalk.gray(t('email.resendDesc')));
    console.log(chalk.gray(t('email.apiKeyHint')));
    console.log(chalk.gray(t('email.domainHint')));
    console.log('');

    const resendApiKey = await password({
      message: t('email.apiKeyPrompt'),
      mask: '*',
      validate: (value) => {
        if (!value.trim()) return t('email.apiKeyRequired');
        if (!value.startsWith('re_')) {
          return t('email.apiKeyWarning');
        }
        return true;
      },
    });

    const fromAddress = await input({
      message: t('email.fromAddressPrompt'),
      default: 'noreply@yourdomain.com',
      validate: (value) => {
        if (!value.includes('@')) return t('email.fromAddressValidation');
        return true;
      },
    });

    const fromName = await input({
      message: t('email.fromNamePrompt'),
      default: 'Authrim',
    });

    emailConfig = {
      provider: 'resend',
      fromAddress,
      fromName: fromName || undefined,
      apiKey: resendApiKey,
    };

    console.log('');
    console.log(chalk.yellow('⚠️  ' + t('email.domainVerificationRequired')));
    console.log(chalk.gray('   ' + t('email.seeDocumentation')));
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.database = {
    core: parseDbLocation(coreDbLocation),
    pii: parseDbLocation(piiDbLocation),
  };
  config.features = {
    ...config.features,
    email: {
      provider: emailConfig.provider,
      fromAddress: emailConfig.fromAddress,
      fromName: emailConfig.fromName,
      configured: emailConfig.provider === 'resend',
    },
  };
  config.urls = {
    api: {
      custom: apiDomain || null,
      auto: getWorkersDevUrl(envPrefix + '-ar-router'),
    },
    loginUi: {
      custom: loginUiDomain || null,
      auto: getPagesDevUrl(envPrefix + '-ar-login-ui'),
      sameAsApi: false,
    },
    adminUi: {
      custom: adminUiDomain || null,
      auto: getPagesDevUrl(envPrefix + '-ar-admin-ui'),
      sameAsApi: false,
    },
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📋 Configuration Summary'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(chalk.bold('Infrastructure:'));
  console.log(`  Environment:   ${chalk.cyan(envPrefix)}`);
  console.log(`  Worker Prefix: ${chalk.cyan(envPrefix + '-ar-*')}`);
  console.log('');
  console.log(chalk.bold('URLs (Single-tenant):'));
  console.log(`  Issuer URL:    ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`);
  console.log(
    `  Login UI:      ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  Admin UI:      ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');
  console.log(chalk.bold('Email:'));
  if (emailConfig.provider === 'resend') {
    console.log(`  Provider:      ${chalk.cyan('Resend')}`);
    console.log(`  From Address:  ${chalk.cyan(emailConfig.fromAddress)}`);
    if (emailConfig.fromName) {
      console.log(`  From Name:     ${chalk.cyan(emailConfig.fromName)}`);
    }
  } else {
    console.log(`  Provider:      ${chalk.gray('Not configured (configure later)')}`);
  }
  console.log('');

  const proceed = await confirm({
    message: 'Start setup with this configuration?',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  // Save email secrets if configured
  if (emailConfig.provider === 'resend' && emailConfig.apiKey) {
    // Save to external keys directory: {cwd}/.authrim-keys/{env}/
    const keysDir = getExternalKeysDir(envPrefix, process.cwd());
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
      const resendApiKeyPath = join(keysDir, 'resend_api_key.txt');
      await fs.writeFile(resendApiKeyPath, emailConfig.apiKey!.trim());
      await fs.chmod(resendApiKeyPath, 0o600);
      const emailFromPath = join(keysDir, 'email_from.txt');
      await fs.writeFile(emailFromPath, emailConfig.fromAddress!.trim());
      await fs.chmod(emailFromPath, 0o600);
      if (emailConfig.fromName) {
        const emailFromNamePath = join(keysDir, 'email_from_name.txt');
        await fs.writeFile(emailFromNamePath, emailConfig.fromName.trim());
        await fs.chmod(emailFromNamePath, 0o600);
      }
    });
    console.log(chalk.gray(`📧 Email secrets saved to ${keysDir}/`));
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
  console.log(chalk.bold(t('custom.title')));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 1: Environment prefix
  const envPrefix = await input({
    message: t('env.prompt'),
    default: options.env || 'prod',
    validate: (value) => {
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        return t('env.customValidation');
      }
      return true;
    },
  });

  // Check if environment already exists
  const checkSpinner = ora(t('env.checking')).start();
  try {
    const existingEnvs = await detectEnvironments();
    const existingEnv = existingEnvs.find((e) => e.env === envPrefix);
    if (existingEnv) {
      checkSpinner.fail(t('env.alreadyExists', { env: envPrefix }));
      console.log('');
      console.log(chalk.yellow('  ' + t('env.existingResources')));
      console.log(`    ${t('env.workers', { count: String(existingEnv.workers.length) })}`);
      console.log(`    ${t('env.d1Databases', { count: String(existingEnv.d1.length) })}`);
      console.log(`    ${t('env.kvNamespaces', { count: String(existingEnv.kv.length) })}`);
      console.log('');
      console.log(chalk.yellow('  ' + t('env.chooseAnother', { command: getCommandPrefix() })));
      return;
    }
    checkSpinner.succeed(t('env.available'));
  } catch {
    checkSpinner.warn(t('env.checkFailed'));
  }

  // Step 2: Cloudflare API Token
  const cfApiToken = await password({
    message: t('cf.apiTokenPrompt'),
    mask: '*',
    validate: (value) => {
      if (!value || value.length < 10) {
        return t('cf.apiTokenValidation');
      }
      return true;
    },
  });

  // Step 3: Profile selection
  const profile = await select({
    message: t('profile.prompt'),
    choices: [
      {
        value: 'basic-op',
        name: t('profile.basicOp'),
        description: t('profile.basicOpDesc'),
      },
      {
        value: 'fapi-rw',
        name: t('profile.fapiRw'),
        description: t('profile.fapiRwDesc'),
      },
      {
        value: 'fapi2-security',
        name: t('profile.fapi2Security'),
        description: t('profile.fapi2SecurityDesc'),
      },
    ],
    default: 'basic-op',
  });

  // Step 4: Infrastructure overview (Workers are auto-generated from env)
  console.log('');
  console.log(chalk.blue('━━━ ' + t('infra.title') + ' ━━━'));
  console.log('');
  console.log(chalk.gray('  ' + t('infra.workersNote')));
  console.log(`    ${t('infra.router')}     ${chalk.cyan(envPrefix + '-ar-router')}`);
  console.log(`    ${t('infra.auth')}       ${chalk.cyan(envPrefix + '-ar-auth')}`);
  console.log(`    ${t('infra.token')}      ${chalk.cyan(envPrefix + '-ar-token')}`);
  console.log(`    ${t('infra.management')} ${chalk.cyan(envPrefix + '-ar-management')}`);
  console.log(chalk.gray('    ' + t('infra.otherWorkers')));
  console.log('');
  console.log(chalk.gray('  ' + t('infra.defaultEndpoints')));
  console.log(
    `    ${t('infra.api')}        ${chalk.gray(getWorkersDevUrl(envPrefix + '-ar-router'))}`
  );
  console.log(`    ${t('infra.ui')}         ${chalk.gray(getPagesDevUrl(envPrefix + '-ar-ui'))}`);
  console.log('');

  // Step 5: Tenant configuration
  console.log(chalk.blue('━━━ ' + t('tenant.title') + ' ━━━'));
  console.log('');

  const multiTenant = await confirm({
    message: t('tenant.multiTenantPrompt'),
    default: false,
  });

  let tenantName = 'default';
  let tenantDisplayName = 'Default Tenant';
  let baseDomain: string | undefined;

  // Step 6: URL configuration (depends on tenant mode)
  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;

  if (multiTenant) {
    // Multi-tenant mode: base domain is required, becomes the issuer base
    console.log('');
    console.log(chalk.blue('━━━ ' + t('tenant.multiTenantTitle') + ' ━━━'));
    console.log('');
    console.log(chalk.gray('  ' + t('tenant.multiTenantNote1')));
    console.log(chalk.gray('    • ' + t('tenant.multiTenantNote2')));
    console.log(chalk.gray('    • ' + t('tenant.multiTenantNote3')));
    console.log(chalk.gray('    • ' + t('tenant.multiTenantNote4')));
    console.log('');

    baseDomain = await input({
      message: t('tenant.baseDomainPrompt'),
      validate: (value) => {
        if (!value) return t('tenant.baseDomainRequired');
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
          return t('tenant.baseDomainValidation');
        }
        return true;
      },
    });

    console.log('');
    console.log(chalk.green('  ✓ ' + t('tenant.issuerFormat', { domain: baseDomain })));
    console.log(chalk.gray('    ' + t('tenant.issuerExample', { domain: baseDomain })));
    console.log('');

    // API domain in multi-tenant is the base domain (or custom apex)
    apiDomain = baseDomain;

    tenantName = await input({
      message: t('tenant.defaultTenantPrompt'),
      default: 'default',
      validate: (value) => {
        if (!/^[a-z][a-z0-9-]*$/.test(value)) {
          return t('tenant.defaultTenantValidation');
        }
        return true;
      },
    });

    tenantDisplayName = await input({
      message: t('tenant.displayNamePrompt'),
      default: 'Default Tenant',
    });

    // UI domains for multi-tenant
    console.log('');
    console.log(chalk.blue('━━━ ' + t('tenant.uiDomainTitle') + ' ━━━'));
    console.log('');

    const useCustomUiDomain = await confirm({
      message: t('tenant.customUiDomainPrompt'),
      default: false,
    });

    if (useCustomUiDomain) {
      loginUiDomain = await input({
        message: t('tenant.loginUiDomain'),
        default: '',
      });

      adminUiDomain = await input({
        message: t('tenant.adminUiDomain'),
        default: '',
      });
    }
  } else {
    // Single-tenant mode
    console.log('');
    console.log(chalk.blue('━━━ ' + t('tenant.singleTenantTitle') + ' ━━━'));
    console.log('');
    console.log(chalk.gray('  ' + t('tenant.singleTenantNote1')));
    console.log(chalk.gray('    • ' + t('tenant.singleTenantNote2')));
    console.log(chalk.gray('    • ' + t('tenant.singleTenantNote3')));
    console.log('');

    tenantDisplayName = await input({
      message: t('tenant.organizationName'),
      default: 'Default Tenant',
    });

    const useCustomDomain = await confirm({
      message: t('domain.prompt'),
      default: false,
    });

    if (useCustomDomain) {
      console.log('');
      console.log(chalk.gray('  ' + t('domain.enterDomains')));
      console.log('');

      apiDomain = await input({
        message: t('domain.apiDomain'),
        validate: (value) => {
          if (!value) return true;
          if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
            return t('domain.customValidation');
          }
          return true;
        },
      });

      loginUiDomain = await input({
        message: t('domain.loginUiDomain'),
        default: '',
      });

      adminUiDomain = await input({
        message: t('domain.adminUiDomain'),
        default: '',
      });
    }

    if (apiDomain) {
      console.log('');
      console.log(chalk.green('  ✓ ' + t('domain.issuerUrl', { url: 'https://' + apiDomain })));
    } else {
      console.log('');
      console.log(
        chalk.green(
          '  ✓ ' + t('domain.issuerUrl', { url: getWorkersDevUrl(envPrefix + '-ar-router') })
        )
      );
      console.log(chalk.gray('    ' + t('domain.usingWorkersDev')));
    }
  }

  // Step 5: Optional components
  console.log('');
  console.log(chalk.blue('━━━ ' + t('components.title') + ' ━━━'));
  console.log(chalk.gray('  ' + t('components.note')));
  console.log('');

  const enableSaml = await confirm({
    message: t('components.samlPrompt'),
    default: false,
  });

  const enableVc = await confirm({
    message: t('components.vcPrompt'),
    default: false,
  });

  // Step 6: Feature flags
  console.log('');
  console.log(chalk.blue('━━━ ' + t('features.title') + ' ━━━'));
  console.log('');

  const enableQueue = await confirm({
    message: t('features.queuePrompt'),
    default: false,
  });

  const enableR2 = await confirm({
    message: t('features.r2Prompt'),
    default: false,
  });

  const emailProviderChoice = await select({
    message: t('email.title'),
    choices: [
      { value: 'none', name: t('email.skipOption') },
      { value: 'resend', name: t('email.resendOption') },
      { value: 'sendgrid', name: 'SendGrid (coming soon)', disabled: true },
      { value: 'ses', name: t('email.sesOption') + ' (coming soon)', disabled: true },
    ],
    default: 'none',
  });

  // Email configuration details
  let emailConfigNormal: {
    provider: 'resend' | 'none';
    fromAddress?: string;
    fromName?: string;
    apiKey?: string;
  } = { provider: 'none' };

  if (emailProviderChoice === 'resend') {
    console.log('');
    console.log(chalk.blue('━━━ ' + t('email.resendOption') + ' ━━━'));
    console.log(chalk.gray(t('email.apiKeyHint')));
    console.log(chalk.gray(t('email.domainHint')));
    console.log('');

    const resendApiKey = await password({
      message: t('email.apiKeyPrompt'),
      mask: '*',
      validate: (value) => {
        if (!value.trim()) return t('email.apiKeyRequired');
        if (!value.startsWith('re_')) {
          return t('email.apiKeyWarning');
        }
        return true;
      },
    });

    const fromAddress = await input({
      message: t('email.fromAddressPrompt'),
      default: 'noreply@yourdomain.com',
      validate: (value) => {
        if (!value.includes('@')) return t('email.fromAddressValidation');
        return true;
      },
    });

    const fromName = await input({
      message: t('email.fromNamePrompt'),
      default: 'Authrim',
    });

    emailConfigNormal = {
      provider: 'resend',
      fromAddress,
      fromName: fromName || undefined,
      apiKey: resendApiKey,
    };

    console.log('');
    console.log(chalk.yellow('⚠️  ' + t('email.domainVerificationRequired')));
    console.log(chalk.gray('   ' + t('email.seeDocumentation')));
  }

  // Step 7: Advanced OIDC settings
  const configureOidc = await confirm({
    message: t('oidc.configurePrompt'),
    default: false,
  });

  let accessTokenTtl = 3600; // 1 hour
  let refreshTokenTtl = 604800; // 7 days
  let authCodeTtl = 600; // 10 minutes
  let pkceRequired = true;

  if (configureOidc) {
    console.log('');
    console.log(chalk.blue('━━━ ' + t('oidc.title') + ' ━━━'));
    console.log('');

    const accessTokenTtlStr = await input({
      message: t('oidc.accessTokenTtl'),
      default: '3600',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    accessTokenTtl = parseInt(accessTokenTtlStr, 10);

    const refreshTokenTtlStr = await input({
      message: t('oidc.refreshTokenTtl'),
      default: '604800',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    refreshTokenTtl = parseInt(refreshTokenTtlStr, 10);

    const authCodeTtlStr = await input({
      message: t('oidc.authCodeTtl'),
      default: '600',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    authCodeTtl = parseInt(authCodeTtlStr, 10);

    pkceRequired = await confirm({
      message: t('oidc.pkceRequired'),
      default: true,
    });
  }

  // Step 8: Sharding settings
  const configureSharding = await confirm({
    message: t('sharding.configurePrompt'),
    default: false,
  });

  let authCodeShards = 64;
  let refreshTokenShards = 8;
  let sessionShards = 32;
  let challengeShards = 16;
  let flowStateShards = 32;

  if (configureSharding) {
    console.log('');
    console.log(chalk.blue('━━━ ' + t('sharding.title') + ' ━━━'));
    console.log(chalk.gray('  ' + t('sharding.note')));
    console.log('');

    const authCodeShardsStr = await input({
      message: t('sharding.authCodeShards'),
      default: '64',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    authCodeShards = parseInt(authCodeShardsStr, 10);

    const refreshTokenShardsStr = await input({
      message: t('sharding.refreshTokenShards'),
      default: '8',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    refreshTokenShards = parseInt(refreshTokenShardsStr, 10);
  }

  // Step 9: Database Configuration
  console.log('');
  console.log(chalk.blue('━━━ ' + t('db.title') + ' ━━━'));
  console.log(chalk.yellow('⚠️  ' + t('db.regionWarning')));
  console.log('');

  const dbLocationChoices = [
    { name: t('region.auto'), value: 'auto' },
    { name: '── ' + t('db.locationHints') + ' ──', value: '__separator1__', disabled: true },
    { name: t('region.wnam'), value: 'wnam' },
    { name: t('region.enam'), value: 'enam' },
    { name: t('region.weur'), value: 'weur' },
    { name: t('region.eeur'), value: 'eeur' },
    { name: t('region.apac'), value: 'apac' },
    { name: t('region.oceania'), value: 'oc' },
    {
      name: '── ' + t('db.jurisdictionCompliance') + ' ──',
      value: '__separator2__',
      disabled: true,
    },
    { name: t('region.euJurisdiction'), value: 'eu' },
  ];

  console.log(chalk.gray('  ' + t('db.coreDescription')));
  const coreDbLocation = await select({
    message: t('db.coreRegion'),
    choices: dbLocationChoices,
    default: 'auto',
  });

  console.log('');
  console.log(chalk.gray('  ' + t('db.piiDescription')));
  console.log(chalk.gray('  ' + t('db.piiNote')));
  const piiDbLocation = await select({
    message: t('db.piiRegion'),
    choices: dbLocationChoices,
    default: 'auto',
  });

  // Step 10: Security Configuration
  console.log('');
  console.log(chalk.blue('━━━ ' + t('security.title') + ' ━━━'));
  console.log(chalk.yellow('⚠️  ' + t('security.warning')));
  console.log('');

  console.log(chalk.gray('  ' + t('security.description')));
  const piiEncryptionEnabled = await select({
    message: t('security.piiEncryption'),
    choices: [
      {
        name: t('security.piiEncryptionEnabled'),
        value: true,
        description: t('security.piiEncryptionEnabledDesc'),
      },
      {
        name: t('security.piiEncryptionDisabled'),
        value: false,
        description: t('security.piiEncryptionDisabledDesc'),
      },
    ],
    default: true,
  });

  const domainHashEnabled = await select({
    message: t('security.domainHash'),
    choices: [
      {
        name: t('security.domainHashEnabled'),
        value: true,
        description: t('security.domainHashEnabledDesc'),
      },
      {
        name: t('security.domainHashDisabled'),
        value: false,
        description: t('security.domainHashDisabledDesc'),
      },
    ],
    default: true,
  });

  // Parse location vs jurisdiction
  function parseDbLocationNormal(value: string) {
    if (value === 'eu') {
      return { location: 'auto' as const, jurisdiction: 'eu' as const };
    }
    return {
      location: value as 'auto' | 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc',
      jurisdiction: 'none' as const,
    };
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.profile = profile as 'basic-op' | 'fapi-rw' | 'fapi2-security';
  config.database = {
    core: parseDbLocationNormal(coreDbLocation),
    pii: parseDbLocationNormal(piiDbLocation),
  };
  config.tenant = {
    name: tenantName,
    displayName: tenantDisplayName,
    multiTenant,
    baseDomain,
  };
  config.components = {
    ...config.components,
    saml: enableSaml,
    async: enableQueue, // async is tied to queue
    vc: enableVc,
    bridge: true, // Standard component
    policy: true, // Standard component
  };
  config.urls = {
    api: {
      custom: apiDomain || null,
      auto: getWorkersDevUrl(envPrefix + '-ar-router'),
    },
    loginUi: {
      custom: loginUiDomain || null,
      auto: getPagesDevUrl(envPrefix + '-ar-login-ui'),
      sameAsApi: false,
    },
    adminUi: {
      custom: adminUiDomain || null,
      auto: getPagesDevUrl(envPrefix + '-ar-admin-ui'),
      sameAsApi: false,
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
    sessionShards,
    challengeShards,
    flowStateShards,
  };
  config.features = {
    queue: { enabled: enableQueue },
    r2: { enabled: enableR2 },
    email: {
      provider: emailConfigNormal.provider,
      fromAddress: emailConfigNormal.fromAddress,
      fromName: emailConfigNormal.fromName,
      configured: emailConfigNormal.provider === 'resend',
    },
  };
  config.security = {
    piiEncryptionEnabled,
    domainHashEnabled,
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📋 Configuration Summary'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Infrastructure
  console.log(chalk.bold('Infrastructure:'));
  console.log(`  Environment:   ${chalk.cyan(envPrefix)}`);
  console.log(`  Worker Prefix: ${chalk.cyan(envPrefix + '-ar-*')}`);
  console.log(`  Profile:       ${chalk.cyan(profile)}`);
  console.log('');

  // Tenant mode and Issuer
  console.log(chalk.bold('Tenant & Issuer:'));
  console.log(
    `  Mode:          ${multiTenant ? chalk.cyan('Multi-tenant') : chalk.cyan('Single-tenant')}`
  );
  if (multiTenant && baseDomain) {
    console.log(`  Base Domain:   ${chalk.cyan(baseDomain)}`);
    console.log(`  Issuer Format: ${chalk.cyan('https://{tenant}.' + baseDomain)}`);
    console.log(`  Example:       ${chalk.gray('https://acme.' + baseDomain)}`);
  } else {
    const issuerUrl = config.urls.api.custom || config.urls.api.auto;
    console.log(`  Issuer URL:    ${chalk.cyan(issuerUrl)}`);
  }
  console.log(`  Default Tenant: ${chalk.cyan(tenantName)}`);
  console.log(`  Display Name:  ${chalk.cyan(tenantDisplayName)}`);
  console.log('');

  // Public URLs
  console.log(chalk.bold('Public URLs:'));
  if (multiTenant && baseDomain) {
    console.log(
      `  API Router:    ${chalk.cyan('*.' + baseDomain)} → ${chalk.gray(envPrefix + '-ar-router')}`
    );
  } else {
    console.log(`  API Router:    ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`);
  }
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
  console.log(`  Social Login:  ${chalk.green('Enabled')} ${chalk.gray('(standard)')}`);
  console.log(`  Policy Engine: ${chalk.green('Enabled')} ${chalk.gray('(standard)')}`);
  console.log('');
  console.log(chalk.bold('Feature Flags:'));
  console.log(`  Queue:         ${enableQueue ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log(`  R2:            ${enableR2 ? chalk.green('Enabled') : chalk.gray('Disabled')}`);
  console.log('');
  console.log(chalk.bold('Email:'));
  if (emailConfigNormal.provider === 'resend') {
    console.log(`  Provider:      ${chalk.cyan('Resend')}`);
    console.log(`  From Address:  ${chalk.cyan(emailConfigNormal.fromAddress)}`);
    if (emailConfigNormal.fromName) {
      console.log(`  From Name:     ${chalk.cyan(emailConfigNormal.fromName)}`);
    }
  } else {
    console.log(`  Provider:      ${chalk.gray('Not configured (configure later)')}`);
  }
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
  console.log(chalk.bold('Database:'));
  const coreDbDisplay =
    coreDbLocation === 'eu'
      ? 'EU Jurisdiction'
      : coreDbLocation === 'auto'
        ? 'Automatic'
        : coreDbLocation.toUpperCase();
  const piiDbDisplay =
    piiDbLocation === 'eu'
      ? 'EU Jurisdiction'
      : piiDbLocation === 'auto'
        ? 'Automatic'
        : piiDbLocation.toUpperCase();
  console.log(`  Core DB:       ${chalk.cyan(coreDbDisplay)}`);
  console.log(`  PII DB:        ${chalk.cyan(piiDbDisplay)}`);
  console.log('');

  const proceed = await confirm({
    message: 'Start setup with this configuration?',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  // Save email secrets if configured
  if (emailConfigNormal.provider === 'resend' && emailConfigNormal.apiKey) {
    // Save to external keys directory: {cwd}/.authrim-keys/{env}/
    const keysDir = getExternalKeysDir(envPrefix, process.cwd());
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
      const resendApiKeyPath = join(keysDir, 'resend_api_key.txt');
      await fs.writeFile(resendApiKeyPath, emailConfigNormal.apiKey!.trim());
      await fs.chmod(resendApiKeyPath, 0o600);
      const emailFromPath = join(keysDir, 'email_from.txt');
      await fs.writeFile(emailFromPath, emailConfigNormal.fromAddress!.trim());
      await fs.chmod(emailFromPath, 0o600);
      if (emailConfigNormal.fromName) {
        const emailFromNamePath = join(keysDir, 'email_from_name.txt');
        await fs.writeFile(emailFromNamePath, emailConfigNormal.fromName.trim());
        await fs.chmod(emailFromNamePath, 0o600);
      }
    });
    console.log(chalk.gray(`📧 Email secrets saved to ${keysDir}/`));
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
  const outputDir = resolve(keepPath || '.');
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
      console.log('');
      console.log(chalk.yellow('  Run the following command to install:'));
      console.log('');
      console.log(chalk.cyan('    npm install -g wrangler'));
      console.log('');
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail('Not logged in to Cloudflare');
      console.log('');
      console.log(chalk.yellow('  Run the following command to authenticate:'));
      console.log('');
      console.log(chalk.cyan('    wrangler login'));
      console.log('');
      return;
    }

    wranglerCheck.succeed(`Connected to Cloudflare (${auth.email || 'authenticated'})`);

    // Get account ID and workers subdomain
    const accountId = await getAccountId();
    if (accountId) {
      config.cloudflare = { accountId };
    }

    // Get workers.dev subdomain for correct URL generation
    workersSubdomain = await getWorkersSubdomain();
  } catch (error) {
    wranglerCheck.fail('Failed to check wrangler');
    console.error(error);
    return;
  }

  // Step 1: Generate keys (external directory: .authrim-keys/{env}/)
  // Check if keys already exist for this environment
  const cwdDir = process.cwd();
  if (keysExistForEnvironment(outputDir, env, cwdDir)) {
    console.log(chalk.yellow(`⚠️  Warning: Keys already exist for environment "${env}"`));
    console.log(chalk.yellow('   Existing keys will be overwritten.'));
    console.log('');
  }

  const keysSpinner = ora('Generating cryptographic keys...').start();
  try {
    const keyId = generateKeyId(env);
    secrets = generateAllSecrets(keyId);

    // Save to external structure: {cwd}/.authrim-keys/{env}/
    const externalKeysDir = getExternalKeysDir(env, cwdDir);
    await saveKeysToDirectory(secrets, { keysBaseDir: cwdDir, env });

    config.keys = {
      keyId: secrets.keyPair.keyId,
      publicKeyJwk: secrets.keyPair.publicKeyJwk as Record<string, unknown>,
      secretsPath: getExternalKeysPathForConfig(env, cwdDir),
      includeSecrets: false,
      storageType: 'external',
    };

    keysSpinner.succeed(`Keys generated (${externalKeysDir})`);
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
      databaseConfig: config.database,
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

  // Step 3: Create lock file (save to new structure: .authrim/{env}/lock.json)
  const envPaths = getEnvironmentPaths({ baseDir: outputDir, env });
  const lockSpinner = ora('Generating lock file...').start();
  try {
    const lockFile = createLockFile(env, provisionedResources);
    await saveLockFile(lockFile, { baseDir: outputDir, env });
    lockSpinner.succeed(`Lock file saved (${envPaths.lock})`);
  } catch (error) {
    lockSpinner.fail('Lock file save failed');
    console.error(error);
  }

  // Step 4: Save configuration (save to new structure: .authrim/{env}/config.json)
  const configSpinner = ora('Saving configuration...').start();
  try {
    // Ensure environment directory exists
    await mkdir(envPaths.root, { recursive: true });

    const configPath = envPaths.config;
    config.updatedAt = new Date().toISOString();
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Also save version.txt
    const setupVersion = getVersion();
    await writeFile(envPaths.version, setupVersion, 'utf-8');

    configSpinner.succeed(`Configuration saved (${configPath})`);
  } catch (error) {
    configSpinner.fail('Configuration save failed');
    throw error;
  }

  // Step 4.5: Generate ui.env for UI builds
  const uiEnvSpinner = ora('Generating UI environment file...').start();
  try {
    const apiBaseUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
    if (apiBaseUrl) {
      await saveUiEnv(envPaths.uiEnv, {
        PUBLIC_API_BASE_URL: apiBaseUrl,
      });
      uiEnvSpinner.succeed(`UI env saved (${envPaths.uiEnv})`);
    } else {
      uiEnvSpinner.warn('Skipped ui.env generation (no API URL configured)');
      console.log(chalk.gray('  Tip: ui.env will be created when API URL is configured'));
    }
  } catch (error) {
    uiEnvSpinner.fail('UI env generation failed');
    console.error(error);
    // Non-fatal: continue with setup
  }

  // Step 5: Generate wrangler.toml files
  const resourceIds = toResourceIds(provisionedResources);
  const packagesDir = join(outputDir, 'packages');
  const baseDir = process.cwd();

  // Step 5a: Save master wrangler configs to .authrim/{env}/wrangler/
  const wranglerSpinner = ora('Saving wrangler.toml master configs...').start();
  try {
    const { saveMasterWranglerConfigs, syncWranglerConfigs } =
      await import('../../core/wrangler-sync.js');

    const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
      baseDir,
      env,
      dryRun: false,
      onProgress: (msg) => {
        wranglerSpinner.text = msg;
      },
    });

    if (masterResult.success) {
      wranglerSpinner.succeed(`Saved ${masterResult.files.length} wrangler.toml master configs`);
    } else {
      wranglerSpinner.warn('Some wrangler configs failed to save');
      for (const error of masterResult.errors) {
        console.log(chalk.yellow(`  • ${error}`));
      }
    }

    // Step 5b: Sync to deployment locations (if packages directory exists)
    if (existsSync(packagesDir)) {
      const syncSpinner = ora('Syncing wrangler configs to packages...').start();

      const syncResult = await syncWranglerConfigs(
        {
          baseDir,
          env,
          packagesDir,
          force: true, // First time setup, always overwrite
          dryRun: false,
          onProgress: (msg) => {
            syncSpinner.text = msg;
          },
        },
        undefined // No manual edit callback for init
      );

      if (syncResult.success) {
        syncSpinner.succeed(`Synced wrangler configs to ${syncResult.synced.length} components`);
      } else {
        syncSpinner.fail('wrangler config sync failed');
        for (const error of syncResult.errors) {
          console.log(chalk.red(`  • ${error}`));
        }
      }
    }
  } catch (error) {
    wranglerSpinner.fail('wrangler.toml generation failed');
    console.error(error);
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
  console.log(`  - ${envPaths.config}`);
  console.log(`  - ${envPaths.lock}`);
  console.log(`  - ${envPaths.version}`);
  console.log(
    `  - ${envPaths.keys}/ ${chalk.gray('(private keys - add .authrim/ to .gitignore)')}`
  );
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
  console.log('  1. Upload secrets to Cloudflare:');
  console.log(chalk.cyan(`     ${getCommandPrefix()} secrets --env=${env}`));
  console.log('');
  console.log('  2. Deploy Workers:');
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

  // Determine lock file path based on config file structure
  // New structure: .authrim/{env}/config.json -> .authrim/{env}/lock.json
  // Legacy structure: authrim-config.json -> authrim-lock.json
  let lockPath: string;
  const isNewStructure =
    configPath.includes(`${AUTHRIM_DIR}/`) && configPath.endsWith('/config.json');
  if (isNewStructure) {
    lockPath = configPath.replace('/config.json', '/lock.json');
  } else {
    lockPath = configPath.replace('authrim-config.json', 'authrim-lock.json');
  }

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
      console.log('');
      console.log(chalk.yellow('  Run the following command to install:'));
      console.log('');
      console.log(chalk.cyan('    npm install -g wrangler'));
      console.log('');
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail('Not logged in to Cloudflare');
      console.log('');
      console.log(chalk.yellow('  Run the following command to authenticate:'));
      console.log('');
      console.log(chalk.cyan('    wrangler login'));
      console.log('');
      return;
    }

    wranglerCheck.succeed(`Connected to Cloudflare (${auth.email || 'authenticated'})`);

    // Get workers.dev subdomain for correct URL generation
    workersSubdomain = await getWorkersSubdomain();
  } catch (error) {
    wranglerCheck.fail('Failed to check wrangler');
    console.error(error);
    return;
  }

  // Load lock file
  const lock = await loadLockFile(lockPath);
  const hasLock = lock !== null;

  if (!hasLock) {
    console.log(chalk.yellow(`\n⚠️  Lock file not found (${lockPath})`));
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
        databaseConfig: config.database,
        onProgress: (msg) => console.log(`  ${msg}`),
      });

      // Create and save lock file
      const newLock = createLockFile(env, provisionedResources);
      await saveLockFile(newLock, lockPath);
      console.log(chalk.green(`\n✓ Lock file saved (${lockPath})`));
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
      api: { custom: null, auto: getWorkersDevUrl(env + '-ar-router') },
      loginUi: { custom: null, auto: getPagesDevUrl(env + '-ar-login-ui'), sameAsApi: false },
      adminUi: { custom: null, auto: getPagesDevUrl(env + '-ar-admin-ui'), sameAsApi: false },
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
    auto: config.urls.api?.auto || getWorkersDevUrl(env + '-ar-router'),
  };
  config.urls.loginUi = {
    custom: loginUiDomain || null,
    auto: config.urls.loginUi?.auto || getPagesDevUrl(env + '-ar-login-ui'),
    sameAsApi: config.urls.loginUi?.sameAsApi ?? false,
  };
  config.urls.adminUi = {
    custom: adminUiDomain || null,
    auto: config.urls.adminUi?.auto || getPagesDevUrl(env + '-ar-admin-ui'),
    sameAsApi: config.urls.adminUi?.sameAsApi ?? false,
  };

  return true;
}

// =============================================================================
// Edit Components
// =============================================================================

async function editComponents(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\nCurrent Component Settings:'));
  console.log(
    `  SAML:          ${config.components.saml ? chalk.green('Enabled') : chalk.gray('Disabled')}`
  );
  console.log(
    `  Async:         ${config.components.async ? chalk.green('Enabled') : chalk.gray('Disabled')}`
  );
  console.log(
    `  VC:            ${config.components.vc ? chalk.green('Enabled') : chalk.gray('Disabled')}`
  );
  console.log(`  Social Login:  ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
  console.log(`  Policy Engine: ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
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

  // Standard components are always enabled
  config.components.bridge = true;
  config.components.policy = true;

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
  config.features.email = {
    provider: emailProvider as 'none' | 'resend' | 'sendgrid' | 'ses',
    configured: config.features.email?.configured || false,
    fromAddress: config.features.email?.fromAddress,
    fromName: config.features.email?.fromName,
  };

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
