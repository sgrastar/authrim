/**
 * Update Command
 *
 * Updates workers for an existing environment without full init.
 * Compares local package versions with deployed versions and updates only changed workers.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  saveLockFile,
  type AuthrimLock,
} from '../../core/lock.js';
import {
  deployAll,
  deployUiWorkerComponent,
  deployUiWorkerBindingTargets,
  UI_WORKER_COMPONENTS,
  resolveMissingUiWorkerBindingTargets,
  resolveExistingWorkerComponents,
  buildApiPackages,
  loadDeploySecretsFromKeys,
  type DeployOptions,
  type DeployResult,
  type UiWorkerComponent,
} from '../../core/deploy.js';
import {
  isWranglerInstalled,
  checkAuth,
  getWorkersSubdomain,
  findMigrationsRoot,
  ensureSetupMachineAccessInD1,
  cleanupSetupMachineAccessInD1,
} from '../../core/cloudflare.js';
import { CORE_WORKER_COMPONENTS, type WorkerComponent } from '../../core/naming.js';
import {
  getLocalPackageVersions,
  getRootProductVersion,
  compareVersions,
  getComponentsToUpdate,
  getPackageVersion,
  type VersionComparison,
} from '../../core/version.js';
import {
  findAuthrimBaseDir,
  findKeysDirectory,
  getEnvironmentPaths,
  resolvePaths,
} from '../../core/paths.js';
import { saveMasterWranglerConfigs, syncWranglerConfigs } from '../../core/wrangler-sync.js';
import { buildResourceIdsFromLock } from '../../core/wrangler.js';
import { AuthrimConfigSchema } from '../../core/config.js';
import { ensureSupplementalKeyFiles } from '../../core/keys.js';
import {
  resolveAdminUiEntryUrl,
  resolveIssuerUrl,
  resolveLoginUiEntryUrl,
  resolveLoginUiExecutionOrigin,
} from '../../core/url-config.js';
import {
  calculateReleaseManifestChecksum,
  compareProductVersions,
  isProductVersion,
  loadTargetReleaseMigrationManifest,
  readReleaseMigrationManifest,
  resolveReleaseMigrationTargets,
} from '../../core/release-migrations.js';
import {
  applyReleaseSchemaUpdatePlan,
  buildReleaseSchemaUpdatePlan,
  type ReleaseSchemaUpdatePlan,
} from '../../core/release-update.js';
import {
  buildWorkerHttpReadinessTargets,
  waitForWorkerDeploymentsReady,
  waitForWorkerHttpReady,
  waitForRouterWorkerReady,
} from '../../core/worker-readiness.js';
import { resolveUiDeploymentSettings } from '../../core/ui-deployment.js';
import { mergeAndSaveUiEnv } from '../../core/ui-env.js';
import { ensureLoginUiClient } from '../../core/login-ui-client.js';
import { prepareAdminUiBffDeployment } from '../../core/admin-ui-bff-deployment.js';
import { withReleaseUpdateState, withSchemaTargetStates } from '../../core/release-state.js';
import {
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from '../../core/environment-operation-policy.js';

export { withReleaseUpdateState, withSchemaTargetStates } from '../../core/release-state.js';

// =============================================================================
// Types
// =============================================================================

export interface UpdateCommandOptions {
  env?: string;
  all?: boolean;
  dryRun?: boolean;
  skipBuild?: boolean;
  allowDraftManifest?: boolean;
  externalSchemaReady?: boolean;
  yes?: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Display version comparison table
 */
function displayVersionTable(comparisons: VersionComparison[]): void {
  console.log(chalk.bold('\nVersion Comparison:'));
  console.log('─'.repeat(70));
  console.log(
    chalk.gray(`${'Worker'.padEnd(18)} ${'Deployed'.padEnd(14)} ${'Local'.padEnd(14)} Status`)
  );
  console.log('─'.repeat(70));

  for (const c of comparisons) {
    let status: string;
    if (c.needsUpdate) {
      if (!c.deployedVersion) {
        status = chalk.red('● not deployed');
      } else {
        status = chalk.yellow('⬆ update');
      }
    } else {
      status = chalk.green('✓ current');
    }

    // Pad with actual string lengths (accounting for chalk)
    const deployedPadded = c.deployedVersion
      ? c.deployedVersion.padEnd(14)
      : chalk.gray('-').padStart(1) + ' '.repeat(13);
    const localPadded = c.localVersion
      ? c.localVersion.padEnd(14)
      : chalk.gray('-').padStart(1) + ' '.repeat(13);

    console.log(`  ${c.component.padEnd(16)} ${deployedPadded} ${localPadded} ${status}`);
  }

  console.log('─'.repeat(70));
}

/**
 * Update lock file with deployment results AND version info
 */
