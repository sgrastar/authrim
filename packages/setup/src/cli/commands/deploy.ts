/**
 * Deploy Command
 *
 * Handles deployment of Authrim workers to Cloudflare.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm, select } from '@inquirer/prompts';
import { t, getLocale } from '../../i18n/index.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import {
  saveLockFile,
  loadLockFileAuto,
  reconcileSharedD1ResourcesInLock,
  reconcileSharedKVResourcesInLock,
  acquireEnvironmentOperationLock,
} from '../../core/lock.js';
import {
  getEnvironmentPaths,
  findLegacyConfigPath,
  resolvePaths,
  listEnvironments,
  findAuthrimBaseDir,
  AUTHRIM_DIR,
  type EnvironmentPaths,
  type LegacyPaths,
} from '../../core/paths.js';
import {
  deployAll,
  deployUiWorkerComponent,
  deployAllUiWorkers,
  deployUiWorkerBindingTargets,
  resolveMissingUiWorkerBindingTargets,
  resolveExistingWorkerComponents,
  updateLockWithDeployments,
  buildApiPackages,
  loadDeploySecretsFromKeys,
  UI_WORKER_COMPONENTS,
  hasBlockingDeploymentFailures,
  type DeployOptions,
  type UiWorkerComponent,
} from '../../core/deploy.js';
import {
  isWranglerInstalled,
  checkAuth,
  runMigrationsForEnvironment,
  ensureInitialAdminRolesInD1,
  ensureAdminUiBffMachineAccessInD1,
  cleanupSetupMachineAccessInD1,
  ensureSetupMachineAccessInD1,
  ensureInitialTenantInD1,
  seedDefaultCanonicalCatalog,
  seedRuntimeProfiles,
  getWorkersSubdomain,
  ensureWildcardDnsForMultiTenant,
  listD1Databases,
  listKVNamespaces,
  findMigrationsRoot,
} from '../../core/cloudflare.js';
import { type WorkerComponent, CORE_WORKER_COMPONENTS } from '../../core/naming.js';
import { generateWranglerConfig, toToml, buildResourceIdsFromLock } from '../../core/wrangler.js';
import { completeInitialSetup, displaySetupInstructions } from '../../core/admin.js';
import { ensureLoginUiClient } from '../../core/login-ui-client.js';
import { prepareAdminUiBffDeployment } from '../../core/admin-ui-bff-deployment.js';
import {
  configureDownstreamIntrospectionDeployment,
  resolveDownstreamIntrospectionKeysDir,
} from '../../core/downstream-introspection-deploy.js';
import { describeAdminUiApiMode, resolveUiDeploymentSettings } from '../../core/ui-deployment.js';
import { mergeAndSaveUiEnv } from '../../core/ui-env.js';
import {
  resolveApiBaseUrlCandidates,
  resolveAdminUiEntryUrl,
  resolveIssuerUrl,
  resolveLoginUiEntryUrl,
  resolveLoginUiExecutionOrigin,
} from '../../core/url-config.js';
import { ensureSupplementalKeyFiles } from '../../core/keys.js';
import { getPackageVersion, getRootProductVersion } from '../../core/version.js';
import {
  calculateReleaseManifestChecksum,
  loadInstalledReleaseMigrationManifest,
  loadTargetReleaseMigrationManifest,
  resolveReleaseMigrationTargets,
} from '../../core/release-migrations.js';
import {
  withReleaseUpdateState,
  withRecordedReleaseSchemaTargets,
  withSchemaTargetStates,
  withVerifiedInitialReleaseState,
} from '../../core/release-state.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../../core/release-deployment-guard.js';
import {
  buildWorkerHttpReadinessTargets,
  waitForRouterWorkerReady,
  waitForWorkerDeploymentsReady,
  waitForWorkerHttpReady,
} from '../../core/worker-readiness.js';
import {
  ensureInitialTenantD1Resources,
  inspectTenantD1Topology,
  markTenantD1SlotsDeploymentState,
  publishInitialTenantD1RuntimeSnapshot,
} from '../../core/tenant-d1-bootstrap.js';
import { validateSetupDomainInputs } from '../../web/domain-form-state.js';
import type { SyncAction } from '../../core/wrangler-sync.js';
import { saveMasterWranglerConfigs } from '../../core/wrangler-sync.js';
import { printCliCapabilitySummary } from '../capability-summary.js';
import {
  formatWildcardDnsManualAction,
  getCloudflareDnsRecordsDashboardUrl,
  getWildcardDnsManualAction,
  isWildcardDnsPermissionError,
} from '../../core/wildcard-dns-manual-action.js';
import {
  assertPendingTopologyUpdate,
  completeTopologyUpdate,
  topologyUpdateResumeInstruction,
} from '../../core/topology-update.js';

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
  externalSchemaReady?: boolean;
  /** Internal authorization context supplied by explicit topology commands. */
  operationKind?: 'worker_redeploy' | 'topology_change';
}

/** Non-interactive deploys must apply the freshly generated target-environment section. */
export function getAutomaticWranglerSyncAction(
  options: Pick<DeployCommandOptions, 'yes'>
): SyncAction | null {
  return options.yes === true ? 'overwrite' : null;
}

