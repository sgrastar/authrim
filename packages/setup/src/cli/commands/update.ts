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
  acquireDeployConfigLock,
  acquireEnvironmentOperationLock,
  clearProvisionalWorkerScriptOwnership,
  loadLockFileAuto,
  reconcileD1ResourcesInLock,
  reconcileQueueResourcesInLock,
  reconcileSharedKVResourcesInLock,
  saveLockFile,
  type AuthrimLock,
  type DeployConfigLockProof,
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
  type DeploymentSummary,
  type UiWorkerComponent,
} from '../../core/deploy.js';
import {
  isWranglerInstalled,
  checkAuth,
  getWorkersSubdomain,
  findMigrationsRoot,
  ensureInitialTenantInD1,
  getRequiredQueues,
  getRequiredR2Buckets,
  listD1Databases,
  listKVNamespaces,
  listQueues,
  listR2Buckets,
  assertR2BucketOwnershipIdentity,
  assertR2BucketOwnershipForUse,
} from '../../core/cloudflare.js';
import { runEphemeralSetupMachineAccess } from '../../core/setup-machine-access-lifecycle.js';
import { CORE_WORKER_COMPONENTS, getWorkerName, type WorkerComponent } from '../../core/naming.js';
import {
  prepareManagedWorkerScriptOwnership,
  type WorkerScriptOwnershipGuard,
} from '../../core/worker-script-ownership.js';
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
import { buildWorkerDeploymentResourceIds } from '../../core/deployment-resource-ids.js';
import {
  compileControlWorkerInventoryFromArtifacts,
  registerControlWorkerInventory,
  registerUiWorkerInventoryFromArtifacts,
} from '../../core/control-worker-inventory.js';
import { refreshLockFromControlGeneratedState } from '../../core/control-generated-state.js';
import {
  discoverExternalCapabilities,
  registerExternalCapabilities,
} from '../../core/external-capability-registration.js';
import { publishDynamicPluginWorkerBundles } from '../../core/dynamic-plugin-publication.js';
import {
  publishAndActivateMigrationRelease,
  type MigrationReleaseArtifactPlan,
} from '../../core/migration-release-publication.js';
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
  assertDatabaseOnlyWorkerCompatibility,
  assertReleaseDatabaseCompatibility,
  buildReleaseMigrationArtifactManifest,
  compareProductVersions,
  isProductVersion,
  listReleaseMigrationManifests,
  loadTargetReleaseMigrationManifest,
  readReleaseMigrationManifest,
  resolveReleaseMigrationExecutionManifest,
  resolveReleaseMigrationTargets,
  type ReleaseMigrationManifest,
} from '../../core/release-migrations.js';
import {
  applyReleaseSchemaUpdatePlan,
  buildReleaseSchemaUpdatePlan,
  getControlManagedReleaseStreamIds,
  type ReleaseSchemaUpdatePlan,
} from '../../core/release-update.js';
import {
  beginReleaseRolloutVerification,
  completeReleaseRolloutHandoff,
  createReleaseRolloutHandoff,
  getActiveReleaseRolloutHandoffStatus,
  getReleaseRolloutHandoffStatus,
  type ReleaseRolloutHandoffStatus,
  waitForReleaseRolloutAwaitingSetup,
} from '../../core/release-rollout-handoff.js';
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
import {
  withRecoveredReleaseUpdateState,
  withReleaseUpdateState,
  withSchemaTargetStates,
} from '../../core/release-state.js';
import {
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from '../../core/environment-operation-policy.js';
import { publishInitialControlPlaneRuntimeSnapshot } from '../../core/control-plane-bootstrap.js';

export {
  withRecoveredReleaseUpdateState,
  withReleaseUpdateState,
  withSchemaTargetStates,
} from '../../core/release-state.js';

export async function recoverActiveControlReleaseRollout(input: {
  lock: AuthrimLock;
  environmentId: string;
  targetVersion: string;
  manifestChecksum: string;
  loadActiveRollout?: (input: {
    controlDatabaseId: string;
    environmentId: string;
  }) => Promise<ReleaseRolloutHandoffStatus | null>;
}): Promise<{ lock: AuthrimLock; activeRollout: ReleaseRolloutHandoffStatus | null }> {
  const controlDatabase = input.lock.d1.CONTROL_DB;
  if (!controlDatabase) return { lock: input.lock, activeRollout: null };
  const activeRollout = await (input.loadActiveRollout ?? getActiveReleaseRolloutHandoffStatus)({
    controlDatabaseId: controlDatabase.id,
    environmentId: input.environmentId,
  });
  if (!activeRollout) return { lock: input.lock, activeRollout: null };
  return {
    lock: withRecoveredReleaseUpdateState(input.lock, {
      targetVersion: input.targetVersion,
      manifestChecksum: input.manifestChecksum,
      activeRollout,
    }),
    activeRollout,
  };
}

// =============================================================================
// Types
// =============================================================================

export interface UpdateCommandOptions {
  env?: string;
  all?: boolean;
  dryRun?: boolean;
  skipBuild?: boolean;
  allowDraftManifest?: boolean;
  databaseOnly?: boolean;
  externalSchemaReady?: boolean;
  yes?: boolean;
}

const CONTROL_COORDINATOR_SETTLE_MS = 65_000;
const RELEASE_ROLLOUT_OBSERVATION_MS = 30_000;

// =============================================================================
// Helpers
// =============================================================================

export function splitReleaseDeploymentForControlCoordinator(
  components: readonly WorkerComponent[]
): { coordinator: WorkerComponent[]; remaining: WorkerComponent[] } {
  if (!components.includes('ar-control')) {
    return { coordinator: [], remaining: [...components] };
  }
  return {
    coordinator: ['ar-control'],
    remaining: components.filter((component) => component !== 'ar-control'),
  };
}

export function includeRequiredReleaseControlCoordinator(
  components: readonly WorkerComponent[],
  controlManagedStreamIds: readonly string[],
  databaseOnly: boolean
): WorkerComponent[] {
  if (databaseOnly || controlManagedStreamIds.length === 0 || components.includes('ar-control')) {
    return [...components];
  }
  return [...components, 'ar-control'];
}

export function includeRequiredReleaseManagement(
  components: readonly WorkerComponent[],
  hasReleaseSchemaDelta: boolean,
  databaseOnly: boolean
): WorkerComponent[] {
  if (databaseOnly || !hasReleaseSchemaDelta || components.includes('ar-management')) {
    return [...components];
  }
  return [...components, 'ar-management'];
}

export function splitReleaseSchemaTargetsForControlHandoff(
  targets: ReleaseSchemaUpdatePlan['automaticTargets']
): {
  controlSchemaTargets: ReleaseSchemaUpdatePlan['automaticTargets'];
  remainingSetupTargets: ReleaseSchemaUpdatePlan['automaticTargets'];
} {
  const setupOwnedTargets = targets.filter((target) => target.target.scope !== 'tenant');
  return {
    controlSchemaTargets: setupOwnedTargets.filter(
      (target) => target.target.streamId === 'd1-control'
    ),
    remainingSetupTargets: setupOwnedTargets.filter(
      (target) => target.target.streamId !== 'd1-control'
    ),
  };
}

async function awaitControlManagedReleaseRollout(input: {
  controlDatabaseId: string;
  environmentId: string;
  sourceVersion?: string;
  productVersion: string;
  manifestChecksum: string;
  manifest: ReleaseMigrationManifest;
  artifact: MigrationReleaseArtifactPlan;
  managedStreamIds: readonly string[];
  lock: AuthrimLock;
  lockPath: string;
}): Promise<{ lock: AuthrimLock; ready: boolean }> {
  const spinner = ora('Handing managed database migrations to Control...').start();
  try {
    const created = await createReleaseRolloutHandoff({
      controlDatabaseId: input.controlDatabaseId,
      environmentId: input.environmentId,
      sourceVersion: input.sourceVersion,
      targetVersion: input.productVersion,
      artifact: input.artifact,
      manifest: input.manifest,
      managedStreamIds: input.managedStreamIds,
      actorId: 'setup:update',
    });
    let workingLock = withReleaseUpdateState(input.lock, {
      targetVersion: input.productVersion,
      phase: 'control_handoff',
      manifestChecksum: input.manifestChecksum,
      controlOperationId: created.operationId,
      controlManifestDigest: input.artifact.manifestDigest,
      controlCompletedTargets: created.completedTargets,
      controlTotalTargets: created.totalTargets,
    });
    await saveLockFile(workingLock, input.lockPath);
    const ready = await waitForReleaseRolloutAwaitingSetup({
      controlDatabaseId: input.controlDatabaseId,
      environmentId: input.environmentId,
      operationId: created.operationId,
      timeoutMs: RELEASE_ROLLOUT_OBSERVATION_MS,
      onProgress: (status) => {
        spinner.text = `Control database rollout: ${status.completedTargets}/${status.totalTargets} (${status.phase})`;
      },
    });
    if (
      ready.phase !== 'awaiting_setup' &&
      ready.phase !== 'verifying' &&
      ready.phase !== 'completed'
    ) {
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: input.productVersion,
        phase: 'control_handoff',
        manifestChecksum: input.manifestChecksum,
        controlOperationId: ready.operationId,
        controlManifestDigest: input.artifact.manifestDigest,
        controlCompletedTargets: ready.completedTargets,
        controlTotalTargets: ready.totalTargets,
      });
      await saveLockFile(workingLock, input.lockPath);
      spinner.warn(
        `Control continues the database rollout in the background (${ready.completedTargets}/${ready.totalTargets})`
      );
      return { lock: workingLock, ready: false };
    }
    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: input.productVersion,
      phase: 'awaiting_setup',
      manifestChecksum: input.manifestChecksum,
      controlOperationId: ready.operationId,
      controlManifestDigest: input.artifact.manifestDigest,
      controlCompletedTargets: ready.completedTargets,
      controlTotalTargets: ready.totalTargets,
    });
    await saveLockFile(workingLock, input.lockPath);
    if (ready.phase !== 'completed') {
      await beginReleaseRolloutVerification({
        controlDatabaseId: input.controlDatabaseId,
        environmentId: input.environmentId,
        operationId: ready.operationId,
        actorId: 'setup:update',
      });
    }
    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: input.productVersion,
      phase: 'schema_applied',
      manifestChecksum: input.manifestChecksum,
      controlOperationId: ready.operationId,
      controlManifestDigest: input.artifact.manifestDigest,
      controlCompletedTargets: ready.completedTargets,
      controlTotalTargets: ready.totalTargets,
    });
    await saveLockFile(workingLock, input.lockPath);
    spinner.succeed(
      `Control-managed databases are ready (${ready.completedTargets}/${ready.totalTargets})`
    );
    return { lock: workingLock, ready: true };
  } catch (error) {
    spinner.fail('Control-managed database rollout did not become ready');
    throw error;
  }
}

