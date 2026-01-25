/**
 * Deploy Command
 *
 * Handles deployment of Authrim workers to Cloudflare.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm, select } from '@inquirer/prompts';
import { t } from '../../i18n/index.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { saveLockFile, loadLockFileAuto } from '../../core/lock.js';
import {
  getEnvironmentPaths,
  getLegacyPaths,
  resolvePaths,
  listEnvironments,
  AUTHRIM_DIR,
  type EnvironmentPaths,
  type LegacyPaths,
} from '../../core/paths.js';
import {
  deployAll,
  uploadSecrets,
  deployAllPages,
  updateLockWithDeployments,
  buildApiPackages,
  type DeployOptions,
} from '../../core/deploy.js';
import {
  isWranglerInstalled,
  checkAuth,
  runMigrationsForEnvironment,
  getWorkersSubdomain,
} from '../../core/cloudflare.js';
import { type WorkerComponent } from '../../core/naming.js';
import { completeInitialSetup, displaySetupInstructions } from '../../core/admin.js';
import type { SyncAction } from '../../core/wrangler-sync.js';

// =============================================================================
// Types
// =============================================================================

export interface DeployCommandOptions {
  config?: string;
  env?: string;
  source?: string;
  component?: string;
  dryRun?: boolean;
  skipSecrets?: boolean;
  skipBuild?: boolean;
  skipUi?: boolean;
  skipMigrations?: boolean;
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

  // Find config file (support both new and legacy structures)
  // Also search in common subdirectories (authrim/) for cases where setup was run from parent dir
  let baseDir = process.cwd();
  let configPath: string = 'authrim-config.json';
  let config: AuthrimConfig | null = null;
  // rootDir is where the authrim source code is (containing packages/)
  // If --source is provided, use that; otherwise will be determined during search
  let rootDir: string = options.source ? resolve(options.source) : resolve('.');

  // Helper function to find authrim source directory
  // Searches in multiple common locations
  const findAuthrimSource = (searchDir: string): string | null => {
    const checkDir = (dir: string): boolean => {
      const packagesDir = join(dir, 'packages');
      return existsSync(packagesDir) && existsSync(join(packagesDir, 'ar-auth'));
    };

    // Check provided directory first
    if (checkDir(searchDir)) {
      return searchDir;
    }

    // Check common subdirectory names
    const commonNames = ['authrim', 'source', 'src'];
    for (const name of commonNames) {
      const subDir = join(searchDir, name);
      if (existsSync(subDir) && checkDir(subDir)) {
        return subDir;
      }
    }

    // Check parent directory (in case we're in .authrim/{env}/)
    const parentDir = dirname(searchDir);
    if (checkDir(parentDir)) {
      return parentDir;
    }

    return null;
  };

  if (options.env) {
    // Environment specified - try new structure first, then legacy
    // Also search in common subdirectories
    const searchDirs = [baseDir, join(baseDir, 'authrim')];

    for (const searchDir of searchDirs) {
      if (!existsSync(searchDir)) {
        continue;
      }

      const resolved = resolvePaths({ baseDir: searchDir, env: options.env });
      let envLockPath: string;

      if (resolved.type === 'new') {
        const envPaths = resolved.paths as EnvironmentPaths;
        configPath = envPaths.config;
        envLockPath = envPaths.lock;
      } else {
        const legacyPaths = resolved.paths as LegacyPaths;
        configPath = legacyPaths.config;
        envLockPath = legacyPaths.lock;
      }

      // Check for config.json first, then fall back to lock.json
      if (existsSync(configPath)) {
        config = await loadConfig(configPath);
        if (config) {
          baseDir = searchDir;
          if (!options.source) {
            rootDir = findAuthrimSource(searchDir) || searchDir;
          }
          break;
        }
      } else if (existsSync(envLockPath)) {
        // config.json missing but lock.json exists - create minimal config
        console.log(
          chalk.yellow(`\n⚠️  config.json not found for env "${options.env}", using lock.json`)
        );
        const { loadLockFile } = await import('../../core/lock.js');
        const lock = await loadLockFile(envLockPath);
        if (lock) {
          config = {
            version: '1.0.0',
            environment: { prefix: lock.env },
            components: { api: true, loginUi: true, adminUi: true },
          } as AuthrimConfig;
          baseDir = searchDir;
          if (!options.source) {
            rootDir = findAuthrimSource(searchDir) || searchDir;
          }
          break;
        }
      }
    }
  } else if (options.config) {
    // Explicit config path provided
    configPath = options.config;
    config = await loadConfig(configPath);
    // Derive baseDir from config path
    const configDir = dirname(resolve(configPath));
    // If config is in .authrim/{env}/, baseDir should be 2 levels up
    if (configDir.includes(`${AUTHRIM_DIR}/`)) {
      baseDir = resolve(configDir, '..', '..');
      if (!options.source) {
        rootDir = findAuthrimSource(baseDir) || baseDir;
      }
    } else {
      if (!options.source) {
        rootDir = findAuthrimSource(configDir) || configDir;
      }
    }
  } else {
    // No options - auto-detect
    // Search current directory and common subdirectories
    const searchDirs = [baseDir, join(baseDir, 'authrim')];

    for (const searchDir of searchDirs) {
      if (!existsSync(searchDir)) continue;

      const environments = listEnvironments(searchDir);
      if (environments.length > 0) {
        // Try first environment in new structure
        const envPaths = getEnvironmentPaths({ baseDir: searchDir, env: environments[0] });
        // Check for lock.json since config.json might be missing
        if (existsSync(envPaths.config) || existsSync(envPaths.lock)) {
          if (existsSync(envPaths.config)) {
            configPath = envPaths.config;
            config = await loadConfig(configPath);
          }
          if (config || existsSync(envPaths.lock)) {
            baseDir = searchDir;
            if (!options.source) {
              rootDir = findAuthrimSource(searchDir) || searchDir;
            }
            // If config is missing but lock exists, we can still proceed with defaults
            if (!config && existsSync(envPaths.lock)) {
              console.log(
                chalk.yellow(
                  '\n⚠️  config.json not found, using lock.json to determine environment'
                )
              );
              const { loadLockFile } = await import('../../core/lock.js');
              const lock = await loadLockFile(envPaths.lock);
              if (lock) {
                // Create minimal config from lock file
                config = {
                  version: '1.0.0',
                  environment: { prefix: lock.env },
                  components: { api: true, loginUi: true, adminUi: true },
                } as AuthrimConfig;
              }
            }
            break;
          }
        }
      }
      // Fall back to legacy
      if (!config) {
        configPath = join(searchDir, 'authrim-config.json');
        if (existsSync(configPath)) {
          config = await loadConfig(configPath);
          if (config) {
            baseDir = searchDir;
            if (!options.source) {
              rootDir = findAuthrimSource(searchDir) || searchDir;
            }
            break;
          }
        }
      }
    }
  }

  if (!config) {
    console.error(chalk.red(`\nConfig file not found`));
    console.log(chalk.yellow('Searched in:'));
    console.log(chalk.gray('  • ' + process.cwd()));
    console.log(chalk.gray('  • ' + join(process.cwd(), 'authrim')));
    console.log(chalk.yellow('\nRun "authrim-setup init" first to create a config,'));
    console.log(chalk.yellow('or run deploy from the authrim source directory.'));
    process.exit(1);
  }

  const env = options.env || config.environment.prefix;

  // Validate source directory
  const packagesDir = join(rootDir, 'packages');
  if (!existsSync(packagesDir) || !existsSync(join(packagesDir, 'ar-auth'))) {
    console.error(chalk.red('\n❌ Authrim source not found'));
    console.log(chalk.yellow('\nThe deploy command needs access to the Authrim source code.'));
    console.log(chalk.gray(`  Searched in: ${rootDir}`));
    console.log(chalk.yellow('\nSolutions:'));
    console.log(chalk.gray('  1. Run deploy from the authrim source directory'));
    console.log(chalk.gray('  2. Specify the source directory with --source <path>'));
    console.log(chalk.gray('     Example: deploy --env ' + env + ' --source ./path/to/authrim'));
    process.exit(1);
  }

  console.log(chalk.cyan(`\nEnvironment: ${env}`));
  console.log(chalk.cyan(`Source: ${rootDir}`));
  console.log(chalk.cyan(`Config: ${configPath}`));

  // Load lock file (support both structures)
  const { lock, path: lockPath, type: structureType } = await loadLockFileAuto(baseDir, env);

  if (!lock) {
    console.error(chalk.red('\nLock file not found'));
    console.log(chalk.yellow('Run "authrim-setup init" first to provision resources.'));
    process.exit(1);
  }
  console.log(chalk.cyan(`Lock: ${lockPath}`));

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
    if (config.components.policy) enabledComponents.push('ar-policy');

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
      message: options.dryRun ? t('deploy.confirmDryRun') : t('deploy.confirmStart'),
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow(t('deploy.cancelled')));
      return;
    }
  }

  console.log('');

  // Check wrangler.toml sync status (only for new structure)
  if (structureType === 'new' && !options.component) {
    const packagesDir = join(rootDir, 'packages');

    if (existsSync(packagesDir)) {
      const syncSpinner = ora('Checking wrangler.toml sync status...').start();

      try {
        const { checkWranglerStatus, syncWranglerConfigs } =
          await import('../../core/wrangler-sync.js');

        const status = await checkWranglerStatus({ baseDir, env, packagesDir });
        const outOfSync = status.filter((s) => !s.inSync && s.masterExists && s.deployExists);

        if (outOfSync.length > 0) {
          syncSpinner.warn(`${outOfSync.length} component(s) have modified wrangler.toml`);
          console.log('');
          console.log(chalk.yellow('The following wrangler configs have been manually modified:'));
          for (const s of outOfSync) {
            console.log(chalk.gray(`  • ${s.component}/wrangler.toml`));
          }
          console.log('');

          const action = await select({
            message: t('deploy.wranglerChanged'),
            choices: [
              { value: 'keep', name: t('deploy.wranglerKeep') },
              { value: 'backup', name: t('deploy.wranglerBackup') },
              { value: 'overwrite', name: t('deploy.wranglerOverwrite') },
            ],
          });

          if (action === 'backup' || action === 'overwrite') {
            const resyncSpinner = ora('Syncing wrangler configs...').start();
            const syncResult = await syncWranglerConfigs(
              {
                baseDir,
                env,
                packagesDir,
                force: true,
                dryRun: options.dryRun,
                onProgress: (msg) => {
                  resyncSpinner.text = msg;
                },
              },
              async () => action as SyncAction
            );

            if (syncResult.success) {
              resyncSpinner.succeed('Wrangler configs synced');
            } else {
              resyncSpinner.fail('Sync failed');
              for (const error of syncResult.errors) {
                console.log(chalk.red(`  • ${error}`));
              }
            }
          } else {
            console.log(chalk.gray('  Keeping manual changes'));
          }
          console.log('');
        } else {
          // Check if any need to be created
          const needsSync = status.filter((s) => s.masterExists && !s.deployExists);
          if (needsSync.length > 0) {
            syncSpinner.text = 'Syncing wrangler configs to packages...';
            const syncResult = await syncWranglerConfigs(
              {
                baseDir,
                env,
                packagesDir,
                force: true,
                dryRun: options.dryRun,
              },
              undefined
            );
            syncSpinner.succeed(`Synced ${syncResult.synced.length} wrangler configs`);
          } else {
            syncSpinner.succeed('Wrangler configs in sync');
          }
        }
      } catch (error) {
        syncSpinner.warn('Could not check wrangler sync status');
        console.log(chalk.gray(`  ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  // Build packages first (unless skipped or dry-run)
  if (!options.skipBuild && !options.dryRun) {
    const buildSpinner = ora('Building packages...').start();

    const buildResult = await buildApiPackages({
      rootDir,
      onProgress: (msg) => {
        buildSpinner.text = msg;
      },
    });

    if (buildResult.success) {
      buildSpinner.succeed('Packages built successfully');
    } else {
      buildSpinner.fail('Failed to build packages');
      console.error(chalk.red(`\nBuild error: ${buildResult.error}`));
      console.log(chalk.yellow('\nYou can try building manually:'));
      console.log(chalk.cyan('  pnpm install'));
      console.log(chalk.cyan('  pnpm run build:api'));
      process.exit(1);
    }

    console.log('');
  }

  // Upload secrets first (if not skipped)
  if (!options.skipSecrets && !options.component) {
    // Determine keys directory based on structure
    let keysDir: string;
    if (structureType === 'new') {
      const envPaths = getEnvironmentPaths({ baseDir, env });
      keysDir = envPaths.keys;
    } else {
      // Legacy: use secretsPath from config or default
      keysDir = config.keys.secretsPath || getLegacyPaths(baseDir, env).keys;
    }

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
        console.log(chalk.yellow(`No secrets found in ${keysDir}`));
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

    // Determine the API base URL for the UI to connect to
    let apiBaseUrl = config.urls?.api?.custom || config.urls?.api?.auto;

    // If no URL in config, construct it with correct workers.dev subdomain
    if (!apiBaseUrl) {
      const subdomain = await getWorkersSubdomain();
      if (subdomain) {
        apiBaseUrl = `https://${env}-ar-router.${subdomain}.workers.dev`;
      } else {
        // Fallback without subdomain (may not work correctly)
        apiBaseUrl = `https://${env}-ar-router.workers.dev`;
        console.log(
          chalk.yellow(`  ⚠️  Could not determine workers.dev subdomain, using fallback URL`)
        );
        console.log(chalk.gray(`     If API calls fail, set the correct URL in config or ui.env`));
      }
    }

    // Get ui.env path for new structure (preferred method for Vite builds)
    // Always regenerate ui.env from config to ensure sync
    let uiEnvPath: string | undefined;
    if (structureType === 'new') {
      const envPaths = getEnvironmentPaths({ baseDir, env });
      uiEnvPath = envPaths.uiEnv;

      // Regenerate ui.env from config.json to ensure they are in sync
      // Detect if custom domains are used (same registrable domain = no need for proxy)
      const apiHasCustomDomain = !!config.urls?.api?.custom;
      const adminUiHasCustomDomain = !!config.urls?.adminUi?.custom;
      const useDirectMode = apiHasCustomDomain && adminUiHasCustomDomain;

      // Safari ITP Proxy Mode (default for workers.dev/pages.dev):
      //   - PUBLIC_API_BASE_URL is empty (frontend sends to same-origin /api/*)
      //   - API_BACKEND_URL is set (server-side proxy forwards to backend)
      // Direct Mode (for custom domains on same registrable domain):
      //   - PUBLIC_API_BASE_URL is set (frontend sends directly to backend)
      //   - API_BACKEND_URL is empty (proxy disabled)
      const { saveUiEnv } = await import('../../core/ui-env.js');
      try {
        if (useDirectMode) {
          await saveUiEnv(uiEnvPath, {
            PUBLIC_API_BASE_URL: apiBaseUrl, // Frontend sends directly to backend
            API_BACKEND_URL: '', // Proxy disabled
          });
          console.log(chalk.gray(`  ui.env synced (direct mode: ${apiBaseUrl})`));
          console.log(chalk.gray(`  Custom domains detected - Safari ITP proxy disabled`));
        } else {
          await saveUiEnv(uiEnvPath, {
            PUBLIC_API_BASE_URL: '', // Empty for proxy mode (same-origin)
            API_BACKEND_URL: apiBaseUrl, // Server-side proxy target
          });
          console.log(chalk.gray(`  ui.env synced (proxy mode: ${apiBaseUrl})`));
        }
      } catch (syncError) {
        console.log(chalk.yellow(`  ⚠️  Could not sync ui.env: ${syncError}`));
      }
    }

    const pagesResult = await deployAllPages(
      { ...deployOptions, apiBaseUrl, uiEnvPath },
      {
        loginUi: config.components.loginUi ?? true,
        adminUi: config.components.adminUi ?? true,
      }
    );

    if (pagesResult.failedCount === 0) {
      console.log(chalk.green('\n✓ All UI packages deployed successfully'));
      for (const result of pagesResult.results) {
        console.log(chalk.cyan(`  • ${result.component}: ${result.projectName}`));
      }
    } else {
      console.log(
        chalk.yellow(
          `\n⚠️  ${pagesResult.successCount}/${pagesResult.results.length} UI packages deployed`
        )
      );
      for (const result of pagesResult.results) {
        if (result.success) {
          console.log(chalk.green(`  ✓ ${result.component}: ${result.projectName}`));
        } else {
          console.log(chalk.red(`  ✗ ${result.component}: ${result.error}`));
        }
      }
    }
  }

  // Run D1 database migrations (unless skipped or dry-run)
  let migrationsSuccess = true;
  if (
    !options.skipMigrations &&
    !options.dryRun &&
    !options.component &&
    summary.failedCount === 0
  ) {
    console.log(chalk.bold('\n📜 Running D1 database migrations...\n'));

    const migrationsSpinner = ora('Running migrations...').start();

    try {
      const migrationsResult = await runMigrationsForEnvironment(env, rootDir, (msg) => {
        migrationsSpinner.text = msg;
      });

      if (migrationsResult.success) {
        migrationsSpinner.succeed(
          `Migrations completed - core: ${migrationsResult.core.appliedCount}, pii: ${migrationsResult.pii.appliedCount}, admin: ${migrationsResult.admin.appliedCount} applied`
        );
      } else {
        migrationsSpinner.warn('Some migrations failed');
        if (migrationsResult.core.error) {
          console.log(chalk.yellow(`  Core: ${migrationsResult.core.error}`));
        }
        if (migrationsResult.pii.error) {
          console.log(chalk.yellow(`  PII: ${migrationsResult.pii.error}`));
        }
        if (migrationsResult.admin.error) {
          console.log(chalk.yellow(`  Admin: ${migrationsResult.admin.error}`));
        }
        migrationsSuccess = false;
      }
    } catch (error) {
      migrationsSpinner.fail('Migrations failed');
      console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      migrationsSuccess = false;
    }
  }

  // Final summary
  console.log(chalk.bold('\n━━━ Deployment Complete ━━━\n'));

  if (summary.failedCount === 0 && migrationsSuccess) {
    console.log(chalk.green('✅ All components deployed and migrations applied!\n'));
  } else if (summary.failedCount === 0 && !migrationsSuccess) {
    console.log(chalk.yellow('⚠️  All components deployed, but some migrations failed.\n'));
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
        // Use appropriate keys directory based on structure
        const setupOptions: Parameters<typeof completeInitialSetup>[0] = {
          env,
          baseUrl,
          baseDir,
          legacy: structureType === 'legacy',
          onProgress: (msg) => {
            setupSpinner.text = msg;
          },
        };
        // Support legacy keysDir option
        if (options.keysDir) {
          setupOptions.keysDir = options.keysDir;
        }
        const setupResult = await completeInitialSetup(setupOptions);

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

export async function statusCommand(options: { config?: string; env?: string }): Promise<void> {
  console.log(chalk.bold('\n📊 Authrim Deployment Status\n'));

  const baseDir = process.cwd();
  let configPath: string;
  let config: AuthrimConfig | null = null;
  let env: string | undefined = options.env;

  // Find config (support both structures)
  if (options.config) {
    configPath = options.config;
    config = await loadConfig(configPath);
  } else if (env) {
    const resolved = resolvePaths({ baseDir, env });
    if (resolved.type === 'new') {
      configPath = (resolved.paths as EnvironmentPaths).config;
    } else {
      configPath = (resolved.paths as LegacyPaths).config;
    }
    config = await loadConfig(configPath);
  } else {
    // Auto-detect
    const environments = listEnvironments(baseDir);
    if (environments.length > 0) {
      env = environments[0];
      const envPaths = getEnvironmentPaths({ baseDir, env });
      if (existsSync(envPaths.config)) {
        configPath = envPaths.config;
        config = await loadConfig(configPath);
      }
    }
    if (!config) {
      configPath = 'authrim-config.json';
      config = await loadConfig(configPath);
    }
  }

  if (!config) {
    console.log(chalk.yellow(`Config not found: ${configPath!}`));
    return;
  }

  env = env || config.environment.prefix;

  // Load lock file with auto-detection
  const { lock } = await loadLockFileAuto(baseDir, env);

  if (!lock) {
    console.log(chalk.yellow(`No deployment found (lock file not found for env: ${env})`));
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