/** Ignore a stale config default while preserving an explicit CLI override for strict validation. */
export function getDeployKeysDirHint(input: {
  baseDir: string;
  explicitKeysDir?: string;
  configuredKeysDir?: string;
}): string | undefined {
  if (input.explicitKeysDir) return input.explicitKeysDir;
  if (!input.configuredKeysDir) return undefined;
  return existsSync(resolve(input.baseDir, input.configuredKeysDir))
    ? input.configuredKeysDir
    : undefined;
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

function validateDeployDomainDepthConfig(config: AuthrimConfig): Array<{
  path: string;
  message: string;
}> {
  const multiTenant = config.tenant?.multiTenant === true;

  return validateSetupDomainInputs({
    apiDomain: multiTenant ? config.tenant?.baseDomain || '' : config.urls?.api?.custom || '',
    loginUiDomain: config.urls?.loginUi?.custom,
    adminUiDomain: config.urls?.adminUi?.custom,
    tenantName: config.tenant?.name,
  }).map((issue) => ({
    path:
      issue.field === 'apiDomain'
        ? multiTenant
          ? 'tenant.baseDomain'
          : 'urls.api.custom'
        : issue.field === 'loginUiDomain'
          ? 'urls.loginUi.custom'
          : 'urls.adminUi.custom',
    message: issue.suggestion
      ? `${issue.message} Suggested host: ${issue.suggestion}`
      : issue.message,
  }));
}

async function ensureSupplementalKeysForDeploy(
  keysDir: string,
  onProgress: (message: string) => void
): Promise<void> {
  if (!existsSync(keysDir)) {
    return;
  }

  const result = await ensureSupplementalKeyFiles(keysDir);
  if (result.createdFiles.length === 0) {
    return;
  }

  onProgress(`Created ${result.createdFiles.length} supplemental key file(s) in ${keysDir}`);
  for (const filePath of result.createdFiles) {
    onProgress(`  - ${filePath.replace(`${keysDir}/`, '')}`);
  }
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

  const workersSubdomain = await getWorkersSubdomain();
  await printCliCapabilitySummary({
    auth,
    wranglerInstalled: true,
    workersSubdomain,
    locale: getLocale(),
  });

  // Find config file (support both new and legacy structures)
  // Also search in common subdirectories (authrim/) for cases where setup was run from parent dir
  let baseDir = findAuthrimBaseDir(process.cwd());
  let configPath: string = findLegacyConfigPath(baseDir, options.env);
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
        configPath = findLegacyConfigPath(searchDir, options.env);
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

  const domainDepthIssues = validateDeployDomainDepthConfig(config);
  if (domainDepthIssues.length > 0) {
    console.error(chalk.red('\n❌ Invalid domain configuration'));
    for (const issue of domainDepthIssues) {
      console.error(chalk.red(`  • ${issue.path}: ${issue.message}`));
    }
    console.log('');
    console.log(chalk.yellow('Fix the domains in config.json before deploying.'));
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
  const plannedConfigText = existsSync(configPath) ? await readFile(configPath, 'utf-8') : null;

  // Load lock file (support both structures)
  const { lock, path: lockPath, type: structureType } = await loadLockFileAuto(baseDir, env);

  if (!lock) {
    console.error(chalk.red('\nLock file not found'));
    console.log(chalk.yellow('Run "authrim-setup init" first to provision resources.'));
    process.exit(1);
  }
  console.log(chalk.cyan(`Lock: ${lockPath}`));
  let currentLock = lock;
  const targetProductVersion = await getRootProductVersion(rootDir);
  const isInitialDeployment =
    !currentLock.productVersion && Object.keys(currentLock.workers ?? {}).length === 0;
  if (isInitialDeployment && options.component) {
    console.error(chalk.red('\nInitial deployment must deploy the complete release.'));
    process.exit(1);
  }
  if (isInitialDeployment && options.skipMigrations) {
    console.error(chalk.red('\nInitial deployment cannot skip database migrations.'));
    process.exit(1);
  }
  if (
    isInitialDeployment &&
    options.skipUi &&
    ((config.components.loginUi ?? true) || (config.components.adminUi ?? true))
  ) {
    console.error(chalk.red('\nInitial deployment cannot skip enabled UI components.'));
    process.exit(1);
  }
  const migrationsRootResult = await findMigrationsRoot(rootDir);
  if (!migrationsRootResult.path) {
    console.error(chalk.red('\nRelease migrations directory was not found.'));
    process.exit(1);
  }
  const deploymentRelease = isInitialDeployment
    ? loadTargetReleaseMigrationManifest({
        migrationsRoot: migrationsRootResult.path,
        productVersion: targetProductVersion,
        allowDraft: true,
      })
    : loadInstalledReleaseMigrationManifest({
        migrationsRoot: migrationsRootResult.path,
        productVersion: targetProductVersion,
        lock: currentLock,
      });
  const initialRelease = isInitialDeployment ? deploymentRelease : undefined;
  const initialManifestChecksum = initialRelease
    ? calculateReleaseManifestChecksum(initialRelease.manifest)
    : undefined;
  const initialTargets = initialRelease
    ? resolveReleaseMigrationTargets({ lock: currentLock, config })
    : [];
  const unresolvableInitialTargets = initialTargets.filter((target) => !target.streamId);
  if (unresolvableInitialTargets.length > 0) {
    console.error(chalk.red('\nThe selected release has no migration stream for these databases:'));
    for (const target of unresolvableInitialTargets) {
      console.error(chalk.red(`  • ${target.connectionRef ?? target.id}`));
    }
    process.exit(1);
  }
  const initialManualTargetIds = new Set(
    initialTargets.filter((target) => !target.automatic).map((target) => target.id)
  );
  if (initialManualTargetIds.size > 0 && !options.externalSchemaReady) {
    console.error(
      chalk.red(
        '\nExternal database migrations must be applied before initial deployment. Re-run with --external-schema-ready after verification.'
      )
    );
    process.exit(1);
  }
  const deploymentGuard = evaluateReleaseDeploymentGuard(
    currentLock,
    targetProductVersion,
    isInitialDeployment ? 'initial_deploy' : (options.operationKind ?? 'worker_redeploy')
  );
  if (!deploymentGuard.allowed) {
    console.error(
      chalk.red(`\n${releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion)}`)
    );
    process.exit(1);
  }
  if (options.operationKind === 'topology_change') {
    try {
      assertPendingTopologyUpdate(currentLock, {
        phase: 'pending_deploy',
        targetProductVersion,
        config,
      });
    } catch (error) {
      console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  }

  if (
    options.component &&
    (UI_WORKER_COMPONENTS as readonly string[]).includes(options.component)
  ) {
    const uiComponent = options.component as UiWorkerComponent;

    console.log(chalk.cyan(`\nDeploying single UI component: ${uiComponent}`));

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

    const operationLock = options.dryRun
      ? undefined
      : await acquireEnvironmentOperationLock(lockPath, `deploy:${uiComponent}`);
    try {
      if (operationLock) {
        const lockedEnvironment = await loadLockFileAuto(baseDir, env);
        if (
          !lockedEnvironment.lock ||
          JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(currentLock)
        ) {
          throw new Error('environment_changed_while_waiting_for_deploy_lock');
        }
        const lockedConfigText = existsSync(configPath)
          ? await readFile(configPath, 'utf-8')
          : null;
        if (lockedConfigText !== plannedConfigText) {
          throw new Error('config_changed_while_waiting_for_deploy_lock');
        }
        currentLock = lockedEnvironment.lock;
      }

      const apiBaseUrl = resolveIssuerUrl(config, { env });
      let loginUiClientId: string | undefined;
      const uiKeysDir = !options.dryRun
        ? resolveDownstreamIntrospectionKeysDir({
            env,
            rootDir: baseDir,
            keysDir: options.keysDir || config.keys?.secretsPath || './keys/',
            keysBaseDir: process.cwd(),
          })
        : undefined;
      if (uiKeysDir) {
        await ensureSupplementalKeysForDeploy(uiKeysDir, (message) => {
          console.log(chalk.gray(message));
        });
      }

      if (uiComponent === 'ar-login-ui' && !options.dryRun) {
        const loginUiUrl = resolveLoginUiExecutionOrigin(config, { env });
        const keysDir = uiKeysDir!;

        const readinessResult = await waitForRouterWorkerReady({
          apiBaseUrl,
          onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
        });
        if (!readinessResult.ready) {
          console.error(
            chalk.red(
              `API router did not become reachable at ${readinessResult.checkedUrl}: ${readinessResult.error || 'unknown readiness error'}`
            )
          );
          process.exit(1);
        }

        const setupMachineResult = await ensureSetupMachineAccessInD1(env, config, keysDir, (msg) =>
          console.log(chalk.gray(`  ${msg}`))
        );
        if (!setupMachineResult.success) {
          console.error(
            chalk.red(
              `Setup machine access bootstrap failed: ${setupMachineResult.error || 'unknown error'}`
            )
          );
          process.exit(1);
        }

        try {
          const clientResult = await ensureLoginUiClient({
            apiBaseUrl,
            apiBaseUrls: resolveApiBaseUrlCandidates(config, {
              env,
              purpose: 'tenant-scoped-admin',
            }),
            loginUiUrl,
            keysDir,
            tenantId: config.tenant?.name,
            onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
          });

          if (clientResult.success && clientResult.clientId) {
            loginUiClientId = clientResult.clientId;
            console.log(chalk.gray(`  ✓ Login UI client resolved: ${loginUiClientId}`));
          } else {
            console.error(
              chalk.red(`Login UI client creation failed: ${clientResult.error || 'unknown error'}`)
            );
            process.exit(1);
          }
        } finally {
          await cleanupSetupMachineAccessInD1(env, keysDir);
        }
      }

      const uiSettings = resolveUiDeploymentSettings({
        component: uiComponent,
        config,
        apiBaseUrl,
        loginUiClientId,
      });

      if (uiComponent === 'ar-login-ui' && loginUiClientId) {
        await mergeAndSaveUiEnv(getEnvironmentPaths({ baseDir, env }).uiEnv, uiSettings.uiEnv);
        console.log(chalk.gray(`  ✓ Login UI env updated with client_id`));
      }

      const adminUiBffSecrets =
        uiComponent === 'ar-admin-ui' && !options.dryRun
          ? await prepareAdminUiBffDeployment({
              env,
              config,
              keysDir: uiKeysDir!,
              onProgress: (message) => console.log(chalk.gray(`  ${message}`)),
            })
          : undefined;

      const result = await deployUiWorkerComponent(uiComponent, {
        env,
        rootDir: resolve(rootDir),
        dryRun: options.dryRun || false,
        apiBaseUrl: uiSettings.apiBaseUrl,
        runtimeApiBackendUrl: uiSettings.runtimeApiBackendUrl,
        uiEnvConfig: uiSettings.uiEnv,
        serviceBindingName: uiSettings.serviceBindingName,
        workersDev: uiSettings.workersDev,
        routes: uiSettings.routes,
        adminUiBffSecrets,
        onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
      });

      if (!options.dryRun && result.deployedAt && (result.success || result.trafficCommitted)) {
        const version = await getPackageVersion(join(rootDir, 'packages', uiComponent));
        currentLock = {
          ...currentLock,
          workers: {
            ...currentLock.workers,
            [uiComponent]: {
              name: result.projectName,
              deployedAt: result.deployedAt,
              version: version ?? undefined,
            },
          },
          updatedAt: new Date().toISOString(),
        };
        await saveLockFile(currentLock, lockPath);
      }

      if (!result.success) {
        console.error(chalk.red(`\n${uiComponent} deployment failed: ${result.error}`));
        process.exit(1);
      }

      if (!options.dryRun) {
        const visibility = await waitForWorkerDeploymentsReady({
          targets: [{ workerName: result.projectName, deployedAt: result.deployedAt }],
        });
        if (!visibility.ready) {
          throw new Error(
            `UI Worker deployment did not become visible: ${visibility.error ?? 'unknown error'}`
          );
        }
        const workersSubdomain = await getWorkersSubdomain();
        const entryUrl =
          uiComponent === 'ar-login-ui'
            ? resolveLoginUiEntryUrl(config, { env, workersSubdomain })
            : resolveAdminUiEntryUrl(config, { env, workersSubdomain });
        const httpReadiness = await waitForWorkerHttpReady({
          targets: [{ workerName: result.projectName, url: entryUrl }],
        });
        if (!httpReadiness.ready) {
          throw new Error(
            `UI Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
          );
        }
      }

      console.log(chalk.green(`\n✓ ${uiComponent} deployed successfully`));
      console.log(chalk.gray(`  Project: ${result.projectName}`));
      return;
    } finally {
      await operationLock?.release();
    }
  }

  // Determine what to deploy
  let componentsToDeply: WorkerComponent[] | undefined;
  let resolvedKeysDir: string | null = null;

  const getResolvedKeysDir = (): string => {
    if (resolvedKeysDir) {
      return resolvedKeysDir;
    }

    resolvedKeysDir = resolveDownstreamIntrospectionKeysDir({
      env,
      rootDir: baseDir,
      keysDir: getDeployKeysDirHint({
        baseDir,
        explicitKeysDir: options.keysDir,
        configuredKeysDir: config.keys.secretsPath,
      }),
      keysBaseDir: process.cwd(),
    });
    return resolvedKeysDir;
  };

  if (options.component) {
    // Deploy single component
    componentsToDeply = [options.component as WorkerComponent];
    console.log(chalk.cyan(`\nDeploying single component: ${options.component}`));
  } else {
    const enabledComponents = [...CORE_WORKER_COMPONENTS];

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

  const operationLock = options.dryRun
    ? undefined
    : await acquireEnvironmentOperationLock(lockPath, 'deploy');
  try {
    if (operationLock) {
      const lockedEnvironment = await loadLockFileAuto(baseDir, env);
      if (
        !lockedEnvironment.lock ||
        JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(currentLock)
      ) {
        throw new Error('environment_changed_while_waiting_for_deploy_lock');
      }
      const lockedConfigText = existsSync(configPath) ? await readFile(configPath, 'utf-8') : null;
      if (lockedConfigText !== plannedConfigText) {
        throw new Error('config_changed_while_waiting_for_deploy_lock');
      }
      currentLock = lockedEnvironment.lock;
      const lockedDeploymentRelease = isInitialDeployment
        ? loadTargetReleaseMigrationManifest({
            migrationsRoot: migrationsRootResult.path,
            productVersion: targetProductVersion,
            allowDraft: true,
          })
        : loadInstalledReleaseMigrationManifest({
            migrationsRoot: migrationsRootResult.path,
            productVersion: targetProductVersion,
            lock: currentLock,
          });
      if (
        lockedDeploymentRelease.draft !== deploymentRelease.draft ||
        calculateReleaseManifestChecksum(lockedDeploymentRelease.manifest) !==
          calculateReleaseManifestChecksum(deploymentRelease.manifest)
      ) {
        throw new Error('release_manifest_changed_while_waiting_for_deploy_lock');
      }
    }

    console.log('');

    if (!options.dryRun) {
      await ensureSupplementalKeysForDeploy(getResolvedKeysDir(), (message) => {
        console.log(chalk.gray(message));
      });
    }

    if (!options.dryRun) {
      const resourceReconciliationSpinner = ora('Refreshing Cloudflare resource IDs...').start();
      try {
        const [databases, namespaces] = await Promise.all([listD1Databases(), listKVNamespaces()]);
        const d1Reconciliation = reconcileSharedD1ResourcesInLock(currentLock, env, databases);
        const kvReconciliation = reconcileSharedKVResourcesInLock(
          d1Reconciliation.lock,
          env,
          namespaces
        );
        const missingResources = [
          ...d1Reconciliation.missingBindings.map((missing) => ({ type: 'D1', ...missing })),
          ...kvReconciliation.missingBindings.map((missing) => ({ type: 'KV', ...missing })),
        ];

        if (missingResources.length > 0) {
          resourceReconciliationSpinner.fail('Required Cloudflare resources are missing');
          for (const missing of missingResources) {
            console.log(chalk.red(`  • ${missing.type} ${missing.binding}: ${missing.name}`));
          }
          process.exit(1);
        }

        currentLock = kvReconciliation.lock;
        const updatedResources = [
          ...d1Reconciliation.updatedBindings.map((binding) => `D1 ${binding}`),
          ...kvReconciliation.updatedBindings.map((binding) => `KV ${binding}`),
        ];
        if (updatedResources.length > 0) {
          await saveLockFile(currentLock, lockPath);
          resourceReconciliationSpinner.succeed(
            `Refreshed Cloudflare bindings: ${updatedResources.join(', ')}`
          );
        } else {
          resourceReconciliationSpinner.succeed('D1 and KV resource IDs are current');
        }
      } catch (error) {
        resourceReconciliationSpinner.fail('Failed to refresh Cloudflare resource IDs');
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    }

    // A new environment is schema-first: no Worker (including a temporary UI binding target)
    // may be published until every automatically managed shared D1 database is on the exact
    // release manifest selected by the product version.
    if (isInitialDeployment && !options.dryRun && initialRelease && initialManifestChecksum) {
      currentLock = withReleaseUpdateState(currentLock, {
        targetVersion: targetProductVersion,
        phase: 'planned',
        manifestChecksum: initialManifestChecksum,
        manualTargets: [...initialManualTargetIds],
      });
      await saveLockFile(currentLock, lockPath);

      const initialMigrationSpinner = ora('Applying initial release schema...').start();
      const result = await runMigrationsForEnvironment(
        env,
        rootDir,
        (message) => {
          initialMigrationSpinner.text = message;
        },
        config,
        {
          productVersion: targetProductVersion,
          allowDraft: true,
        }
      );
      if (!result.success) {
        initialMigrationSpinner.fail('Initial release schema failed');
        console.error(
          chalk.red(
            `  ${result.core.error ?? result.pii.error ?? result.admin.error ?? 'unknown migration error'}`
          )
        );
        process.exit(1);
      }
      initialMigrationSpinner.succeed('Initial release schema applied');

      const appliedTargetIds = initialTargets
        .filter((target) => target.automatic || initialManualTargetIds.has(target.id))
        .map((target) => target.id);
      currentLock = withSchemaTargetStates(currentLock, {
        targetIds: appliedTargetIds,
        manualTargetIds: initialManualTargetIds,
        productVersion: targetProductVersion,
        manifestChecksum: initialManifestChecksum,
        targetStreamIds: new Map(initialTargets.map((target) => [target.id, target.streamId])),
        manifest: initialRelease.manifest,
      });
      currentLock = withReleaseUpdateState(currentLock, {
        targetVersion: targetProductVersion,
        phase: 'schema_applied',
        manifestChecksum: initialManifestChecksum,
        appliedTargets: appliedTargetIds,
        manualTargets: [...initialManualTargetIds],
      });
      await saveLockFile(currentLock, lockPath);
    }

    // Refresh generated wrangler configs from the current config/lock before deployment.
    // This prevents stale bindings such as send_email from surviving across setup upgrades.
    if (structureType === 'new' && lock) {
      const mayMutateTenantTopology =
        isInitialDeployment || options.operationKind === 'topology_change';
      if (mayMutateTenantTopology) {
        const tenantD1BootstrapSpinner = ora('Checking tenant D1 bindings...').start();
        const tenantD1BootstrapResult = await ensureInitialTenantD1Resources({
          env,
          config,
          lock: currentLock,
          rootDir,
          release: deploymentRelease,
          onProgress: (msg) => {
            tenantD1BootstrapSpinner.text = msg;
          },
        });
        if (tenantD1BootstrapResult.success) {
          if (tenantD1BootstrapResult.skipped) {
            tenantD1BootstrapSpinner.succeed('Tenant D1 bootstrap not required');
          } else {
            const tenantTargets = resolveReleaseMigrationTargets({
              lock: currentLock,
              config,
            }).filter((target) => target.scope === 'tenant' && target.automatic);
            currentLock = withRecordedReleaseSchemaTargets(currentLock, {
              productVersion: targetProductVersion,
              manifest: deploymentRelease.manifest,
              targets: tenantTargets,
            });
            await saveLockFile(currentLock, lockPath);
            tenantD1BootstrapSpinner.succeed(
              `Tenant D1 bindings ready (${tenantD1BootstrapResult.createdCount ?? 0} created)`
            );
          }
        } else {
          tenantD1BootstrapSpinner.fail('Tenant D1 bootstrap failed');
          console.log(chalk.red(`  ${tenantD1BootstrapResult.error || 'unknown error'}`));
          process.exit(1);
        }
      } else {
        const topologyIssues = inspectTenantD1Topology({
          env,
          config,
          lock: currentLock,
          productVersion: targetProductVersion,
          manifest: deploymentRelease.manifest,
        });
        if (topologyIssues.length > 0) {
          console.error(
            chalk.red(
              '\nTenant D1 topology is incomplete. A Worker-only redeploy cannot create databases or apply schema.'
            )
          );
          for (const issue of topologyIssues) {
            console.error(chalk.red(`  • ${issue.binding}: ${issue.reason}`));
          }
          console.log(
            chalk.yellow(
              `Run authrim-setup tenant-db-pool-expand --env ${env} for an explicit topology operation.`
            )
          );
          process.exit(1);
        }
      }

      const resourceIds = buildResourceIdsFromLock(currentLock, config);
      const masterSpinner = ora('Refreshing generated wrangler configs...').start();
      const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
        baseDir,
        env,
        dryRun: options.dryRun,
        onProgress: (msg) => {
          masterSpinner.text = msg;
        },
      });

      if (!masterResult.success) {
        masterSpinner.fail('Failed to refresh generated wrangler configs');
        for (const error of masterResult.errors) {
          console.log(chalk.red(`  • ${error}`));
        }
        process.exit(1);
      }

      masterSpinner.succeed(`Refreshed ${masterResult.files.length} generated wrangler config(s)`);
    }

    // Check wrangler.toml sync status (only for new structure)
    if (structureType === 'new') {
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
            console.log(
              chalk.yellow('The following wrangler configs have been manually modified:')
            );
            for (const s of outOfSync) {
              console.log(chalk.gray(`  • ${s.component}/wrangler.toml`));
            }
            console.log('');

            const automaticAction = getAutomaticWranglerSyncAction(options);
            const action =
              automaticAction ??
              (await select({
                message: t('deploy.wranglerChanged'),
                choices: [
                  { value: 'keep', name: t('deploy.wranglerKeep') },
                  { value: 'backup', name: t('deploy.wranglerBackup') },
                  { value: 'overwrite', name: t('deploy.wranglerOverwrite') },
                ],
              }));
            if (automaticAction) {
              console.log(chalk.gray('  --yes: applying regenerated target-environment sections'));
            }

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

    // Check if wrangler.toml files exist at all, if not generate them from lock file
    const sampleWranglerPath = join(rootDir, 'packages', 'ar-lib-core', 'wrangler.toml');
    if (!existsSync(sampleWranglerPath) && lock) {
      const genSpinner = ora('Generating wrangler configs from lock file...').start();

      try {
        const resourceIds = buildResourceIdsFromLock(currentLock, config);

        // Get workers subdomain
        const workersSubdomain = await getWorkersSubdomain();

        // Generate wrangler.toml for each component
        let generatedCount = 0;
        for (const component of CORE_WORKER_COMPONENTS) {
          const componentDir = join(rootDir, 'packages', component);
          if (!existsSync(componentDir)) {
            continue;
          }

          const wranglerConfig = generateWranglerConfig(
            component,
            config,
            resourceIds,
            workersSubdomain ?? undefined
          );
          const tomlContent = toToml(wranglerConfig, env);
          const tomlPath = join(componentDir, 'wrangler.toml');

          if (!options.dryRun) {
            await writeFile(tomlPath, tomlContent, 'utf-8');
          }
          generatedCount++;
        }

        genSpinner.succeed(`Generated ${generatedCount} wrangler config(s)`);
      } catch (error) {
        genSpinner.fail('Failed to generate wrangler configs');
        console.error(chalk.red(`\nError: ${error}`));
        process.exit(1);
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

    // Load secrets once; Wrangler uploads each Worker's subset with its code/version.
    let deploymentSecrets: Record<string, string> = {};
    if (!options.skipSecrets) {
      const keysDir = getResolvedKeysDir();

      if (existsSync(keysDir)) {
        deploymentSecrets = await loadDeploySecretsFromKeys(keysDir, componentsToDeply);
        if (Object.keys(deploymentSecrets).length > 0) {
          console.log(
            chalk.gray(
              `Prepared ${Object.keys(deploymentSecrets).length} secret value(s) for atomic Worker deployment.`
            )
          );
        } else {
          console.log(chalk.yellow(`No secrets found in ${keysDir}`));
        }
      }
      console.log('');
    }

    // Deploy workers
    console.log(chalk.bold('🔨 Deploying workers...\n'));

    const shouldEnsureWildcardDns =
      !options.dryRun && (!options.component || options.component === 'ar-router');

    if (shouldEnsureWildcardDns) {
      const wildcardBaseDomain =
        config.tenant?.multiTenant === true ? config.tenant.baseDomain?.trim() : undefined;

      if (wildcardBaseDomain) {
        const action = getWildcardDnsManualAction(wildcardBaseDomain, getLocale());
        console.log(chalk.yellow(`${action.summary}`));
        console.log(chalk.gray(action.timing));
        console.log('');
      }

      try {
        await ensureWildcardDnsForMultiTenant(config, (message) => {
          console.log(chalk.gray(message));
        });
        console.log('');
      } catch (error) {
        const wildcardBaseDomain =
          config.tenant?.multiTenant === true ? config.tenant.baseDomain?.trim() : undefined;
        if (wildcardBaseDomain && isWildcardDnsPermissionError(error)) {
          const action = getWildcardDnsManualAction(wildcardBaseDomain, getLocale());
          console.error(chalk.red(action.title));
          console.log('');
          console.log(formatWildcardDnsManualAction(action));
          const dashboardUrl = getCloudflareDnsRecordsDashboardUrl(
            auth.accountId,
            wildcardBaseDomain
          );
          if (dashboardUrl) {
            console.log(dashboardUrl);
            console.log('');
          }
          console.log('');
          process.exit(1);
        }
        console.error(
          chalk.red(
            `Failed to prepare wildcard DNS: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        process.exit(1);
      }
    }

    const deployOptions: DeployOptions = {
      env,
      rootDir,
      dryRun: options.dryRun,
      maxRetries: 3,
      retryDelayMs: 1000,
      concurrency: 2,
      deploymentStrategy: 'auto',
      existingComponents: CORE_WORKER_COMPONENTS.filter(
        (component) => currentLock.workers?.[component] !== undefined
      ),
      secrets: deploymentSecrets,
      cleanupLegacyStaticSecrets: true,
      onProgress: (msg) => console.log(msg),
      onError: (component, error) => {
        console.error(chalk.red(`Error in ${component}: ${error.message}`));
      },
    };
    if (!options.dryRun) {
      deployOptions.existingComponents = await resolveExistingWorkerComponents(
        deployOptions,
        CORE_WORKER_COMPONENTS
      );
    }

    const enabledUiBindingTargets = {
      loginUi: config.components.loginUi ?? true,
      adminUi: config.components.adminUi ?? true,
    };
    const routerSelected =
      componentsToDeply?.includes('ar-router') || options.component === 'ar-router';
    const missingUiBindingTargets = routerSelected
      ? options.dryRun
        ? enabledUiBindingTargets
        : await resolveMissingUiWorkerBindingTargets(deployOptions, enabledUiBindingTargets)
      : { loginUi: false, adminUi: false };
    const shouldPrepareUiBindingTargets =
      routerSelected && (missingUiBindingTargets.loginUi || missingUiBindingTargets.adminUi);

    if (shouldPrepareUiBindingTargets) {
      const placeholderSummary = await deployUiWorkerBindingTargets(
        {
          ...deployOptions,
          apiBaseUrl: resolveIssuerUrl(config, { env }),
        },
        missingUiBindingTargets
      );

      if (placeholderSummary.failedCount > 0) {
        console.log(chalk.yellow('\n⚠️  UI Worker pre-deploy failed'));
        for (const result of placeholderSummary.results.filter((candidate) => !candidate.success)) {
          console.log(chalk.red(`  • ${result.component}: ${result.error || 'unknown error'}`));
        }
        console.log(
          chalk.gray('  ar-router may fail if it references missing UI Worker bindings.')
        );
      }
      console.log('');
    }

    const summary = await deployAll(deployOptions, componentsToDeply);

    // Update lock file with deployment results
    if (
      !options.dryRun &&
      summary.results.some((result) => result.success || result.trafficCommitted)
    ) {
      currentLock = updateLockWithDeployments(currentLock, summary.results);
      await saveLockFile(currentLock, lockPath);
      console.log(chalk.gray(`\nLock file updated: ${lockPath}`));
    }

    const markTenantD1SlotsAfterDeploymentIssue = async (
      state: 'pending_binding' | 'unavailable',
      stage: string,
      errorCode: string
    ): Promise<void> => {
      if (options.dryRun || options.component) {
        return;
      }
      const result = await markTenantD1SlotsDeploymentState({
        env,
        config,
        lock: currentLock,
        state,
        stage,
        errorCode,
        onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
      });
      if (result.success && !result.skipped) {
        console.log(chalk.yellow(`  Tenant D1 slots marked ${state} for setup rerun recovery.`));
      } else if (!result.success) {
        console.log(
          chalk.yellow(
            `  Could not mark tenant D1 slots ${state}: ${result.error || 'unknown error'}`
          )
        );
      }
    };

    if (!options.dryRun && !options.component && summary.failedCount > 0) {
      const failedComponents = summary.results
        .filter((result) => !result.success)
        .map((result) => `${result.component}:${result.error || 'deploy_failed'}`)
        .join(',');
      await markTenantD1SlotsAfterDeploymentIssue(
        'pending_binding',
        'worker_deploy',
        failedComponents || 'worker_deploy_failed'
      );
    }

    let deploymentApiBaseUrl = resolveIssuerUrl(config, { env });
    if (!options.dryRun && !options.component && summary.failedCount === 0) {
      const workerDeploymentSpinner = ora('Verifying Worker deployments...').start();
      const workerDeploymentResult = await waitForWorkerDeploymentsReady({
        targets: summary.results
          .filter((result) => result.success)
          .map((result) => ({
            workerName: result.workerName,
            deployedAt: result.deployedAt,
          })),
        onProgress: (msg) => {
          workerDeploymentSpinner.text = msg;
        },
      });
      if (workerDeploymentResult.ready) {
        workerDeploymentSpinner.succeed('Worker deployments are visible');
      } else {
        workerDeploymentSpinner.fail('Worker deployments did not become visible');
        console.error(
          chalk.red(`  ${workerDeploymentResult.error || 'unknown verification error'}`)
        );
        await markTenantD1SlotsAfterDeploymentIssue(
          'unavailable',
          'worker_deployment_visibility',
          workerDeploymentResult.error || 'worker_deployment_visibility_failed'
        );
        process.exit(1);
      }

      const workersSubdomain = await getWorkersSubdomain();
      const workerHttpTargets = buildWorkerHttpReadinessTargets(
        summary.results.filter((result) => result.success),
        workersSubdomain,
        { workersDevEnabled: !config.urls?.api?.custom }
      );
      if (workerHttpTargets.length > 0) {
        const workerHttpSpinner = ora('Verifying Worker HTTP health...').start();
        const workerHttpResult = await waitForWorkerHttpReady({
          targets: workerHttpTargets,
          onProgress: (msg) => {
            workerHttpSpinner.text = msg;
          },
        });
        if (workerHttpResult.ready) {
          workerHttpSpinner.succeed('Worker HTTP health checks passed');
        } else {
          workerHttpSpinner.fail('Worker HTTP health checks failed');
          console.error(chalk.red(`  ${workerHttpResult.error || 'unknown health check error'}`));
          await markTenantD1SlotsAfterDeploymentIssue(
            'unavailable',
            'worker_http_health',
            workerHttpResult.error || 'worker_http_health_failed'
          );
          process.exit(1);
        }
      }

      if (!deploymentApiBaseUrl) {
        deploymentApiBaseUrl = workersSubdomain
          ? `https://${env}-ar-router.${workersSubdomain}.workers.dev`
          : `https://${env}-ar-router.workers.dev`;
      }

      const readinessSpinner = ora('Waiting for API router to become reachable...').start();
      const readinessResult = await waitForRouterWorkerReady({
        apiBaseUrl: deploymentApiBaseUrl,
        onProgress: (msg) => {
          readinessSpinner.text = msg;
        },
      });

      if (readinessResult.ready) {
        readinessSpinner.succeed('API router is reachable');
      } else {
        readinessSpinner.fail('API router did not become reachable');
        console.error(
          chalk.red(
            `  ${readinessResult.checkedUrl}: ${readinessResult.error || 'unknown readiness error'}`
          )
        );
        await markTenantD1SlotsAfterDeploymentIssue(
          'unavailable',
          'router_readiness',
          readinessResult.error || 'router_readiness_failed'
        );
        process.exit(1);
      }
    }

    // Initial schema was applied before Worker publication. Existing same-version redeploys may
    // still reconcile their installed manifest here; both paths then run post-deploy bootstrap.
    let migrationsSuccess = true;
    let initialTenantSuccess = true;
    let initialAdminRolesSuccess = true;
    let setupMachineAccessSuccess = true;
    let setupMachineAccessCleanupDone = false;
    let adminUiBffMachineAccessSuccess = true;
    let defaultCanonicalCatalogSeedSuccess = true;
    let runtimeProfileSeedSuccess = true;
    let uiWorkersSuccess = true;
    const cleanupEphemeralSetupMachineAccess = async (): Promise<void> => {
      if (
        setupMachineAccessCleanupDone ||
        options.dryRun ||
        options.component ||
        !setupMachineAccessSuccess
      ) {
        return;
      }
      setupMachineAccessCleanupDone = true;
      const cleanupSpinner = ora('Removing setup machine access...').start();
      const cleanupResult = await cleanupSetupMachineAccessInD1(
        env,
        getResolvedKeysDir(),
        (msg) => {
          cleanupSpinner.text = msg;
        }
      );
      if (cleanupResult.success) {
        cleanupSpinner.succeed('Setup machine access removed');
      } else {
        cleanupSpinner.warn('Setup machine access cleanup failed');
        if (cleanupResult.error) {
          console.log(chalk.yellow(`  ${cleanupResult.error}`));
        }
      }
    };
    if (
      !options.skipMigrations &&
      !options.dryRun &&
      !options.component &&
      summary.failedCount === 0
    ) {
      if (!isInitialDeployment) {
        console.log(chalk.bold('\n📜 Running D1 database migrations...\n'));
      }
      const migrationsSpinner = isInitialDeployment
        ? undefined
        : ora('Running migrations...').start();

      try {
        const migrationsResult = isInitialDeployment
          ? undefined
          : await runMigrationsForEnvironment(
              env,
              rootDir,
              (msg) => {
                if (migrationsSpinner) migrationsSpinner.text = msg;
              },
              config,
              {
                productVersion: targetProductVersion,
                allowDraft: deploymentRelease.draft,
              }
            );

        if (isInitialDeployment || migrationsResult?.success) {
          if (migrationsResult && migrationsSpinner) {
            migrationsSpinner.succeed(
              `Migrations completed - core: ${migrationsResult.core.appliedCount}, pii: ${migrationsResult.pii.appliedCount}, admin: ${migrationsResult.admin.appliedCount} applied`
            );
          }

          const bootstrapSpinner = ora('Ensuring initial tenant exists...').start();
          const bootstrapResult = await ensureInitialTenantInD1(env, config, (msg) => {
            bootstrapSpinner.text = msg;
          });

          if (bootstrapResult.success) {
            bootstrapSpinner.succeed(`Initial tenant ready: ${config.tenant.name}`);
          } else {
            bootstrapSpinner.fail('Initial tenant bootstrap failed');
            if (bootstrapResult.error) {
              console.log(chalk.red(`  ${bootstrapResult.error}`));
            }
            initialTenantSuccess = false;
          }

          const adminRolesSpinner = ora('Ensuring initial admin roles exist...').start();
          const adminRolesResult = await ensureInitialAdminRolesInD1(env, config, (msg) => {
            adminRolesSpinner.text = msg;
          });

          if (adminRolesResult.success) {
            adminRolesSpinner.succeed(`Initial admin roles ready: ${config.tenant.name}`);
          } else {
            adminRolesSpinner.fail('Initial admin role bootstrap failed');
            if (adminRolesResult.error) {
              console.log(chalk.red(`  ${adminRolesResult.error}`));
            }
            initialAdminRolesSuccess = false;
          }

          const setupMachineSpinner = ora('Ensuring setup machine access exists...').start();
          const setupMachineResult = await ensureSetupMachineAccessInD1(
            env,
            config,
            getResolvedKeysDir(),
            (msg) => {
              setupMachineSpinner.text = msg;
            }
          );

          if (setupMachineResult.success) {
            setupMachineSpinner.succeed('Setup machine access ready');
          } else {
            setupMachineSpinner.fail('Setup machine access bootstrap failed');
            if (setupMachineResult.error) {
              console.log(chalk.red(`  ${setupMachineResult.error}`));
            }
            setupMachineAccessSuccess = false;
          }

          if (config.components.adminUi ?? true) {
            const adminUiBffSpinner = ora('Ensuring Admin UI BFF machine access exists...').start();
            const adminUiBffResult = await ensureAdminUiBffMachineAccessInD1(
              env,
              config,
              getResolvedKeysDir(),
              (msg) => {
                adminUiBffSpinner.text = msg;
              }
            );

            if (adminUiBffResult.success) {
              adminUiBffSpinner.succeed('Admin UI BFF machine access ready');
            } else {
              adminUiBffSpinner.fail('Admin UI BFF machine access bootstrap failed');
              if (adminUiBffResult.error) {
                console.log(chalk.red(`  ${adminUiBffResult.error}`));
              }
              adminUiBffMachineAccessSuccess = false;
            }
          }

          const catalogSeedSpinner = ora('Seeding default canonical field catalog...').start();
          const catalogSeedResult = await seedDefaultCanonicalCatalog(env, config, (msg) => {
            catalogSeedSpinner.text = msg;
          });

          if (catalogSeedResult.success) {
            catalogSeedSpinner.succeed(
              `Default canonical field catalog ready (${catalogSeedResult.seededCount} fields)`
            );
          } else {
            catalogSeedSpinner.fail('Default canonical field catalog seed failed');
            if (catalogSeedResult.error) {
              console.log(chalk.red(`  ${catalogSeedResult.error}`));
            }
            defaultCanonicalCatalogSeedSuccess = false;
          }

          const profileSeedSpinner = ora('Seeding runtime profiles...').start();
          const profileSeedResult = await seedRuntimeProfiles(env, config, (msg) => {
            profileSeedSpinner.text = msg;
          });

          if (profileSeedResult.success) {
            profileSeedSpinner.succeed(
              `Runtime profiles ready (${profileSeedResult.seededCount} seeded to ${profileSeedResult.backend})`
            );
          } else {
            profileSeedSpinner.fail('Runtime profile seed failed');
            if (profileSeedResult.error) {
              console.log(chalk.red(`  ${profileSeedResult.error}`));
            }
            runtimeProfileSeedSuccess = false;
          }

          const tenantD1SnapshotSpinner = ora(
            'Publishing initial tenant D1 runtime snapshot...'
          ).start();
          const tenantD1SnapshotResult = await publishInitialTenantD1RuntimeSnapshot({
            env,
            config,
            lock: currentLock,
            rootDir,
            keysDir: getResolvedKeysDir(),
            release: deploymentRelease.manifest,
            onProgress: (msg) => {
              tenantD1SnapshotSpinner.text = msg;
            },
          });
          if (tenantD1SnapshotResult.success) {
            if (tenantD1SnapshotResult.skipped) {
              tenantD1SnapshotSpinner.succeed('Initial tenant D1 runtime snapshot not required');
            } else {
              tenantD1SnapshotSpinner.succeed('Initial tenant D1 runtime snapshot ready');
            }
          } else {
            tenantD1SnapshotSpinner.fail('Initial tenant D1 runtime snapshot failed');
            if (tenantD1SnapshotResult.error) {
              console.log(chalk.red(`  ${tenantD1SnapshotResult.error}`));
            }
            process.exit(1);
          }
        } else {
          migrationsSpinner?.warn('Some migrations failed');
          if (migrationsResult?.core.error) {
            console.log(chalk.yellow(`  Core: ${migrationsResult.core.error}`));
          }
          if (migrationsResult?.pii.error) {
            console.log(chalk.yellow(`  PII: ${migrationsResult.pii.error}`));
          }
          if (migrationsResult?.admin.error) {
            console.log(chalk.yellow(`  Admin: ${migrationsResult.admin.error}`));
          }
          migrationsSuccess = false;
        }
      } catch (error) {
        migrationsSpinner?.fail('Migrations failed');
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        migrationsSuccess = false;
      }
    }

    const bootstrapSuccess =
      migrationsSuccess &&
      initialTenantSuccess &&
      initialAdminRolesSuccess &&
      setupMachineAccessSuccess &&
      adminUiBffMachineAccessSuccess &&
      defaultCanonicalCatalogSeedSuccess &&
      runtimeProfileSeedSuccess;

    const shouldConfigureDownstreamIntrospectionClient =
      !options.dryRun &&
      !options.skipSecrets &&
      summary.failedCount === 0 &&
      bootstrapSuccess &&
      (!options.component || options.component === 'ar-userinfo');

    if (shouldConfigureDownstreamIntrospectionClient) {
      const keysDir = getResolvedKeysDir();
      const downstreamSetupResult = await configureDownstreamIntrospectionDeployment({
        env,
        rootDir,
        keysDir,
        apiBaseUrl: deploymentApiBaseUrl,
        apiBaseUrls: resolveApiBaseUrlCandidates(config, { env, purpose: 'tenant-scoped-admin' }),
        tenantId: config.tenant?.name,
        dryRun: options.dryRun,
        onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
      });

      if (downstreamSetupResult.success && downstreamSetupResult.redeployResult?.deployedAt) {
        currentLock = updateLockWithDeployments(currentLock, [
          downstreamSetupResult.redeployResult,
        ]);
        await saveLockFile(currentLock, lockPath);
        console.log(
          chalk.green(
            `  ✓ ${downstreamSetupResult.redeployResult.workerName} redeployed successfully`
          )
        );
      } else if (!downstreamSetupResult.success) {
        console.log(
          chalk.yellow(
            `\n⚠️  Downstream introspection client setup skipped: ${downstreamSetupResult.error}`
          )
        );
        for (const error of downstreamSetupResult.secretUploadErrors ?? []) {
          console.log(chalk.red(`  • ${error}`));
        }
      }
    }

    // Deploy UI Workers only after database and tenant bootstrap work has completed.
    if (
      !options.skipUi &&
      !options.component &&
      summary.failedCount === 0 &&
      bootstrapSuccess &&
      (config.components.loginUi || config.components.adminUi)
    ) {
      console.log(chalk.bold('\n📱 Deploying UI to Cloudflare Workers...\n'));

      let apiBaseUrl = deploymentApiBaseUrl;
      if (!apiBaseUrl) {
        const subdomain = await getWorkersSubdomain();
        if (subdomain) {
          apiBaseUrl = `https://${env}-ar-router.${subdomain}.workers.dev`;
        } else {
          apiBaseUrl = `https://${env}-ar-router.workers.dev`;
          console.log(
            chalk.yellow(`  ⚠️  Could not determine workers.dev subdomain, using fallback URL`)
          );
          console.log(
            chalk.gray(`     If API calls fail, set the correct URL in config or ui.env`)
          );
        }
      }

      let loginUiClientId: string | undefined;
      if (config.components.loginUi && !options.dryRun) {
        const loginUiUrl = resolveLoginUiExecutionOrigin(config, { env });
        const keysDir = getResolvedKeysDir();

        const clientResult = await ensureLoginUiClient({
          apiBaseUrl,
          apiBaseUrls: resolveApiBaseUrlCandidates(config, {
            env,
            purpose: 'tenant-scoped-admin',
          }),
          loginUiUrl,
          keysDir,
          tenantId: config.tenant?.name,
          onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
        });

        if (clientResult.success && clientResult.clientId) {
          loginUiClientId = clientResult.clientId;
          if (clientResult.alreadyExists) {
            console.log(chalk.gray(`  ✓ Login UI client exists: ${loginUiClientId}`));
          } else {
            console.log(chalk.green(`  ✓ Login UI client created: ${loginUiClientId}`));
          }
        } else {
          await cleanupEphemeralSetupMachineAccess();
          console.error(
            chalk.red(
              `  ✗ Login UI client creation failed: ${clientResult.error || 'unknown error'}`
            )
          );
          process.exit(1);
        }
      }

      await cleanupEphemeralSetupMachineAccess();

      const loginUiSettings = resolveUiDeploymentSettings({
        component: 'ar-login-ui',
        config,
        apiBaseUrl,
        loginUiClientId,
      });
      if (loginUiClientId) {
        await mergeAndSaveUiEnv(getEnvironmentPaths({ baseDir, env }).uiEnv, loginUiSettings.uiEnv);
        console.log(chalk.gray(`  ✓ Login UI env updated with client_id`));
      }
      const adminUiSettings = resolveUiDeploymentSettings({
        component: 'ar-admin-ui',
        config,
        apiBaseUrl,
      });
      const adminUiBffSecrets =
        (config.components.adminUi ?? true) && !options.dryRun
          ? await prepareAdminUiBffDeployment({
              env,
              config,
              keysDir: getResolvedKeysDir(),
              onProgress: (message) => console.log(chalk.gray(`  ${message}`)),
            })
          : undefined;
      if ((config.components.adminUi ?? true) && adminUiSettings.adminUiApiMode) {
        console.log(
          chalk.gray(
            `  Admin UI API mode: ${adminUiSettings.adminUiApiMode} - ${describeAdminUiApiMode(
              adminUiSettings.adminUiApiMode
            )}`
          )
        );
      }

      const uiWorkersResult = await deployAllUiWorkers(
        {
          ...deployOptions,
          apiBaseUrl,
          perComponent: {
            'ar-login-ui': {
              apiBaseUrl: loginUiSettings.apiBaseUrl,
              runtimeApiBackendUrl: loginUiSettings.runtimeApiBackendUrl,
              uiEnvConfig: loginUiSettings.uiEnv,
              serviceBindingName: loginUiSettings.serviceBindingName,
              workersDev: loginUiSettings.workersDev,
              routes: loginUiSettings.routes,
            },
            'ar-admin-ui': {
              apiBaseUrl: adminUiSettings.apiBaseUrl,
              runtimeApiBackendUrl: adminUiSettings.runtimeApiBackendUrl,
              uiEnvConfig: adminUiSettings.uiEnv,
              serviceBindingName: adminUiSettings.serviceBindingName,
              workersDev: adminUiSettings.workersDev,
              routes: adminUiSettings.routes,
              adminUiBffSecrets,
            },
          },
        },
        {
          loginUi: config.components.loginUi ?? true,
          adminUi: config.components.adminUi ?? true,
        }
      );

      if (
        !options.dryRun &&
        uiWorkersResult.results.some((result) => result.success || result.trafficCommitted)
      ) {
        const workers = { ...currentLock.workers };
        for (const result of uiWorkersResult.results) {
          if ((!result.success && !result.trafficCommitted) || !result.deployedAt) {
            continue;
          }
          workers[result.component] = {
            name: result.projectName,
            deployedAt: result.deployedAt,
            version:
              (await getPackageVersion(join(rootDir, 'packages', result.component))) ?? undefined,
          };
        }
        currentLock = {
          ...currentLock,
          workers,
          updatedAt: new Date().toISOString(),
        };
        await saveLockFile(currentLock, lockPath);
      }

      uiWorkersSuccess = uiWorkersResult.failedCount === 0;
      if (uiWorkersSuccess && !options.dryRun) {
        const visibility = await waitForWorkerDeploymentsReady({
          targets: uiWorkersResult.results.map((result) => ({
            workerName: result.projectName,
            deployedAt: result.deployedAt,
          })),
        });
        if (!visibility.ready) {
          uiWorkersSuccess = false;
          console.error(
            chalk.red(
              `UI Worker deployments are not visible: ${visibility.error ?? 'unknown error'}`
            )
          );
        } else {
          const workersSubdomain = await getWorkersSubdomain();
          const httpReadiness = await waitForWorkerHttpReady({
            targets: uiWorkersResult.results.map((result) => ({
              workerName: result.projectName,
              url:
                result.component === 'ar-login-ui'
                  ? resolveLoginUiEntryUrl(config, { env, workersSubdomain })
                  : resolveAdminUiEntryUrl(config, { env, workersSubdomain }),
            })),
          });
          if (!httpReadiness.ready) {
            uiWorkersSuccess = false;
            console.error(
              chalk.red(
                `UI Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
              )
            );
          }
        }
      }
      if (uiWorkersSuccess) {
        console.log(chalk.green('\n✓ All UI packages deployed successfully'));
        for (const result of uiWorkersResult.results) {
          console.log(chalk.cyan(`  • ${result.component}: ${result.projectName}`));
        }
      } else {
        console.log(
          chalk.yellow(
            `\n⚠️  ${uiWorkersResult.successCount}/${uiWorkersResult.results.length} UI packages deployed`
          )
        );
        for (const result of uiWorkersResult.results) {
          if (result.success) {
            console.log(chalk.green(`  ✓ ${result.component}: ${result.projectName}`));
          } else {
            console.log(chalk.red(`  ✗ ${result.component}: ${result.error}`));
          }
        }
      }
    }

    // Final summary
    console.log(chalk.bold('\n━━━ Deployment Complete ━━━\n'));

    if (summary.failedCount === 0 && bootstrapSuccess && uiWorkersSuccess) {
      console.log(chalk.green('✅ All components deployed and migrations applied!\n'));
    } else if (summary.failedCount === 0 && !migrationsSuccess) {
      console.log(chalk.yellow('⚠️  All components deployed, but some migrations failed.\n'));
    } else if (summary.failedCount === 0 && !initialTenantSuccess) {
      console.log(
        chalk.yellow('⚠️  All components deployed, but initial tenant bootstrap failed.\n')
      );
    } else if (summary.failedCount === 0 && !initialAdminRolesSuccess) {
      console.log(
        chalk.yellow('⚠️  All components deployed, but initial admin role bootstrap failed.\n')
      );
    } else if (summary.failedCount === 0 && !defaultCanonicalCatalogSeedSuccess) {
      console.log(
        chalk.yellow('⚠️  All components deployed, but default canonical catalog seed failed.\n')
      );
    } else if (summary.failedCount === 0 && !runtimeProfileSeedSuccess) {
      console.log(chalk.yellow('⚠️  All components deployed, but runtime profile seed failed.\n'));
    } else if (summary.failedCount === 0 && !uiWorkersSuccess) {
      console.log(
        chalk.yellow('⚠️  All API components deployed, but UI Worker deployment failed.\n')
      );
    } else {
      console.log(
        chalk.yellow(`⚠️  ${summary.successCount}/${summary.totalComponents} components deployed\n`)
      );
    }

    // Print URLs
    if (!options.dryRun && config.urls) {
      console.log(chalk.bold('URLs:'));

      const apiUrl = resolveIssuerUrl(config, { env });
      const loginUrl = config.urls.loginUi?.custom || config.urls.loginUi?.auto;
      const adminUrl = config.urls.adminUi?.custom || config.urls.adminUi?.auto;

      if (apiUrl) console.log(chalk.cyan(`  API:       ${apiUrl}`));
      if (loginUrl) console.log(chalk.cyan(`  Login UI:  ${loginUrl}`));
      if (adminUrl) console.log(chalk.cyan(`  Admin UI:  ${adminUrl}`));
      if (config.components.adminUi ?? true) {
        const adminUiSettings = resolveUiDeploymentSettings({
          component: 'ar-admin-ui',
          config,
          apiBaseUrl: apiUrl,
        });
        if (adminUiSettings.adminUiApiMode) {
          console.log(
            chalk.gray(
              `  Admin UI API mode: ${adminUiSettings.adminUiApiMode} - ${describeAdminUiApiMode(
                adminUiSettings.adminUiApiMode
              )}`
            )
          );
        }
      }

      console.log('');
    }

    // Initial admin setup (only if all components deployed successfully)
    if (!options.dryRun && summary.failedCount === 0) {
      const baseUrl = resolveIssuerUrl(config, { env });

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

    await cleanupEphemeralSetupMachineAccess();

    const blockingDeploymentFailures = hasBlockingDeploymentFailures({
      workerFailedCount: summary.failedCount,
      migrationsSuccess,
      initialTenantSuccess,
      initialAdminRolesSuccess,
      setupMachineAccessSuccess,
      adminUiBffMachineAccessSuccess,
      defaultCanonicalCatalogSeedSuccess,
      runtimeProfileSeedSuccess,
      uiWorkersSuccess,
    });

    if (
      isInitialDeployment &&
      !options.dryRun &&
      !blockingDeploymentFailures &&
      initialRelease &&
      initialManifestChecksum
    ) {
      const finalTargets = resolveReleaseMigrationTargets({ lock: currentLock, config });
      currentLock = withVerifiedInitialReleaseState(currentLock, {
        productVersion: targetProductVersion,
        manifestChecksum: initialManifestChecksum,
        manifest: initialRelease.manifest,
        targets: finalTargets,
        acknowledgedManualTargetIds: initialManualTargetIds,
      });
      await saveLockFile(currentLock, lockPath);
      console.log(chalk.gray(`Release state verified at ${targetProductVersion}.`));
    }

    if (
      options.operationKind === 'topology_change' &&
      !options.dryRun &&
      !blockingDeploymentFailures
    ) {
      currentLock = completeTopologyUpdate(currentLock, {
        targetProductVersion,
        config,
      });
      await saveLockFile(currentLock, lockPath);
      console.log(chalk.gray('Topology update state verified and cleared.'));
    }

    if (blockingDeploymentFailures) {
      // Let CI fail at the deploy step while still giving cleanup a chance to run.
      process.exitCode = 1;
    }
  } finally {
    await operationLock?.release();
  }
}

// =============================================================================
// Status Command
// =============================================================================

export async function statusCommand(options: { config?: string; env?: string }): Promise<void> {
  console.log(chalk.bold('\n📊 Authrim Deployment Status\n'));

  const baseDir = findAuthrimBaseDir(process.cwd());
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
      configPath = findLegacyConfigPath(baseDir, env);
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
  console.log(chalk.bold('Product version:'), lock.productVersion || 'Not installed');
  if (lock.topologyUpdate) {
    console.log(chalk.yellow('\nIncomplete topology update:'));
    console.log(`  Kind: ${lock.topologyUpdate.kind}`);
    console.log(`  Phase: ${lock.topologyUpdate.phase}`);
    console.log(`  Target version: ${lock.topologyUpdate.targetProductVersion}`);
    if (lock.topologyUpdate.subject) {
      console.log(`  Recorded subject: ${lock.topologyUpdate.subject}`);
    }
    console.log(`  Resume: ${topologyUpdateResumeInstruction(lock.topologyUpdate, lock.env)}`);
  }

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