function updateLockWithDeploymentsAndVersions(
  lock: AuthrimLock,
  results: DeployResult[],
  localVersions: Partial<Record<WorkerComponent, string>>
): AuthrimLock {
  const workers = { ...lock.workers };

  for (const result of results) {
    if ((result.success || result.trafficCommitted) && result.deployedAt) {
      workers[result.component] = {
        name: result.workerName,
        deployedAt: result.deployedAt,
        version: localVersions[result.component] || result.version,
      };
    }
  }

  return {
    ...lock,
    workers,
    updatedAt: new Date().toISOString(),
  };
}

function displaySchemaUpdatePlan(plan: ReleaseSchemaUpdatePlan): void {
  console.log(chalk.bold('\nDatabase Schema Plan:'));
  console.log(`  Target release: ${chalk.cyan(plan.productVersion)}`);
  console.log(`  Automatic D1 targets: ${chalk.cyan(String(plan.automaticTargets.length))}`);
  const tenantTargets = plan.automaticTargets.filter((item) => item.target.scope === 'tenant');
  if (tenantTargets.length > 0) {
    const shardTargets = tenantTargets.filter((item) => item.target.shard !== undefined);
    console.log(
      `  Tenant D1 targets: ${chalk.cyan(String(tenantTargets.length))}` +
        (shardTargets.length > 0 ? ` (${shardTargets.length} shard target(s))` : '')
    );
  }
  for (const blocked of plan.blockedTargets) {
    console.log(
      chalk.yellow(
        `  External target requires operator migration: ${blocked.target.connectionRef ?? blocked.target.id}`
      )
    );
    if (blocked.changedFiles.length > 0) {
      console.log(chalk.gray(`    ${blocked.changedFiles.join(', ')}`));
    }
  }
}

export function assertProductUpgradeAllowed(
  currentVersion: string | undefined,
  targetVersion: string
): void {
  if (currentVersion && compareProductVersions(targetVersion, currentVersion) < 0) {
    throw new Error(`product_downgrade_not_supported:${currentVersion}:${targetVersion}`);
  }
}

export function resolveLegacyDeploymentVersion(
  deployedVersions: Record<string, { version?: string }>
): {
  inferredVersion?: string;
  upgradeFloor?: string;
  ambiguous: boolean;
  invalidVersions?: string[];
} {
  const recordedVersions = [
    ...new Set(
      Object.values(deployedVersions).flatMap((deployment) =>
        deployment.version ? [deployment.version] : []
      )
    ),
  ];
  const invalidVersions = recordedVersions.filter((version) => !isProductVersion(version)).sort();
  const versions = recordedVersions.filter(isProductVersion).sort(compareProductVersions);
  return {
    ...(versions.length === 1 ? { inferredVersion: versions[0] } : {}),
    ...(versions.length > 0 ? { upgradeFloor: versions.at(-1) } : {}),
    ambiguous: versions.length > 1,
    ...(invalidVersions.length > 0 ? { invalidVersions } : {}),
  };
}

export function isUpdateSourceLockUnchanged(
  sourceLock: AuthrimLock,
  currentLock: AuthrimLock | null | undefined
): boolean {
  return Boolean(currentLock) && JSON.stringify(currentLock) === JSON.stringify(sourceLock);
}

export function resolveSchemaExecutionState(input: {
  plan: ReleaseSchemaUpdatePlan;
  resumableRelease?: NonNullable<AuthrimLock['releaseUpdate']>;
  acknowledgeExternal: boolean;
}): {
  acknowledgedManualTargets: Set<string>;
  remainingBlockedTargets: ReleaseSchemaUpdatePlan['blockedTargets'];
  automaticTargets: ReleaseSchemaUpdatePlan['automaticTargets'];
} {
  const acknowledgedManualTargets = new Set(input.resumableRelease?.manualTargets ?? []);
  if (input.acknowledgeExternal) {
    for (const target of input.plan.blockedTargets) {
      if (
        target.target.streamId &&
        !target.blockedReason?.startsWith('release_migration_stream_')
      ) {
        acknowledgedManualTargets.add(target.target.id);
      }
    }
  }
  const remainingBlockedTargets = input.plan.blockedTargets.filter(
    (target) =>
      !target.target.streamId ||
      target.blockedReason?.startsWith('release_migration_stream_') ||
      !acknowledgedManualTargets.has(target.target.id)
  );
  const completedTargets = new Set(
    input.resumableRelease && input.resumableRelease.phase !== 'planned'
      ? input.resumableRelease.appliedTargets
      : []
  );
  return {
    acknowledgedManualTargets,
    remainingBlockedTargets,
    automaticTargets: input.plan.automaticTargets.filter(
      (target) => !completedTargets.has(target.target.id)
    ),
  };
}

export function getUiComponentsToUpdate(input: {
  config: ReturnType<typeof AuthrimConfigSchema.parse>;
  lock: AuthrimLock;
  localVersions: ReadonlyMap<UiWorkerComponent, string>;
  all: boolean;
}): UiWorkerComponent[] {
  return UI_WORKER_COMPONENTS.filter((component) => {
    const enabled =
      component === 'ar-login-ui'
        ? input.config.components.loginUi !== false
        : input.config.components.adminUi !== false;
    if (!enabled || !input.localVersions.has(component)) return false;
    return (
      input.all || input.lock.workers?.[component]?.version !== input.localVersions.get(component)
    );
  });
}

