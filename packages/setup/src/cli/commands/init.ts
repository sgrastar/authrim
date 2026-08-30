/**
 * Init Command - Setup wizard for Authrim
 *
 * Provides both CLI and Web UI modes for setting up Authrim.
 */

import { input, select, confirm as inquirerConfirm, password } from '@inquirer/prompts';
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
import { dirname, join, resolve } from 'node:path';
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
  checkZoneExists,
  extractZoneName,
  type ZoneCheckResult,
} from '../../core/cloudflare.js';
import {
  acquireEnvironmentOperationForEnvironment,
  createLockFile,
  saveLockFile,
  loadLockFile,
} from '../../core/lock.js';
import {
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from '../../core/environment-operation-policy.js';
import { hasDatabaseTopologyChange } from '../../core/environment-config-policy.js';
import {
  getEnvironmentPaths,
  getExternalKeysDir,
  getExternalKeysPathForConfig,
  AUTHRIM_DIR,
  LEGACY_CONFIG_FILE,
  LEGACY_LOCK_FILE,
  findLegacyConfigPath,
  findLegacyLockPath,
  getLegacyConfigFileName,
  getLegacyLockFileName,
  listEnvironments,
  findAuthrimBaseDir,
} from '../../core/paths.js';
import {
  downloadSource,
  verifySourceStructure,
  checkForUpdate,
  getLocalVersion,
} from '../../core/source.js';
import { saveUiEnv, buildInitialUiEnvConfig } from '../../core/ui-env.js';
import { buildUrlsConfig, getUiWorkersDevUrl, getWorkersDevUrl } from '../../core/url-config.js';
import { uiCustomDomainRequiresOwnRoute } from '../../core/ui-deployment.js';
import { generateRandomTenantId, isValidTenantId } from '../../core/tenant-id.js';
import { printCliCapabilitySummary } from '../capability-summary.js';
import { inspectLocalEnvironmentState } from '../../core/local-environment-state.js';
import {
  isValidCustomDomain,
  validateSetupDomainInputs,
  type SetupDomainValidationIssue,
} from '../../web/domain-form-state.js';

// =============================================================================
// Zone Check Helper
// =============================================================================

interface ZoneDomainConfig {
  zoneId?: string | null;
  customDomainBinding?: boolean;
}

let cliCapabilitySummaryShown = false;

async function confirm(config: Parameters<typeof inquirerConfirm>[0]): Promise<boolean> {
  return inquirerConfirm({
    ...config,
    transformer: config.transformer ?? ((value) => t(value ? 'common.yes' : 'common.no')),
  });
}

async function ensureNewEnvironmentNameIsAvailable(input: {
  environment: string;
  baseDir: string;
}): Promise<boolean> {
  const checkSpinner = ora(t('env.checking')).start();
  const localState = inspectLocalEnvironmentState({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (localState.exists) {
    checkSpinner.fail(t('env.alreadyExists', { env: input.environment }));
    console.log('');
    console.log(chalk.yellow('  ' + t('env.existingResources')));
    for (const path of localState.paths) console.log(chalk.gray(`    ${path}`));
    console.log('');
    console.log(chalk.yellow('  ' + t('env.chooseAnother', { command: getCommandPrefix() })));
    return false;
  }

  try {
    const existingEnvironments = await detectEnvironments();
    const existingEnvironment = existingEnvironments.find(
      (candidate) => candidate.env === input.environment
    );
    if (existingEnvironment) {
      checkSpinner.fail(t('env.alreadyExists', { env: input.environment }));
      console.log('');
      console.log(chalk.yellow('  ' + t('env.existingResources')));
      console.log(`    ${t('env.workers', { count: String(existingEnvironment.workers.length) })}`);
      console.log(`    ${t('env.d1Databases', { count: String(existingEnvironment.d1.length) })}`);
      console.log(`    ${t('env.kvNamespaces', { count: String(existingEnvironment.kv.length) })}`);
      console.log('');
      console.log(chalk.yellow('  ' + t('env.chooseAnother', { command: getCommandPrefix() })));
      return false;
    }
    checkSpinner.succeed(t('env.available'));
  } catch {
    checkSpinner.warn(t('env.checkFailed'));
  }
  return true;
}

function formatSetupDomainValidationIssue(issue: SetupDomainValidationIssue): string {
  const message =
    issue.kind === 'baseDomainDepth'
      ? t('domain.baseDomainDepthError', { hostname: issue.hostname })
      : t('domain.uiDomainDepthError', {
          label:
            issue.field === 'loginUiDomain' ? t('web.domain.loginUi') : t('web.domain.adminUi'),
          hostname: issue.hostname,
        });
  return issue.suggestion
    ? `${message} ${t('domain.suggestedHost', { hostname: issue.suggestion })}`
    : message;
}

function validateCliApiDomainInput(value: string, tenantName = 'default'): true | string {
  if (!value) return true;
  if (!isValidCustomDomain(value)) {
    return t('tenant.baseDomainValidation');
  }
  const issue = validateSetupDomainInputs({
    apiDomain: value,
    tenantName,
  }).find((candidate) => candidate.field === 'apiDomain');
  return issue ? formatSetupDomainValidationIssue(issue) : true;
}

function validateCliUiDomainInput(
  value: string,
  field: 'loginUiDomain' | 'adminUiDomain',
  apiDomain: string | null | undefined,
  tenantName = 'default'
): true | string {
  if (!value) return true;
  if (!isValidCustomDomain(value)) {
    return t('domain.customValidation');
  }
  const issue = validateSetupDomainInputs({
    apiDomain: apiDomain || '',
    loginUiDomain: field === 'loginUiDomain' ? value : undefined,
    adminUiDomain: field === 'adminUiDomain' ? value : undefined,
    tenantName,
  }).find((candidate) => candidate.field === field);
  return issue ? formatSetupDomainValidationIssue(issue) : true;
}

async function showCliCapabilitySummaryOnce(options?: {
  installed?: boolean;
  auth?: Awaited<ReturnType<typeof checkAuth>>;
  workersSubdomain?: string | null;
}): Promise<void> {
  if (cliCapabilitySummaryShown) {
    return;
  }

  const installed = options?.installed ?? (await isWranglerInstalled());
  const auth = options?.auth ?? (installed ? await checkAuth() : { isLoggedIn: false });
  workersSubdomain =
    options?.workersSubdomain ??
    (installed && auth.isLoggedIn ? await getWorkersSubdomain() : null);

  await printCliCapabilitySummary({
    auth,
    wranglerInstalled: installed,
    workersSubdomain,
    locale: getLocale(),
  });
  cliCapabilitySummaryShown = true;
}

/**
 * Check Cloudflare zone for a domain and prompt user for binding configuration.
 * Never blocks setup - all errors are handled gracefully.
 */
async function checkAndPromptZone(domain: string, domainConfig: ZoneDomainConfig): Promise<void> {
  const spinner = ora(t('domain.checkingZone', { domain })).start();

  try {
    const result = await checkZoneExists(domain);
    spinner.stop();
    const diagnosticCode = result.diagnostic?.code;
    const zoneName = extractZoneName(domain);

    if (result.found && result.zone) {
      console.log(
        chalk.green(
          `  ✓ ${t('domain.zoneFound', { zone: result.zone.name, status: result.zone.status })}`
        )
      );
      domainConfig.zoneId = result.zone.id;
      console.log('');
      console.log(chalk.gray(`  ${t('domain.configureBindingDesc')}`));

      const bind = await confirm({ message: t('domain.configureBinding'), default: true });
      domainConfig.customDomainBinding = bind;
      return;
    }

    printCliZoneDiagnostic(result, { domain, zoneName });

    if (result.diagnostic?.allowBinding) {
      console.log('');
      console.log(chalk.gray(`  ${t('domain.configureBindingDesc')}`));
      const bind = await confirm({ message: t('domain.configureBinding'), default: true });
      domainConfig.customDomainBinding = bind;
      return;
    }

    if (diagnosticCode === 'zone_not_found') {
      console.log('');
      const ok = await confirm({ message: t('domain.continueWithoutZone'), default: true });
      if (!ok) {
        throw new Error('USER_CANCELLED_DOMAIN');
      }
      return;
    }

    console.log(chalk.gray(`    ${t('domain.zoneCheckSkipped')}`));
  } catch (error) {
    spinner.stop();
    if (error instanceof Error && error.message === 'USER_CANCELLED_DOMAIN') {
      throw error;
    }
    // Unexpected error - don't block setup
    console.log(chalk.yellow(`  ⚠ ${t('domain.zoneCheckFailed')}`));
    console.log(chalk.gray(`    ${t('domain.zoneCheckSkipped')}`));
  }
}

async function checkUiCustomDomainZoneIfNeeded(params: {
  label: string;
  domain: string | null | undefined;
  apiDomain: string | null | undefined;
  baseDomain?: string | null;
  multiTenant?: boolean;
}): Promise<boolean> {
  const domain = params.domain?.trim();
  if (
    !domain ||
    !uiCustomDomainRequiresOwnRoute({
      uiDomain: domain,
      apiDomain: params.apiDomain,
      baseDomain: params.baseDomain,
      multiTenant: params.multiTenant,
    })
  ) {
    return true;
  }

  const spinner = ora(t('domain.checkingZone', { domain })).start();

  try {
    const result = await checkZoneExists(domain);
    spinner.stop();
    const zoneName = extractZoneName(domain);

    if (result.found && result.zone) {
      console.log(
        chalk.green(
          `  ✓ ${params.label}: ${t('domain.zoneFound', {
            zone: result.zone.name,
            status: result.zone.status,
          })}`
        )
      );
      return true;
    }

    console.log(chalk.yellow(`  ⚠ ${t('domain.uiRequiresOwnRoute', { label: params.label })}`));
    printCliZoneDiagnostic(result, { domain, zoneName });

    if (result.diagnostic?.code === 'zone_not_found') {
      console.log('');
      const ok = await confirm({
        message: `${params.label}: ${t('domain.continueWithoutZone')}`,
        default: false,
      });
      return ok;
    }

    return true;
  } catch {
    spinner.stop();
    console.log(chalk.yellow(`  ⚠ ${params.label}: ${t('domain.zoneCheckFailed')}`));
    console.log(chalk.gray(`    ${t('domain.zoneCheckSkipped')}`));
    return true;
  }
}

function printCliZoneDiagnostic(
  result: ZoneCheckResult,
  params: { domain: string; zoneName: string }
): void {
  const code = result.diagnostic?.code || 'api_error';
  const translatedParams = {
    domain: params.domain,
    zone: params.zoneName,
  };
  const title = t(`domain.diagnostic.${code}.title`, translatedParams);
  const body = t(`domain.diagnostic.${code}.body`, translatedParams);
  const next = t(`domain.diagnostic.${code}.next`, translatedParams);
  const icon = result.diagnostic?.severity === 'error' ? '✖' : '⚠';
  const color = result.diagnostic?.severity === 'error' ? chalk.red : chalk.yellow;

  console.log(color(`  ${icon} ${title}`));
  console.log(chalk.gray(`    ${body}`));
  if (next && next !== `domain.diagnostic.${code}.next`) {
    console.log(chalk.gray(`    ${next}`));
  }
}

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
  tenantPlacement?: 'tenant_exclusive' | 'shared_pool';
}

export function resolveInitialTenantPlacement(
  value: string | undefined
): 'tenant_exclusive' | 'shared_pool' {
  if (value === undefined || value === 'tenant_exclusive') return 'tenant_exclusive';
  if (value === 'shared_pool') return 'shared_pool';
  throw new Error('invalid_initial_tenant_placement');
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
 * Strip the protocol from a URL for display in domain-only prompts.
 */
function stripProtocol(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '');
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
    const configFiles = [
      LEGACY_CONFIG_FILE,
      LEGACY_LOCK_FILE,
      ...listEnvironments(sourceDir).flatMap((env) => [
        getLegacyConfigFileName(env),
        getLegacyLockFileName(env),
      ]),
    ];
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
  await showCliCapabilitySummaryOnce();

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
  const foundConfigs: { path: string; env: string }[] = [];

  // Check new structure (.authrim/{env}/config.json)
  for (const env of environments) {
    const newPaths = getEnvironmentPaths({ baseDir, env });
    if (existsSync(newPaths.config)) {
      foundConfigs.push({ path: newPaths.config, env });
    }
  }

  const legacyConfigPaths = new Set([
    findLegacyConfigPath(baseDir),
    ...environments.map((env) => findLegacyConfigPath(baseDir, env)),
  ]);
  const detectedLegacyConfig = [...legacyConfigPaths].find((path) => existsSync(path));
  if (detectedLegacyConfig) {
    console.log(chalk.red('Legacy Setup configuration is not supported by this release.'));
    console.log(chalk.gray(`  Detected: ${detectedLegacyConfig}`));
    console.log(chalk.gray('  Create a fresh environment with authrim-setup init.'));
    return false;
  }

  let configPath: string;

  if (foundConfigs.length > 0) {
    console.log(chalk.green(`✓ Found ${foundConfigs.length} configuration(s):`));
    for (const cfg of foundConfigs) {
      console.log(`  • ${cfg.path} - env: ${cfg.env}`);
    }
    console.log('');

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
          name: `📂 ${cfg.env} (${cfg.path})`,
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
    console.log(chalk.cyan(`   ${getCommandPrefix()} --config /path/to/authrim-{env}-config.json`));
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

async function promptAutomaticProvisioning(): Promise<boolean> {
  const enabled = await confirm({
    message: t('web.db.automaticProvisioningTitle'),
    default: true,
  });
  console.log(
    chalk.gray(
      enabled
        ? `  ${t('web.db.automaticProvisioningOnDesc')}`
        : `  ${t('web.db.automaticProvisioningOffDesc')}`
    )
  );
  return enabled;
}

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

  if (
    !(await ensureNewEnvironmentNameIsAvailable({
      environment: envPrefix,
      baseDir: resolve(options.keep || '.'),
    }))
  ) {
    return;
  }

  // Step 2: Show infrastructure info
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
  const quickDomainConfig: ZoneDomainConfig = {};

  if (useCustomDomain) {
    console.log('');
    console.log(chalk.gray('  ' + t('domain.singleTenantNote')));
    console.log('');

    apiDomain = await input({
      message: t('domain.apiDomain'),
      validate: (value) => {
        return validateCliApiDomainInput(value);
      },
    });

    // Check Cloudflare zone for the domain
    if (apiDomain) {
      console.log('');
      try {
        await checkAndPromptZone(apiDomain, quickDomainConfig);
      } catch {
        // User cancelled - clear domain and continue
        apiDomain = null;
      }
      console.log('');
    }

    loginUiDomain = await input({
      message: t('domain.loginUiDomain'),
      default: '',
      validate: (value) => validateCliUiDomainInput(value, 'loginUiDomain', apiDomain),
    });

    adminUiDomain = await input({
      message: t('domain.adminUiDomain'),
      default: '',
      validate: (value) => validateCliUiDomainInput(value, 'adminUiDomain', apiDomain),
    });

    if (loginUiDomain || adminUiDomain) {
      console.log('');
      if (
        !(await checkUiCustomDomainZoneIfNeeded({
          label: t('web.domain.loginUi'),
          domain: loginUiDomain,
          apiDomain,
          multiTenant: false,
        }))
      ) {
        loginUiDomain = null;
      }
      if (
        !(await checkUiCustomDomainZoneIfNeeded({
          label: t('web.domain.adminUi'),
          domain: adminUiDomain,
          apiDomain,
          multiTenant: false,
        }))
      ) {
        adminUiDomain = null;
      }
      console.log('');
    }
  }

  // Unified Control Plane provisioning mode
  console.log('');
  console.log(chalk.blue('━━━ ' + t('web.db.controlPlaneTitle') + ' ━━━'));
  console.log(chalk.gray('  ' + t('web.db.controlPlaneDesc')));
  console.log(chalk.gray('  ' + t('web.db.controlPlaneTenantPlacement')));
  const automaticProvisioning = await promptAutomaticProvisioning();

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
    provider: 'cloudflare' | 'resend' | 'none';
    fromAddress?: string;
    fromName?: string;
    apiKey?: string;
  } = { provider: 'none' };

  if (configureEmail) {
    console.log('');
    const provider = (await select({
      message: t('email.title'),
      choices: [
        { value: 'cloudflare', name: t('web.email.cloudflareSetup') },
        { value: 'resend', name: t('email.resendOption') },
        { value: 'none', name: t('email.skipOption') },
      ],
      default: 'cloudflare',
    })) as 'cloudflare' | 'resend' | 'none';

    let resendApiKey: string | undefined;

    if (provider === 'cloudflare') {
      console.log(chalk.gray(t('web.email.cloudflareRequirementPaid')));
      console.log(chalk.gray(t('web.email.cloudflareRequirementDns')));
      console.log(chalk.gray(t('web.email.cloudflareRequirementManual')));
      console.log('');
    } else if (provider === 'resend') {
      console.log(chalk.gray(t('email.resendDesc')));
      console.log(chalk.gray(t('email.apiKeyHint')));
      console.log(chalk.gray(t('email.domainHint')));
      console.log('');

      resendApiKey = await password({
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
    }

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
      provider,
      fromAddress,
      fromName: fromName || undefined,
      apiKey: resendApiKey,
    };

    if (provider === 'resend') {
      console.log('');
      console.log(chalk.yellow('⚠️  ' + t('email.domainVerificationRequired')));
      console.log(chalk.gray('   ' + t('email.seeDocumentation')));
    }
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.tenant = {
    ...config.tenant,
    placementPolicy: resolveInitialTenantPlacement(options.tenantPlacement),
  };
  config.controlPlane = { automaticProvisioning };
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
      configured: emailConfig.provider !== 'none',
    },
  };
  config.urls = buildUrlsConfig({
    env: envPrefix,
    apiDomain,
    loginUiDomain,
    adminUiDomain,
    zoneId: quickDomainConfig.zoneId ?? null,
    customDomainBinding: quickDomainConfig.customDomainBinding ?? false,
    workersSubdomain,
  });

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold(`📋 ${t('config.summary')}`));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(chalk.bold(t('config.infrastructure')));
  console.log(`  ${t('config.environment')}   ${chalk.cyan(envPrefix)}`);
  console.log(`  ${t('config.workerPrefix')} ${chalk.cyan(envPrefix + '-ar-*')}`);
  console.log(`  ${t('config.d1Routing')} ${chalk.cyan('Control Plane')}`);
  console.log(`  ${t('config.placement')} ${chalk.cyan(config.tenant.placementPolicy)}`);
  console.log(
    `  ${t('config.provisioning')} ${automaticProvisioning ? chalk.green(t('web.db.automaticProvisioningOn')) : chalk.yellow(t('web.db.automaticProvisioningOff'))}`
  );
  console.log('');
  console.log(chalk.bold(`${t('config.publicUrls')} (${t('config.singleTenant')})`));
  console.log(
    `  ${t('config.issuerUrl')} ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`
  );
  console.log(
    `  ${t('config.loginUi')} ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  ${t('config.adminUi')} ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');
  console.log(chalk.bold(t('config.emailSettings')));
  if (emailConfig.provider === 'cloudflare') {
    console.log(`  ${t('email.provider')} ${chalk.cyan(t('web.email.cloudflareSetup'))}`);
    console.log(
      `  ${t('web.email.cloudflareRequirements')}: ${chalk.yellow(t('web.email.cloudflareRequirementPaid'))}`
    );
    console.log(`  ${t('email.fromAddress')} ${chalk.cyan(emailConfig.fromAddress)}`);
    if (emailConfig.fromName) {
      console.log(`  ${t('email.fromName')} ${chalk.cyan(emailConfig.fromName)}`);
    }
  } else if (emailConfig.provider === 'resend') {
    console.log(`  ${t('email.provider')} ${chalk.cyan('Resend')}`);
    console.log(`  ${t('email.fromAddress')} ${chalk.cyan(emailConfig.fromAddress)}`);
    if (emailConfig.fromName) {
      console.log(`  ${t('email.fromName')} ${chalk.cyan(emailConfig.fromName)}`);
    }
  } else {
    console.log(`  ${t('email.provider')} ${chalk.gray(t('config.notConfigured'))}`);
  }
  console.log('');

  const proceed = await confirm({
    message: t('deploy.prompt'),
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow(t('deploy.cancelled')));
    return;
  }

  // Save email secrets if configured
  if (emailConfig.provider !== 'none' && emailConfig.fromAddress) {
    // Save to external keys directory: {cwd}/.authrim-keys/{env}/
    const keysDir = getExternalKeysDir(envPrefix, process.cwd());
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
      const emailFromPath = join(keysDir, 'email_from.txt');
      await fs.writeFile(emailFromPath, emailConfig.fromAddress!.trim());
      await fs.chmod(emailFromPath, 0o600);
      if (emailConfig.fromName) {
        const emailFromNamePath = join(keysDir, 'email_from_name.txt');
        await fs.writeFile(emailFromNamePath, emailConfig.fromName.trim());
        await fs.chmod(emailFromNamePath, 0o600);
      }
      if (emailConfig.provider === 'resend' && emailConfig.apiKey) {
        const resendApiKeyPath = join(keysDir, 'resend_api_key.txt');
        await fs.writeFile(resendApiKeyPath, emailConfig.apiKey.trim());
        await fs.chmod(resendApiKeyPath, 0o600);
      }
    });
    console.log(chalk.gray(`📧 ${t('deploy.emailSecretsSaved', { path: `${keysDir}/` })}`));
  }
  // Run setup
  await executeSetup(config, options.keep);
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

  if (
    !(await ensureNewEnvironmentNameIsAvailable({
      environment: envPrefix,
      baseDir: resolve(options.keep || '.'),
    }))
  ) {
    return;
  }

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
  console.log(
    `    ${t('infra.ui')}         ${chalk.gray(getUiWorkersDevUrl(envPrefix + '-ar-ui'))}`
  );
  console.log('');

  // Step 5: Tenant configuration
  console.log(chalk.blue('━━━ ' + t('tenant.title') + ' ━━━'));
  console.log('');

  let tenantName = 'default';
  let tenantDisplayName = 'Initial Tenant';
  let baseDomain: string | undefined;
  let primaryTenant: string | undefined;
  let nakedDomain = false;
  let userIdFormat: 'nanoid' | 'uuid' = 'nanoid';

  // Step 6: URL configuration
  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;
  const fullDomainConfig: ZoneDomainConfig = {};

  // Base domain configuration
  console.log('');
  console.log(chalk.blue('━━━ ' + t('tenant.multiTenantTitle') + ' ━━━'));
  console.log('');
  console.log(chalk.gray('  ' + t('tenant.domainSetupHint')));
  console.log(chalk.gray('  ' + t('tenant.customDomainExamples')));
  console.log(chalk.gray('    • ' + t('tenant.nakedDomainExample')));
  console.log(chalk.gray('    • ' + t('tenant.subdomainExample')));
  console.log('');

  baseDomain = await input({
    message: t('tenant.baseDomainPrompt'),
    validate: (value) => {
      return validateCliApiDomainInput(value, tenantName);
    },
  });

  baseDomain = baseDomain || undefined;
  console.log('');
  if (baseDomain) {
    console.log(chalk.green(`  ✓ ${t('config.baseDomain')} ${baseDomain}`));
  } else {
    console.log(chalk.green(`  ✓ ${t('domain.usingWorkersDev')}`));
  }

  // Check Cloudflare zone for the base domain
  if (baseDomain) {
    try {
      await checkAndPromptZone(baseDomain, fullDomainConfig);
    } catch {
      // User cancelled - this is non-fatal, continue with setup
    }
  }
  console.log('');

  // API domain is the base domain
  apiDomain = baseDomain || null;

  console.log(chalk.gray('  ' + t('tenant.idRules')));
  console.log(chalk.gray('  ' + t('tenant.randomIdHint')));

  const suggestedTenantId = generateRandomTenantId();
  const useRandomTenantId = await confirm({
    message: t('tenant.randomIdPrompt', { id: suggestedTenantId }),
    default: !!baseDomain,
  });

  if (useRandomTenantId) {
    tenantName = suggestedTenantId;
    console.log(chalk.green(`  ✓ ${t('web.form.tenantId')}: ${tenantName}`));
  } else {
    tenantName = await input({
      message: t('tenant.defaultTenantPrompt'),
      default: baseDomain ? 'default' : tenantName || 'default',
      validate: (value) => {
        if (!isValidTenantId(value)) {
          return t('tenant.defaultTenantValidation');
        }
        return true;
      },
    });
  }

  tenantDisplayName = await input({
    message: t('tenant.displayNamePrompt'),
    default: t('tenant.initialDisplayName'),
  });

  if (baseDomain) {
    nakedDomain = await confirm({
      message: t('tenant.nakedDomainPrompt'),
      default: false,
    });

    if (nakedDomain) {
      primaryTenant = await input({
        message: t('tenant.primaryTenantPrompt'),
        default: '',
        validate: (value) => {
          if (!value) {
            return true;
          }
          if (!isValidTenantId(value)) {
            return t('tenant.defaultTenantValidation');
          }
          return true;
        },
      });
      primaryTenant = primaryTenant || undefined;
    }
  }

  // User ID format selection
  console.log('');
  console.log(chalk.blue('━━━ ' + t('userId.title') + ' ━━━'));
  console.log('');
  console.log(chalk.gray('  ' + t('userId.note')));
  console.log('');

  userIdFormat = await select<'nanoid' | 'uuid'>({
    message: t('userId.prompt'),
    choices: [
      {
        name: t('userId.nanoid'),
        value: 'nanoid' as const,
        description: t('userId.nanoidDesc'),
      },
      {
        name: t('userId.uuid'),
        value: 'uuid' as const,
        description: t('userId.uuidDesc'),
      },
    ],
    default: 'nanoid',
  });

  console.log('');
  console.log(chalk.green('  ✓ ' + t('userId.selected', { format: userIdFormat })));

  // UI domains
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
      validate: (value) => validateCliUiDomainInput(value, 'loginUiDomain', baseDomain, tenantName),
    });

    adminUiDomain = await input({
      message: t('tenant.adminUiDomain'),
      default: '',
      validate: (value) => validateCliUiDomainInput(value, 'adminUiDomain', baseDomain, tenantName),
    });

    if (loginUiDomain || adminUiDomain) {
      console.log('');
      if (
        !(await checkUiCustomDomainZoneIfNeeded({
          label: t('web.domain.loginUi'),
          domain: loginUiDomain,
          apiDomain,
          baseDomain,
          multiTenant: !!baseDomain,
        }))
      ) {
        loginUiDomain = null;
      }
      if (
        !(await checkUiCustomDomainZoneIfNeeded({
          label: t('web.domain.adminUi'),
          domain: adminUiDomain,
          apiDomain,
          baseDomain,
          multiTenant: !!baseDomain,
        }))
      ) {
        adminUiDomain = null;
      }
      console.log('');
    }
  }

  // Step 5: Standard components
  console.log('');
  console.log(chalk.blue('━━━ ' + t('components.title') + ' ━━━'));
  console.log(chalk.gray('  ' + t('components.note')));
  console.log('');

  // Step 6: Feature flags
  console.log('');
  console.log(chalk.blue('━━━ ' + t('features.title') + ' ━━━'));
  console.log('');
  const enableQueue = await confirm({
    message: t('features.queuePrompt'),
    default: false,
  });

  const enableR2 = true;

  const emailProviderChoice = await select({
    message: t('email.title'),
    choices: [
      { value: 'cloudflare', name: t('web.email.cloudflareSetup') },
      { value: 'resend', name: t('email.resendOption') },
      { value: 'none', name: t('email.skipOption') },
      { value: 'sendgrid', name: `SendGrid (${t('common.comingSoon')})`, disabled: true },
      { value: 'ses', name: `${t('email.sesOption')} (${t('common.comingSoon')})`, disabled: true },
    ],
    default: 'cloudflare',
  });

  // Email configuration details
  let emailConfigNormal: {
    provider: 'cloudflare' | 'resend' | 'none';
    fromAddress?: string;
    fromName?: string;
    apiKey?: string;
  } = { provider: 'none' };

  if (emailProviderChoice === 'cloudflare' || emailProviderChoice === 'resend') {
    console.log('');
    console.log(
      chalk.blue(
        '━━━ ' +
          (emailProviderChoice === 'cloudflare'
            ? 'Cloudflare Email Service'
            : t('email.resendOption')) +
          ' ━━━'
      )
    );
    if (emailProviderChoice === 'cloudflare') {
      console.log(chalk.gray(t('web.email.cloudflareRequirementPaid')));
      console.log(chalk.gray(t('web.email.cloudflareRequirementDns')));
      console.log(chalk.gray(t('web.email.cloudflareRequirementManual')));
    } else {
      console.log(chalk.gray(t('email.apiKeyHint')));
      console.log(chalk.gray(t('email.domainHint')));
    }
    console.log('');

    const resendApiKey =
      emailProviderChoice === 'resend'
        ? await password({
            message: t('email.apiKeyPrompt'),
            mask: '*',
            validate: (value) => {
              if (!value.trim()) return t('email.apiKeyRequired');
              if (!value.startsWith('re_')) {
                return t('email.apiKeyWarning');
              }
              return true;
            },
          })
        : undefined;

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
      provider: emailProviderChoice,
      fromAddress,
      fromName: fromName || undefined,
      apiKey: resendApiKey,
    };

    if (emailProviderChoice === 'resend') {
      console.log('');
      console.log(chalk.yellow('⚠️  ' + t('email.domainVerificationRequired')));
      console.log(chalk.gray('   ' + t('email.seeDocumentation')));
    }
  }

  // Step 8: Sharding settings
  const configureSharding = await confirm({
    message: t('sharding.configurePrompt'),
    default: false,
  });

  let authCodeShards = 4;
  let refreshTokenShards = 4;
  let sessionShards = 4;
  let challengeShards = 4;

  if (configureSharding) {
    console.log('');
    console.log(chalk.blue('━━━ ' + t('sharding.title') + ' ━━━'));
    console.log(chalk.gray('  ' + t('sharding.note')));
    console.log('');

    const authCodeShardsStr = await input({
      message: t('sharding.authCodeShards'),
      default: '4',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    authCodeShards = parseInt(authCodeShardsStr, 10);

    const refreshTokenShardsStr = await input({
      message: t('sharding.refreshTokenShards'),
      default: '4',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return t('oidc.positiveInteger');
        return true;
      },
    });
    refreshTokenShards = parseInt(refreshTokenShardsStr, 10);
  }

  // Step 9: Unified Control Plane provisioning mode
  console.log('');
  console.log(chalk.blue('━━━ ' + t('web.db.controlPlaneTitle') + ' ━━━'));
  console.log(chalk.gray('  ' + t('web.db.controlPlaneDesc')));
  console.log(chalk.gray('  ' + t('web.db.controlPlaneTenantPlacement')));
  console.log('');
  const automaticProvisioning = await promptAutomaticProvisioning();

  // Step 10: Database Configuration
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
  config.controlPlane = { automaticProvisioning };
  config.database = {
    core: parseDbLocationNormal(coreDbLocation),
    pii: parseDbLocationNormal(piiDbLocation),
  };
  config.tenant = {
    name: tenantName,
    displayName: tenantDisplayName,
    placementPolicy: resolveInitialTenantPlacement(options.tenantPlacement),
    multiTenant: !!baseDomain,
    baseDomain,
    userIdFormat,
    primaryTenant,
    nakedDomain,
  };
  config.components = {
    ...config.components,
    saml: true,
    async: true,
    vc: true,
    bridge: true, // Standard component
    policy: true, // Standard component
  };
  config.urls = buildUrlsConfig({
    env: envPrefix,
    apiDomain,
    loginUiDomain,
    adminUiDomain,
    zoneId: fullDomainConfig.zoneId ?? null,
    customDomainBinding: fullDomainConfig.customDomainBinding ?? false,
    workersSubdomain,
  });
  config.sharding = {
    authCodeShards,
    refreshTokenShards,
    sessionShards,
    challengeShards,
  };
  config.features = {
    queue: { enabled: enableQueue },
    r2: { enabled: enableR2 },
    pluginDynamicWorkers: config.features.pluginDynamicWorkers,
    email: {
      provider: emailConfigNormal.provider,
      fromAddress: emailConfigNormal.fromAddress,
      fromName: emailConfigNormal.fromName,
      configured: emailConfigNormal.provider !== 'none',
    },
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold(`📋 ${t('config.summary')}`));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Infrastructure
  console.log(chalk.bold(t('config.infrastructure')));
  console.log(`  ${t('config.environment')} ${chalk.cyan(envPrefix)}`);
  console.log(`  ${t('config.workerPrefix')} ${chalk.cyan(envPrefix + '-ar-*')}`);
  console.log('');

  // Tenant mode and Issuer
  console.log(chalk.bold(t('config.tenantIssuer')));
  console.log(
    `  ${t('config.mode')} ${chalk.cyan(baseDomain ? t('config.multiTenant') : t('config.singleTenant'))}`
  );
  if (baseDomain) {
    console.log(`  ${t('config.baseDomain')} ${chalk.cyan(baseDomain)}`);
    console.log(`  ${t('config.issuerFormat')} ${chalk.cyan('{tenant}.' + baseDomain)}`);
    console.log(
      `  ${t('common.example')}: ${chalk.gray(nakedDomain ? 'https://' + baseDomain : 'https://acme.' + baseDomain)}`
    );
    if (nakedDomain) {
      console.log(`  ${t('web.form.nakedDomain')}: ${chalk.cyan(primaryTenant || tenantName)}`);
    }
  } else {
    const issuerUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    console.log(`  ${t('config.issuerUrl')} ${chalk.cyan(issuerUrl)}`);
  }
  console.log(`  ${t('config.defaultTenant')} ${chalk.cyan(tenantName)}`);
  console.log(`  ${t('config.displayName')} ${chalk.cyan(tenantDisplayName)}`);
  console.log('');

  // Public URLs
  console.log(chalk.bold(t('config.publicUrls')));
  if (baseDomain) {
    console.log(
      `  ${t('config.apiRouter')} ${chalk.cyan('*.' + baseDomain)} → ${chalk.gray(envPrefix + '-ar-router')}`
    );
    if (nakedDomain) {
      console.log(
        `  ${t('config.apiRouter')} ${chalk.cyan(baseDomain)} → ${chalk.gray(envPrefix + '-ar-router')}`
      );
    }
  } else {
    console.log(
      `  ${t('config.apiRouter')} ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`
    );
  }
  console.log(
    `  ${t('config.loginUi')} ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  ${t('config.adminUi')} ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');
  console.log(chalk.bold(t('config.components')));
  const enabledStandard = `${chalk.green(t('config.enabled'))} ${chalk.gray(t('config.standard'))}`;
  console.log(`  ${t('components.saml')} ${enabledStandard}`);
  console.log(`  Async/CIBA: ${enabledStandard}`);
  console.log(`  ${t('components.vc')} ${enabledStandard}`);
  console.log(`  ${t('components.socialLogin')} ${enabledStandard}`);
  console.log(`  ${t('components.policyEngine')} ${enabledStandard}`);
  console.log('');
  console.log(chalk.bold(t('config.featureFlags')));
  console.log(
    `  ${t('features.queue')} ${enableQueue ? chalk.green(t('config.enabled')) : chalk.gray(t('config.disabled'))}`
  );
  console.log(
    `  ${t('features.r2')} ${enableR2 ? chalk.green(t('config.enabled')) : chalk.gray(t('config.disabled'))}`
  );
  console.log('');
  console.log(chalk.bold(t('config.emailSettings')));
  if (emailConfigNormal.provider === 'cloudflare') {
    console.log(`  ${t('email.provider')} ${chalk.cyan(t('web.email.cloudflareSetup'))}`);
    console.log(
      `  ${t('web.email.cloudflareRequirements')}: ${chalk.yellow(t('web.email.cloudflareRequirementPaid'))}`
    );
    console.log(`  ${t('email.fromAddress')} ${chalk.cyan(emailConfigNormal.fromAddress)}`);
    if (emailConfigNormal.fromName) {
      console.log(`  ${t('email.fromName')} ${chalk.cyan(emailConfigNormal.fromName)}`);
    }
  } else if (emailConfigNormal.provider === 'resend') {
    console.log(`  ${t('email.provider')} ${chalk.cyan('Resend')}`);
    console.log(`  ${t('email.fromAddress')} ${chalk.cyan(emailConfigNormal.fromAddress)}`);
    if (emailConfigNormal.fromName) {
      console.log(`  ${t('email.fromName')} ${chalk.cyan(emailConfigNormal.fromName)}`);
    }
  } else {
    console.log(`  ${t('email.provider')} ${chalk.gray(t('config.notConfigured'))}`);
  }
  console.log('');
  console.log(chalk.bold(t('config.oidcSettings')));
  console.log(
    `  ${t('config.accessTtl')} ${chalk.cyan(`${config.oidc.accessTokenTtl} ${t('config.sec')}`)}`
  );
  console.log(
    `  ${t('config.refreshTtl')} ${chalk.cyan(`${config.oidc.refreshTokenTtl} ${t('config.sec')}`)}`
  );
  console.log(
    `  ${t('config.authCodeTtl')} ${chalk.cyan(`${config.oidc.authCodeTtl} ${t('config.sec')}`)}`
  );
  console.log(
    `  ${t('config.pkceRequired')} ${config.oidc.pkceRequired ? chalk.green(t('common.yes')) : chalk.yellow(t('common.no'))}`
  );
  console.log('');
  console.log(chalk.bold(t('config.sharding')));
  console.log(
    `  ${t('config.authCodeShards')} ${chalk.cyan(authCodeShards)} ${t('config.shards')}`
  );
  console.log(
    `  ${t('config.refreshTokenShards')} ${chalk.cyan(refreshTokenShards)} ${t('config.shards')}`
  );
  console.log('');
  console.log(chalk.bold(t('config.database')));
  console.log(`  ${t('config.d1Routing')} ${chalk.cyan('Control Plane')}`);
  console.log(`  ${t('config.placement')} ${chalk.cyan(config.tenant.placementPolicy)}`);
  console.log(
    `  ${t('config.provisioning')} ${automaticProvisioning ? chalk.green(t('web.db.automaticProvisioningOn')) : chalk.yellow(t('web.db.automaticProvisioningOff'))}`
  );
  const coreDbDisplay =
    coreDbLocation === 'eu'
      ? t('region.euJurisdiction')
      : coreDbLocation === 'auto'
        ? t('region.auto')
        : coreDbLocation.toUpperCase();
  const piiDbDisplay =
    piiDbLocation === 'eu'
      ? t('region.euJurisdiction')
      : piiDbLocation === 'auto'
        ? t('region.auto')
        : piiDbLocation.toUpperCase();
  console.log(`  ${t('config.coreDb')} ${chalk.cyan(coreDbDisplay)}`);
  console.log(`  ${t('config.piiDb')} ${chalk.cyan(piiDbDisplay)}`);
  console.log('');

  const proceed = await confirm({
    message: t('deploy.prompt'),
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow(t('deploy.cancelled')));
    return;
  }

  // Save email secrets if configured
  if (emailConfigNormal.provider !== 'none' && emailConfigNormal.fromAddress) {
    // Save to external keys directory: {cwd}/.authrim-keys/{env}/
    const keysDir = getExternalKeysDir(envPrefix, process.cwd());
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
      const emailFromPath = join(keysDir, 'email_from.txt');
      await fs.writeFile(emailFromPath, emailConfigNormal.fromAddress!.trim());
      await fs.chmod(emailFromPath, 0o600);
      if (emailConfigNormal.fromName) {
        const emailFromNamePath = join(keysDir, 'email_from_name.txt');
        await fs.writeFile(emailFromNamePath, emailConfigNormal.fromName.trim());
        await fs.chmod(emailFromNamePath, 0o600);
      }
      if (emailConfigNormal.provider === 'resend' && emailConfigNormal.apiKey) {
        const resendApiKeyPath = join(keysDir, 'resend_api_key.txt');
        await fs.writeFile(resendApiKeyPath, emailConfigNormal.apiKey.trim());
        await fs.chmod(resendApiKeyPath, 0o600);
      }
    });
    console.log(chalk.gray(`📧 ${t('deploy.emailSecretsSaved', { path: `${keysDir}/` })}`));
  }
  await executeSetup(config, options.keep);
}