async function completeControlManagedReleaseRollout(input: {
  controlDatabaseId: string;
  environmentId: string;
  operationId: string | undefined;
}): Promise<void> {
  if (!input.operationId) return;
  const current = await getReleaseRolloutHandoffStatus({
    controlDatabaseId: input.controlDatabaseId,
    environmentId: input.environmentId,
    operationId: input.operationId,
  });
  if (current.phase === 'completed') return;
  await completeReleaseRolloutHandoff({
    controlDatabaseId: input.controlDatabaseId,
    environmentId: input.environmentId,
    operationId: input.operationId,
    actorId: 'setup:update',
  });
}

function mergeDeploymentSummaries(
  first: DeploymentSummary,
  second: DeploymentSummary
): DeploymentSummary {
  return {
    totalComponents: first.totalComponents + second.totalComponents,
    successCount: first.successCount + second.successCount,
    failedCount: first.failedCount + second.failedCount,
    results: [...first.results, ...second.results],
    startedAt: first.startedAt,
    completedAt: second.completedAt,
    duration: first.duration + second.duration,
  };
}

function isWorkerDeploymentLeaseBusy(error: unknown): boolean {
  return error instanceof Error && error.message === 'worker_deployment_lease_busy';
}

async function waitForControlCoordinatorSettlement(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, CONTROL_COORDINATOR_SETTLE_MS);
  });
}

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
export function updateLockWithDeploymentsAndVersions(
  lock: AuthrimLock,
  results: DeployResult[],
  localVersions: Partial<Record<WorkerComponent, string>>
): AuthrimLock {
  const workers = { ...lock.workers };
  const workerScriptOwnership = { ...lock.workerScriptOwnership };

  for (const result of results) {
    // A committed script followed by trigger/secret-cleanup failure is not a completed release
    // deployment. Retain the previous lock version so the next update must reconcile that Worker.
    if (!result.success) continue;
    if (!result.deployedAt || !result.cloudflareVersionId || !result.cloudflareScriptTag) {
      throw new Error(`worker_deployment_exact_version_unavailable:${result.component}`);
    }
    workers[result.component] = {
      name: result.workerName,
      deployedAt: result.deployedAt,
      version: localVersions[result.component] || result.version,
      cloudflareVersionId: result.cloudflareVersionId,
      cloudflareScriptTag: result.cloudflareScriptTag,
    };
    delete workerScriptOwnership[result.component];
  }

  return {
    ...lock,
    workers,
    workerScriptOwnership:
      Object.keys(workerScriptOwnership).length > 0 ? workerScriptOwnership : undefined,
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
      `  Control-managed D1 targets: ${chalk.cyan(String(tenantTargets.length))}` +
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
      input.all ||
      input.lock.workers?.[component]?.version !== input.localVersions.get(component) ||
      !input.lock.workers?.[component]?.cloudflareVersionId
    );
  });
}