export function getWorkspaceVersionMismatches(input: {
  productVersion: string;
  apiVersions: Partial<Record<WorkerComponent, string>>;
  uiVersions: ReadonlyMap<UiWorkerComponent, string>;
}): string[] {
  return [
    ...CORE_WORKER_COMPONENTS.map(
      (component) => [component, input.apiVersions[component]] as const
    ),
    ...UI_WORKER_COMPONENTS.map(
      (component) => [component, input.uiVersions.get(component)] as const
    ),
  ]
    .filter(([, version]) => version !== input.productVersion)
    .map(([component, version]) => `${component}=${version ?? 'missing'}`);
}

async function deployReleaseUiWorkers(input: {
  env: string;
  baseDir: string;
  config: ReturnType<typeof AuthrimConfigSchema.parse>;
  lock: AuthrimLock;
  lockPath: string;
  components: UiWorkerComponent[];
  productVersion: string;
  skipBuild: boolean;
}): Promise<AuthrimLock> {
  if (input.components.length === 0) return input.lock;
  const keysDirectory = findKeysDirectory({
    env: input.env,
    sourceDir: input.baseDir,
    keysBaseDir: process.cwd(),
  });
  if (!keysDirectory) {
    throw new Error('UI Worker release update requires the environment keys directory.');
  }
  await ensureSupplementalKeyFiles(keysDirectory.path);
  const apiBaseUrl = resolveIssuerUrl(input.config, { env: input.env });
  const readiness = await waitForRouterWorkerReady({ apiBaseUrl });
  if (!readiness.ready) {
    throw new Error(
      `API router is not ready for UI deployment: ${readiness.error ?? readiness.checkedUrl}`
    );
  }

  let workingLock = input.lock;
  for (const component of input.components) {
    let loginUiClientId: string | undefined;
    if (component === 'ar-login-ui') {
      const setupMachine = await ensureSetupMachineAccessInD1(
        input.env,
        input.config,
        keysDirectory.path
      );
      if (!setupMachine.success) {
        throw new Error(`Setup machine access failed: ${setupMachine.error ?? 'unknown error'}`);
      }
      let loginUiClientError: Error | undefined;
      try {
        const client = await ensureLoginUiClient({
          apiBaseUrl,
          loginUiUrl: resolveLoginUiExecutionOrigin(input.config, { env: input.env }),
          keysDir: keysDirectory.path,
          tenantId: input.config.tenant.name,
        });
        if (!client.success || !client.clientId) {
          throw new Error(`Login UI client update failed: ${client.error ?? 'unknown error'}`);
        }
        loginUiClientId = client.clientId;
      } catch (error) {
        loginUiClientError = error instanceof Error ? error : new Error(String(error));
      }
      const cleanup = await cleanupSetupMachineAccessInD1(input.env, keysDirectory.path);
      if (!cleanup.success) {
        const cleanupError = new Error(
          `Setup machine access cleanup failed: ${cleanup.error ?? 'unknown error'}`
        );
        if (loginUiClientError) {
          throw new AggregateError(
            [loginUiClientError, cleanupError],
            'Login UI client update and setup machine access cleanup both failed.'
          );
        }
        throw cleanupError;
      }
      if (loginUiClientError) {
        throw loginUiClientError;
      }
    }

    const settings = resolveUiDeploymentSettings({
      component,
      config: input.config,
      apiBaseUrl,
      loginUiClientId,
    });
    if (component === 'ar-login-ui' && loginUiClientId) {
      await mergeAndSaveUiEnv(
        getEnvironmentPaths({ baseDir: input.baseDir, env: input.env }).uiEnv,
        settings.uiEnv
      );
    }
    const adminUiBffSecrets =
      component === 'ar-admin-ui'
        ? await prepareAdminUiBffDeployment({
            env: input.env,
            config: input.config,
            keysDir: keysDirectory.path,
          })
        : undefined;
    const result = await deployUiWorkerComponent(component, {
      env: input.env,
      rootDir: input.baseDir,
      apiBaseUrl: settings.apiBaseUrl,
      runtimeApiBackendUrl: settings.runtimeApiBackendUrl,
      uiEnvConfig: settings.uiEnv,
      serviceBindingName: settings.serviceBindingName,
      workersDev: settings.workersDev,
      routes: settings.routes,
      adminUiBffSecrets,
      skipBuild: input.skipBuild,
    });
    if (!result.success || !result.deployedAt) {
      throw new Error(`${component} release deployment failed: ${result.error ?? 'unknown error'}`);
    }
    const visibility = await waitForWorkerDeploymentsReady({
      targets: [{ workerName: result.projectName, deployedAt: result.deployedAt }],
    });
    if (!visibility.ready) {
      throw new Error(
        `${component} release deployment did not become visible: ${visibility.error ?? 'unknown verification error'}`
      );
    }
    const workersSubdomain = await getWorkersSubdomain();
    const entryUrl =
      component === 'ar-login-ui'
        ? resolveLoginUiEntryUrl(input.config, { env: input.env, workersSubdomain })
        : resolveAdminUiEntryUrl(input.config, { env: input.env, workersSubdomain });
    const httpReadiness = await waitForWorkerHttpReady({
      targets: [{ workerName: result.projectName, url: entryUrl }],
    });
    if (!httpReadiness.ready) {
      throw new Error(
        `${component} release deployment is not reachable: ${httpReadiness.error ?? entryUrl}`
      );
    }
    workingLock = {
      ...workingLock,
      workers: {
        ...workingLock.workers,
        [component]: {
          name: result.projectName,
          deployedAt: result.deployedAt,
          version: input.productVersion,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await saveLockFile(workingLock, input.lockPath);
  }
  return workingLock;
}

// =============================================================================
// Update Command
// =============================================================================

export async function updateCommand(options: UpdateCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🔄 Authrim Worker Update\n'));

  const baseDir = findAuthrimBaseDir(process.cwd());
  const env = options.env;

  // Validate required options
  if (!env) {
    console.error(chalk.red('Error: --env is required'));
    console.log(chalk.yellow('\nUsage:'));
    console.log('  authrim-setup update --env <name>');
    console.log('  authrim-setup update --env prod --all      # Update all workers');
    console.log('  authrim-setup update --env prod --dry-run  # Preview changes');
    process.exit(1);
  }

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

  // Load lock file
  spinner.start('Loading environment...');

  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);

  if (!lock) {
    spinner.fail('Lock file not found');
    console.log(chalk.yellow(`\nEnvironment "${env}" not found.`));
    console.log(chalk.yellow('Run "authrim-setup init" first to create the environment.'));
    process.exit(1);
  }

  spinner.succeed(`Environment loaded: ${env}`);
  console.log(chalk.gray(`  Lock file: ${lockPath}`));
  let workingLock = lock;
  const resolvedEnvironment = resolvePaths({ baseDir, env });
  if (resolvedEnvironment.type === 'legacy') {
    console.error(
      chalk.red('This environment still uses the legacy local file layout and cannot be updated.')
    );
    console.log(
      chalk.yellow(`Run authrim-setup migrate --env ${env}, then rerun authrim-setup update.`)
    );
    process.exit(1);
  }
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(envPaths.config)) {
    console.error(chalk.red(`Configuration file not found: ${envPaths.config}`));
    process.exit(1);
  }
  const config = AuthrimConfigSchema.parse(JSON.parse(await readFile(envPaths.config, 'utf-8')));

  // Get version comparison
  spinner.start('Comparing versions...');

  const localVersions = await getLocalPackageVersions(baseDir);
  const productVersion = await getRootProductVersion(baseDir);
  const operationDecision = evaluateEnvironmentOperation({
    operation: 'release_update',
    lock,
    targetVersion: productVersion,
  });
  if (!operationDecision.allowed) {
    spinner.fail('The environment cannot enter a release update');
    console.error(chalk.red(environmentOperationBlockMessage(operationDecision, productVersion)));
    process.exit(1);
  }
  const localUiVersions = new Map<UiWorkerComponent, string>();
  for (const component of UI_WORKER_COMPONENTS) {
    const version = await getPackageVersion(join(baseDir, 'packages', component));
    if (version) localUiVersions.set(component, version);
  }
  const mismatchedPackages = getWorkspaceVersionMismatches({
    productVersion,
    apiVersions: localVersions,
    uiVersions: localUiVersions,
  });
  if (mismatchedPackages.length > 0) {
    spinner.fail('Package versions do not match the Authrim product version');
    console.error(
      chalk.red(`Expected ${productVersion}; mismatched: ${mismatchedPackages.join(', ')}`)
    );
    process.exit(1);
  }

  // Build deployed versions from lock file
  const deployedVersions: Record<string, { version?: string; deployedAt?: string }> = {};
  if (lock.workers) {
    for (const [component, info] of Object.entries(lock.workers)) {
      deployedVersions[component] = {
        version: info.version,
        deployedAt: info.deployedAt,
      };
    }
  }
  const legacyDeploymentVersion = resolveLegacyDeploymentVersion(deployedVersions);
  if (legacyDeploymentVersion.invalidVersions?.length) {
    spinner.fail('Deployed Worker versions contain invalid product versions');
    console.error(chalk.red(legacyDeploymentVersion.invalidVersions.join(', ')));
    process.exit(1);
  }
  if (!workingLock.productVersion) {
    if (legacyDeploymentVersion.inferredVersion) {
      workingLock = { ...workingLock, productVersion: legacyDeploymentVersion.inferredVersion };
    } else if (legacyDeploymentVersion.ambiguous) {
      console.log(
        chalk.yellow(
          '  Legacy Worker versions are mixed; database schemas will be reconciled from cumulative migration history.'
        )
      );
    }
  }

  const comparisons = compareVersions(localVersions, deployedVersions);

  spinner.succeed('Version comparison complete');

  // Display version table
  displayVersionTable(comparisons);

  // Get components to update
  const componentsToUpdate = getComponentsToUpdate(comparisons, options.all || false);
  const uiComponentsToUpdate = getUiComponentsToUpdate({
    config,
    lock: workingLock,
    localVersions: localUiVersions,
    all: options.all === true,
  });
  let updateCount = componentsToUpdate.length + uiComponentsToUpdate.length;
  console.log(
    chalk.cyan(
      `\n${updateCount} worker(s) ${options.all ? 'to deploy' : 'need updating'} ` +
        `(${componentsToUpdate.length} API, ${uiComponentsToUpdate.length} UI)`
    )
  );

  spinner.start('Resolving release migration manifest...');
  const migrationSearch = await findMigrationsRoot(baseDir);
  if (!migrationSearch.path) {
    spinner.fail('Migration directory not found');
    console.error(chalk.red(migrationSearch.searchPaths.join(', ')));
    process.exit(1);
  }
  const migrationsRoot = migrationSearch.path;
  let targetManifestResult: ReturnType<typeof loadTargetReleaseMigrationManifest>;
  try {
    targetManifestResult = loadTargetReleaseMigrationManifest({
      migrationsRoot,
      productVersion,
      allowDraft: options.allowDraftManifest === true,
    });
  } catch (error) {
    spinner.fail('Release migration manifest could not be loaded');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
  if (targetManifestResult.draft) {
    console.log(chalk.yellow('  Using a development draft migration manifest.'));
  }
  try {
    assertProductUpgradeAllowed(
      workingLock.productVersion ?? legacyDeploymentVersion.upgradeFloor,
      productVersion
    );
  } catch {
    spinner.fail('Authrim product downgrades are not supported');
    console.error(
      chalk.red(
        `Current ${workingLock.productVersion ?? legacyDeploymentVersion.upgradeFloor ?? 'unknown'}; requested ${productVersion}`
      )
    );
    process.exit(1);
  }
  const manifestChecksum = calculateReleaseManifestChecksum(targetManifestResult.manifest);
  const minimumProductVersion = targetManifestResult.manifest.minimumProductVersion;
  if (
    minimumProductVersion &&
    (!workingLock.productVersion ||
      compareProductVersions(workingLock.productVersion, minimumProductVersion) < 0)
  ) {
    spinner.fail('The deployed Authrim release is below this manifest upgrade boundary');
    console.error(
      chalk.red(
        `Current ${workingLock.productVersion ?? 'unknown'}; minimum supported ${minimumProductVersion}`
      )
    );
    process.exit(1);
  }
  let currentManifest: ReturnType<typeof readReleaseMigrationManifest> | undefined;
  if (workingLock.productVersion) {
    const currentManifestPath = join(
      migrationsRoot,
      'releases',
      `${workingLock.productVersion}.json`
    );
    if (existsSync(currentManifestPath)) {
      currentManifest = readReleaseMigrationManifest(currentManifestPath);
    }
  }
  const physicalTargets = resolveReleaseMigrationTargets({ lock: workingLock, config });
  const targetManifestCache = new Map<string, ReturnType<typeof readReleaseMigrationManifest>>();
  const currentManifestForTarget = (
    target: (typeof physicalTargets)[number]
  ): ReturnType<typeof readReleaseMigrationManifest> | undefined => {
    const state = workingLock.schemaTargets?.[target.id];
    if (!state) return undefined;
    if (state.streamId === target.streamId && state.files) {
      const targetStream = targetManifestResult.manifest.streams.find(
        (stream) => stream.id === target.streamId
      );
      if (!targetStream) return undefined;
      return {
        formatVersion: 1,
        productVersion: state.productVersion,
        streams: [
          {
            id: targetStream.id,
            dialect: targetStream.dialect,
            logicalRoles: targetStream.logicalRoles,
            files: state.files,
          },
        ],
      };
    }
    if (state.productVersion === productVersion) {
      return state.manifestChecksum === manifestChecksum
        ? targetManifestResult.manifest
        : undefined;
    }
    const cached = targetManifestCache.get(state.productVersion);
    if (cached) return cached;
    const path = join(migrationsRoot, 'releases', `${state.productVersion}.json`);
    if (!existsSync(path)) return undefined;
    const manifest = readReleaseMigrationManifest(path);
    if (manifest.productVersion !== state.productVersion) return undefined;
    if (calculateReleaseManifestChecksum(manifest) !== state.manifestChecksum) return undefined;
    targetManifestCache.set(state.productVersion, manifest);
    return manifest;
  };
  const schemaPlan = buildReleaseSchemaUpdatePlan({
    targetManifest: targetManifestResult.manifest,
    currentManifest,
    currentManifestForTarget,
    targets: physicalTargets,
  });
  spinner.succeed('Release migration plan resolved');
  displaySchemaUpdatePlan(schemaPlan);
  if (
    schemaPlan.targets.some((target) => target.requiresAction) &&
    !componentsToUpdate.includes('ar-management')
  ) {
    componentsToUpdate.push('ar-management');
    updateCount += 1;
    console.log(
      chalk.gray('  ar-management will be redeployed to publish refreshed schema registrations.')
    );
  }

  const resumableRelease =
    workingLock.releaseUpdate?.targetVersion === productVersion &&
    workingLock.releaseUpdate.manifestChecksum === manifestChecksum
      ? workingLock.releaseUpdate
      : undefined;
  const schemaExecutionState = resolveSchemaExecutionState({
    plan: schemaPlan,
    resumableRelease,
    acknowledgeExternal: options.externalSchemaReady === true,
  });
  const { acknowledgedManualTargets, remainingBlockedTargets } = schemaExecutionState;
  if (remainingBlockedTargets.length > 0 && !options.dryRun) {
    const hardBlocked = remainingBlockedTargets.filter((target) => !target.target.streamId);
    console.error(
      chalk.red(
        hardBlocked.length > 0
          ? `\nNo release migration stream exists for: ${hardBlocked.map((target) => target.target.id).join(', ')}`
          : '\nExternal database migrations are required. Apply the listed release stream with operator-managed database tooling, then rerun with --external-schema-ready.'
      )
    );
    process.exit(1);
  }

  // Confirm update
  if (!options.yes) {
    const confirmed = await confirm({
      message: options.dryRun
        ? 'Show the complete release update plan?'
        : `Update schema targets and ${updateCount} worker(s) to ${productVersion}?`,
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nUpdate cancelled.'));
      return;
    }
  }

  // Dry run mode
  if (options.dryRun) {
    console.log(chalk.bold('\n[DRY RUN] Would update:'));
    for (const component of componentsToUpdate) {
      const c = comparisons.find((x) => x.component === component);
      if (c) {
        const from = c.deployedVersion || 'new';
        console.log(`  • ${component}: ${from} → ${c.localVersion}`);
      }
    }
    for (const component of uiComponentsToUpdate) {
      console.log(
        `  • ${component}: ${workingLock.workers?.[component]?.version ?? 'new'} → ${productVersion}`
      );
    }
    for (const target of schemaPlan.automaticTargets) {
      console.log(
        `  • schema ${target.target.binding ?? target.target.id}: ${target.target.streamId}`
      );
    }
    console.log(chalk.gray('\nNo changes made.'));
    return;
  }

  const operationLock = await acquireEnvironmentOperationLock(lockPath, 'update');
  try {
    const lockedEnvironment = await loadLockFileAuto(baseDir, env);
    if (!isUpdateSourceLockUnchanged(lock, lockedEnvironment.lock)) {
      throw new Error('environment_changed_while_waiting_for_update_lock');
    }
    const lockedConfig = AuthrimConfigSchema.parse(
      JSON.parse(await readFile(envPaths.config, 'utf-8'))
    );
    if (JSON.stringify(lockedConfig) !== JSON.stringify(config)) {
      throw new Error('config_changed_while_waiting_for_update_lock');
    }
    const lockedTargetManifest = loadTargetReleaseMigrationManifest({
      migrationsRoot,
      productVersion,
      allowDraft: options.allowDraftManifest === true,
    });
    if (
      lockedTargetManifest.draft !== targetManifestResult.draft ||
      calculateReleaseManifestChecksum(lockedTargetManifest.manifest) !== manifestChecksum
    ) {
      throw new Error('release_manifest_changed_while_waiting_for_update_lock');
    }

    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: productVersion,
      phase: 'planned',
      manifestChecksum,
      manualTargets: [...acknowledgedManualTargets],
    });
    await saveLockFile(workingLock, lockPath);

    const acknowledgedBlockedTargets = schemaPlan.blockedTargets.filter((target) =>
      acknowledgedManualTargets.has(target.target.id)
    );
    const executableSchemaPlan: ReleaseSchemaUpdatePlan = {
      ...schemaPlan,
      automaticTargets: schemaExecutionState.automaticTargets,
      manualTargets: [...schemaPlan.manualTargets, ...acknowledgedBlockedTargets],
      blockedTargets: remainingBlockedTargets,
    };
    const migrationSpinner = ora('Updating database schemas...').start();
    const migrationResult = await applyReleaseSchemaUpdatePlan({
      plan: executableSchemaPlan,
      manifest: targetManifestResult.manifest,
      migrationsRoot,
      concurrency: 2,
      backfillLegacyChecksums: !targetManifestResult.draft,
      onProgress: (message) => {
        migrationSpinner.text = message;
      },
    });
    if (!migrationResult.success) {
      migrationSpinner.fail('Database schema update failed');
      for (const result of migrationResult.results.filter((item) => !item.success)) {
        console.error(chalk.red(`  ${result.targetId}: ${result.error ?? 'unknown error'}`));
      }
      process.exit(1);
    }
    migrationSpinner.succeed('Database schemas are ready');
    const appliedTargetIds = [
      ...new Set([
        ...(resumableRelease?.appliedTargets ?? []),
        ...migrationResult.results.map((result) => result.targetId),
        ...acknowledgedManualTargets,
        ...schemaPlan.targets
          .filter((target) => !target.requiresAction)
          .map((target) => target.target.id),
      ]),
    ];
    const operatorTargetIds = new Set([
      ...acknowledgedManualTargets,
      ...schemaPlan.targets
        .filter((target) => !target.requiresAction && !target.target.automatic)
        .map((target) => target.target.id),
    ]);
    workingLock = withSchemaTargetStates(workingLock, {
      targetIds: appliedTargetIds,
      manualTargetIds: operatorTargetIds,
      productVersion,
      manifestChecksum,
      targetStreamIds: new Map(physicalTargets.map((target) => [target.id, target.streamId])),
      manifest: targetManifestResult.manifest,
    });
    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: productVersion,
      phase: 'schema_applied',
      manifestChecksum,
      appliedTargets: appliedTargetIds,
      manualTargets: [...acknowledgedManualTargets],
    });
    await saveLockFile(workingLock, lockPath);

    if (componentsToUpdate.length === 0) {
      const lockedWorkers = Object.values(workingLock.workers ?? {}).filter(
        (worker) => worker.version === productVersion
      );
      const verificationSpinner = ora('Verifying existing Worker deployments...').start();
      const deploymentVerification = await waitForWorkerDeploymentsReady({
        targets: lockedWorkers.map((worker) => ({
          workerName: worker.name,
          deployedAt: worker.deployedAt,
        })),
        onProgress: (message) => {
          verificationSpinner.text = message;
        },
      });
      if (!deploymentVerification.ready) {
        verificationSpinner.fail('Existing Worker deployment verification failed');
        console.error(chalk.red(deploymentVerification.error ?? 'unknown verification error'));
        process.exit(1);
      }
      const workersSubdomain = await getWorkersSubdomain();
      const httpTargets = buildWorkerHttpReadinessTargets(
        lockedWorkers.map((worker) => ({ workerName: worker.name })),
        workersSubdomain,
        { workersDevEnabled: !config.urls?.api?.custom }
      );
      if (httpTargets.length > 0) {
        const httpResult = await waitForWorkerHttpReady({ targets: httpTargets });
        if (!httpResult.ready) {
          verificationSpinner.fail('Existing Worker HTTP health checks failed');
          console.error(chalk.red(httpResult.error ?? 'unknown health-check error'));
          process.exit(1);
        }
      }
      verificationSpinner.succeed('Existing Worker deployments are healthy');
      try {
        workingLock = await deployReleaseUiWorkers({
          env,
          baseDir,
          config,
          lock: workingLock,
          lockPath,
          components: uiComponentsToUpdate,
          productVersion,
          skipBuild: options.skipBuild === true,
        });
      } catch (error) {
        verificationSpinner.fail('UI Worker release deployment failed');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: productVersion,
        phase: 'verified',
        manifestChecksum,
      });
      await saveLockFile(workingLock, lockPath);
      console.log(
        chalk.green('\n✅ Database schemas and all enabled Workers are at the target release.')
      );
      return;
    }

    // Regenerate from the schema-applied lock before copying to deploy locations.
    const wranglerSpinner = ora('Refreshing wrangler configs...').start();
    const masterResult = await saveMasterWranglerConfigs(
      config,
      buildResourceIdsFromLock(workingLock, config),
      {
        baseDir,
        env,
        onProgress: (msg) => {
          wranglerSpinner.text = msg;
        },
      }
    );
    if (!masterResult.success) {
      wranglerSpinner.fail('Wrangler config generation failed');
      console.error(chalk.red(`\nErrors: ${masterResult.errors.join(', ')}`));
      process.exit(1);
    }
    const syncResult = await syncWranglerConfigs({
      baseDir,
      env,
      packagesDir: join(baseDir, 'packages'),
      force: true,
      dryRun: false,
      onProgress: (msg) => {
        wranglerSpinner.text = msg;
      },
    });
    if (!syncResult.success && syncResult.errors.length > 0) {
      wranglerSpinner.fail('Wrangler config sync failed');
      console.error(chalk.red(`\nErrors: ${syncResult.errors.join(', ')}`));
      process.exit(1);
    }
    wranglerSpinner.succeed(`Refreshed ${syncResult.synced.length} wrangler config(s)`);

    // Build packages (unless skipped)
    if (!options.skipBuild) {
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

    // Deploy workers
    console.log(chalk.bold('\n🚀 Deploying workers...\n'));

    const keysDirectory = findKeysDirectory({
      env,
      sourceDir: baseDir,
      keysBaseDir: process.cwd(),
    });
    if (keysDirectory) {
      await ensureSupplementalKeyFiles(keysDirectory.path);
    }
    const deploymentSecrets = keysDirectory
      ? await loadDeploySecretsFromKeys(keysDirectory.path, componentsToUpdate)
      : {};

    const deployOptions: DeployOptions = {
      env,
      rootDir: resolve(baseDir),
      maxRetries: 3,
      retryDelayMs: 1000,
      concurrency: 2,
      deploymentStrategy: 'auto',
      existingComponents: CORE_WORKER_COMPONENTS.filter(
        (component) => workingLock.workers?.[component] !== undefined
      ),
      secrets: deploymentSecrets,
      cleanupLegacyStaticSecrets: true,
      onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
      onError: (component, error) => {
        console.error(chalk.red(`  ❌ Error in ${component}: ${error.message}`));
      },
    };
    if (!options.dryRun) {
      deployOptions.existingComponents = await resolveExistingWorkerComponents(
        deployOptions,
        CORE_WORKER_COMPONENTS
      );
    }

    if (componentsToUpdate.includes('ar-router') && existsSync(envPaths.config)) {
      const config = AuthrimConfigSchema.parse(
        JSON.parse(await readFile(envPaths.config, 'utf-8'))
      );
      const missingUiBindingTargets = await resolveMissingUiWorkerBindingTargets(deployOptions, {
        loginUi: config.components.loginUi ?? true,
        adminUi: config.components.adminUi ?? true,
      });
      if (missingUiBindingTargets.loginUi || missingUiBindingTargets.adminUi) {
        const placeholderSummary = await deployUiWorkerBindingTargets(
          {
            ...deployOptions,
            apiBaseUrl: resolveIssuerUrl(config, { env }),
          },
          missingUiBindingTargets
        );
        if (placeholderSummary.failedCount > 0) {
          console.error(chalk.red('UI Worker binding-target deployment failed'));
          process.exit(1);
        }
      }
    }

    const summary = await deployAll(deployOptions, componentsToUpdate);

    // Update lock file with new versions
    if (summary.results.some((result) => result.success || result.trafficCommitted)) {
      workingLock = updateLockWithDeploymentsAndVersions(
        workingLock,
        summary.results,
        localVersions
      );
      await saveLockFile(workingLock, lockPath);
      console.log(chalk.gray(`\n  Lock file updated: ${lockPath}`));
    }

    if (!options.dryRun && summary.failedCount === 0) {
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: productVersion,
        phase: 'workers_deployed',
        manifestChecksum,
      });
      await saveLockFile(workingLock, lockPath);
      const verificationSpinner = ora('Verifying Worker deployments...').start();
      const verificationResult = await waitForWorkerDeploymentsReady({
        targets: summary.results
          .filter((result) => result.success)
          .map((result) => ({
            workerName: result.workerName,
            deployedAt: result.deployedAt,
          })),
        onProgress: (msg) => {
          verificationSpinner.text = msg;
        },
      });
      if (verificationResult.ready) {
        verificationSpinner.succeed('Worker deployments are visible');
      } else {
        verificationSpinner.fail('Worker deployments did not become visible');
        console.error(chalk.red(`  ${verificationResult.error || 'unknown verification error'}`));
        process.exit(1);
      }

      const workersSubdomain = await getWorkersSubdomain();
      let workersDevEnabled = true;
      try {
        const configContent = await readFile(envPaths.config, 'utf-8');
        const config = AuthrimConfigSchema.parse(JSON.parse(configContent));
        workersDevEnabled = !config.urls?.api?.custom;
      } catch {
        workersDevEnabled = true;
      }
      const workerHttpTargets = buildWorkerHttpReadinessTargets(
        summary.results.filter((result) => result.success),
        workersSubdomain,
        { workersDevEnabled }
      );
      if (workerHttpTargets.length > 0) {
        const httpSpinner = ora('Verifying Worker HTTP health...').start();
        const httpResult = await waitForWorkerHttpReady({
          targets: workerHttpTargets,
          onProgress: (msg) => {
            httpSpinner.text = msg;
          },
        });
        if (httpResult.ready) {
          httpSpinner.succeed('Worker HTTP health checks passed');
        } else {
          httpSpinner.fail('Worker HTTP health checks failed');
          console.error(chalk.red(`  ${httpResult.error || 'unknown health check error'}`));
          process.exit(1);
        }
      }
      try {
        workingLock = await deployReleaseUiWorkers({
          env,
          baseDir,
          config,
          lock: workingLock,
          lockPath,
          components: uiComponentsToUpdate,
          productVersion,
          skipBuild: options.skipBuild === true,
        });
      } catch (error) {
        verificationSpinner.fail('UI Worker release deployment failed');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: productVersion,
        phase: 'verified',
        manifestChecksum,
      });
      await saveLockFile(workingLock, lockPath);
    }

    // Display summary
    console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('  Update Summary'));
    console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    if (summary.failedCount === 0) {
      console.log(chalk.green(`  ✅ ${summary.successCount} worker(s) updated successfully!`));
    } else {
      console.log(
        chalk.yellow(
          `  ⚠️  ${summary.successCount}/${summary.totalComponents} updated, ${summary.failedCount} failed`
        )
      );

      console.log(chalk.bold('\n  Failed:'));
      for (const result of summary.results.filter((r) => !r.success)) {
        console.log(chalk.red(`    • ${result.component}: ${result.error}`));
      }
    }

    console.log('');
  } finally {
    await operationLock.release();
  }
}