// =============================================================================
// Execute Setup
// =============================================================================

async function executeSetup(config: AuthrimConfig, keepPath?: string): Promise<void> {
  const outputDir = resolve(keepPath || '.');
  const env = config.environment.prefix;
  let secrets: ReturnType<typeof generateAllSecrets> | null = null;

  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold(`🚀 ${t('deploy.starting')}`));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 0: Check wrangler and auth
  const wranglerCheck = ora(t('prereq.checking')).start();
  try {
    const installed = await isWranglerInstalled();
    if (!installed) {
      wranglerCheck.fail(t('prereq.wranglerNotInstalled'));
      console.log('');
      console.log(chalk.yellow(`  ${t('prereq.wranglerInstallHint')}`));
      console.log('');
      console.log(chalk.cyan('    npm install -g wrangler'));
      console.log('');
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail(t('prereq.notLoggedIn'));
      console.log('');
      console.log(chalk.yellow(`  ${t('prereq.loginHint')}`));
      console.log('');
      console.log(chalk.cyan('    wrangler login'));
      console.log('');
      return;
    }

    wranglerCheck.succeed(
      auth.email ? t('prereq.loggedInAs', { email: auth.email }) : t('prereq.authenticated')
    );

    // Get account ID and workers subdomain
    const accountId = await getAccountId();
    if (accountId) {
      config.cloudflare = { accountId };
    }

    // Get workers.dev subdomain for correct URL generation
    workersSubdomain = await getWorkersSubdomain();
    await showCliCapabilitySummaryOnce({
      installed,
      auth,
      workersSubdomain,
    });
  } catch (error) {
    wranglerCheck.fail(t('prereq.checkFailed'));
    console.error(error);
    return;
  }

  const environmentOperation = await acquireEnvironmentOperationForEnvironment({
    baseDir: outputDir,
    env,
    operation: 'init-provision',
  });
  const provisionDecision = evaluateEnvironmentOperation({
    operation: 'provision',
    lock: environmentOperation.lock,
  });
  if (!provisionDecision.allowed) {
    await environmentOperation.release();
    throw new Error(environmentOperationBlockMessage(provisionDecision));
  }

  try {
    // Step 1: Generate keys (external directory: .authrim-keys/{env}/)
    // Check if keys already exist for this environment
    const cwdDir = process.cwd();
    if (keysExistForEnvironment(outputDir, env, cwdDir)) {
      console.log(chalk.yellow(`⚠️  ${t('keys.existing', { env })}`));
      console.log(chalk.yellow(`   ${t('keys.existingWarning')}`));
      console.log('');
    }

    const keysSpinner = ora(t('keys.generating')).start();
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

      keysSpinner.succeed(t('keys.generated', { path: externalKeysDir }));
    } catch (error) {
      keysSpinner.fail(t('keys.error'));
      throw error;
    }

    // Step 2: Provision Cloudflare resources
    console.log('');
    console.log(chalk.blue(`⏳ ${t('deploy.creatingResources')}`));
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
      console.log(chalk.red(`  ✗ ${t('deploy.resourcesFailed')}`));
      console.error(error);
      throw new Error(t('deploy.initialProvisioningFailed'), { cause: error });
    }

    // Step 3: Create lock file (save to new structure: .authrim/{env}/lock.json)
    const envPaths = getEnvironmentPaths({ baseDir: outputDir, env });
    const lockSpinner = ora(t('resource.provisioning', { resource: 'lock.json' })).start();
    try {
      const lockFile = createLockFile(env, provisionedResources);
      await saveLockFile(lockFile, { baseDir: outputDir, env });
      lockSpinner.succeed(t('resource.provisioned', { resource: `lock.json (${envPaths.lock})` }));
    } catch (error) {
      lockSpinner.fail(t('resource.failed', { resource: 'lock.json' }));
      console.error(error);
      throw error;
    }

    // Step 4: Save configuration (save to new structure: .authrim/{env}/config.json)
    const configSpinner = ora(t('config.saving')).start();
    try {
      // Ensure environment directory exists
      await mkdir(envPaths.root, { recursive: true });

      const configPath = envPaths.config;
      config.updatedAt = new Date().toISOString();
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

      // Also save version.txt
      const setupVersion = getVersion();
      await writeFile(envPaths.version, setupVersion, 'utf-8');

      configSpinner.succeed(t('config.saved', { path: configPath }));
    } catch (error) {
      configSpinner.fail(t('config.error'));
      throw error;
    }

    // Step 4.5: Generate ui.env for UI builds
    const uiEnvSpinner = ora(t('resource.provisioning', { resource: 'ui.env' })).start();
    try {
      const initialUiEnv = buildInitialUiEnvConfig(config);
      if (initialUiEnv) {
        await saveUiEnv(envPaths.uiEnv, initialUiEnv);
        uiEnvSpinner.succeed(t('resource.provisioned', { resource: `ui.env (${envPaths.uiEnv})` }));
      } else {
        uiEnvSpinner.warn(t('resource.skipped', { resource: 'ui.env' }));
        console.log(chalk.gray(`  ${t('config.uiEnvNoApi')}`));
      }
    } catch (error) {
      uiEnvSpinner.fail(t('resource.failed', { resource: 'ui.env' }));
      console.error(error);
      // Non-fatal: continue with setup
    }

    // Step 5: Generate wrangler.toml files
    const resourceIds = toResourceIds(provisionedResources);
    const packagesDir = join(outputDir, 'packages');
    const baseDir = process.cwd();

    // Step 5a: Save master wrangler configs to .authrim/{env}/wrangler/
    const wranglerSpinner = ora(t('resource.provisioning', { resource: 'wrangler.toml' })).start();
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
        wranglerSpinner.succeed(
          t('config.wranglerConfigsSaved', { count: masterResult.files.length })
        );
      } else {
        wranglerSpinner.warn(t('config.wranglerConfigsPartial'));
        for (const error of masterResult.errors) {
          console.log(chalk.yellow(`  • ${error}`));
        }
      }

      // Step 5b: Sync to deployment locations (if packages directory exists)
      if (existsSync(packagesDir)) {
        const syncSpinner = ora(t('config.wranglerConfigsSyncing')).start();

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
          syncSpinner.succeed(
            t('config.wranglerConfigsSynced', { count: syncResult.synced.length })
          );
        } else {
          syncSpinner.fail(t('config.wranglerConfigsSyncFailed'));
          for (const error of syncResult.errors) {
            console.log(chalk.red(`  • ${error}`));
          }
        }
      }
    } catch (error) {
      wranglerSpinner.fail(t('resource.failed', { resource: 'wrangler.toml' }));
      console.error(error);
    }

    // Summary
    console.log('');
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold.green(`🎉 ${t('complete.title')}`));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');

    // Show provisioned resources
    if (provisionedResources.d1.length > 0 || provisionedResources.kv.length > 0) {
      console.log(chalk.bold(`📦 ${t('complete.createdResources')}`));
      console.log('');

      if (provisionedResources.d1.length > 0) {
        console.log(`  ${t('web.provision.d1Databases')}:`);
        for (const db of provisionedResources.d1) {
          console.log(`    ✓ ${db.name} (${db.id.slice(0, 8)}...)`);
        }
      }

      if (provisionedResources.kv.length > 0) {
        console.log(`  ${t('web.provision.kvNamespaces')}:`);
        for (const kv of provisionedResources.kv) {
          console.log(`    ✓ ${kv.name} (${kv.id.slice(0, 8)}...)`);
        }
      }

      console.log('');
    }

    console.log(chalk.bold(`📁 ${t('complete.generatedFiles')}`));
    console.log(`  - ${envPaths.config}`);
    console.log(`  - ${envPaths.lock}`);
    console.log(`  - ${envPaths.version}`);
    console.log(`  - ${envPaths.keys}/ ${chalk.gray(`(${t('web.provision.keepSafe')})`)}`);
    console.log('');

    // Show URLs
    console.log(chalk.bold(`🌐 ${t('complete.urls')}`));
    const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
    const loginUrl = config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || '';
    const adminUrl = config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || '';
    console.log(`  ${t('complete.issuerUrl', { url: chalk.cyan(apiUrl) })}`);
    console.log(`  ${t('complete.uiUrl', { url: chalk.cyan(loginUrl) })}`);
    console.log(`  ${t('complete.adminUrl', { url: chalk.cyan(adminUrl) })}`);
    console.log('');

    // Next steps
    console.log(chalk.bold(`📋 ${t('complete.nextSteps')}`));
    console.log('');
    for (const line of buildSetupCompletionNextSteps({
      env,
      automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
      commandPrefix: getCommandPrefix(),
    })) {
      console.log(line);
    }
    console.log('');
  } finally {
    await environmentOperation.release();
  }
}