export function includeWorkersMissingExactVersionEvidence(
  components: readonly WorkerComponent[],
  lock: AuthrimLock
): WorkerComponent[] {
  const selected = new Set(components);
  for (const component of CORE_WORKER_COMPONENTS) {
    const worker = lock.workers?.[component];
    if (worker && !worker.cloudflareVersionId) selected.add(component);
  }
  return [...selected];
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

export function assertUpdateCloudflareResourceIdentity(input: {
  lock: AuthrimLock;
  env: string;
  databases: Array<{ name: string; uuid: string }>;
  namespaces: Array<{ title: string; id: string }>;
  queues: Array<{ name: string; id?: string }>;
  requiredQueues: Array<{ binding: string; name: string }>;
  r2Buckets: Array<{ name: string }>;
  requiredR2BucketNames: readonly string[];
}): void {
  const d1 = reconcileD1ResourcesInLock(input.lock, input.env, input.databases);
  const kv = reconcileSharedKVResourcesInLock(d1.lock, input.env, input.namespaces);
  const queues = reconcileQueueResourcesInLock(kv.lock, input.queues, input.requiredQueues);
  const identityMismatches = [
    ...d1.identityMismatches.map((item) => ({ type: 'D1', ...item })),
    ...kv.identityMismatches.map((item) => ({ type: 'KV', ...item })),
    ...queues.identityMismatches.map((item) => ({ type: 'Queue', ...item })),
  ];
  if (identityMismatches.length > 0) {
    const summary = identityMismatches
      .map(
        (item) =>
          `${item.type}:${item.binding}:${item.lockedId ?? 'missing'}:${item.liveId ?? 'unavailable'}`
      )
      .join(',');
    throw new Error(`cloudflare_resource_identity_mismatch:${summary}`);
  }

  const missingResources = [
    ...d1.missingBindings.map((item) => `D1:${item.binding}:${item.name}`),
    ...kv.missingBindings.map((item) => `KV:${item.binding}:${item.name}`),
    ...queues.missingBindings.map((item) => `Queue:${item.binding}:${item.name}`),
  ];
  const liveR2BucketNames = new Set(input.r2Buckets.map((bucket) => bucket.name));
  for (const bucketName of input.requiredR2BucketNames) {
    if (!liveR2BucketNames.has(bucketName)) missingResources.push(`R2:${bucketName}`);
  }
  if (missingResources.length > 0) {
    throw new Error(`required_cloudflare_resources_missing:${missingResources.join(',')}`);
  }
}

async function deployReleaseUiWorkers(input: {
  env: string;
  baseDir: string;
  config: ReturnType<typeof AuthrimConfigSchema.parse>;
  lock: AuthrimLock;
  lockPath: string;
  components: UiWorkerComponent[];
  productVersion: string;
  release: ReleaseMigrationManifest;
  skipBuild: boolean;
  deployConfigLockProof: DeployConfigLockProof;
  workerScriptOwnership: WorkerScriptOwnershipGuard;
}): Promise<AuthrimLock> {
  if (input.components.length === 0) return input.lock;
  const coreDatabaseIdentifier = input.lock.d1.DB?.id;
  const adminDatabaseIdentifier = input.lock.d1.DB_ADMIN?.id;
  if (!coreDatabaseIdentifier || !adminDatabaseIdentifier) {
    throw new Error('fixed_bootstrap_databases_required_for_ui_update');
  }
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

  const initialTenant = await ensureInitialTenantInD1(input.env, input.config, undefined, {
    databaseIdentifier: coreDatabaseIdentifier,
  });
  if (!initialTenant.success) {
    throw new Error(
      `Initial tenant prerequisite failed: ${initialTenant.error ?? 'unknown error'}`
    );
  }
  const snapshot = await publishInitialControlPlaneRuntimeSnapshot({
    env: input.env,
    config: input.config,
    lock: input.lock,
    rootDir: input.baseDir,
    keysDir: keysDirectory.path,
    release: input.release,
  });
  if (!snapshot.success) {
    throw new Error(`Initial tenant runtime snapshot failed: ${snapshot.error ?? 'unknown error'}`);
  }

  let workingLock = input.lock;
  for (const component of input.components) {
    let loginUiClientId: string | undefined;
    if (component === 'ar-login-ui') {
      loginUiClientId = await runEphemeralSetupMachineAccess({
        env: input.env,
        config: input.config,
        keysDir: keysDirectory.path,
        databaseIdentifier: adminDatabaseIdentifier,
        action: async () => {
          const client = await ensureLoginUiClient({
            apiBaseUrl,
            loginUiUrl: resolveLoginUiExecutionOrigin(input.config, { env: input.env }),
            keysDir: keysDirectory.path,
            tenantId: input.config.tenant.name,
          });
          if (!client.success || !client.clientId) {
            throw new Error(`Login UI client update failed: ${client.error ?? 'unknown error'}`);
          }
          return client.clientId;
        },
      });
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
            databaseIdentifier: adminDatabaseIdentifier,
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
      deployConfigLockProof: input.deployConfigLockProof,
      workerScriptOwnership: input.workerScriptOwnership,
    });
    if (
      !result.success ||
      !result.deployedAt ||
      !result.cloudflareVersionId ||
      !result.cloudflareScriptTag
    ) {
      throw new Error(`${component} release deployment failed: ${result.error ?? 'unknown error'}`);
    }
    const visibility = await waitForWorkerDeploymentsReady({
      targets: [
        {
          workerName: result.projectName,
          deployedAt: result.deployedAt,
          expectedVersionId: result.cloudflareVersionId,
        },
      ],
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
    workingLock = clearProvisionalWorkerScriptOwnership(
      {
        ...workingLock,
        workers: {
          ...workingLock.workers,
          [component]: {
            name: result.projectName,
            deployedAt: result.deployedAt,
            version: input.productVersion,
            cloudflareVersionId: result.cloudflareVersionId,
            cloudflareScriptTag: result.cloudflareScriptTag,
          },
        },
        updatedAt: new Date().toISOString(),
      },
      [component]
    );
    await saveLockFile(workingLock, input.lockPath);
  }
  const controlDatabaseId = workingLock.d1.CONTROL_DB?.id;
  if (!controlDatabaseId) {
    throw new Error('control_database_required_for_ui_worker_inventory');
  }
  await registerUiWorkerInventoryFromArtifacts({
    baseDir: input.baseDir,
    environmentId: input.env,
    environmentName: input.env,
    controlDatabaseName: controlDatabaseId,
    components: input.components,
    environmentBootstrap: {
      defaultResidencyPolicyId: input.config.profiles.defaults.residency,
      automaticProvisioning: input.config.controlPlane?.automaticProvisioning === true,
    },
    registeredBy: 'setup:update-ui',
    disableMissing: false,
  });
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
  if (lock.env !== env) {
    throw new Error('update_lock_environment_mismatch');
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
  if (config.environment.prefix !== env) {
    throw new Error('update_config_environment_mismatch');
  }

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
  const componentsToUpdate = includeWorkersMissingExactVersionEvidence(
    getComponentsToUpdate(comparisons, options.all || false),
    workingLock
  );
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
  const migrationSearch = await findMigrationsRoot(baseDir, undefined, { strictRoot: true });
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
  const physicalTargets = resolveReleaseMigrationTargets({ lock: workingLock, config });
  try {
    assertReleaseDatabaseCompatibility({
      manifest: targetManifestResult.manifest,
      manifestChecksum,
      installedProductVersion: workingLock.productVersion,
      installedSchemaManifestChecksums: Object.values(workingLock.schemaTargets ?? {}).map(
        (state) => state.manifestChecksum
      ),
      installedSchemaTargets: workingLock.schemaTargets,
      currentTargets: physicalTargets,
      targetManifestIsDraft: targetManifestResult.draft,
    });
  } catch (error) {
    spinner.fail('This pre-1.0 database baseline requires a fresh installation');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
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
  const migrationExecutionManifest = resolveReleaseMigrationExecutionManifest({
    targetManifest: targetManifestResult.manifest,
    installedProductVersion: workingLock.productVersion,
    availableManifests: listReleaseMigrationManifests(migrationsRoot).map(
      (release) => release.manifest
    ),
  });
  const migrationArtifactManifest = workingLock.productVersion
    ? buildReleaseMigrationArtifactManifest({
        targetManifest: targetManifestResult.manifest,
        installedProductVersion: workingLock.productVersion,
        availableManifests: listReleaseMigrationManifests(migrationsRoot).map(
          (release) => release.manifest
        ),
      })
    : targetManifestResult.manifest;
  const targetManifestCache = new Map<string, ReturnType<typeof readReleaseMigrationManifest>>();
  const currentManifestForTarget = (
    target: (typeof physicalTargets)[number]
  ): ReturnType<typeof readReleaseMigrationManifest> | undefined => {
    const state = workingLock.schemaTargets?.[target.id];
    if (!state) return undefined;
    if (state.streamId === target.streamId && state.files) {
      const targetStream = migrationExecutionManifest.streams.find(
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
      return state.manifestChecksum === manifestChecksum ? migrationExecutionManifest : undefined;
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
    targetManifest: migrationExecutionManifest,
    currentManifest,
    currentManifestForTarget,
    requireCurrentManifestForTargets: true,
    targets: physicalTargets,
  });
  spinner.succeed('Release migration plan resolved');
  displaySchemaUpdatePlan(schemaPlan);
  const hasReleaseSchemaDelta = migrationExecutionManifest.streams.some(
    (stream) => stream.files.length > 0
  );
  if (options.databaseOnly) {
    if (options.all) {
      spinner.fail('--database-only cannot be combined with --all');
      process.exit(1);
    }
    if (!hasReleaseSchemaDelta) {
      spinner.fail('The target release has no database schema changes');
      process.exit(1);
    }
    try {
      assertDatabaseOnlyWorkerCompatibility(
        targetManifestResult.manifest,
        workingLock.productVersion
      );
    } catch (error) {
      spinner.fail('The current Workers are not compatible with the target database schema');
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
    const inconsistentWorkers = Object.entries(workingLock.workers ?? {}).filter(
      ([, worker]) => worker.version !== workingLock.productVersion || !worker.cloudflareVersionId
    );
    if (inconsistentWorkers.length > 0 || Object.keys(workingLock.workers ?? {}).length === 0) {
      spinner.fail('Exact current Worker version evidence is required for a database-only update');
      console.error(
        chalk.red(
          `Expected ${workingLock.productVersion ?? 'unknown'}; mismatched: ${
            inconsistentWorkers.map(([component]) => component).join(', ') ||
            'no deployed Workers recorded'
          }`
        )
      );
      process.exit(1);
    }
    componentsToUpdate.splice(0, componentsToUpdate.length);
    uiComponentsToUpdate.splice(0, uiComponentsToUpdate.length);
    updateCount = 0;
    console.log(
      chalk.yellow(
        `  Database-only mode: retaining Workers at ${workingLock.productVersion}; productVersion will not advance.`
      )
    );
  }
  const controlManagedStreamIds = getControlManagedReleaseStreamIds({
    targetManifest: migrationExecutionManifest,
    currentManifest,
  });
  const componentsWithCoordinator = includeRequiredReleaseControlCoordinator(
    componentsToUpdate,
    controlManagedStreamIds,
    options.databaseOnly === true
  );
  if (componentsWithCoordinator.length !== componentsToUpdate.length) {
    componentsToUpdate.push('ar-control');
    updateCount += 1;
    console.log(
      chalk.gray('  ar-control will be redeployed first to coordinate managed database migrations.')
    );
  }
  if (controlManagedStreamIds.length > 0) {
    console.log(
      chalk.gray(
        `  Control will snapshot and migrate managed databases for: ${controlManagedStreamIds.join(', ')}`
      )
    );
  }
  const componentsWithManagement = includeRequiredReleaseManagement(
    componentsToUpdate,
    hasReleaseSchemaDelta,
    options.databaseOnly === true
  );
  if (componentsWithManagement.length !== componentsToUpdate.length) {
    componentsToUpdate.push('ar-management');
    updateCount += 1;
    console.log(
      chalk.gray('  ar-management will be redeployed to publish refreshed schema registrations.')
    );
  }

  const recoveredRollout = await recoverActiveControlReleaseRollout({
    lock: workingLock,
    environmentId: env,
    targetVersion: productVersion,
    manifestChecksum,
  });
  workingLock = recoveredRollout.lock;
  if (recoveredRollout.activeRollout) {
    console.log(
      chalk.yellow(
        `  Recovered active Control release rollout ${recoveredRollout.activeRollout.operationId} (${recoveredRollout.activeRollout.phase}).`
      )
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
        : options.databaseOnly
          ? `Update database schemas to ${productVersion} and retain Workers at ${workingLock.productVersion}?`
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
  let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
  try {
    deployConfigLock = await acquireDeployConfigLock({
      baseDir,
      env,
      operation: 'update',
    });
    const lockedEnvironment = await loadLockFileAuto(baseDir, env);
    if (!isUpdateSourceLockUnchanged(lock, lockedEnvironment.lock)) {
      throw new Error('environment_changed_while_waiting_for_update_lock');
    }
    const lockedConfig = AuthrimConfigSchema.parse(
      JSON.parse(await readFile(envPaths.config, 'utf-8'))
    );
    if (lockedConfig.environment.prefix !== env) {
      throw new Error('update_config_environment_mismatch_after_operation_lock');
    }
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

    // The migration plan addresses D1 targets by name, while the lock retains their immutable
    // provider IDs. Re-prove the complete topology after both locks are held and before persisting
    // `planned` or mutating any schema. This prevents a deleted resource from being silently
    // replaced by an unrelated same-name D1/KV/Queue between release planning and execution.
    const requiredQueues =
      lockedConfig.features.queue?.enabled === true ? getRequiredQueues(env) : [];
    const verifyQueues =
      requiredQueues.length > 0 || Object.keys(workingLock.queues ?? {}).length > 0;
    const requiredR2BucketNames = [
      ...new Set([
        ...Object.values(workingLock.r2 ?? {}).map((bucket) => bucket.name),
        ...getRequiredR2Buckets(env, {
          includeFeatureBuckets: lockedConfig.features.r2?.enabled === true,
        }).map((bucket) => bucket.name),
      ]),
    ];
    const [liveDatabases, liveNamespaces, liveQueues, liveR2Buckets] = await Promise.all([
      listD1Databases(),
      listKVNamespaces(),
      verifyQueues ? listQueues({ strictOutput: true, requireIds: true }) : Promise.resolve([]),
      requiredR2BucketNames.length > 0
        ? listR2Buckets({ throwOnError: true })
        : Promise.resolve([]),
    ]);
    await Promise.all(
      Object.entries(workingLock.r2 ?? {}).map(([binding, bucket]) =>
        assertR2BucketOwnershipIdentity({
          ...bucket,
          environment: workingLock.env,
          binding,
        })
      )
    );
    assertUpdateCloudflareResourceIdentity({
      lock: workingLock,
      env,
      databases: liveDatabases,
      namespaces: liveNamespaces,
      queues: liveQueues,
      requiredQueues,
      r2Buckets: liveR2Buckets,
      requiredR2BucketNames,
    });

    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: productVersion,
      phase: 'planned',
      manifestChecksum,
      manualTargets: [...acknowledgedManualTargets],
    });
    await saveLockFile(workingLock, lockPath);

    const { controlSchemaTargets, remainingSetupTargets } =
      splitReleaseSchemaTargetsForControlHandoff(schemaExecutionState.automaticTargets);
    const migrationResults: Awaited<ReturnType<typeof applyReleaseSchemaUpdatePlan>>['results'] =
      [];
    const applySetupTargets = async (
      targets: ReleaseSchemaUpdatePlan['automaticTargets'],
      label: string
    ): Promise<void> => {
      if (targets.length === 0) return;
      const migrationSpinner = ora(label).start();
      const result = await applyReleaseSchemaUpdatePlan({
        plan: {
          ...schemaPlan,
          automaticTargets: targets,
          manualTargets: [],
          blockedTargets: [],
        },
        manifest: migrationExecutionManifest,
        migrationsRoot,
        concurrency: 2,
        backfillLegacyChecksums: !targetManifestResult.draft,
        onProgress: (message) => {
          migrationSpinner.text = message;
        },
      });
      migrationResults.push(...result.results);
      if (!result.success) {
        migrationSpinner.fail('Database schema update failed');
        for (const failure of result.results.filter((item) => !item.success)) {
          console.error(chalk.red(`  ${failure.targetId}: ${failure.error ?? 'unknown error'}`));
        }
        throw new Error('release_setup_schema_update_failed');
      }
      migrationSpinner.succeed(label.replace(/\.\.\.$/u, ' complete'));
    };
    const baseAppliedTargetIds = [
      ...new Set([
        ...(resumableRelease?.appliedTargets ?? []),
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

    await applySetupTargets(controlSchemaTargets, 'Updating the Control database schema...');
    let appliedTargetIds = [
      ...new Set([...baseAppliedTargetIds, ...migrationResults.map((result) => result.targetId)]),
    ];
    workingLock = withSchemaTargetStates(workingLock, {
      targetIds: appliedTargetIds,
      manualTargetIds: operatorTargetIds,
      productVersion,
      manifestChecksum,
      targetStreamIds: new Map(physicalTargets.map((target) => [target.id, target.streamId])),
      manifest: migrationExecutionManifest,
      preserveExistingFiles: true,
    });
    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: productVersion,
      phase: 'control_handoff',
      manifestChecksum,
      appliedTargets: appliedTargetIds,
      manualTargets: [...acknowledgedManualTargets],
    });
    await saveLockFile(workingLock, lockPath);

    const controlDatabase = workingLock.d1.CONTROL_DB;
    let migrationReleaseArtifact: MigrationReleaseArtifactPlan | undefined;
    if (hasReleaseSchemaDelta) {
      const migrationReleaseBucket = workingLock.r2?.MIGRATION_RELEASES;
      if (!controlDatabase) throw new Error('control_database_required_for_release_publication');
      if (!migrationReleaseBucket) {
        throw new Error('migration_release_bucket_required_for_release_publication');
      }
      const releasePublicationSpinner = ora('Publishing migration release artifact...').start();
      try {
        const verifyMigrationBucketOwnership = () =>
          assertR2BucketOwnershipForUse({
            ...migrationReleaseBucket,
            environment: env,
            binding: 'MIGRATION_RELEASES',
          });
        await verifyMigrationBucketOwnership();
        const publication = await publishAndActivateMigrationRelease({
          migrationsRoot,
          manifest: migrationArtifactManifest,
          draft: targetManifestResult.draft,
          bucketName: migrationReleaseBucket.name,
          controlDatabaseId: controlDatabase.id,
          environmentId: env,
          actorId: 'setup:update',
          verifyBucketOwnership: verifyMigrationBucketOwnership,
          onProgress: (message) => {
            releasePublicationSpinner.text = message;
          },
        });
        migrationReleaseArtifact = publication.artifact;
        releasePublicationSpinner.succeed(
          `Migration release ${publication.artifact.releaseId} published (${publication.artifact.streamIds.length} D1 streams)`
        );
      } catch (error) {
        releasePublicationSpinner.fail('Migration release publication failed');
        throw error;
      }
    }

    if (controlManagedStreamIds.length > 0) {
      if (!controlDatabase || !migrationReleaseArtifact) {
        throw new Error('release_rollout_handoff_prerequisite_missing');
      }
      const handoff = await createReleaseRolloutHandoff({
        controlDatabaseId: controlDatabase.id,
        environmentId: env,
        sourceVersion: resumableRelease?.previousProductVersion ?? workingLock.productVersion,
        targetVersion: productVersion,
        artifact: migrationReleaseArtifact,
        manifest: targetManifestResult.manifest,
        managedStreamIds: controlManagedStreamIds,
        actorId: 'setup:update',
      });
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: productVersion,
        phase: 'control_handoff',
        manifestChecksum,
        appliedTargets: appliedTargetIds,
        manualTargets: [...acknowledgedManualTargets],
        controlOperationId: handoff.operationId,
        controlManifestDigest: migrationReleaseArtifact.manifestDigest,
        controlCompletedTargets: handoff.completedTargets,
        controlTotalTargets: handoff.totalTargets,
      });
      await saveLockFile(workingLock, lockPath);
    }

    await applySetupTargets(remainingSetupTargets, 'Updating setup-owned database schemas...');
    appliedTargetIds = [
      ...new Set([...baseAppliedTargetIds, ...migrationResults.map((result) => result.targetId)]),
    ];
    workingLock = withSchemaTargetStates(workingLock, {
      targetIds: appliedTargetIds,
      manualTargetIds: operatorTargetIds,
      productVersion,
      manifestChecksum,
      targetStreamIds: new Map(physicalTargets.map((target) => [target.id, target.streamId])),
      manifest: migrationExecutionManifest,
      preserveExistingFiles: true,
    });
    workingLock = withReleaseUpdateState(workingLock, {
      targetVersion: productVersion,
      phase: controlManagedStreamIds.length > 0 ? 'control_handoff' : 'schema_applied',
      manifestChecksum,
      appliedTargets: appliedTargetIds,
      manualTargets: [...acknowledgedManualTargets],
    });
    await saveLockFile(workingLock, lockPath);

    const workerOwnership = await prepareManagedWorkerScriptOwnership({
      lock: workingLock,
      lockPath,
      targets: [
        ...componentsToUpdate.map((component) => ({
          component,
          workerName: getWorkerName(env, component),
        })),
        ...uiComponentsToUpdate.map((component) => ({
          component,
          workerName: `${env}-${component}`,
        })),
      ],
    });
    if (workerOwnership.changed) {
      workingLock = workerOwnership.lock;
      await saveLockFile(workingLock, lockPath);
    }

    if (componentsToUpdate.length === 0) {
      if (controlManagedStreamIds.length > 0) {
        if (!controlDatabase || !migrationReleaseArtifact) {
          throw new Error('release_rollout_handoff_prerequisite_missing');
        }
        const observation = await awaitControlManagedReleaseRollout({
          controlDatabaseId: controlDatabase.id,
          environmentId: env,
          sourceVersion: resumableRelease?.previousProductVersion ?? workingLock.productVersion,
          productVersion,
          manifestChecksum,
          manifest: targetManifestResult.manifest,
          artifact: migrationReleaseArtifact,
          managedStreamIds: controlManagedStreamIds,
          lock: workingLock,
          lockPath,
        });
        workingLock = observation.lock;
        if (!observation.ready) {
          console.log(
            chalk.cyan(
              '\nDatabase migration continues safely in Control. Run this update again later to resume Worker activation.'
            )
          );
          return;
        }
      }
      const retainedWorkerVersion = options.databaseOnly
        ? workingLock.productVersion
        : productVersion;
      const lockedWorkers = Object.values(workingLock.workers ?? {}).filter(
        (worker) => worker.version === retainedWorkerVersion
      );
      const workersWithoutExactVersion = lockedWorkers.filter(
        (worker) => !worker.cloudflareVersionId
      );
      if (workersWithoutExactVersion.length > 0) {
        throw new Error(
          `worker_deployment_exact_version_unavailable:${workersWithoutExactVersion
            .map((worker) => worker.name)
            .join(',')}`
        );
      }
      const verificationSpinner = ora('Verifying existing Worker deployments...').start();
      const deploymentVerification = await waitForWorkerDeploymentsReady({
        targets: lockedWorkers.map((worker) => ({
          workerName: worker.name,
          deployedAt: worker.deployedAt,
          expectedVersionId: worker.cloudflareVersionId,
        })),
        onProgress: (message) => {
          verificationSpinner.text = message;
        },
      });
      if (!deploymentVerification.ready) {
        verificationSpinner.fail('Existing Worker deployment verification failed');
        console.error(chalk.red(deploymentVerification.error ?? 'unknown verification error'));
        throw new Error(
          `existing_worker_deployment_verification_failed:${deploymentVerification.error ?? 'unknown'}`
        );
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
          throw new Error(`existing_worker_http_health_failed:${httpResult.error ?? 'unknown'}`);
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
          release: targetManifestResult.manifest,
          skipBuild: options.skipBuild === true,
          deployConfigLockProof: deployConfigLock!.proof,
          workerScriptOwnership: workerOwnership.guard,
        });
      } catch (error) {
        verificationSpinner.fail('UI Worker release deployment failed');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        throw error instanceof Error
          ? error
          : new Error('ui_worker_release_deployment_failed', { cause: error });
      }
      if (!controlDatabase && workingLock.releaseUpdate?.controlOperationId) {
        throw new Error('control_database_required_for_release_rollout_completion');
      }
      if (controlDatabase) {
        await completeControlManagedReleaseRollout({
          controlDatabaseId: controlDatabase.id,
          environmentId: env,
          operationId: workingLock.releaseUpdate?.controlOperationId,
        });
      }
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: productVersion,
        phase: options.databaseOnly ? 'database_only_verified' : 'verified',
        manifestChecksum,
      });
      await saveLockFile(workingLock, lockPath);
      console.log(
        chalk.green(
          options.databaseOnly
            ? `\n✅ Database schemas are at ${productVersion}; Workers remain at ${retainedWorkerVersion}.`
            : '\n✅ Database schemas and all enabled Workers are at the target release.'
        )
      );
      return;
    }

    // Regenerate from the schema-applied lock before copying to deploy locations.
    const wranglerSpinner = ora('Refreshing wrangler configs...').start();
    try {
      const projected = await refreshLockFromControlGeneratedState({
        lock: workingLock,
        environmentId: env,
      });
      workingLock = projected.lock;
      await saveLockFile(workingLock, lockPath);
      wranglerSpinner.text = `Loaded Control DB bindings (+${projected.added.length} ~${projected.changed.length} -${projected.removed.length})`;
    } catch (error) {
      wranglerSpinner.fail('Control DB generated-state projection failed');
      console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      throw error instanceof Error
        ? error
        : new Error('control_generated_state_projection_failed', { cause: error });
    }
    const deploymentResourceIds = await buildWorkerDeploymentResourceIds({
      lock: workingLock,
      config,
      environmentId: env,
      onProgress: (message) => {
        wranglerSpinner.text = message;
      },
    });
    const masterResult = await saveMasterWranglerConfigs(config, deploymentResourceIds, {
      baseDir,
      env,
      onProgress: (msg) => {
        wranglerSpinner.text = msg;
      },
    });
    if (!masterResult.success) {
      wranglerSpinner.fail('Wrangler config generation failed');
      console.error(chalk.red(`\nErrors: ${masterResult.errors.join(', ')}`));
      throw new Error(`wrangler_config_generation_failed:${masterResult.errors.join(',')}`);
    }
    const controlDatabaseId = workingLock.d1?.CONTROL_DB?.id;
    if (!controlDatabaseId) {
      wranglerSpinner.fail('CONTROL_DB is required for desired Worker inventory');
      throw new Error('control_database_required_for_desired_worker_inventory');
    }
    try {
      const inventory = await compileControlWorkerInventoryFromArtifacts({
        baseDir,
        environmentId: env,
        environmentName: env,
        components: CORE_WORKER_COMPONENTS,
        artifactPaths: masterResult.files,
      });
      await registerControlWorkerInventory({
        controlDatabaseName: controlDatabaseId,
        records: inventory,
        environmentBootstrap: {
          defaultResidencyPolicyId: config.profiles.defaults.residency,
          automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
        },
        registeredBy: 'setup:update',
        onProgress: (message) => {
          wranglerSpinner.text = message;
        },
      });
      const externalSources = await discoverExternalCapabilities({ baseDir });
      const pluginBundleBucket = workingLock.r2?.PLUGIN_BUNDLES;
      const verifyPluginBundleOwnership = pluginBundleBucket
        ? () =>
            assertR2BucketOwnershipForUse({
              ...pluginBundleBucket,
              environment: env,
              binding: 'PLUGIN_BUNDLES',
            })
        : undefined;
      if (config.features.pluginDynamicWorkers.enabled) {
        if (!pluginBundleBucket) throw new Error('plugin_bundle_bucket_required');
        await verifyPluginBundleOwnership!();
      }
      await publishDynamicPluginWorkerBundles({
        baseDir,
        enabled: config.features.pluginDynamicWorkers.enabled,
        sources: externalSources,
        bucketName: pluginBundleBucket?.name,
        pluginRunnerDatabaseId: workingLock.d1?.PLUGIN_RUNNER_DB?.id,
        verifyBucketOwnership: verifyPluginBundleOwnership,
        onProgress: (message) => {
          wranglerSpinner.text = message;
        },
      });
      await registerExternalCapabilities({
        controlDatabaseName: controlDatabaseId,
        environmentId: env,
        sources: externalSources,
        registeredBy: 'setup:update',
      });
    } catch (error) {
      wranglerSpinner.fail('Desired Worker inventory registration failed');
      console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      throw error instanceof Error
        ? error
        : new Error('desired_worker_inventory_registration_failed', { cause: error });
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
      throw new Error(`wrangler_config_sync_failed:${syncResult.errors.join(',')}`);
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
        throw new Error(`worker_build_failed:${buildResult.error ?? 'unknown'}`);
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
    const deploymentSecrets = await loadDeploySecretsFromKeys(
      keysDirectory?.path,
      componentsToUpdate
    );
    const deploymentControlDatabase = workingLock.d1.CONTROL_DB;
    if (!deploymentControlDatabase) {
      throw new Error('control_database_required_for_worker_deployment_lease');
    }

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
      deploymentLease: {
        controlDatabaseId: deploymentControlDatabase.id,
        environmentId: env,
        actorId: 'setup:update',
        accountId: config.cloudflare?.accountId,
        required: true,
      },
      cleanupLegacyStaticSecrets: true,
      deployConfigLockProof: deployConfigLock!.proof,
      workerScriptOwnership: workerOwnership.guard,
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
      const missingUiBindingTargets = await resolveMissingUiWorkerBindingTargets(deployOptions, {
        loginUi: lockedConfig.components.loginUi ?? true,
        adminUi: lockedConfig.components.adminUi ?? true,
      });
      if (missingUiBindingTargets.loginUi || missingUiBindingTargets.adminUi) {
        const placeholderSummary = await deployUiWorkerBindingTargets(
          {
            ...deployOptions,
            apiBaseUrl: resolveIssuerUrl(lockedConfig, { env }),
          },
          missingUiBindingTargets
        );
        if (placeholderSummary.failedCount > 0) {
          console.error(chalk.red('UI Worker binding-target deployment failed'));
          throw new Error('ui_worker_binding_target_deployment_failed');
        }
      }
    }

    const deploymentGroups = splitReleaseDeploymentForControlCoordinator(componentsToUpdate);
    let controlRolloutReady = false;
    const ensureControlRolloutReady = async (): Promise<boolean> => {
      if (controlRolloutReady || controlManagedStreamIds.length === 0) return true;
      if (!controlDatabase || !migrationReleaseArtifact) {
        throw new Error('release_rollout_handoff_prerequisite_missing');
      }
      const coordinator = workingLock.workers?.['ar-control'];
      if (!coordinator || coordinator.version !== productVersion) {
        throw new Error('release_rollout_control_coordinator_not_updated');
      }
      const coordinatorReady = await waitForWorkerDeploymentsReady({
        targets: [
          {
            workerName: coordinator.name,
            deployedAt: coordinator.deployedAt,
            expectedVersionId: coordinator.cloudflareVersionId,
          },
        ],
      });
      if (!coordinatorReady.ready) {
        throw new Error(
          `release_rollout_control_coordinator_not_ready:${coordinatorReady.error ?? 'unknown'}`
        );
      }
      const coordinatorWorkersSubdomain = await getWorkersSubdomain();
      const coordinatorHttpTargets = buildWorkerHttpReadinessTargets(
        [{ workerName: coordinator.name }],
        coordinatorWorkersSubdomain,
        { workersDevEnabled: !config.urls?.api?.custom }
      );
      if (coordinatorHttpTargets.length > 0) {
        const coordinatorHttp = await waitForWorkerHttpReady({ targets: coordinatorHttpTargets });
        if (!coordinatorHttp.ready) {
          throw new Error(
            `release_rollout_control_coordinator_not_healthy:${coordinatorHttp.error ?? 'unknown'}`
          );
        }
      }
      const observation = await awaitControlManagedReleaseRollout({
        controlDatabaseId: controlDatabase.id,
        environmentId: env,
        sourceVersion: resumableRelease?.previousProductVersion ?? workingLock.productVersion,
        productVersion,
        manifestChecksum,
        manifest: targetManifestResult.manifest,
        artifact: migrationReleaseArtifact,
        managedStreamIds: controlManagedStreamIds,
        lock: workingLock,
        lockPath,
      });
      workingLock = observation.lock;
      controlRolloutReady = observation.ready;
      return observation.ready;
    };
    let summary: DeploymentSummary;
    if (!options.dryRun && deploymentGroups.coordinator.length > 0) {
      console.log(
        chalk.gray('  Deploying ar-control first so in-flight provisioning can safely converge...')
      );
      const coordinatorSummary = await deployAll(deployOptions, deploymentGroups.coordinator);
      if (coordinatorSummary.failedCount > 0) {
        summary = coordinatorSummary;
      } else {
        workingLock = updateLockWithDeploymentsAndVersions(
          workingLock,
          coordinatorSummary.results,
          localVersions
        );
        if (!(await ensureControlRolloutReady())) {
          console.log(
            chalk.cyan(
              '\nDatabase migration continues safely in Control. Run this update again later to resume Worker activation.'
            )
          );
          return;
        }
        let remainingSummary: DeploymentSummary;
        try {
          remainingSummary = await deployAll(deployOptions, deploymentGroups.remaining);
        } catch (error) {
          if (!isWorkerDeploymentLeaseBusy(error)) throw error;
          console.log(
            chalk.gray(
              '  Waiting for the updated Control coordinator to release superseded provisioning leases...'
            )
          );
          await waitForControlCoordinatorSettlement();
          remainingSummary = await deployAll(deployOptions, deploymentGroups.remaining);
        }
        summary = mergeDeploymentSummaries(coordinatorSummary, remainingSummary);
      }
    } else {
      if (!(await ensureControlRolloutReady())) {
        console.log(
          chalk.cyan(
            '\nDatabase migration continues safely in Control. Run this update again later to resume Worker activation.'
          )
        );
        return;
      }
      summary = await deployAll(deployOptions, componentsToUpdate);
    }

    // Update lock file with new versions
    if (summary.results.some((result) => result.success)) {
      workingLock = updateLockWithDeploymentsAndVersions(
        workingLock,
        summary.results,
        localVersions
      );
    }

    if (summary.failedCount > 0) {
      console.error(
        chalk.red(
          `\nWorker activation failed: ${summary.successCount}/${summary.totalComponents} updated, ${summary.failedCount} failed`
        )
      );
      for (const result of summary.results.filter((candidate) => !candidate.success)) {
        console.error(chalk.red(`  • ${result.component}: ${result.error ?? 'unknown error'}`));
      }
      // Successful components remain checkpointed for an idempotent resume, but a partial
      // activation is never a successful CLI operation. In particular, the Web wrapper must not
      // mistake the retained control_handoff phase for a healthy in-progress database rollout.
      throw new Error(`release_worker_deployment_failed:${summary.failedCount}`);
    }

    if (!options.dryRun) {
      const verificationSpinner = ora('Verifying Worker deployments...').start();
      const verificationResult = await waitForWorkerDeploymentsReady({
        targets: summary.results
          .filter((result) => result.success)
          .map((result) => ({
            workerName: result.workerName,
            deployedAt: result.deployedAt,
            expectedVersionId: result.cloudflareVersionId,
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
        throw new Error(
          `worker_deployment_verification_failed:${verificationResult.error ?? 'unknown'}`
        );
      }

      const workersSubdomain = await getWorkersSubdomain();
      const workersDevEnabled = !lockedConfig.urls?.api?.custom;
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
          throw new Error(`worker_http_health_failed:${httpResult.error ?? 'unknown'}`);
        }
      }
      workingLock = withReleaseUpdateState(workingLock, {
        targetVersion: productVersion,
        phase: 'workers_deployed',
        manifestChecksum,
      });
      await saveLockFile(workingLock, lockPath);
      console.log(
        chalk.gray(`\n  Lock file updated after identity and health checks: ${lockPath}`)
      );
      try {
        workingLock = await deployReleaseUiWorkers({
          env,
          baseDir,
          config,
          lock: workingLock,
          lockPath,
          components: uiComponentsToUpdate,
          productVersion,
          release: targetManifestResult.manifest,
          skipBuild: options.skipBuild === true,
          deployConfigLockProof: deployConfigLock!.proof,
          workerScriptOwnership: workerOwnership.guard,
        });
      } catch (error) {
        verificationSpinner.fail('UI Worker release deployment failed');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        throw error instanceof Error
          ? error
          : new Error('ui_worker_release_deployment_failed', { cause: error });
      }
      if (!controlDatabase && workingLock.releaseUpdate?.controlOperationId) {
        throw new Error('control_database_required_for_release_rollout_completion');
      }
      if (controlDatabase) {
        await completeControlManagedReleaseRollout({
          controlDatabaseId: controlDatabase.id,
          environmentId: env,
          operationId: workingLock.releaseUpdate?.controlOperationId,
        });
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

    console.log(chalk.green(`  ✅ ${summary.successCount} worker(s) updated successfully!`));

    console.log('');
  } finally {
    try {
      await deployConfigLock?.release();
    } finally {
      await operationLock.release();
    }
  }
}