export function buildSetupCompletionNextSteps(input: {
  env: string;
  automaticProvisioning: boolean;
  commandPrefix: string;
}): string[] {
  const deployCommand = `${input.commandPrefix} deploy --env ${input.env}`;
  if (input.automaticProvisioning) {
    return [
      `  ${t('complete.automaticStep1')}`,
      `     ${deployCommand}`,
      '',
      `  ${t('complete.automaticStep2')}`,
      `     ${t('complete.automaticStep2Detail')}`,
    ];
  }
  return [
    `  ${t('complete.manualStep1')}`,
    `     ${deployCommand}`,
    '',
    `  ${t('complete.manualStep2')}`,
    `     ${t('complete.manualStep2Detail')}`,
  ];
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
  // Legacy structure: authrim-{env}-config.json -> authrim-{env}-lock.json
  let lockPath: string;
  const isNewStructure =
    configPath.includes(`${AUTHRIM_DIR}/`) && configPath.endsWith('/config.json');
  if (isNewStructure) {
    lockPath = configPath.replace('/config.json', '/lock.json');
  } else {
    lockPath = findLegacyLockPath(dirname(resolve(configPath)), env);
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
    await showCliCapabilitySummaryOnce({
      installed,
      auth,
      workersSubdomain,
    });
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
    console.log(chalk.red('Redeploy cannot provision a missing environment.'));
    console.log(chalk.yellow(`Run ${getCommandPrefix()} init to provision it explicitly.`));
    return;
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
  const enabledComponents: string[] = [
    'ar-lib-core',
    'ar-discovery',
    'ar-auth',
    'ar-token',
    'ar-userinfo',
    'ar-management',
    'ar-async',
    'ar-policy',
    'ar-saml',
    'ar-bridge',
    'ar-vc',
    'ar-router',
  ];

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
  const originalConfig = structuredClone(config);
  const originalConfigText = JSON.stringify(originalConfig);
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
      { value: 'oidc', name: '⚙️  OIDC Settings (TTL, etc.)' },
      { value: 'features', name: '🎛️  Feature Flags' },
      { value: 'runtimeProfiles', name: '🧭 Runtime Profiles' },
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
    case 'oidc':
      configModified = await editOidcSettings(config);
      break;
    case 'features':
      configModified = await editFeatures(config);
      break;
    case 'runtimeProfiles':
      configModified = await editRuntimeProfiles(config);
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
      const env = config.environment.prefix;
      const baseDir = findAuthrimBaseDir(dirname(resolve(configPath)));
      const operation = await acquireEnvironmentOperationForEnvironment({
        baseDir,
        env,
        operation: 'init-config-edit',
      });
      try {
        const targetProductVersion = operation.lock ? getVersion() : undefined;
        const decision = evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock: operation.lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          throw new Error(environmentOperationBlockMessage(decision, targetProductVersion));
        }

        const persistedConfigText = await readFile(configPath, 'utf-8');
        const persistedConfig = parseConfig(JSON.parse(persistedConfigText));
        if (JSON.stringify(persistedConfig) !== originalConfigText) {
          throw new Error('config_changed_while_waiting_for_init_config_lock');
        }
        if (operation.lock?.productVersion && hasDatabaseTopologyChange(originalConfig, config)) {
          throw new Error(
            'Database topology changes require a dedicated topology command for a deployed environment.'
          );
        }

        await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(chalk.green(`\n✓ Configuration saved: ${configPath}`));
      } finally {
        await operation.release();
      }

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
      loginUi: { custom: null, auto: getUiWorkersDevUrl(env + '-ar-login-ui'), sameAsApi: false },
      adminUi: { custom: null, auto: getUiWorkersDevUrl(env + '-ar-admin-ui'), sameAsApi: false },
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
    default: stripProtocol(config.urls.api?.custom),
    validate: (value) => {
      return validateCliApiDomainInput(value, config.tenant?.name || 'default');
    },
  });

  // Check Cloudflare zone for the domain
  const updateDomainConfig: ZoneDomainConfig = {};
  if (apiDomain) {
    console.log('');
    try {
      await checkAndPromptZone(apiDomain, updateDomainConfig);
    } catch {
      // User cancelled - non-fatal
    }
    console.log('');
  }

  const loginUiDomain = await input({
    message: 'Login UI domain (leave empty for workers.dev)',
    default: stripProtocol(config.urls.loginUi?.custom),
    validate: (value) =>
      validateCliUiDomainInput(value, 'loginUiDomain', apiDomain, config.tenant?.name || 'default'),
  });

  const adminUiDomain = await input({
    message: 'Admin UI domain (leave empty for workers.dev)',
    default: stripProtocol(config.urls.adminUi?.custom),
    validate: (value) =>
      validateCliUiDomainInput(value, 'adminUiDomain', apiDomain, config.tenant?.name || 'default'),
  });

  let checkedLoginUiDomain: string | null = loginUiDomain || null;
  let checkedAdminUiDomain: string | null = adminUiDomain || null;
  if (checkedLoginUiDomain || checkedAdminUiDomain) {
    console.log('');
    const multiTenant = config.tenant?.multiTenant === true && !!apiDomain;
    const baseDomain = multiTenant ? apiDomain : config.tenant?.baseDomain;
    if (
      !(await checkUiCustomDomainZoneIfNeeded({
        label: t('web.domain.loginUi'),
        domain: checkedLoginUiDomain,
        apiDomain,
        baseDomain,
        multiTenant,
      }))
    ) {
      checkedLoginUiDomain = null;
    }
    if (
      !(await checkUiCustomDomainZoneIfNeeded({
        label: t('web.domain.adminUi'),
        domain: checkedAdminUiDomain,
        apiDomain,
        baseDomain,
        multiTenant,
      }))
    ) {
      checkedAdminUiDomain = null;
    }
    console.log('');
  }

  config.urls = buildUrlsConfig({
    env,
    apiDomain,
    loginUiDomain: checkedLoginUiDomain,
    adminUiDomain: checkedAdminUiDomain,
    zoneId: updateDomainConfig.zoneId,
    customDomainBinding: updateDomainConfig.customDomainBinding,
    workersSubdomain,
    existingUrls: config.urls,
  });

  return true;
}

// =============================================================================
// Edit Components
// =============================================================================

async function editComponents(config: AuthrimConfig): Promise<boolean> {
  config.components.saml = true;
  config.components.async = true;
  config.components.vc = true;
  config.components.bridge = true;
  config.components.policy = true;

  console.log(chalk.bold('\nCurrent Component Settings:'));
  console.log(`  SAML:          ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
  console.log(`  Async/CIBA:    ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
  console.log(`  VC:            ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
  console.log(`  Social Login:  ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
  console.log(`  Policy Engine: ${chalk.green('Enabled')} ${chalk.gray('(standard - always on)')}`);
  console.log('');

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
    message:
      'Enable Cloudflare Queues? Disabled by default. Free plan capacity is roughly 3,000 delivered messages/day; Authrim queues async audit fan-out, logging delivery retries, export build jobs, and rewrap retry jobs.',
    default: config.features.queue?.enabled || false,
  });

  const r2Enabled = await confirm({
    message: 'Enable Cloudflare R2 object storage?',
    default: config.features.r2?.enabled ?? true,
  });

  const emailProvider = await select({
    message: 'Select email provider',
    choices: [
      { value: 'cloudflare', name: 'Cloudflare Email Service' },
      { value: 'resend', name: 'Resend' },
      { value: 'none', name: 'None (email disabled)' },
      { value: 'sendgrid', name: 'SendGrid' },
      { value: 'ses', name: 'AWS SES' },
    ],
    default: config.features.email?.provider || 'none',
  });

  config.features.queue = { enabled: queueEnabled };
  config.features.r2 = { enabled: r2Enabled };
  config.features.email = {
    ...config.features.email,
    provider: emailProvider as 'none' | 'cloudflare' | 'resend' | 'sendgrid' | 'ses',
    configured: config.features.email?.configured || false,
    fromAddress: config.features.email?.fromAddress,
    fromName: config.features.email?.fromName,
  };

  return true;
}

// =============================================================================
// Edit Runtime Profiles
// =============================================================================

function normalizeHyperdriveBindingSuggestion(ref: string): string {
  return `HYPERDRIVE_${ref.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

async function ensureHyperdriveReference(
  config: AuthrimConfig,
  options: {
    refKey: string;
    driver: 'postgres' | 'mysql';
    label: string;
    suggestedBinding?: string;
  }
): Promise<void> {
  const existing = config.profiles.references.hyperdrive[options.refKey];
  const binding = await input({
    message: `${options.label} Hyperdrive binding`,
    default:
      existing?.binding ||
      options.suggestedBinding ||
      normalizeHyperdriveBindingSuggestion(options.refKey),
    validate: (value) => {
      if (!value.trim()) return 'Binding is required';
      return true;
    },
  });

  const id = await input({
    message: `${options.label} Hyperdrive ID`,
    default: existing?.id || '',
    validate: (value) => {
      if (!value.trim()) return 'Hyperdrive ID is required';
      return true;
    },
  });

  config.profiles.references.hyperdrive[options.refKey] = {
    binding: binding.trim(),
    id: id.trim(),
    driver: options.driver,
  };
}

async function configureRequiredHyperdriveReferences(
  config: AuthrimConfig,
  seededProfile?: {
    primary?: {
      type: 'd1' | 'postgres' | 'mysql';
      bindingRef?: string;
      connectionRef?: string;
    } | null;
    archive?:
      | { type: 'd1' | 'postgres' | 'mysql'; bindingRef?: string; connectionRef?: string }
      | { type: 'r2'; bucketRef: string; prefix?: string }
      | null;
  }
): Promise<void> {
  const refs = new Map<
    string,
    { refKey: string; driver: 'postgres' | 'mysql'; label: string; suggestedBinding?: string }
  >();
  const registerAuditTarget = (
    target:
      | { type: 'd1' | 'postgres' | 'mysql'; bindingRef?: string; connectionRef?: string }
      | { type: 'r2'; bucketRef: string; prefix?: string }
      | null
      | undefined,
    label: string
  ) => {
    if (!target || target.type === 'd1' || target.type === 'r2') {
      return;
    }
    const refKey = target.connectionRef?.trim() || target.bindingRef?.trim();
    if (!refKey) {
      return;
    }
    refs.set(`${target.type}:${refKey}`, {
      refKey,
      driver: target.type,
      label,
      suggestedBinding: target.bindingRef?.trim() || normalizeHyperdriveBindingSuggestion(refKey),
    });
  };

  const activeAuditProfile =
    config.profiles.seed.audit.find((profile) => profile.id === config.profiles.defaults.audit) ??
    null;
  if (activeAuditProfile) {
    registerAuditTarget(
      activeAuditProfile.primary,
      `Active audit profile ${activeAuditProfile.id} primary`
    );
    registerAuditTarget(
      activeAuditProfile.archive,
      `Active audit profile ${activeAuditProfile.id} archive`
    );
  }

  if (seededProfile) {
    registerAuditTarget(seededProfile.primary, 'Edited audit profile primary');
    registerAuditTarget(seededProfile.archive, 'Edited audit profile archive');
  }

  for (const entry of refs.values()) {
    await ensureHyperdriveReference(config, entry);
  }
}

async function editRuntimeProfiles(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\nCurrent Runtime Profile Settings:'));
  console.log(
    `  Default Audit Profile: ${chalk.cyan(config.profiles.defaults.audit || 'builtin:audit:standard')}`
  );
  console.log(
    `  Default Residency:     ${chalk.cyan(config.profiles.defaults.residency || 'builtin:residency:default')}`
  );
  console.log(`  Registry Backend:      ${chalk.cyan(config.profiles.registry.backend || 'kv')}`);
  console.log(`  Seeded Audit Profiles: ${chalk.cyan(config.profiles.seed.audit.length)}`);
  console.log(
    `  Hyperdrive Refs:       ${chalk.cyan(Object.keys(config.profiles.references.hyperdrive).length)}`
  );
  console.log('');

  const defaultAuditProfileId = await input({
    message: 'Default audit profile ID',
    default: config.profiles.defaults.audit || 'builtin:audit:standard',
    validate: (value) => {
      if (!value.trim()) return 'Profile ID is required';
      if (value.trim() === 'builtin:audit:minimal') {
        return [
          'builtin:audit:minimal is not supported.',
          'Use builtin:audit:standard or a setup-defined custom audit profile.',
        ].join(' ');
      }
      return true;
    },
  });

  const defaultResidencyProfileId = await input({
    message: 'Default residency profile ID',
    default: config.profiles.defaults.residency || 'builtin:residency:default',
    validate: (value) => {
      if (!value.trim()) return 'Profile ID is required';
      return true;
    },
  });

  config.profiles.defaults.audit = defaultAuditProfileId.trim();
  config.profiles.defaults.residency = defaultResidencyProfileId.trim();

  const editHttpSinkProfile = await confirm({
    message: 'Create or update a seeded audit profile with a generic HTTP sink?',
    default: config.profiles.seed.audit.length > 0,
  });

  if (!editHttpSinkProfile) {
    await configureRequiredHyperdriveReferences(config);
    return true;
  }

  const existingProfile =
    config.profiles.seed.audit.find((profile) =>
      profile.sinks.some((sink) => sink.type === 'http')
    ) ?? config.profiles.seed.audit[0];
  const existingHttpSink = existingProfile?.sinks.find(
    (
      sink
    ): sink is {
      type: 'http';
      url?: string;
      urlRef?: string;
      authTokenRef?: string;
      headers?: Record<string, string>;
    } => sink.type === 'http'
  );

  const profileId = await input({
    message: 'Audit profile ID',
    default: existingProfile?.id || 'custom:audit:http-sink',
    validate: (value) => {
      if (!value.trim()) return 'Profile ID is required';
      return true;
    },
  });

  const label = await input({
    message: 'Audit profile label',
    default: existingProfile?.label || 'HTTP Sink Audit Profile',
    validate: (value) => {
      if (!value.trim()) return 'Label is required';
      return true;
    },
  });

  const deliveryMode = await select({
    message: 'Select audit delivery mode',
    choices: [
      {
        value: 'archive-only',
        name: 'Archive-only + HTTP sink',
        description: 'No hot query store. Archive to R2 and forward to the HTTP sink.',
      },
      {
        value: 'd1-primary',
        name: 'D1 primary + archive + HTTP sink',
        description: 'Keep hot queries in D1 and also archive / forward.',
      },
    ],
    default: existingProfile?.primary == null ? 'archive-only' : 'd1-primary',
  });

  const useDirectUrl = await confirm({
    message: 'Store the sink URL directly in config? (Use "No" to keep only a urlRef/bindingRef)',
    default: Boolean(existingHttpSink?.url),
  });

  const directUrl = useDirectUrl
    ? await input({
        message: 'HTTP sink URL',
        default: existingHttpSink?.url || 'https://example.com/audit',
        validate: (value) => {
          try {
            new URL(value);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      })
    : '';

  const urlRef = await input({
    message: 'HTTP sink URL ref (env/binding name, leave empty if using direct URL only)',
    default: existingHttpSink?.urlRef || (!useDirectUrl ? 'AUTHRIM_AUDIT_HTTP_URL' : ''),
  });

  if (!directUrl && !urlRef.trim()) {
    console.log(chalk.red('\nEither a direct URL or a URL ref is required.'));
    return false;
  }

  const authTokenRef = await input({
    message: 'HTTP sink auth token ref (optional)',
    default: existingHttpSink?.authTokenRef || 'AUTHRIM_AUDIT_HTTP_TOKEN',
  });

  const headersInput = await input({
    message: 'Additional HTTP headers as JSON object (optional)',
    default: JSON.stringify(existingHttpSink?.headers || {}, null, 0),
    validate: (value) => {
      if (!value.trim()) return true;
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return 'Please enter a JSON object';
        }
        return true;
      } catch {
        return 'Please enter valid JSON';
      }
    },
  });

  const parsedHeaders = headersInput.trim()
    ? (JSON.parse(headersInput) as Record<string, string>)
    : {};

  const seededProfile = {
    id: profileId.trim(),
    label: label.trim(),
    description:
      deliveryMode === 'archive-only'
        ? 'Archive-only audit profile with a generic HTTP forwarding sink.'
        : 'D1-backed audit profile with archive and generic HTTP forwarding sink.',
    primary:
      deliveryMode === 'archive-only'
        ? null
        : {
            type: 'd1' as const,
            bindingRef: 'DB',
            dataset: 'event_log',
          },
    archive: {
      type: 'r2' as const,
      bucketRef: 'AUDIT_ARCHIVE',
      prefix: 'logs/v1',
    },
    sinks: [
      {
        type: 'http' as const,
        ...(directUrl ? { url: directUrl.trim() } : {}),
        ...(urlRef.trim() ? { urlRef: urlRef.trim() } : {}),
        ...(authTokenRef.trim() ? { authTokenRef: authTokenRef.trim() } : {}),
        ...(Object.keys(parsedHeaders).length > 0 ? { headers: parsedHeaders } : {}),
      },
    ],
    retention:
      deliveryMode === 'archive-only'
        ? {
            eventLogRetentionDays: 30,
            piiLogRetentionDays: 30,
            archiveBeforeDelete: false,
            primaryDays: null,
            archiveDays: 30,
          }
        : {
            eventLogRetentionDays: 90,
            piiLogRetentionDays: 365,
            archiveBeforeDelete: false,
            primaryDays: 90,
            archiveDays: null,
          },
    archiveFailureMode: 'gate_cleanup' as const,
    sinkFailureMode: 'best_effort' as const,
  };

  const existingIndex = config.profiles.seed.audit.findIndex(
    (profile) => profile.id === seededProfile.id
  );

  if (existingIndex >= 0) {
    config.profiles.seed.audit[existingIndex] = seededProfile;
  } else {
    config.profiles.seed.audit.push(seededProfile);
  }

  await configureRequiredHyperdriveReferences(config, seededProfile);

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
  console.log(chalk.gray('  Note: Power of 2 recommended for shard count (4, 8, 16, 32, 64, 128)'));
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
