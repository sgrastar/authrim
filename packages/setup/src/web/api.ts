/**
 * API Routes for Authrim Setup Web UI
 *
 * Provides REST API endpoints for the setup wizard.
 *
 * Security Notes:
 * - This API is designed to be accessed from localhost only
 * - A session token is generated on server start to prevent unauthorized access
 * - Concurrent mutation requests are rejected to prevent duplicate side effects
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  isWranglerInstalled,
  checkAuth,
  getSetupCapabilityDiagnostics,
  deriveSetupCapabilityEstimate,
  deriveSetupCapabilityStatuses,
  ensureWildcardDnsForMultiTenant,
  provisionResources,
  provisionR2Buckets,
  buildR2BucketProvisioningStatus,
  confirmEnvironmentObservedForDeletion,
  detectEnvironments,
  deleteEnvironment,
  EnvironmentInventoryUnavailableError,
  getWorkersSubdomain,
  checkAdminSetupStatus,
  generateAndStoreSetupToken,
  runMigrationsForEnvironment,
  getD1MigrationStatusForEnvironment,
  runD1MigrationsForEnvironmentSelection,
  ensureInitialAdminRolesInD1,
  ensureAdminUiBffMachineAccessInD1,
  cleanupSetupMachineAccessInD1,
  ensureSetupMachineAccessInD1,
  ensureInitialTenantInD1,
  seedDefaultCanonicalCatalog,
  seedRuntimeProfiles,
  getWorkerDeployments,
  listR2Buckets,
  type CloudflareAuth,
  type EnvironmentInfo,
  type EnvironmentInventoryResource,
  findMigrationsRoot,
  getAccountId,
  getCloudflareApiToken,
  getRequiredR2Buckets,
  getRequiredQueues,
  listD1Databases,
  listKVNamespaces,
  listQueues,
  listWorkers,
  assertR2BucketOwnershipIdentity,
  assertR2BucketOwnershipForUse,
} from '../core/cloudflare.js';
import {
  getCloudflareDnsRecordsDashboardUrl,
  isWildcardDnsPermissionError,
} from '../core/wildcard-dns-manual-action.js';
import {
  AuthrimConfigSchema,
  createDefaultConfig,
  D1LocationSchema,
  D1JurisdictionSchema,
  type AuthrimConfig,
} from '../core/config.js';
import {
  ensureSupplementalKeyFiles,
  generateAllSecrets,
  loadKeysFromDirectory,
  saveKeysToDirectory,
  keysExistForEnvironment,
} from '../core/keys.js';
import {
  acquireDeployConfigLock,
  acquireEnvironmentOperationForEnvironment,
  clearProvisionalWorkerScriptOwnership,
  collectWorkerDeletionIdentities,
  createLockFile,
  hasPostProvisioningLockState,
  loadLockFileAuto,
  mergeLockFiles,
  mergeProvisionedResourcesIntoLock,
  reconcileD1ResourcesInLock,
  reconcileQueueResourcesInLock,
  reconcileLockAfterResourceDeletion,
  reconcileSharedKVResourcesInLock,
  saveLockFile,
  withBackfilledWorkerDeletionIdentities,
  withDnsOwnershipEntry,
  type AuthrimLock,
  type DeployConfigLockProof,
} from '../core/lock.js';
import {
  getEnvironmentPaths,
  getExternalKeysDir,
  getExternalKeysPathForConfig,
  deriveExternalKeysBaseDirFromConfigPath,
  findKeysDirectory,
  resolvePaths,
  listEnvironments,
  findAuthrimBaseDir,
  findLegacyConfigPath,
  AUTHRIM_DIR,
  type EnvironmentPaths,
  type LegacyPaths,
} from '../core/paths.js';
import {
  beginOrResumeProvisioningIntent,
  calculateProvisioningResourceSpecDigest,
  completeProvisioningIntent,
  hasExactProvisioningResourceIdentity,
  loadProvisioningIntent,
  recordProvisionedResource,
  recordProvisioningResourceCreateIssued,
  recordProvisioningResourceCreateRejected,
  recordProvisioningResourceIdentified,
  recordProvisioningKeyId,
  type ProvisioningIntent,
  type ProvisioningResourceSpec,
} from '../core/provisioning-intent.js';
import {
  prepareManagedWorkerScriptOwnership,
  prepareWorkerScriptOwnership,
  type WorkerScriptOwnershipGuard,
} from '../core/worker-script-ownership.js';
import { readPrivateFileSecurely, writePrivateFileAtomically } from '../core/atomic-file.js';
import { reconcileLegacyQueueIdentitiesForDeletion } from '../core/legacy-queue-identity-deletion.js';
import {
  promotePendingEmailSecrets,
  recoverLegacyPreBundleEmailSecrets,
  stagePendingEmailSecrets,
} from '../core/pending-email-secrets.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';
import {
  checkWranglerStatus,
  saveMasterWranglerConfigs,
  syncWranglerConfigs,
} from '../core/wrangler-sync.js';
import { buildWorkerDeploymentResourceIds } from '../core/deployment-resource-ids.js';
import { refreshWorkerDeploymentArtifacts } from '../core/worker-deployment-artifacts.js';
import { cleanupLocalEnvironmentArtifacts } from '../core/environment-cleanup.js';
import { cleanupSetupManagedControlTokens } from '../core/control-token-environment-cleanup.js';
import { inspectLocalEnvironmentState } from '../core/local-environment-state.js';
import {
  updateDeploymentProgress,
  type DeploymentProgressSnapshot,
} from '../core/deployment-progress.js';
import {
  buildInitialAdminSetupUrl,
  buildUrlsConfig,
  resolveAdminUiEntryUrl,
  resolveApiBaseUrlCandidates,
  resolveIssuerUrl,
  resolveLoginUiEntryUrl,
  resolveLoginUiExecutionOrigin,
  validateDomainRoutingConfig,
} from '../core/url-config.js';
import { normalizeTenantConfigForApiDomain } from '../core/tenant-mode.js';
import {
  ensureInitialControlPlaneResources,
  inspectInitialControlPlaneTopology,
  publishInitialControlPlaneRuntimeSnapshot,
} from '../core/control-plane-bootstrap.js';
import {
  initializeControlKeyState,
  reconcileLocalControlKeyFiles,
} from '../core/control-key-state.js';
import {
  loadControlGeneratedKeyState,
  loadControlStagedSigningKeys,
  projectControlGeneratedKeyState,
} from '../core/control-generated-state.js';
import {
  advanceInitialBootstrapWorkerBindingsAsOperator,
  reconcileInitialBootstrapHandoffAsOperator,
  recordInitialBootstrapWorkerEvidence,
  registerInitialControlTopology,
  requestInitialBootstrapAcceleration,
  listInitialBootstrapReconciledWorkerVersions,
  workerVersionIdentity,
  waitForInitialBootstrapHandoff,
} from '../core/control-bootstrap-handoff.js';
import {
  compileControlWorkerInventoryFromArtifacts,
  registerControlWorkerInventory,
  registerUiWorkerInventoryFromArtifacts,
} from '../core/control-worker-inventory.js';
import {
  discoverExternalCapabilities,
  registerExternalCapabilities,
} from '../core/external-capability-registration.js';
import { publishDynamicPluginWorkerBundles } from '../core/dynamic-plugin-publication.js';
import { publishAndActivateMigrationRelease } from '../core/migration-release-publication.js';
import { ensureInitialNotificationProviderConfiguration } from '../core/notification-provider-bootstrap.js';
import {
  deployAll,
  buildApiPackages,
  deployAllUiWorkers,
  deployUiWorkerBindingTargets,
  resolveMissingUiWorkerBindingTargets,
  resolveExistingWorkerComponents,
  deployUiWorkerComponent,
  deployWorker,
  loadDeploySecretsFromKeys,
  UI_WORKER_COMPONENTS,
  updateLockWithDeployments,
  type DeployResult,
  type DeploymentSummary,
  type UiWorkerComponent,
} from '../core/deploy.js';
import {
  D1_DATABASES,
  KV_NAMESPACES,
  getD1DatabaseName,
  getEnabledComponents,
  getKVNamespaceName,
  getWorkerName,
  WORKER_COMPONENTS,
  type WorkerComponent,
} from '../core/naming.js';
import {
  getLocalPackageVersions,
  getPackageVersion,
  getRootProductVersion,
  compareVersions,
  getComponentsToUpdate,
} from '../core/version.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../core/release-deployment-guard.js';
import {
  classifyEnvironmentLifecycle,
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from '../core/environment-operation-policy.js';
import { hasDatabaseTopologyChange } from '../core/environment-config-policy.js';
import {
  assertDatabaseOnlyWorkerCompatibility,
  calculateReleaseManifestChecksum,
  loadInstalledReleaseMigrationManifest,
  loadTargetReleaseMigrationManifest,
  resolveReleaseMigrationTargets,
  type ReleaseMigrationManifest,
} from '../core/release-migrations.js';
import {
  applyReleaseSchemaUpdatePlan,
  buildReleaseSchemaUpdatePlan,
} from '../core/release-update.js';
import { evaluateReleaseUpdateAvailability } from '../core/release-update-availability.js';
import {
  withRecordedReleaseSchemaTargets,
  withReleaseUpdateState,
  withSchemaTargetStates,
  withVerifiedInitialReleaseState,
} from '../core/release-state.js';
import {
  assertPendingTopologyUpdate,
  completeTopologyUpdate,
  prepareTopologyUpdate,
} from '../core/topology-update.js';
import {
  commitTopologyConfigTransaction,
  readEffectiveTopologyConfig,
  recoverTopologyConfigTransaction,
} from '../core/topology-config-transaction.js';
import { completeInitialSetup } from '../core/admin.js';
import { prepareAdminUiBffDeployment } from '../core/admin-ui-bff-deployment.js';
import { describeAdminUiApiMode, resolveUiDeploymentSettings } from '../core/ui-deployment.js';
import { saveUiEnv, buildInitialUiEnvConfig, mergeAndSaveUiEnv } from '../core/ui-env.js';
import { validateSetupDomainInputs } from './domain-form-state.js';
import { runReleaseUpdateCli } from './release-update-runner.js';
import { getMissingRequiredDeploySecrets } from '../core/secrets.js';
import {
  buildCloudflareBootstrapTokenEndDate,
  buildCloudflareBootstrapTemplateUrl,
  cleanupCloudflareBootstrapToken,
  CloudflareTokenBootstrapError,
  detectCloudflareTokenOwnership,
  selectPreferredCloudflareTokenOwnership,
  WranglerControlSecretSink,
  type CloudflareTokenOwnership,
} from '../core/cloudflare-control-token-bootstrap.js';
import {
  completeControlTokenBootstrap,
  findMissingControlTokenResourceClasses,
  hasReadyControlTokenBootstrap,
  reconcileControlSecretGenerationWorkerLock,
  resolveControlTokenResourceClasses,
} from '../core/control-token-bootstrap-orchestrator.js';
import {
  isTokenlessPendingControlProvisioningAuthority,
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
  type ControlProvisioningAuthorityState,
} from '../core/control-provisioning-authority.js';
import { loadPendingControlBootstrap } from '../core/pending-control-bootstrap.js';
import {
  listPendingControlOperatorOperations,
  listPendingPluginControlCleanupOperations,
  listPendingPluginControlOperatorOperations,
  listPendingTenantDisasterRecoveryOperatorOperations,
} from '../core/control-operator-operations.js';
import { executeSetupPluginCleanupOperator } from '../core/plugin-control-cleanup-operator-executor.js';
import { executeSetupPluginControlOperator } from '../core/plugin-control-operator-executor.js';
import {
  listSetupExclusiveCapacityTenants,
  previewSetupControlCapacity,
  requestSetupControlCapacity,
} from '../core/control-capacity-client.js';
import { runEphemeralSetupMachineAccess } from '../core/setup-machine-access-lifecycle.js';
import { assertFixedD1ResourceIdentities } from '../core/fixed-d1-identity.js';
import {
  executeSetupControlOperatorCreate,
  executeSetupControlOperatorMigration,
  executeSetupControlOperatorWorkerBindings,
} from '../core/control-operator-executor.js';
import {
  buildWorkerHttpReadinessTargets,
  waitForRouterWorkerReady,
  waitForWorkerDeploymentsReady,
  waitForWorkerHttpReady,
} from '../core/worker-readiness.js';
import {
  configureDownstreamIntrospectionDeployment,
  createDownstreamIntrospectionFailure,
  resolveDownstreamIntrospectionKeysDir,
} from '../core/downstream-introspection-deploy.js';
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// =============================================================================
// Session & Security
// =============================================================================

/**
 * Session token for API authentication (generated on server start)
 * This is embedded in the HTML page served to the browser
 */
let sessionToken: string = '';

/**
 * Generate a new session token
 */
export function generateSessionToken(): string {
  sessionToken = randomBytes(32).toString('hex');
  return sessionToken;
}

/**
 * Get current session token (for embedding in HTML)
 */
export function getSessionToken(): string {
  return sessionToken;
}

/**
 * Recover the exact Worker set from an interrupted initial Web deployment.
 *
 * Older setup versions persisted the deployed Worker names and timestamps but omitted the
 * Cloudflare version IDs and the workers_deployed release checkpoint. Only recover that legacy
 * state when every enabled Worker has exact environment/name/version evidence. A version created
 * by Control's recorded binding reconciliation is also trusted, then re-verified by the final
 * handoff checks; any other version drift remains a hard recovery failure.
 */
export async function buildWebInitialHandoffResumeSummary(input: {
  lock: AuthrimLock;
  components: readonly WorkerComponent[];
  productVersion: string;
  getDeployment?: typeof getWorkerDeployments;
  listScripts?: typeof listWorkers;
  allowSecretTriggeredVersionAdvanceFor?: readonly WorkerComponent[];
  reconciledWorkerVersions?: ReadonlySet<string>;
  now?: string;
}): Promise<DeploymentSummary | null> {
  const phase = input.lock.releaseUpdate?.phase;
  if (phase !== 'schema_applied' && phase !== 'workers_deployed') return null;
  if (input.lock.releaseUpdate?.initialWorkerRedeployRequired === true) return null;

  const lockedWorkers = input.components.map((component) => ({
    component,
    worker: input.lock.workers?.[component],
  }));
  const hasCompleteLocalEvidence = lockedWorkers.every(
    ({ component, worker }) =>
      worker?.name === `${input.lock.env}-${component}` &&
      worker.version === input.productVersion &&
      Boolean(worker.deployedAt && worker.cloudflareVersionId && worker.cloudflareScriptTag)
  );
  if (!hasCompleteLocalEvidence) {
    if (phase === 'workers_deployed') {
      throw new Error('initial_handoff_resume_worker_evidence_incomplete');
    }
    return null;
  }

  const liveScripts = await (input.listScripts ?? listWorkers)();
  const liveScriptByName = new Map<string, (typeof liveScripts)[number]>();
  for (const script of liveScripts) {
    if (liveScriptByName.has(script.name)) {
      throw new Error(`initial_handoff_resume_duplicate_script:${script.name}`);
    }
    liveScriptByName.set(script.name, script);
  }
  for (const { component, worker } of lockedWorkers) {
    if (!worker?.cloudflareScriptTag) {
      throw new Error(`initial_handoff_resume_worker_evidence_incomplete:${component}`);
    }
    const liveScriptTag = liveScriptByName.get(worker.name)?.tag;
    if (!liveScriptTag || liveScriptTag !== worker.cloudflareScriptTag) {
      throw new Error(`initial_handoff_resume_script_identity_mismatch:${component}`);
    }
  }

  const getDeployment = input.getDeployment ?? getWorkerDeployments;
  const recovered = await Promise.all(
    lockedWorkers.map(async ({ component, worker }): Promise<DeployResult> => {
      // The completeness check above narrows the operational state; retain this explicit guard so
      // a future refactor cannot turn an incomplete checkpoint into a deployment fallback.
      if (!worker?.deployedAt || !worker.cloudflareVersionId || !worker.cloudflareScriptTag) {
        throw new Error(`initial_handoff_resume_worker_evidence_incomplete:${component}`);
      }
      const remote = await getDeployment(worker.name);
      const cloudflareVersionId = remote?.versionId ?? undefined;
      if (!remote?.exists || !cloudflareVersionId) {
        throw new Error(`initial_handoff_resume_remote_evidence_missing:${component}`);
      }
      const allowedSecretVersionAdvance =
        input.allowSecretTriggeredVersionAdvanceFor?.includes(component) === true &&
        remote.source === 'Secret Change';
      const allowedBindingVersionAdvance = input.reconciledWorkerVersions?.has(
        workerVersionIdentity(worker.name, cloudflareVersionId)
      );
      if (
        worker.cloudflareVersionId &&
        worker.cloudflareVersionId !== cloudflareVersionId &&
        !allowedSecretVersionAdvance &&
        !allowedBindingVersionAdvance
      ) {
        throw new Error(`initial_handoff_resume_remote_version_mismatch:${component}`);
      }
      return {
        component,
        workerName: worker.name,
        success: true,
        deployedAt: worker.deployedAt,
        version: worker.version,
        cloudflareVersionId,
        cloudflareScriptTag: worker.cloudflareScriptTag,
      };
    })
  );

  const completedAt = input.now ?? new Date().toISOString();
  const results = recovered;
  return {
    totalComponents: results.length,
    successCount: results.length,
    failedCount: 0,
    results,
    startedAt: completedAt,
    completedAt,
    duration: 0,
  };
}

// =============================================================================
// Operation Lock (prevents concurrent state mutations)
// =============================================================================

class SetupOperationInProgressError extends Error {
  constructor() {
    super('Another setup operation is already in progress. Wait for it to finish and retry.');
    this.name = 'SetupOperationInProgressError';
  }
}

const EnvironmentDeleteRequestSchema = z
  .object({
    deleteWorkers: z.boolean().optional().default(true),
    deleteD1: z.boolean().optional().default(true),
    deleteKV: z.boolean().optional().default(true),
    deleteQueues: z.boolean().optional().default(true),
    deleteR2: z.boolean().optional().default(true),
    deletePages: z.boolean().optional().default(true),
    finalizeEnvironment: z.boolean().optional().default(false),
  })
  .strict();

function isEnvironmentOperationConflict(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    /^(?:environment_operation_in_progress|environment_changed_while_waiting_for_operation_lock|environment_operation_lock_unavailable|deploy_config_operation_in_progress):/u.test(
      message
    )
  );
}

function publicControlProvisioningAuthority(authority: ControlProvisioningAuthorityState) {
  return {
    environmentId: authority.environmentId,
    automaticProvisioningEnabled: authority.automaticProvisioningEnabled,
    tokenOwnership: authority.tokenOwnership,
    tokenManagement: authority.tokenManagement,
    capabilityState: authority.capabilityState,
    bootstrapPhase: authority.bootstrapPhase,
    capabilityCheckedAt: authority.capabilityCheckedAt,
    updatedAt: authority.updatedAt,
  };
}

let webOperationRunning = false;

/**
 * Reject a mutation while another Web setup operation is running
 */
async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  if (webOperationRunning) {
    throw new SetupOperationInProgressError();
  }
  webOperationRunning = true;

  try {
    return await operation();
  } finally {
    webOperationRunning = false;
  }
}

// =============================================================================
// State Management
// =============================================================================

interface SetupState {
  status: 'idle' | 'configuring' | 'provisioning' | 'deploying' | 'complete' | 'error';
  config: Partial<AuthrimConfig> | null;
  auth: CloudflareAuth | null;
  progress: string[];
  error: string | null;
  deployResults: DeployResult[];
  logPath: string | null;
  operationProgress: {
    operation: 'delete';
    current: number;
    total: number;
  } | null;
  deploymentProgress: DeploymentProgressSnapshot | null;
}

interface ProgressLogState {
  filePath: string;
  detailFilePath: string;
  writeChain: Promise<void>;
}

const state: SetupState = {
  status: 'idle',
  config: null,
  auth: null,
  progress: [],
  error: null,
  deployResults: [],
  logPath: null,
  operationProgress: null,
  deploymentProgress: null,
};

let progressLogState: ProgressLogState | null = null;
let deploymentProgressTracking = false;

function buildDomainRoutingValidationResult(config: AuthrimConfig) {
  const conflicts = validateDomainRoutingConfig({
    apiDomain: config.urls?.api?.custom,
    loginUiDomain: config.urls?.loginUi?.custom,
    adminUiDomain: config.urls?.adminUi?.custom,
    multiTenant: config.tenant.multiTenant,
    nakedDomain: config.tenant.nakedDomain,
  });

  const routingConflicts = conflicts.map((conflict) => ({
    path: conflict.field === 'loginUiDomain' ? 'urls.loginUi.custom' : 'urls.adminUi.custom',
    message: conflict.message,
  }));

  const depthConflicts = validateSetupDomainInputs({
    apiDomain: config.tenant.multiTenant
      ? config.tenant.baseDomain || ''
      : config.urls?.api?.custom || '',
    loginUiDomain: config.urls?.loginUi?.custom,
    adminUiDomain: config.urls?.adminUi?.custom,
    tenantName: config.tenant.name,
  }).map((issue) => ({
    path:
      issue.field === 'apiDomain'
        ? config.tenant.multiTenant
          ? 'tenant.baseDomain'
          : 'urls.api.custom'
        : issue.field === 'loginUiDomain'
          ? 'urls.loginUi.custom'
          : 'urls.adminUi.custom',
    message: issue.suggestion
      ? `${issue.message} Suggested host: ${issue.suggestion}`
      : issue.message,
  }));

  return [...routingConflicts, ...depthConflicts];
}

function formatLogTimestamp(date = new Date()): string {
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function resolveProgressLogKeysDir(env: string): string {
  const baseDir = findAuthrimBaseDir(process.cwd());
  const foundKeys = findKeysDirectory({
    env,
    sourceDir: baseDir,
    keysBaseDir: process.cwd(),
  });
  if (foundKeys) {
    return foundKeys.path;
  }

  const resolved = resolvePaths({ baseDir, env });
  if (resolved.type === 'legacy') {
    return (resolved.paths as LegacyPaths).keys;
  }

  return getExternalKeysDir(env, process.cwd());
}

async function beginProgressLog(
  env: string,
  operation: 'provision' | 'deploy' | 'delete' | 'update' | 'service-site'
): Promise<string | null> {
  await flushProgressLog();
  progressLogState = null;

  try {
    const logsDir =
      operation === 'delete'
        ? join(findAuthrimBaseDir(process.cwd()), AUTHRIM_DIR, 'logs', env)
        : join(resolveProgressLogKeysDir(env), 'logs');
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const timestampedBaseName = `${formatLogTimestamp()}-${operation}`;
    let sequence = 0;
    let baseName = timestampedBaseName;
    let filePath = join(logsDir, `${baseName}.log`);
    let detailFilePath = join(logsDir, `${baseName}.detail.log`);
    while (existsSync(filePath) || existsSync(detailFilePath)) {
      sequence += 1;
      baseName = `${timestampedBaseName}-${sequence}`;
      filePath = join(logsDir, `${baseName}.log`);
      detailFilePath = join(logsDir, `${baseName}.detail.log`);
    }
    await writeFile(filePath, '', { encoding: 'utf-8', mode: 0o600 });
    await writeFile(detailFilePath, '', { encoding: 'utf-8', mode: 0o600 });
    progressLogState = {
      filePath,
      detailFilePath,
      writeChain: Promise.resolve(),
    };
    state.logPath = filePath;
    appendProgressLogLine(`📝 Detailed log: ${detailFilePath}\n`, { detailOnly: false });
    return filePath;
  } catch {
    state.logPath = null;
    return null;
  }
}

function appendProgressLogLine(line: string, options: { detailOnly?: boolean } = {}): void {
  if (!progressLogState) {
    return;
  }

  progressLogState.writeChain = progressLogState.writeChain
    .then(async () => {
      if (!options.detailOnly) {
        await appendFile(progressLogState!.filePath, line, 'utf-8');
      }
      await appendFile(progressLogState!.detailFilePath, line, 'utf-8');
    })
    .catch(() => {
      // Ignore log persistence failures so setup can continue
    });
}

async function flushProgressLog(): Promise<void> {
  if (!progressLogState) {
    return;
  }

  await progressLogState.writeChain.catch(() => {
    // Ignore log persistence failures so setup can continue
  });
}

function addProgress(message: string): void {
  const timestamp = new Date().toISOString();
  state.progress.push(message);
  if (deploymentProgressTracking) {
    state.deploymentProgress = updateDeploymentProgress(state.deploymentProgress, message);
    if (
      state.deploymentProgress.status === 'complete' ||
      state.deploymentProgress.status === 'error'
    ) {
      deploymentProgressTracking = false;
    }
  }
  appendProgressLogLine(`[${timestamp}] ${message}\n`);
}

function addDetailProgress(message: string): void {
  const timestamp = new Date().toISOString();
  appendProgressLogLine(`[${timestamp}] ${message}\n`, { detailOnly: true });
}

function getStateConfigForEnv(env: string): Partial<AuthrimConfig> | null {
  if (!state.config) {
    return null;
  }
  return state.config.environment?.prefix === env ? state.config : null;
}

const PROVISIONING_COLLISION_INVENTORY: readonly EnvironmentInventoryResource[] = [
  'Workers',
  'D1 databases',
  'KV namespaces',
  'Queues',
  'R2 buckets',
];

export function buildWebProvisioningResourceSpec(config: AuthrimConfig): ProvisioningResourceSpec {
  const environment = config.environment.prefix;
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...stableConfig } = config;
  const normalizedConfig = {
    ...stableConfig,
    keys: {
      ...stableConfig.keys,
      keyId: undefined,
      publicKeyJwk: undefined,
    },
  };
  return JSON.parse(
    JSON.stringify({
      config: normalizedConfig,
      resources: {
        d1: D1_DATABASES.map((database) => ({
          binding: database.binding,
          name: getD1DatabaseName(environment, database.dbType),
        })),
        kv: KV_NAMESPACES.map((binding) => ({
          binding,
          name: getKVNamespaceName(environment, binding),
        })),
        queues: config.features.queue?.enabled === true ? getRequiredQueues(environment) : [],
        r2: getRequiredR2Buckets(environment, {
          includeFeatureBuckets: config.features.r2?.enabled === true,
        }),
        workers: Array.from(getEnabledComponents(config.components)).map((component) => ({
          binding: component,
          name: getWorkerName(environment, component),
        })),
      },
    })
  ) as ProvisioningResourceSpec;
}

async function assertLockedCloudflareResourcesForWebMutation(input: {
  environment: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
}): Promise<void> {
  const requiredQueues =
    input.config.features.queue?.enabled === true ? getRequiredQueues(input.environment) : [];
  const verifyQueues = requiredQueues.length > 0 || Object.keys(input.lock.queues ?? {}).length > 0;
  const requiredR2BucketNames = [
    ...new Set([
      ...Object.values(input.lock.r2 ?? {}).map((bucket) => bucket.name),
      ...getRequiredR2Buckets(input.environment, {
        includeFeatureBuckets: input.config.features.r2?.enabled === true,
      }).map((bucket) => bucket.name),
    ]),
  ];
  const [databases, namespaces, queues, r2Buckets] = await Promise.all([
    listD1Databases(),
    listKVNamespaces(),
    verifyQueues ? listQueues({ strictOutput: true, requireIds: true }) : Promise.resolve([]),
    requiredR2BucketNames.length > 0 ? listR2Buckets({ throwOnError: true }) : Promise.resolve([]),
  ]);
  const d1 = reconcileD1ResourcesInLock(input.lock, input.environment, databases);
  const kv = reconcileSharedKVResourcesInLock(d1.lock, input.environment, namespaces);
  const queue = reconcileQueueResourcesInLock(kv.lock, queues, requiredQueues);
  const mismatches = [
    ...d1.identityMismatches.map((item) => `D1:${item.binding}`),
    ...kv.identityMismatches.map((item) => `KV:${item.binding}`),
    ...queue.identityMismatches.map((item) => `Queue:${item.binding}`),
  ];
  if (mismatches.length > 0) {
    throw new Error(`cloudflare_resource_identity_mismatch:${mismatches.join(',')}`);
  }
  const missing = [
    ...d1.missingBindings.map((item) => `D1:${item.binding}:${item.name}`),
    ...kv.missingBindings.map((item) => `KV:${item.binding}:${item.name}`),
    ...queue.missingBindings.map((item) => `Queue:${item.binding}:${item.name}`),
  ];
  const liveR2Names = new Set(r2Buckets.map((bucket) => bucket.name));
  for (const bucketName of requiredR2BucketNames) {
    if (!liveR2Names.has(bucketName)) missing.push(`R2:${bucketName}`);
  }
  if (missing.length > 0) {
    throw new Error(`required_cloudflare_resources_missing:${missing.join(',')}`);
  }
  await Promise.all(
    Object.entries(input.lock.r2 ?? {}).map(async ([binding, bucket]) => {
      try {
        await assertR2BucketOwnershipIdentity({
          ...bucket,
          environment: input.lock.env,
          binding,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /^R2 (?:bucket .* (?:provider creation_date changed|recorded in lock\.json is missing)|ownership marker (?:identity is invalid|is missing|is invalid|does not match))/u.test(
            message
          )
        ) {
          throw new Error(`cloudflare_resource_identity_mismatch:R2:${binding}`, {
            cause: error,
          });
        }
        throw error;
      }
    })
  );
}

function loadConfigPinnedByProvisioningIntent(intent: ProvisioningIntent): AuthrimConfig {
  const resourceSpec = intent.resourceSpec;
  if (!resourceSpec || typeof resourceSpec !== 'object' || Array.isArray(resourceSpec)) {
    throw new Error('provisioning_intent_config_missing');
  }
  const pinnedConfig = (resourceSpec as Record<string, ProvisioningResourceSpec | undefined>)
    .config;
  if (!pinnedConfig || typeof pinnedConfig !== 'object' || Array.isArray(pinnedConfig)) {
    throw new Error('provisioning_intent_config_missing');
  }
  return AuthrimConfigSchema.parse(pinnedConfig);
}

export async function loadWebProvisioningConfig(input: {
  baseDir: string;
  environment: string;
  intent?: ProvisioningIntent | null;
}): Promise<AuthrimConfig> {
  const { baseDir, environment: env, intent } = input;
  const path = getEnvironmentPaths({ baseDir, env }).config;
  // Once a durable intent exists, volatile Web state must not replace its pinned configuration.
  // Prefer an atomic config artifact only when it still describes the exact checksummed plan.
  // Otherwise recover from the journal: the process may have stopped after intent publication but
  // before replacing an older wizard config with the fully normalized provisioning config.
  if (intent) {
    if (existsSync(path)) {
      const persisted = parseEnvironmentConfigForEnv(
        JSON.parse(await readFile(path, 'utf-8')),
        env
      );
      if (
        calculateProvisioningResourceSpecDigest(buildWebProvisioningResourceSpec(persisted)) ===
        intent.resourceSpecDigest
      ) {
        return persisted;
      }
    }
    return parseEnvironmentConfigForEnv(loadConfigPinnedByProvisioningIntent(intent), env);
  }
  const inMemory = getStateConfigForEnv(env);
  if (inMemory) return AuthrimConfigSchema.parse(inMemory);
  if (existsSync(path)) {
    return parseEnvironmentConfigForEnv(JSON.parse(await readFile(path, 'utf-8')), env);
  }
  return createDefaultConfig(env);
}

async function hasCompleteProvisioningArtifacts(input: {
  baseDir: string;
  environment: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  intent?: ProvisioningIntent;
}): Promise<boolean> {
  const paths = getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment });
  if (
    !existsSync(paths.config) ||
    !input.config.keys.keyId ||
    hasPostProvisioningLockState(input.lock) ||
    (input.intent && input.intent.keyId !== input.config.keys.keyId)
  ) {
    return false;
  }
  const expectedResources = [
    ...D1_DATABASES.map((database) => ({
      kind: 'd1' as const,
      binding: database.binding,
      name: getD1DatabaseName(input.environment, database.dbType),
      lock: input.lock.d1[database.binding],
    })),
    ...KV_NAMESPACES.map((binding) => ({
      kind: 'kv' as const,
      binding,
      name: getKVNamespaceName(input.environment, binding),
      lock: input.lock.kv[binding],
    })),
    ...(input.config.features.queue?.enabled === true
      ? getRequiredQueues(input.environment).map((resource) => ({
          kind: 'queue' as const,
          ...resource,
          lock: input.lock.queues?.[resource.binding],
        }))
      : []),
    ...getRequiredR2Buckets(input.environment, {
      includeFeatureBuckets: input.config.features.r2?.enabled === true,
    }).map((resource) => ({
      kind: 'r2' as const,
      ...resource,
      lock: input.lock.r2?.[resource.binding],
    })),
  ];
  for (const resource of expectedResources) {
    const checkpoint = input.intent?.resources[`${resource.kind}:${resource.binding}`];
    if (
      !hasExactProvisioningResourceIdentity({
        kind: resource.kind,
        binding: resource.binding,
        expectedName: resource.name,
        lock: resource.lock,
        checkpoint,
        requireCheckpoint: input.intent !== undefined,
      })
    ) {
      return false;
    }
    if (resource.kind === 'r2') {
      try {
        await assertR2BucketOwnershipForUse({
          ...resource.lock!,
          environment: input.environment,
          binding: resource.binding,
        });
      } catch {
        return false;
      }
    }
  }
  const expectedBindingsByKind = {
    d1: expectedResources
      .filter((resource) => resource.kind === 'd1')
      .map((resource) => resource.binding),
    kv: expectedResources
      .filter((resource) => resource.kind === 'kv')
      .map((resource) => resource.binding),
    queue: expectedResources
      .filter((resource) => resource.kind === 'queue')
      .map((resource) => resource.binding),
    r2: expectedResources
      .filter((resource) => resource.kind === 'r2')
      .map((resource) => resource.binding),
  };
  const hasExactBindings = (actual: string[], expected: string[]): boolean =>
    actual.length === expected.length && expected.every((binding) => actual.includes(binding));
  if (
    !hasExactBindings(Object.keys(input.lock.d1), expectedBindingsByKind.d1) ||
    !hasExactBindings(Object.keys(input.lock.kv), expectedBindingsByKind.kv) ||
    !hasExactBindings(Object.keys(input.lock.queues ?? {}), expectedBindingsByKind.queue) ||
    !hasExactBindings(Object.keys(input.lock.r2 ?? {}), expectedBindingsByKind.r2)
  ) {
    return false;
  }
  const wranglerStatuses = await checkWranglerStatus({
    baseDir: input.baseDir,
    env: input.environment,
    packagesDir: join(input.baseDir, 'packages'),
    components: Array.from(getEnabledComponents(input.config.components)),
  });
  if (
    wranglerStatuses.some(
      (status) => !status.masterExists || !status.deployExists || !status.inSync
    )
  ) {
    return false;
  }
  const remoteEnvironment = (
    await detectEnvironments(undefined, {
      requiredResources: ['D1 databases', 'KV namespaces', 'Queues', 'R2 buckets'],
    })
  ).find((candidate) => candidate.env === input.environment);
  if (!remoteEnvironment) return false;
  const expectedNamesByKind = {
    d1: expectedResources
      .filter((resource) => resource.kind === 'd1')
      .map((resource) => resource.name),
    kv: expectedResources
      .filter((resource) => resource.kind === 'kv')
      .map((resource) => resource.name),
    queue: expectedResources
      .filter((resource) => resource.kind === 'queue')
      .map((resource) => resource.name),
    r2: expectedResources
      .filter((resource) => resource.kind === 'r2')
      .map((resource) => resource.name),
  };
  const hasExactRemoteNames = (actual: Array<{ name: string }>, expected: string[]): boolean =>
    actual.length === expected.length &&
    expected.every((name) => actual.some((item) => item.name === name));
  if (
    !hasExactRemoteNames(remoteEnvironment.d1, expectedNamesByKind.d1) ||
    !hasExactRemoteNames(remoteEnvironment.kv, expectedNamesByKind.kv) ||
    !hasExactRemoteNames(remoteEnvironment.queues, expectedNamesByKind.queue) ||
    !hasExactRemoteNames(remoteEnvironment.r2, expectedNamesByKind.r2)
  ) {
    return false;
  }
  for (const resource of expectedResources) {
    const remote =
      resource.kind === 'd1'
        ? remoteEnvironment.d1.find((candidate) => candidate.name === resource.name)
        : resource.kind === 'kv'
          ? remoteEnvironment.kv.find((candidate) => candidate.name === resource.name)
          : resource.kind === 'queue'
            ? remoteEnvironment.queues.find((candidate) => candidate.name === resource.name)
            : remoteEnvironment.r2.find((candidate) => candidate.name === resource.name);
    if (
      !hasExactProvisioningResourceIdentity({
        kind: resource.kind,
        binding: resource.binding,
        expectedName: resource.name,
        lock: resource.lock,
        checkpoint: input.intent?.resources[`${resource.kind}:${resource.binding}`],
        requireCheckpoint: input.intent !== undefined,
        remote,
      })
    ) {
      return false;
    }
  }
  try {
    const persisted = parseEnvironmentConfigForEnv(
      JSON.parse(await readFile(paths.config, 'utf-8')),
      input.environment
    );
    if (
      persisted.cloudflare?.accountId !== input.config.cloudflare?.accountId ||
      persisted.keys.keyId !== input.config.keys.keyId
    ) {
      return false;
    }
    if (
      input.intent &&
      calculateProvisioningResourceSpecDigest(buildWebProvisioningResourceSpec(persisted)) !==
        input.intent.resourceSpecDigest
    ) {
      return false;
    }
    const keysBaseDir = deriveExternalKeysBaseDirFromConfigPath(
      input.environment,
      persisted.keys.secretsPath
    );
    const keys = await loadKeysFromDirectory({
      baseDir: input.baseDir,
      env: input.environment,
      keysBaseDir,
    });
    return keys.keyPair?.keyId === persisted.keys.keyId;
  } catch {
    return false;
  }
}

export function normalizeWebProvisioningConfigForIntent(input: {
  config: AuthrimConfig;
  environment: string;
  workersSubdomain: string | null;
  now?: string;
}): AuthrimConfig {
  const { config, environment, workersSubdomain } = input;
  const now = input.now ?? new Date().toISOString();
  const apiUrl = workersSubdomain
    ? `https://${environment}-ar-router.${workersSubdomain}.workers.dev`
    : `https://${environment}-ar-router.workers.dev`;
  return AuthrimConfigSchema.parse({
    ...config,
    createdAt: config.createdAt || now,
    updatedAt: now,
    urls: buildUrlsConfig({
      env: environment,
      apiDomain: config.urls?.api?.custom || null,
      loginUiDomain: config.urls?.loginUi?.custom || null,
      adminUiDomain: config.urls?.adminUi?.custom || null,
      zoneId: config.urls?.api?.zoneId ?? null,
      customDomainBinding: config.urls?.api?.customDomainBinding ?? false,
      workersSubdomain,
      existingUrls: {
        api: { ...config.urls?.api, auto: apiUrl },
        loginUi: config.urls?.loginUi,
        adminUi: config.urls?.adminUi,
      },
    }),
  });
}

export function parseEnvironmentConfigForEnv(rawConfig: unknown, env: string): AuthrimConfig {
  const config = AuthrimConfigSchema.parse(rawConfig);
  if (config.environment.prefix !== env) {
    throw new Error(
      `Config environment mismatch: requested "${env}" but config is for "${config.environment.prefix}"`
    );
  }
  return config;
}

async function loadEnvironmentConfigForUpdate(
  baseDir: string,
  env: string
): Promise<{
  envPaths: EnvironmentPaths;
  config: AuthrimConfig;
}> {
  const envPaths = getEnvironmentPaths({ baseDir, env, keysBaseDir: process.cwd() });

  if (!existsSync(envPaths.config)) {
    throw new Error(`Config file not found for environment "${env}"`);
  }

  const configContent = await readFile(envPaths.config, 'utf-8');
  return {
    envPaths,
    config: parseEnvironmentConfigForEnv(JSON.parse(configContent), env),
  };
}

async function saveEnvironmentConfig(
  envPaths: EnvironmentPaths,
  config: AuthrimConfig
): Promise<void> {
  await mkdir(envPaths.root, { recursive: true });
  await writePrivateFileAtomically(envPaths.config, `${JSON.stringify(config, null, 2)}\n`);
}

export function resolveWebDeploymentKeysDir(
  rootDir: string,
  env: string,
  config?: Partial<AuthrimConfig> | null
): string {
  if (config?.keys?.storageType === 'external') {
    if (config.keys.secretsPath === './keys/' || config.keys.secretsPath === 'keys/') {
      return getExternalKeysDir(env, rootDir);
    }
    const keysBaseDir = deriveExternalKeysBaseDirFromConfigPath(env, config.keys.secretsPath);
    return getExternalKeysDir(env, keysBaseDir);
  }
  if (config?.keys?.storageType === 'internal') {
    return getEnvironmentPaths({ baseDir: rootDir, env }).keys;
  }
  return resolveDownstreamIntrospectionKeysDir({
    env,
    rootDir,
    keysBaseDir: process.cwd(),
  });
}

async function ensureSupplementalKeysForWebDeploy(keysDir: string): Promise<void> {
  if (!existsSync(keysDir)) {
    return;
  }

  const result = await ensureSupplementalKeyFiles(keysDir);
  if (result.createdFiles.length === 0) {
    return;
  }

  addProgress(`Created ${result.createdFiles.length} supplemental key file(s) in ${keysDir}`);
  for (const filePath of result.createdFiles) {
    addProgress(`  - ${filePath.replace(`${keysDir}/`, '')}`);
  }
}

async function loadSupplementalSecretsForWorkers(options: {
  env: string;
  baseDir: string;
  config?: AuthrimConfig;
  keysDir: string;
  workers: WorkerComponent[];
}): Promise<Record<string, string>> {
  const { env, keysDir, workers } = options;
  if (!existsSync(keysDir)) {
    addProgress(`Warning: Keys directory not found at ${keysDir}`);
    return {};
  }

  if (options.config) {
    await promotePendingEmailSecrets({
      baseDir: options.baseDir,
      environment: env,
      keysDir,
      configuredEmail: options.config.features.email,
    });
  }
  await ensureSupplementalKeysForWebDeploy(keysDir);
  const secrets = await loadDeploySecretsFromKeys(keysDir, workers);
  addProgress(
    `Prepared ${Object.keys(secrets).length} secret value(s) for ${env} Worker deployment.`
  );
  return secrets;
}

async function maybeConfigureDownstreamIntrospectionForWebDeploy(options: {
  env: string;
  rootDir: string;
  config?: Partial<AuthrimConfig> | null;
  components: string[];
  knownRouterReadyBaseUrls?: string[];
  dryRun?: boolean;
  deployConfigLockProof?: DeployConfigLockProof;
}): Promise<void> {
  const { env, rootDir, config, components, knownRouterReadyBaseUrls, dryRun } = options;
  if (dryRun || !components.includes('ar-userinfo')) {
    return;
  }

  const keysDir = resolveWebDeploymentKeysDir(rootDir, env, config);
  let downstreamSetupResult;
  try {
    downstreamSetupResult = await configureDownstreamIntrospectionDeployment({
      env,
      rootDir,
      keysDir,
      apiBaseUrl: resolveIssuerUrl(config, { env }),
      apiBaseUrls: resolveApiBaseUrlCandidates(config, { env, purpose: 'tenant-scoped-admin' }),
      knownRouterReadyBaseUrls,
      tenantId: config?.tenant?.name,
      dryRun,
      deployConfigLockProof: options.deployConfigLockProof,
      onProgress: addProgress,
      onDetail: addDetailProgress,
    });
  } catch (error) {
    const detail = sanitizeError(error);
    addDetailProgress(`Downstream introspection setup failed unexpectedly: ${detail}`);
    downstreamSetupResult = createDownstreamIntrospectionFailure(detail);
  }

  if (!downstreamSetupResult.success) {
    addDetailProgress(
      `Downstream introspection setup deferred: ${downstreamSetupResult.error ?? 'Unknown error'}`
    );
    addProgress('⚠️ Optional downstream grant introspection was deferred.');
    addProgress(
      downstreamSetupResult.impact ?? 'Core login, Admin UI, and token issuance remain available.'
    );
    addProgress(
      downstreamSetupResult.nextAction ?? 'Rerun deploy to retry the optional integration.'
    );
    for (const error of downstreamSetupResult.secretUploadErrors ?? []) {
      addDetailProgress(`Downstream introspection secret upload failed: ${error}`);
    }
    return;
  }

  if (!downstreamSetupResult.redeployResult?.deployedAt) {
    return;
  }

  const { loadLockFileAuto } = await import('../core/lock.js');
  const { lock: currentLock, path: lockPath } = await loadLockFileAuto(rootDir, env);

  if (!currentLock || !lockPath) {
    addProgress('⚠️ Downstream introspection setup completed, but lock file was not available');
    return;
  }

  const updatedLock = updateLockWithDeployments(currentLock, [
    downstreamSetupResult.redeployResult,
  ]);
  await saveLockFile(updatedLock, lockPath);
  addProgress(`✓ ${downstreamSetupResult.redeployResult.workerName} redeployed successfully`);
  addProgress(`Lock file updated: ${lockPath}`);
}

function clearProgress(): void {
  state.progress = [];
  state.operationProgress = null;
  state.deploymentProgress = null;
  deploymentProgressTracking = false;
}

function startInitialDeploymentProgress(): void {
  clearProgress();
  deploymentProgressTracking = true;
}

function markInitialDeploymentError(message: string): void {
  state.status = 'error';
  state.error = message;
  addProgress(`❌ ${message}`);
}

function markOperationError(message: string): string {
  state.status = 'error';
  state.error = message;
  addProgress(`❌ ${message}`);
  return message;
}

function markInitialDeploymentManualAction(): void {
  if (state.deploymentProgress) {
    state.deploymentProgress = { ...state.deploymentProgress, terminal: true };
  }
  deploymentProgressTracking = false;
}

/**
 * Sanitize error messages to prevent information leakage
 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remove potential file paths and secrets
  return message
    .replace(/\/[^\s:]+/g, '[path]')
    .replace(/\\[^\s:]+/g, '[path]')
    .replace(/[a-f0-9]{32,}/gi, '[redacted]');
}

function isSameLoopbackOrigin(requestUrl: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const request = new URL(requestUrl);
    const source = new URL(origin);
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
    return source.origin === request.origin && loopback.has(source.hostname);
  } catch {
    return false;
  }
}

function getWildcardDnsManualActionPayload(
  cfg: Partial<AuthrimConfig> | null | undefined
): { kind: 'wildcard-dns'; baseDomain: string } | null {
  const baseDomain = cfg?.tenant?.multiTenant === true ? cfg.tenant.baseDomain?.trim() : undefined;
  if (!baseDomain) {
    return null;
  }

  return {
    kind: 'wildcard-dns',
    baseDomain,
  };
}

function canContinueAfterRouterReadinessFailure(
  cfg: Partial<AuthrimConfig> | null | undefined,
  error: string | undefined
): boolean {
  if (cfg?.urls?.api?.customDomainBinding !== true) {
    return false;
  }
  return /ENOTFOUND|getaddrinfo|dns/i.test(error || '');
}

function handleRouterReadinessFailure(
  cfg: Partial<AuthrimConfig> | null | undefined,
  checkedUrl: string,
  error: string | undefined,
  addProgress: (message: string) => void
): void {
  addDetailProgress(
    `Router readiness failure detail: ${JSON.stringify({
      checkedUrl,
      error: error || null,
      apiCustom: cfg?.urls?.api?.custom || null,
      apiAuto: cfg?.urls?.api?.auto || null,
      customDomainBinding: cfg?.urls?.api?.customDomainBinding === true,
      multiTenant: cfg?.tenant?.multiTenant === true,
      baseDomain: cfg?.tenant?.baseDomain || null,
      nakedDomain: cfg?.tenant?.nakedDomain === true,
    })}`
  );

  if (canContinueAfterRouterReadinessFailure(cfg, error)) {
    addProgress(
      `⚠️ API router custom domain could not be resolved by this setup process: ${checkedUrl}`
    );
    addProgress(
      '⚠️ Continuing because Worker deployment is visible and the API uses Cloudflare custom domain binding.'
    );
    addProgress(
      '⚠️ If the browser can reach the URL, this is likely local DNS resolver lag in the setup environment.'
    );
    return;
  }

  throw new Error(
    `API router did not become reachable at ${checkedUrl}: ${error || 'unknown readiness error'}`
  );
}

interface WorkerUpdateReadinessEvidence {
  component: WorkerComponent;
  workerName: string;
  deployedAt: string;
  cloudflareVersionId: string;
  cloudflareScriptTag: string;
}

async function verifyWorkerUpdateReadiness(input: {
  config: AuthrimConfig;
  results: WorkerUpdateReadinessEvidence[];
  verifyRouter: boolean;
  onProgress: (message: string) => void;
}): Promise<void> {
  if (input.results.length === 0) return;

  const deploymentResult = await waitForWorkerDeploymentsReady({
    targets: input.results.map((result) => ({
      workerName: result.workerName,
      deployedAt: result.deployedAt,
      expectedVersionId: result.cloudflareVersionId,
    })),
    onProgress: input.onProgress,
  });
  if (!deploymentResult.ready) {
    throw new Error(
      `Worker deployments did not become visible: ${deploymentResult.error || 'unknown verification error'}`
    );
  }

  const workersSubdomain = await getWorkersSubdomain();
  const httpTargets = buildWorkerHttpReadinessTargets(input.results, workersSubdomain, {
    workersDevEnabled: !input.config.urls?.api?.custom,
  });
  if (httpTargets.length > 0) {
    const httpResult = await waitForWorkerHttpReady({
      targets: httpTargets,
      onProgress: input.onProgress,
    });
    if (!httpResult.ready) {
      throw new Error(
        `Worker HTTP health checks failed: ${httpResult.error || 'unknown health check error'}`
      );
    }
  }

  if (input.verifyRouter && input.results.some((result) => result.component === 'ar-router')) {
    const apiBaseUrl = resolveIssuerUrl(input.config, {
      env: input.config.environment.prefix,
    });
    const readinessResult = await waitForRouterWorkerReady({
      apiBaseUrl,
      onProgress: input.onProgress,
      onDetail: addDetailProgress,
    });
    if (!readinessResult.ready) {
      handleRouterReadinessFailure(
        input.config,
        readinessResult.checkedUrl,
        readinessResult.error,
        input.onProgress
      );
    }
  }
}

// =============================================================================
// API Routes
// =============================================================================

export function createApiRoutes(): Hono {
  const api = new Hono();

  api.onError((error, c) => {
    if (error instanceof SetupOperationInProgressError) {
      return c.json(
        {
          success: false,
          error: error.message,
          errorCode: 'setup_operation_in_progress',
        },
        409
      );
    }
    return c.json({ success: false, error: sanitizeError(error) }, 500);
  });

  api.use('*', async (c, next) => {
    await next();
    if (c.res.status !== 500 || !c.res.headers.get('Content-Type')?.includes('application/json')) {
      return;
    }
    const payload = (await c.res
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null;
    if (!isEnvironmentOperationConflict(payload?.error)) {
      return;
    }
    c.res = c.json(
      {
        ...payload,
        success: false,
        error: 'Another setup operation is already in progress. Wait for it to finish and retry.',
        errorCode: 'setup_operation_in_progress',
      },
      409
    );
  });

  // Session token validation middleware for mutating operations
  const validateSession = async (
    c: Parameters<Parameters<typeof api.use>[1]>[0],
    next: () => Promise<void>
  ) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      await next();
      return;
    }
    const token = c.req.header('X-Session-Token');
    if (!sessionToken || token !== sessionToken) {
      return c.json({ error: 'Invalid or missing session token' }, 401);
    }
    await next();
  };

  // Apply session validation to all POST/PUT/DELETE routes
  api.use('/config', validateSession);
  api.use('/config/*', validateSession);
  api.use('/keys/*', validateSession);
  api.use('/email/*', validateSession);
  api.use('/service-site/*', validateSession);
  api.use('/provision', validateSession);
  api.use('/wrangler/*', validateSession);
  api.use('/deploy', validateSession);
  api.use('/reset', validateSession);
  api.use('/admin/*', validateSession);
  api.use('/cloudflare/*', validateSession);
  api.use('/control', validateSession);
  api.use('/control/*', validateSession);
  api.use('/r2/*', validateSession);

  // ==========================================================================
  // Cloudflare Zone Check
  // ==========================================================================

  api.post('/cloudflare/check-zone', async (c) => {
    try {
      const body = (await c.req.json()) as { domain?: string };
      const { domain } = body;

      if (!domain || typeof domain !== 'string') {
        return c.json({ found: false, error: 'domain is required' }, 400);
      }
      if (
        !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)
      ) {
        return c.json({ found: false, error: 'Invalid domain format' }, 400);
      }

      const { checkZoneExists } = await import('../core/cloudflare.js');
      const result = await checkZoneExists(domain);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json(
        {
          found: false,
          error: message,
          diagnostic: {
            code: 'api_error',
            severity: 'error',
            allowBinding: false,
            actions: ['retry_check', 'reload_page'],
          },
        },
        500
      );
    }
  });

  api.post('/cloudflare/control-token-template', async (c) => {
    if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
      return c.json({ success: false, error: 'Invalid setup origin' }, 403);
    }
    const parsed = z
      .object({ env: EnvNameSchema })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid environment name' }, 400);
    }
    try {
      const baseDir = findAuthrimBaseDir(process.cwd());
      const resolved = resolvePaths({ baseDir, env: parsed.data.env });
      const configPath =
        resolved.type === 'new'
          ? (resolved.paths as EnvironmentPaths).config
          : (resolved.paths as LegacyPaths).config;
      const config = existsSync(configPath)
        ? parseEnvironmentConfigForEnv(
            JSON.parse(await readFile(configPath, 'utf-8')),
            parsed.data.env
          )
        : getStateConfigForEnv(parsed.data.env);
      if (!config) return c.json({ success: false, error: 'Environment is not configured' }, 409);
      const wranglerAccountId = await getAccountId();
      if (!wranglerAccountId) {
        return c.json({ success: false, error: 'Wrangler account is unavailable' }, 409);
      }
      if (config.cloudflare?.accountId && config.cloudflare.accountId !== wranglerAccountId) {
        return c.json({ success: false, error: 'Cloudflare account mismatch' }, 409);
      }
      const credential = await getCloudflareApiToken();
      const ownership: CloudflareTokenOwnership =
        credential?.source === 'oauth'
          ? await selectPreferredCloudflareTokenOwnership({
              accountId: wranglerAccountId,
              wranglerOAuthToken: credential.token,
            })
          : 'user';
      return c.json({
        success: true,
        ownership,
        expiresOnDate: buildCloudflareBootstrapTokenEndDate(),
        url: buildCloudflareBootstrapTemplateUrl({
          accountId: wranglerAccountId,
          environment: parsed.data.env,
          ownership,
        }),
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.get('/control/automatic-provisioning/status', async (c) => {
    const parsed = EnvNameSchema.safeParse(c.req.query('env'));
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid environment name' }, 400);
    }
    try {
      const baseDir = findAuthrimBaseDir(process.cwd());
      const { config } = await loadEnvironmentConfigForUpdate(baseDir, parsed.data);
      const { lock } = await loadLockFileAuto(baseDir, parsed.data);
      const controlDatabaseId = lock?.d1.CONTROL_DB?.id;
      const authority = controlDatabaseId
        ? await readControlProvisioningAuthority({
            controlDatabaseName: controlDatabaseId,
            environmentId: parsed.data,
          })
        : null;
      const requiredResourceClasses = resolveControlTokenResourceClasses(config);
      const controlSecretSink = new WranglerControlSecretSink({
        workerName: `${parsed.data}-ar-control`,
        cwd: baseDir,
      });
      const missingResourceClasses =
        authority?.automaticProvisioningEnabled === true && authority.capabilityState === 'ready'
          ? await findMissingControlTokenResourceClasses({
              resourceClasses: requiredResourceClasses,
              secretSink: controlSecretSink,
            })
          : [];
      const readyGenerationMatches =
        authority?.automaticProvisioningEnabled === true && authority.capabilityState === 'ready'
          ? await hasReadyControlTokenBootstrap({
              environmentId: parsed.data,
              controlDatabaseName: controlDatabaseId!,
              resourceClasses: requiredResourceClasses,
              secretSink: controlSecretSink,
            })
          : true;
      const effectiveAuthority = authority
        ? {
            ...publicControlProvisioningAuthority(authority),
            ...(missingResourceClasses.length > 0 || !readyGenerationMatches
              ? { capabilityState: 'blocked' as const }
              : {}),
          }
        : null;
      return c.json({
        success: true,
        controlPlane: true,
        enabled: config.controlPlane?.automaticProvisioning === true,
        authority: effectiveAuthority,
        missingResourceClasses,
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.post('/control/automatic-provisioning/prepare', async (c) => {
    if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
      return c.json({ success: false, error: 'Invalid setup origin' }, 403);
    }
    const parsed = z
      .object({
        env: EnvNameSchema,
        ownership: z.enum(['account', 'user']).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid Automatic provisioning request' }, 400);
    }
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const baseDir = findAuthrimBaseDir(process.cwd());
        const { envPaths, config } = await loadEnvironmentConfigForUpdate(baseDir, parsed.data.env);
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsed.data.env,
          operation: 'web-control-automatic-provisioning-prepare',
          requireExisting: true,
        });
        const controlDatabaseId = operationLock.lock?.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          return c.json({ success: false, error: 'Control database is not configured' }, 409);
        }
        const currentAuthority = await readControlProvisioningAuthority({
          controlDatabaseName: controlDatabaseId,
          environmentId: parsed.data.env,
        });
        if (currentAuthority && currentAuthority.bootstrapPhase !== 'none') {
          return c.json(
            {
              success: false,
              error: 'A checkpointed token cutover must be resumed with the same bootstrap token',
            },
            409
          );
        }
        const updatedConfig = AuthrimConfigSchema.parse({
          ...config,
          controlPlane: { automaticProvisioning: true },
          updatedAt: new Date().toISOString(),
        });
        await saveEnvironmentConfig(envPaths, updatedConfig);
        try {
          await writeControlProvisioningAuthority({
            controlDatabaseName: controlDatabaseId,
            environmentId: parsed.data.env,
            automaticProvisioningEnabled: true,
            tokenOwnership: 'none',
            capabilityState: 'pending',
          });
        } catch (error) {
          await saveEnvironmentConfig(envPaths, config).catch(() => undefined);
          throw error;
        }
        state.config = updatedConfig;
        return c.json({ success: true, enabled: true, capabilityState: 'pending' });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  api.post('/control/automatic-provisioning/cancel-pending', async (c) => {
    if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
      return c.json({ success: false, error: 'Invalid setup origin' }, 403);
    }
    const parsed = z
      .object({ env: EnvNameSchema })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid Automatic provisioning request' }, 400);
    }
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const baseDir = findAuthrimBaseDir(process.cwd());
        const { envPaths, config } = await loadEnvironmentConfigForUpdate(baseDir, parsed.data.env);
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsed.data.env,
          operation: 'web-control-automatic-provisioning-cancel-pending',
          requireExisting: true,
        });
        const controlDatabaseId = operationLock.lock?.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          return c.json({ success: false, error: 'Control database is not configured' }, 409);
        }
        const authority = await readControlProvisioningAuthority({
          controlDatabaseName: controlDatabaseId,
          environmentId: parsed.data.env,
        });
        if (!isTokenlessPendingControlProvisioningAuthority(authority)) {
          return c.json(
            { success: false, error: 'Only tokenless pending authority can be canceled' },
            409
          );
        }
        const disabledConfig = AuthrimConfigSchema.parse({
          ...config,
          controlPlane: { automaticProvisioning: false },
          updatedAt: new Date().toISOString(),
        });
        await saveEnvironmentConfig(envPaths, disabledConfig);
        try {
          const disabledAuthority = await writeControlProvisioningAuthority({
            controlDatabaseName: controlDatabaseId,
            environmentId: parsed.data.env,
            automaticProvisioningEnabled: false,
            tokenOwnership: 'none',
            capabilityState: 'disabled',
          });
          state.config = disabledConfig;
          return c.json({
            success: true,
            enabled: false,
            authority: publicControlProvisioningAuthority(disabledAuthority),
          });
        } catch (error) {
          await saveEnvironmentConfig(envPaths, config).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  api.post('/control/automatic-provisioning/complete', async (c) => {
    if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
      return c.json({ success: false, error: 'Invalid setup origin' }, 403);
    }
    const parsed = z
      .object({
        env: EnvNameSchema,
        bootstrapToken: z.string().min(20).max(4096).regex(/^\S+$/u).optional(),
        ownership: z.enum(['account', 'user']).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid bootstrap token input' }, 400);
    }

    let bootstrapToken = parsed.data.bootstrapToken ?? '';
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let controlDatabaseIdForRecovery: string | undefined;
      let baseDirForRecovery: string | undefined;
      try {
        const baseDir = findAuthrimBaseDir(process.cwd());
        baseDirForRecovery = baseDir;
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsed.data.env,
          operation: 'web-control-automatic-provisioning-complete',
          requireExisting: true,
        });
        const { config } = await loadEnvironmentConfigForUpdate(baseDir, parsed.data.env);
        if (config.controlPlane?.automaticProvisioning !== true) {
          return c.json(
            { success: false, error: 'Automatic provisioning is not pending for this environment' },
            409
          );
        }

        const lock = operationLock.lock;
        const controlDatabaseId = lock?.d1.CONTROL_DB?.id;
        controlDatabaseIdForRecovery = controlDatabaseId;
        const controlWorker = lock?.workers?.['ar-control'];
        if (!controlDatabaseId || !controlWorker) {
          return c.json(
            { success: false, error: 'Control Worker deployment is not available' },
            409
          );
        }
        const pendingAuthority = await readControlProvisioningAuthority({
          controlDatabaseName: controlDatabaseId,
          environmentId: parsed.data.env,
        });
        const deployedAt = controlWorker.deployedAt
          ? Date.parse(controlWorker.deployedAt)
          : Number.NaN;
        const recoveringCutover =
          pendingAuthority?.bootstrapPhase === 'pending_revocation' ||
          pendingAuthority?.bootstrapPhase === 'cutover_verified';
        if (
          pendingAuthority?.automaticProvisioningEnabled !== true ||
          (!recoveringCutover &&
            (pendingAuthority.capabilityState !== 'pending' ||
              pendingAuthority.tokenOwnership !== 'none' ||
              !Number.isFinite(deployedAt) ||
              deployedAt <= pendingAuthority.updatedAt * 1000))
        ) {
          return c.json(
            {
              success: false,
              error: 'Control Worker must be redeployed after Automatic provisioning preparation',
            },
            409
          );
        }

        const wranglerAccountId = await getAccountId();
        if (
          !wranglerAccountId ||
          (config.cloudflare?.accountId && config.cloudflare.accountId !== wranglerAccountId)
        ) {
          return c.json({ success: false, error: 'Cloudflare account mismatch' }, 409);
        }

        // The secret-bearing artifact is read only while this environment's operation lock is
        // held. It may be one durable step ahead of Control when the previous process stopped
        // after staging the child generation but before writing the authority checkpoint.
        const pendingArtifact = await loadPendingControlBootstrap({
          baseDir,
          environment: parsed.data.env,
        });
        if (
          pendingArtifact &&
          (pendingArtifact.accountId !== wranglerAccountId ||
            pendingArtifact.environment !== parsed.data.env)
        ) {
          throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
        }
        const recoveringBeforeAuthorityWrite =
          pendingArtifact !== null &&
          isTokenlessPendingControlProvisioningAuthority(pendingAuthority);
        const recoveringBootstrap = recoveringCutover || recoveringBeforeAuthorityWrite;
        if (!recoveringBootstrap && !bootstrapToken) {
          return c.json({ success: false, error: 'Bootstrap token is required' }, 400);
        }
        const detectedOwnership = recoveringBeforeAuthorityWrite
          ? pendingArtifact.ownership
          : recoveringCutover
            ? pendingAuthority.bootstrapTokenOwnership === 'none'
              ? null
              : pendingAuthority.bootstrapTokenOwnership
            : await detectCloudflareTokenOwnership({
                accountId: wranglerAccountId,
                token: bootstrapToken,
              });
        if (!detectedOwnership)
          throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_inactive');
        if (parsed.data.ownership && parsed.data.ownership !== detectedOwnership) {
          throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_ownership_mismatch');
        }

        await completeControlTokenBootstrap({
          accountId: wranglerAccountId,
          environment: parsed.data.env,
          rootDir: baseDir,
          controlDatabaseName: controlDatabaseId,
          ...(bootstrapToken ? { bootstrapToken } : {}),
          ownership: detectedOwnership,
          resourceClasses: resolveControlTokenResourceClasses(config),
        });
        bootstrapToken = '';
        const authority = await readControlProvisioningAuthority({
          controlDatabaseName: controlDatabaseId,
          environmentId: parsed.data.env,
        });
        if (
          authority?.automaticProvisioningEnabled !== true ||
          authority.capabilityState !== 'ready' ||
          authority.tokenOwnership !== detectedOwnership ||
          authority.tokenManagement !== 'setup'
        ) {
          throw new Error('control_provisioning_authority_reflection_failed');
        }
        const reconciled = reconcileControlSecretGenerationWorkerLock({
          lock: lock!,
          authority,
        });
        if (reconciled.changed) {
          await saveLockFile(reconciled.lock, operationLock.lockFilePath);
        }
        return c.json({
          success: true,
          authority: publicControlProvisioningAuthority(authority),
        });
      } catch (error) {
        const recoveryAuthority = controlDatabaseIdForRecovery
          ? await readControlProvisioningAuthority({
              controlDatabaseName: controlDatabaseIdForRecovery,
              environmentId: parsed.data.env,
            }).catch(() => null)
          : null;
        const recoveryArtifact = baseDirForRecovery
          ? await loadPendingControlBootstrap({
              baseDir: baseDirForRecovery,
              environment: parsed.data.env,
            }).catch(() => null)
          : null;
        return c.json(
          {
            success: false,
            error: sanitizeError(error),
            cleanupRequired:
              error instanceof CloudflareTokenBootstrapError && error.cleanupRequired,
            bootstrapRetainedForRetry:
              error instanceof CloudflareTokenBootstrapError && error.bootstrapRetainedForRetry,
            recoveryTokenRequired:
              error instanceof CloudflareTokenBootstrapError &&
              error.code === 'cloudflare_bootstrap_recovery_token_required',
            cutoverPending:
              (recoveryAuthority !== null && recoveryAuthority.bootstrapPhase !== 'none') ||
              recoveryArtifact !== null,
            capabilityDiagnostic:
              error instanceof CloudflareTokenBootstrapError
                ? error.capabilityDiagnostic
                : undefined,
          },
          500
        );
      } finally {
        bootstrapToken = '';
        await operationLock?.release();
      }
    });
  });

  api.post('/control/automatic-provisioning/cleanup-bootstrap', async (c) => {
    if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
      return c.json({ success: false, error: 'Invalid setup origin' }, 403);
    }
    const parsed = z
      .object({
        env: EnvNameSchema,
        bootstrapToken: z.string().min(20).max(4096).regex(/^\S+$/u),
        ownership: z.enum(['account', 'user']).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid bootstrap cleanup input' }, 400);
    }

    let bootstrapToken = parsed.data.bootstrapToken;
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const baseDir = findAuthrimBaseDir(process.cwd());
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsed.data.env,
          operation: 'web-control-automatic-provisioning-cleanup-bootstrap',
          requireExisting: true,
        });
        const { config } = await loadEnvironmentConfigForUpdate(baseDir, parsed.data.env);
        const wranglerAccountId = await getAccountId();
        if (
          !wranglerAccountId ||
          (config.cloudflare?.accountId && config.cloudflare.accountId !== wranglerAccountId)
        ) {
          return c.json({ success: false, error: 'Cloudflare account mismatch' }, 409);
        }
        const detectedOwnership = await detectCloudflareTokenOwnership({
          accountId: wranglerAccountId,
          token: bootstrapToken,
        });
        if (!detectedOwnership) {
          bootstrapToken = '';
          throw new CloudflareTokenBootstrapError(
            'cloudflare_bootstrap_revocation_unconfirmed',
            true,
            undefined,
            true
          );
        }
        if (parsed.data.ownership && parsed.data.ownership !== detectedOwnership) {
          throw new CloudflareTokenBootstrapError(
            'cloudflare_bootstrap_token_ownership_mismatch',
            true
          );
        }
        await cleanupCloudflareBootstrapToken({
          accountId: wranglerAccountId,
          environment: parsed.data.env,
          ownership: detectedOwnership,
          bootstrapToken,
        });
        bootstrapToken = '';
        return c.json({ success: true, revoked: true });
      } catch (error) {
        return c.json(
          {
            success: false,
            error: sanitizeError(error),
            cleanupRequired: true,
          },
          500
        );
      } finally {
        bootstrapToken = '';
        await operationLock?.release();
      }
    });
  });

  // Get current state (no auth required - read-only)
  api.get('/state', (c) => {
    return c.json(state);
  });

  // Check prerequisites (no auth required - read-only)
  api.get('/prerequisites', async (c) => {
    const wranglerInstalled = await isWranglerInstalled();
    const auth = await checkAuth();
    const workersSubdomain = auth.isLoggedIn ? await getWorkersSubdomain() : null;
    const capabilityDiagnostics = await getSetupCapabilityDiagnostics(
      auth,
      wranglerInstalled,
      workersSubdomain
    );
    const capabilities = deriveSetupCapabilityEstimate(capabilityDiagnostics);
    const capabilityStatuses = deriveSetupCapabilityStatuses(capabilityDiagnostics);

    state.auth = auth;

    return c.json({
      wranglerInstalled,
      auth,
      workersSubdomain,
      capabilityDiagnostics,
      capabilities,
      capabilityStatuses,
      cwd: process.cwd(),
    });
  });

  // Load existing config (no auth required - read-only)
  // Supports both new (.authrim/{env}/config.json) and legacy (authrim-config.json) structures
  api.get('/config', async (c) => {
    const envParam = c.req.query('env');
    const baseDir = findAuthrimBaseDir(process.cwd());

    // Find config file
    let configPath: string | null = null;
    let structureType: 'new' | 'legacy' = 'legacy';

    if (envParam) {
      // Specific environment requested
      const resolved = resolvePaths({ baseDir, env: envParam });
      if (resolved.type === 'new') {
        configPath = (resolved.paths as EnvironmentPaths).config;
        structureType = 'new';
      } else {
        configPath = (resolved.paths as LegacyPaths).config;
        structureType = 'legacy';
      }
    } else {
      // Auto-detect: try new structure first, then legacy
      const environments = listEnvironments(baseDir);
      if (environments.length > 0) {
        const envPaths = getEnvironmentPaths({ baseDir, env: environments[0] });
        if (existsSync(envPaths.config)) {
          configPath = envPaths.config;
          structureType = 'new';
        }
      }
      if (!configPath || !existsSync(configPath)) {
        configPath = findLegacyConfigPath(baseDir);
        structureType = 'legacy';
      }
    }

    if (!existsSync(configPath)) {
      return c.json({
        exists: false,
        config: null,
        structure: structureType,
        environments: listEnvironments(baseDir),
      });
    }

    try {
      const content = await readFile(configPath, 'utf-8');
      const rawConfig = JSON.parse(content);

      // Validate with Zod schema
      const parseResult = AuthrimConfigSchema.safeParse(rawConfig);
      if (!parseResult.success) {
        return c.json({
          exists: true,
          config: rawConfig,
          valid: false,
          structure: structureType,
          configPath,
          environments: listEnvironments(baseDir),
          errors: parseResult.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }

      state.config = parseResult.data;
      return c.json({
        exists: true,
        config: parseResult.data,
        valid: true,
        structure: structureType,
        configPath,
        environments: listEnvironments(baseDir),
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ exists: true, valid: false, error: 'Invalid JSON syntax' }, 400);
      }
      return c.json({ exists: false, error: sanitizeError(error) }, 500);
    }
  });

  // Validate config (POST - accepts config in body)
  api.post('/config/validate', async (c) => {
    try {
      const body = await c.req.json();

      const parseResult = AuthrimConfigSchema.safeParse(body);
      if (!parseResult.success) {
        return c.json({
          valid: false,
          errors: parseResult.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }

      const conflicts = buildDomainRoutingValidationResult(parseResult.data);
      if (conflicts.length > 0) {
        return c.json({
          valid: false,
          errors: conflicts,
        });
      }

      return c.json({ valid: true, config: parseResult.data });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ valid: false, error: 'Invalid JSON syntax' }, 400);
      }
      return c.json({ valid: false, error: sanitizeError(error) }, 500);
    }
  });

  // Save config (with lock to prevent race conditions)
  // Saves to new structure: .authrim/{env}/config.json
  api.post('/config', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const body = await c.req.json();
        const config = AuthrimConfigSchema.parse(body);
        const conflicts = buildDomainRoutingValidationResult(config);
        if (conflicts.length > 0) {
          return c.json({ success: false, errors: conflicts }, 400);
        }
        const baseDir = findAuthrimBaseDir(process.cwd());
        const env = config.environment.prefix;

        const envPaths = getEnvironmentPaths({ baseDir, env });
        const resolvedEnvironment = resolvePaths({ baseDir, env });
        const configPath = resolvedEnvironment.paths.config;

        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env,
          operation: 'web-config-mutation',
        });
        const lock = operationLock.lock;
        const targetProductVersion = lock ? await getRootProductVersion(baseDir) : undefined;
        const decision = evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision, targetProductVersion),
              requiredCommand: lock ? `authrim-setup update --env ${env}` : undefined,
            },
            409
          );
        }
        if (lock?.productVersion && existsSync(configPath)) {
          const currentConfig = AuthrimConfigSchema.parse(
            JSON.parse(await readFile(configPath, 'utf-8'))
          );
          if (hasDatabaseTopologyChange(currentConfig, config)) {
            return c.json(
              {
                success: false,
                error:
                  'Database topology cannot be changed through generic config save after deployment. Use a dedicated topology operation.',
              },
              409
            );
          }
        }

        // Ensure directory exists
        await mkdir(dirname(configPath), { recursive: true });

        // Save config
        await writePrivateFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
        const initialUiEnv = buildInitialUiEnvConfig(config);
        if (initialUiEnv && resolvedEnvironment.type === 'new') {
          await saveUiEnv(envPaths.uiEnv, initialUiEnv);
        }
        state.config = config;

        return c.json({
          success: true,
          configPath,
          structure: resolvedEnvironment.type,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ success: false, errors: error.errors }, 400);
        }
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // Create default config (with lock)
  api.post('/config/default', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const {
          env = 'prod',
          apiDomain,
          loginUiDomain,
          adminUiDomain,
          tenant,
          components,
          zoneId,
          customDomainBinding,
          profiles,
        } = body;

        const config = createDefaultConfig(env);

        // Update tenant configuration
        if (tenant) {
          config.tenant = normalizeTenantConfigForApiDomain(tenant);
        }

        // Update URLs with domain configuration
        config.urls = buildUrlsConfig({
          env,
          apiDomain,
          loginUiDomain,
          adminUiDomain,
          zoneId: zoneId || null,
          customDomainBinding: customDomainBinding ?? false,
        });

        const conflicts = buildDomainRoutingValidationResult(config);
        if (conflicts.length > 0) {
          return c.json({ success: false, errors: conflicts }, 400);
        }

        // Update components if provided
        if (components) {
          config.components = {
            ...config.components,
            ...components,
            saml: true,
            async: true,
            vc: true,
            bridge: true,
            policy: true,
          };
        }

        if (profiles) {
          config.profiles = AuthrimConfigSchema.parse({ ...config, profiles }).profiles;
        }

        const parsedConfig = AuthrimConfigSchema.parse(config);
        state.config = parsedConfig;

        return c.json({ success: true, config: parsedConfig });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ success: false, errors: error.errors }, 400);
        }
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Check if keys exist for an environment
  api.get('/keys/check/:env', async (c) => {
    try {
      const parsedEnv = z
        .string()
        .min(1)
        .max(32)
        .regex(/^[a-z][a-z0-9-]*$/)
        .safeParse(c.req.param('env'));
      if (!parsedEnv.success) {
        return c.json({ exists: false, error: 'Invalid environment name' }, 400);
      }
      const env = parsedEnv.data;
      const baseDir = findAuthrimBaseDir(process.cwd());
      const exists = keysExistForEnvironment(baseDir, env, process.cwd());
      return c.json({ exists, env });
    } catch (error) {
      return c.json({ exists: false, error: sanitizeError(error) });
    }
  });

  // Generate keys (with lock)
  // Saves to external structure: {cwd}/.authrim-keys/{env}/
  api.post('/keys/generate', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const body = await c.req.json();
        const { keyId } = body;
        const parsedEnv = z
          .string()
          .min(1)
          .max(32)
          .regex(/^[a-z][a-z0-9-]*$/)
          .safeParse(body.env ?? 'default');
        if (!parsedEnv.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const envName = parsedEnv.data;
        const defaultKeysBaseDir = process.cwd();
        const baseDir = findAuthrimBaseDir(defaultKeysBaseDir);
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: envName,
          operation: 'web-key-generation',
        });
        const decision = evaluateEnvironmentOperation({
          // This endpoint is part of initial provisioning. Treating it as a generic config
          // mutation allowed an existing environment's key material to be overwritten before
          // /provision rejected the same environment.
          operation: 'provision',
          lock: operationLock.lock,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision),
              errorCode: decision.reason,
              requiredAction: 'finish_environment_deletion_or_choose_another_name',
            },
            409
          );
        }

        const envPaths = getEnvironmentPaths({ baseDir, env: envName });
        const configuredInput = existsSync(envPaths.config)
          ? parseEnvironmentConfigForEnv(
              JSON.parse(await readFile(envPaths.config, 'utf-8')),
              envName
            )
          : getStateConfigForEnv(envName);
        if (!configuredInput) {
          return c.json(
            {
              success: false,
              error: 'A matching environment config is required before key generation.',
              errorCode: 'environment_config_required',
            },
            409
          );
        }
        const configured = AuthrimConfigSchema.parse(configuredInput);
        const configuredKeysBaseDir =
          configured.keys.storageType === 'external' &&
          configured.keys.secretsPath !== './keys/' &&
          configured.keys.secretsPath !== 'keys/'
            ? deriveExternalKeysBaseDirFromConfigPath(envName, configured.keys.secretsPath)
            : baseDir;
        const durableConfig = AuthrimConfigSchema.parse({
          ...configured,
          keys:
            configured.keys.storageType === 'internal'
              ? configured.keys
              : {
                  ...configured.keys,
                  secretsPath: getExternalKeysPathForConfig(envName, configuredKeysBaseDir),
                  includeSecrets: false,
                  storageType: 'external',
                },
          updatedAt: new Date().toISOString(),
        });
        const keysDir = resolveWebDeploymentKeysDir(baseDir, envName, durableConfig);
        await saveEnvironmentConfig(envPaths, durableConfig);
        state.config = durableConfig;
        await recoverLegacyPreBundleEmailSecrets({
          baseDir,
          environment: envName,
          keysDir,
          configuredProvider: durableConfig.features.email?.provider,
        });
        const loaded = await loadKeysFromDirectory({ targetDir: keysDir });
        if (loaded.keyPair?.keyId && loaded.keyPair.publicKeyJwk) {
          const committedConfig = AuthrimConfigSchema.parse({
            ...durableConfig,
            keys: {
              ...durableConfig.keys,
              keyId: loaded.keyPair.keyId,
              publicKeyJwk: loaded.keyPair.publicKeyJwk,
            },
            updatedAt: new Date().toISOString(),
          });
          await saveEnvironmentConfig(envPaths, committedConfig);
          state.config = committedConfig;
          await promotePendingEmailSecrets({
            baseDir,
            environment: envName,
            keysDir,
            configuredEmail: committedConfig.features.email,
          });
          addProgress('Existing environment keys reused without replacement');
          return c.json({
            success: true,
            keyId: loaded.keyPair.keyId,
            publicKeyJwk: loaded.keyPair.publicKeyJwk,
            keysPath: keysDir,
            replacedExistingKeys: false,
            reusedExistingKeys: true,
          });
        }

        addProgress('Generating cryptographic keys...');
        const secrets = generateAllSecrets(keyId);

        // Save to external keys directory: {cwd}/.authrim-keys/{env}/
        addProgress(`Saving keys to directory: ${keysDir}/`);
        await saveKeysToDirectory(secrets, { targetDir: keysDir });
        const committedConfig = AuthrimConfigSchema.parse({
          ...durableConfig,
          keys: {
            ...durableConfig.keys,
            keyId: secrets.keyPair.keyId,
            publicKeyJwk: secrets.keyPair.publicKeyJwk,
          },
          updatedAt: new Date().toISOString(),
        });
        await saveEnvironmentConfig(envPaths, committedConfig);
        state.config = committedConfig;
        await promotePendingEmailSecrets({
          baseDir,
          environment: envName,
          keysDir,
          configuredEmail: committedConfig.features.email,
        });

        addProgress('Keys generated successfully');

        // Only return public information
        return c.json({
          success: true,
          keyId: secrets.keyPair.keyId,
          publicKeyJwk: secrets.keyPair.publicKeyJwk,
          keysPath: keysDir,
          replacedExistingKeys: false,
          reusedExistingKeys: false,
        });
      } catch (error) {
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // Common environment name validation schema
  const EnvNameSchema = z
    .string()
    .min(1)
    .max(32)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Environment name must start with lowercase letter and contain only lowercase alphanumeric and hyphens'
    );

  // Save email provider configuration (with lock)
  const EmailConfigSchema = z.object({
    env: EnvNameSchema,
    provider: z.enum(['cloudflare', 'resend', 'sendgrid', 'ses']),
    apiKey: z.string().optional(),
    fromAddress: z.string().email(),
    fromName: z.string().optional(),
  });

  const ServiceSiteConfigSchema = z.object({
    env: EnvNameSchema,
    enabled: z.boolean(),
    binding: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Binding must use uppercase letters, numbers, and underscores')
      .default('SERVICE_SITE'),
    workerName: z
      .string()
      .trim()
      .max(63)
      .regex(/^[a-z][a-z0-9-]*$/, 'Worker name must use lowercase letters, numbers, and hyphens')
      .optional()
      .or(z.literal('')),
    deployRouter: z.boolean().optional().default(true),
  });

  api.post('/email/configure', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const body = await c.req.json();

        // Validate request body
        const parseResult = EmailConfigSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                'Invalid request: ' + parseResult.error.issues.map((i) => i.message).join(', '),
            },
            400
          );
        }

        const { env, provider, apiKey, fromAddress, fromName } = parseResult.data;

        // Validate Resend API key format
        if (provider === 'resend' && !apiKey) {
          return c.json(
            {
              success: false,
              error: 'Resend API key is required when Resend is selected',
            },
            400
          );
        }

        if (provider === 'resend' && apiKey && !apiKey.startsWith('re_')) {
          // Warning but not an error - just log it
          addProgress('Warning: Resend API key should start with "re_"');
        }

        // Save secrets to the key directory pinned by an existing environment. Before config is
        // created, the normal external location under the current setup directory is used.
        const keysBaseDir = process.cwd();
        const baseDir = findAuthrimBaseDir(keysBaseDir);
        const envPaths = getEnvironmentPaths({ baseDir, env });
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env,
          operation: 'web-email-config',
        });
        const targetProductVersion = operationLock.lock
          ? await getRootProductVersion(baseDir)
          : undefined;
        const decision = evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock: operationLock.lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }

        const currentConfig = existsSync(envPaths.config)
          ? parseEnvironmentConfigForEnv(JSON.parse(await readFile(envPaths.config, 'utf-8')), env)
          : null;
        const stateConfig = currentConfig ? null : getStateConfigForEnv(env);
        if (!currentConfig && !stateConfig) {
          return c.json(
            {
              success: false,
              error: `Config file not found for environment "${env}"`,
            },
            404
          );
        }
        const keysDir = resolveWebDeploymentKeysDir(baseDir, env, currentConfig ?? stateConfig);
        const emailConfig = {
          provider,
          fromAddress: fromAddress.trim(),
          fromName: fromName?.trim() || undefined,
          configured: true,
        };
        await stagePendingEmailSecrets({
          baseDir,
          environment: env,
          email: { provider, fromAddress, fromName, apiKey },
        });

        let committedConfig: AuthrimConfig;
        if (currentConfig) {
          committedConfig = AuthrimConfigSchema.parse({
            ...currentConfig,
            updatedAt: new Date().toISOString(),
            features: {
              ...currentConfig.features,
              email: {
                ...currentConfig.features.email,
                ...emailConfig,
              },
            },
          });
          await saveEnvironmentConfig(envPaths, committedConfig);
          state.config = committedConfig;
          addProgress(`Updated config: ${envPaths.config}`);
        } else {
          const volatileConfig = stateConfig!;
          const defaultFeatures = createDefaultConfig(env).features;
          committedConfig = AuthrimConfigSchema.parse({
            ...volatileConfig,
            features: {
              queue: volatileConfig.features?.queue ?? defaultFeatures.queue,
              r2: volatileConfig.features?.r2 ?? defaultFeatures.r2,
              pluginDynamicWorkers:
                volatileConfig.features?.pluginDynamicWorkers ??
                defaultFeatures.pluginDynamicWorkers,
              email: {
                ...volatileConfig.features?.email,
                ...emailConfig,
              },
            },
          });
          state.config = committedConfig;
        }

        const publishedKeys = await loadKeysFromDirectory({ targetDir: keysDir });
        const canPromote = Boolean(
          publishedKeys.keyPair?.keyId && publishedKeys.keyPair.publicKeyJwk
        );
        if (canPromote) {
          await promotePendingEmailSecrets({
            baseDir,
            environment: env,
            keysDir,
            configuredEmail: committedConfig.features.email,
          });
        }

        if (provider === 'resend' && apiKey) {
          addProgress(
            canPromote
              ? `Saved ${provider} API key to ${join(keysDir, 'resend_api_key.txt')}`
              : `Staged ${provider} API key until the complete key bundle is published`
          );
        }
        addProgress(
          canPromote
            ? `Saved email from address to ${join(keysDir, 'email_from.txt')}`
            : `Staged email from address until the complete key bundle is published`
        );
        if (fromName) {
          addProgress(
            canPromote
              ? `Saved email from name to ${join(keysDir, 'email_from_name.txt')}`
              : `Staged email from name until the complete key bundle is published`
          );
        }

        addProgress('Email configuration saved successfully');

        return c.json({
          success: true,
          provider,
          fromAddress,
          message: 'Email configuration saved. Secrets will be uploaded during deployment.',
        });
      } catch (error) {
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  api.post('/service-site/configure', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const body = await c.req.json();
        const parseResult = ServiceSiteConfigSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                'Invalid request: ' + parseResult.error.issues.map((i) => i.message).join(', '),
            },
            400
          );
        }

        const { env, enabled, binding, workerName, deployRouter } = parseResult.data;
        const normalizedWorkerName = String(workerName || '').trim();
        if (enabled && !normalizedWorkerName) {
          return c.json(
            {
              success: false,
              error: 'Worker name is required when Service Site fallback is enabled.',
            },
            400
          );
        }

        state.status = 'deploying';
        state.error = null;
        clearProgress();
        state.logPath = await beginProgressLog(env, 'service-site');
        addProgress(`Configuring Service Site binding for environment: ${env}`);

        const baseDir = findAuthrimBaseDir(process.cwd());
        const envPaths = getEnvironmentPaths({ baseDir, env });
        if (!existsSync(envPaths.config)) {
          state.status = 'error';
          state.error = `Config file not found: ${envPaths.config}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            404
          );
        }

        let { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);
        if (!lock || !lockPath) {
          state.status = 'error';
          state.error = `Lock file not found for ${env}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            404
          );
        }

        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env,
          operation: deployRouter ? 'web-service-site-deploy' : 'web-service-site-config',
          requireExisting: true,
        });
        lock = operationLock.lock!;
        lockPath = operationLock.lockFilePath;

        const targetProductVersion = operationLock.lock
          ? await getRootProductVersion(baseDir)
          : undefined;
        const operationDecision = evaluateEnvironmentOperation({
          operation: deployRouter ? 'worker_redeploy' : 'config_mutation',
          lock,
          targetVersion: targetProductVersion,
        });
        if (!operationDecision.allowed) {
          state.status = 'error';
          state.error = environmentOperationBlockMessage(operationDecision, targetProductVersion);
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              requiredCommand: `authrim-setup update --env ${env}`,
              progress: state.progress,
              logPath: state.logPath,
            },
            409
          );
        }

        deployConfigLock = await acquireDeployConfigLock({
          baseDir,
          env,
          operation: deployRouter ? 'web-service-site-deploy' : 'web-service-site-config',
        });

        const config = parseEnvironmentConfigForEnv(
          JSON.parse(await readFile(envPaths.config, 'utf-8')),
          env
        );
        const updatedConfig: AuthrimConfig = {
          ...config,
          serviceSite: {
            enabled,
            binding,
            workerName: normalizedWorkerName || config.serviceSite?.workerName,
            fallbackMode: 'worker_service_binding',
          },
          updatedAt: new Date().toISOString(),
        };
        await writePrivateFileAtomically(
          envPaths.config,
          `${JSON.stringify(updatedConfig, null, 2)}\n`
        );
        state.config = updatedConfig;
        addProgress(
          enabled
            ? `Service Site binding configured: ${binding} -> ${normalizedWorkerName}`
            : 'Service Site binding disabled'
        );
        const resourceIds = await buildWorkerDeploymentResourceIds({
          lock,
          config: updatedConfig,
          environmentId: env,
          components: ['ar-router'],
          onProgress: addProgress,
        });
        addProgress('Refreshing ar-router wrangler config...');
        const masterResult = await saveMasterWranglerConfigs(updatedConfig, resourceIds, {
          baseDir,
          env,
          dryRun: false,
          includeDurableObjectMigrations: false,
          components: ['ar-router'],
          onProgress: addProgress,
        });
        if (!masterResult.success) {
          state.status = 'error';
          state.error = `Wrangler config generation failed: ${masterResult.errors.join(', ')}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        addProgress('Syncing ar-router wrangler config...');
        const syncResult = await syncWranglerConfigs({
          baseDir,
          env,
          packagesDir: join(baseDir, 'packages'),
          force: true,
          dryRun: false,
          components: ['ar-router'],
          onProgress: addProgress,
        });
        if (!syncResult.success && syncResult.errors.length > 0) {
          state.status = 'error';
          state.error = `Wrangler config sync failed: ${syncResult.errors.join(', ')}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }
        addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);

        if (!deployRouter) {
          state.status = 'complete';
          addProgress('Router deploy skipped by request.');
          await flushProgressLog();
          return c.json({
            success: true,
            env,
            configPath: envPaths.config,
            deployRequired: true,
            progress: state.progress,
            logPath: state.logPath,
          });
        }

        addProgress('Building ar-router...');
        const buildResult = await buildApiPackages({
          rootDir: baseDir,
          components: ['ar-router'],
          onProgress: addProgress,
        });
        if (!buildResult.success) {
          state.status = 'error';
          state.error = `Build failed: ${buildResult.error}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        addProgress('Deploying ar-router...');
        const routerDeployOptions = {
          env,
          rootDir: baseDir,
          dryRun: false,
          deploymentStrategy: 'auto' as const,
          existingComponents: WORKER_COMPONENTS.filter(
            (component) => lock.workers?.[component] !== undefined
          ),
          cleanupLegacyStaticSecrets: true,
          deployConfigLockProof: deployConfigLock.proof,
          onProgress: addProgress,
        };
        routerDeployOptions.existingComponents = await resolveExistingWorkerComponents(
          routerDeployOptions,
          WORKER_COMPONENTS
        );
        const deployResult = await deployWorker('ar-router', routerDeployOptions);
        if (!deployResult.success) {
          state.status = 'error';
          state.error = deployResult.error || 'ar-router deployment failed';
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }
        if (
          !deployResult.deployedAt ||
          !deployResult.cloudflareVersionId ||
          !deployResult.cloudflareScriptTag
        ) {
          throw new Error('worker_deployment_exact_version_unavailable:ar-router');
        }

        const visibility = await waitForWorkerDeploymentsReady({
          targets: [
            {
              workerName: deployResult.workerName,
              deployedAt: deployResult.deployedAt,
              expectedVersionId: deployResult.cloudflareVersionId,
            },
          ],
          onProgress: addProgress,
        });
        if (!visibility.ready) {
          throw new Error(
            `ar-router deployment did not become visible: ${visibility.error ?? 'unknown error'}`
          );
        }
        const workersSubdomain = await getWorkersSubdomain();
        const httpTargets = buildWorkerHttpReadinessTargets([deployResult], workersSubdomain, {
          workersDevEnabled: !updatedConfig.urls?.api?.custom,
        });
        if (httpTargets.length > 0) {
          const httpReadiness = await waitForWorkerHttpReady({
            targets: httpTargets,
            onProgress: addProgress,
          });
          if (!httpReadiness.ready) {
            throw new Error(
              `ar-router HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
            );
          }
        }

        // deployWorker durably journals a fresh/pending immutable script identity. Reload that
        // checkpoint before committing the verified result so this specialized route cannot erase
        // it with the pre-deployment lock snapshot.
        const latestLockState = await loadLockFileAuto(baseDir, env);
        if (!latestLockState.lock || latestLockState.path !== lockPath) {
          throw new Error('service_site_worker_deployment_lock_changed');
        }
        const packageVersion = await getPackageVersion(join(baseDir, 'packages', 'ar-router'));
        const updatedLock = updateLockWithDeployments(latestLockState.lock, [
          {
            ...deployResult,
            component: 'ar-router',
            version: packageVersion ?? deployResult.version,
          },
        ]);
        await saveLockFile(updatedLock, lockPath);
        addProgress('Lock file updated');
        state.status = 'complete';
        addProgress('✓ Service Site binding configuration deployed');
        await flushProgressLog();

        return c.json({
          success: true,
          env,
          configPath: envPaths.config,
          workerName: deployResult.workerName,
          deployedAt: deployResult.deployedAt,
          serviceSite: updatedConfig.serviceSite,
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        await flushProgressLog();
        return c.json({ success: false, error: state.error, progress: state.progress }, 500);
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  const EnableCloudflareEmailSchema = z.object({
    env: EnvNameSchema,
    fromAddress: z.string().email(),
    fromName: z.string().optional(),
  });

  api.use('/env/email/*', validateSession);

  api.post('/env/email/cloudflare/enable', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const parseResult = EnableCloudflareEmailSchema.safeParse(await c.req.json());
        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                'Invalid request: ' +
                parseResult.error.issues.map((issue) => issue.message).join(', '),
            },
            400
          );
        }

        const { env, fromAddress, fromName } = parseResult.data;
        const rootDir = process.cwd();
        const baseDir = findAuthrimBaseDir(rootDir);

        state.status = 'deploying';
        state.error = null;
        state.logPath = await beginProgressLog(env, 'deploy');
        clearProgress();
        addProgress(`Enabling Cloudflare Email Service for environment: ${env}`);

        const { envPaths, config } = await loadEnvironmentConfigForUpdate(baseDir, env);
        const { loadLockFileAuto, saveLockFile: saveLock } = await import('../core/lock.js');
        let { lock, path: lockPath } = await loadLockFileAuto(rootDir, env);

        if (!lock || !lockPath) {
          state.status = 'error';
          state.error = `Environment "${env}" lock file not found`;
          return c.json({ success: false, error: state.error }, 404);
        }

        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: rootDir,
          env,
          operation: 'web-cloudflare-email-deploy',
          requireExisting: true,
        });
        lock = operationLock.lock!;
        lockPath = operationLock.lockFilePath;

        const targetProductVersion = await getRootProductVersion(baseDir);
        const deploymentGuard = evaluateReleaseDeploymentGuard(
          lock,
          targetProductVersion,
          'worker_redeploy'
        );
        if (!deploymentGuard.allowed) {
          state.status = 'error';
          state.error = releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion);
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              requiredCommand: `authrim-setup update --env ${env}`,
              progress: state.progress,
              logPath: state.logPath,
            },
            409
          );
        }

        deployConfigLock = await acquireDeployConfigLock({
          baseDir: rootDir,
          env,
          operation: 'web-cloudflare-email-deploy',
        });

        const updatedConfig = AuthrimConfigSchema.parse({
          ...config,
          features: {
            ...config.features,
            email: {
              ...config.features.email,
              provider: 'cloudflare',
              fromAddress: fromAddress.trim(),
              fromName: fromName?.trim() || undefined,
              configured: true,
            },
          },
        });

        await stagePendingEmailSecrets({
          baseDir,
          environment: env,
          email: {
            provider: 'cloudflare',
            fromAddress,
            fromName,
          },
        });
        await saveEnvironmentConfig(envPaths, updatedConfig);
        addProgress(`Updated config: ${envPaths.config}`);

        const configuredKeysDir = resolveWebDeploymentKeysDir(baseDir, env, updatedConfig);
        await promotePendingEmailSecrets({
          baseDir,
          environment: env,
          keysDir: configuredKeysDir,
          configuredEmail: updatedConfig.features.email,
        });
        addProgress(`Saved email bootstrap files to ${configuredKeysDir}`);

        const resourceIds = await buildWorkerDeploymentResourceIds({
          lock,
          config: updatedConfig,
          environmentId: env,
          onProgress: addProgress,
        });
        addProgress('Refreshing generated wrangler configs...');
        const masterResult = await saveMasterWranglerConfigs(updatedConfig, resourceIds, {
          baseDir: rootDir,
          env,
          dryRun: false,
          onProgress: addProgress,
        });

        if (!masterResult.success) {
          state.status = 'error';
          state.error = `Wrangler config generation failed: ${masterResult.errors.join(', ')}`;
          await flushProgressLog();
          return c.json({ success: false, error: state.error }, 500);
        }

        addProgress('Syncing wrangler configs...');
        const syncResult = await syncWranglerConfigs({
          baseDir: rootDir,
          env,
          packagesDir: join(rootDir, 'packages'),
          force: true,
          dryRun: false,
          onProgress: addProgress,
        });

        if (!syncResult.success && syncResult.errors.length > 0) {
          state.status = 'error';
          state.error = `Wrangler config sync failed: ${syncResult.errors.join(', ')}`;
          await flushProgressLog();
          return c.json({ success: false, error: state.error }, 500);
        }

        addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);

        addProgress('Email sender values will be deployed as Worker vars.');

        addProgress('Building packages...');
        const buildResult = await buildApiPackages({
          rootDir: resolve(rootDir),
          onProgress: addProgress,
        });

        if (!buildResult.success) {
          state.status = 'error';
          state.error = `Build failed: ${buildResult.error}`;
          await flushProgressLog();
          return c.json({ success: false, error: state.error }, 500);
        }

        const emailDeployOptions = {
          env,
          rootDir: resolve(rootDir),
          concurrency: 2,
          deploymentStrategy: 'auto' as const,
          existingComponents: WORKER_COMPONENTS.filter(
            (component) => lock.workers?.[component] !== undefined
          ),
          deployConfigLockProof: deployConfigLock.proof,
          onProgress: addProgress,
        };
        emailDeployOptions.existingComponents = await resolveExistingWorkerComponents(
          emailDeployOptions,
          WORKER_COMPONENTS
        );
        const emailDeploySummary = await deployAll(emailDeployOptions, [
          'ar-auth',
          'ar-management',
        ]);
        if (emailDeploySummary.failedCount > 0) {
          state.status = 'error';
          state.error = `Email Worker deployment failed: ${emailDeploySummary.results
            .filter((result) => !result.success)
            .map((result) => `${result.component}: ${result.error || 'Unknown error'}`)
            .join(', ')}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
            },
            500
          );
        }

        const visibility = await waitForWorkerDeploymentsReady({
          targets: emailDeploySummary.results.map((result) => ({
            workerName: result.workerName,
            deployedAt: result.deployedAt,
            expectedVersionId: result.cloudflareVersionId,
          })),
          onProgress: addProgress,
        });
        if (!visibility.ready) {
          throw new Error(
            `Email Worker deployments did not become visible: ${visibility.error ?? 'unknown error'}`
          );
        }
        const workersSubdomain = await getWorkersSubdomain();
        const httpTargets = buildWorkerHttpReadinessTargets(
          emailDeploySummary.results,
          workersSubdomain,
          { workersDevEnabled: !updatedConfig.urls?.api?.custom }
        );
        if (httpTargets.length > 0) {
          const httpReadiness = await waitForWorkerHttpReady({
            targets: httpTargets,
            onProgress: addProgress,
          });
          if (!httpReadiness.ready) {
            throw new Error(
              `Email Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
            );
          }
        }

        const deployResults: DeployResult[] = emailDeploySummary.results;
        const latestLockState = await loadLockFileAuto(baseDir, env);
        if (!latestLockState.lock) {
          throw new Error('email_worker_deployment_lock_unavailable_after_readiness');
        }
        const updatedLock = updateLockWithDeployments(latestLockState.lock, deployResults);
        await saveLock(updatedLock, lockPath);
        addProgress(`Lock file updated: ${lockPath}`);

        state.status = 'complete';
        addProgress('Cloudflare Email Service is now enabled.');
        await flushProgressLog();

        return c.json({
          success: true,
          env,
          config: updatedConfig,
          deployedComponents: deployResults.map((result) => result.component),
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        addProgress(`❌ Failed to enable Cloudflare Email Service: ${state.error}`);
        await flushProgressLog();
        return c.json({ success: false, error: state.error, progress: state.progress }, 500);
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // Provision request schema (with database config validation)
  const ProvisionRequestSchema = z
    .object({
      env: EnvNameSchema,
      databaseConfig: z
        .object({
          core: z
            .object({
              location: D1LocationSchema.optional(),
              jurisdiction: D1JurisdictionSchema.optional(),
            })
            .optional(),
          pii: z
            .object({
              location: D1LocationSchema.optional(),
              jurisdiction: D1JurisdictionSchema.optional(),
            })
            .optional(),
        })
        .optional(),
      createQueues: z.boolean().optional(),
      createR2: z.boolean().optional(),
      automaticProvisioning: z.boolean().optional(),
    })
    .strict();

  // Provision Cloudflare resources (with lock)
  api.post('/provision', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const body = await c.req.json();

        // Validate request body
        const parseResult = ProvisionRequestSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                'Invalid request: ' + parseResult.error.issues.map((i) => i.message).join(', '),
            },
            400
          );
        }

        const { env, databaseConfig, createQueues, createR2, automaticProvisioning } =
          parseResult.data;
        const rootDir = findAuthrimBaseDir(process.cwd());
        const envPaths = getEnvironmentPaths({ baseDir: rootDir, env });
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: rootDir,
          env,
          operation: 'web-provision',
        });
        deployConfigLock = await acquireDeployConfigLock({
          baseDir: rootDir,
          env,
          operation: 'web-provision',
        });
        const earlyProvisioningIntent = await loadProvisioningIntent({
          baseDir: rootDir,
          environment: env,
        });
        const provisioningOnlyLock =
          operationLock.lock && !hasPostProvisioningLockState(operationLock.lock)
            ? operationLock.lock
            : null;
        if (operationLock.lock && !earlyProvisioningIntent && !provisioningOnlyLock) {
          const provisionDecision = evaluateEnvironmentOperation({
            operation: 'provision',
            lock: operationLock.lock,
          });
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(provisionDecision),
              errorCode: provisionDecision.reason,
              requiredAction: 'finish_environment_deletion_or_choose_another_name',
            },
            409
          );
        }
        let config =
          provisioningOnlyLock && !earlyProvisioningIntent
            ? parseEnvironmentConfigForEnv(
                JSON.parse(await readFile(envPaths.config, 'utf-8')),
                env
              )
            : await loadWebProvisioningConfig({
                baseDir: rootDir,
                environment: env,
                intent: earlyProvisioningIntent,
              });
        if (
          (!provisioningOnlyLock && databaseConfig) ||
          (!provisioningOnlyLock && createQueues !== undefined) ||
          (!provisioningOnlyLock && createR2 !== undefined) ||
          (!provisioningOnlyLock && automaticProvisioning !== undefined)
        ) {
          config = AuthrimConfigSchema.parse({
            ...config,
            database: databaseConfig ? { ...config.database, ...databaseConfig } : config.database,
            features: {
              ...config.features,
              queue: {
                enabled:
                  createQueues === undefined
                    ? config.features?.queue?.enabled === true
                    : createQueues === true,
              },
              r2: {
                enabled:
                  createR2 === undefined
                    ? config.features?.r2?.enabled === true
                    : createR2 === true,
              },
            },
            controlPlane: {
              automaticProvisioning:
                automaticProvisioning === undefined
                  ? config.controlPlane?.automaticProvisioning === true
                  : automaticProvisioning,
            },
          });
        }
        const accountId = await getAccountId();
        if (!accountId) throw new Error('cloudflare_account_id_required_for_provisioning');
        if (config.cloudflare?.accountId && config.cloudflare.accountId !== accountId) {
          throw new Error('cloudflare_config_account_id_mismatch');
        }
        config.cloudflare = { accountId };

        const keysBaseDir =
          earlyProvisioningIntent || provisioningOnlyLock
            ? deriveExternalKeysBaseDirFromConfigPath(env, config.keys.secretsPath)
            : rootDir;
        const generatedKeys = await loadKeysFromDirectory({
          baseDir: rootDir,
          env,
          keysBaseDir,
        });
        if (!generatedKeys.keyPair?.keyId || !generatedKeys.keyPair.publicKeyJwk) {
          throw new Error('environment_keys_required_before_provisioning');
        }
        const provisioningKeysDir = resolveWebDeploymentKeysDir(rootDir, env, config);
        await promotePendingEmailSecrets({
          baseDir: rootDir,
          environment: env,
          keysDir: provisioningKeysDir,
          configuredEmail: config.features.email,
        });
        config.keys = {
          ...config.keys,
          keyId: generatedKeys.keyPair.keyId,
          publicKeyJwk: generatedKeys.keyPair.publicKeyJwk as Record<string, unknown>,
          secretsPath: getExternalKeysPathForConfig(env, keysBaseDir),
          includeSecrets: false,
          storageType: 'external',
        };

        // Resolve every deterministic config field before pinning the provisioning intent. A
        // retry loads this persisted URL state, so resolving it after the intent was written would
        // change the resource-spec digest and make a safely resumable attempt look incompatible.
        const workersSubdomain = await getWorkersSubdomain();
        config = normalizeWebProvisioningConfigForIntent({
          config,
          environment: env,
          workersSubdomain,
        });

        const resourceSpec = buildWebProvisioningResourceSpec(config);
        const existingIntent = earlyProvisioningIntent;
        let provisioningAttempt = existingIntent
          ? await beginOrResumeProvisioningIntent({
              baseDir: rootDir,
              environment: env,
              accountId,
              resourceSpec,
            })
          : undefined;
        let repairingIncompleteProvisioningLock = false;
        if (operationLock.lock && (provisioningAttempt || provisioningOnlyLock)) {
          if (
            await hasCompleteProvisioningArtifacts({
              baseDir: rootDir,
              environment: env,
              config,
              lock: operationLock.lock,
              intent: provisioningAttempt?.intent,
            })
          ) {
            if (provisioningAttempt) {
              await completeProvisioningIntent({
                baseDir: rootDir,
                environment: env,
                expectedIntentId: provisioningAttempt.intent.id,
              });
            }
            state.status = 'complete';
            state.config = config;
            return c.json({
              success: true,
              alreadyCompleted: true,
              lock: operationLock.lock,
              config,
              savedPaths: {
                config: envPaths.config,
                lock: envPaths.lock,
                root: envPaths.root,
                log: state.logPath,
              },
            });
          }
          if (hasPostProvisioningLockState(operationLock.lock)) {
            throw new Error('stale_provisioning_intent_after_environment_activation');
          }
          if (!provisioningAttempt) {
            throw new Error('provisioning_completion_evidence_mismatch');
          }
          repairingIncompleteProvisioningLock = true;
        }

        const provisionDecision = evaluateEnvironmentOperation({
          operation: 'provision',
          lock: repairingIncompleteProvisioningLock ? null : operationLock.lock,
        });
        if (!provisionDecision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(provisionDecision),
              errorCode: provisionDecision.reason,
              requiredAction: 'finish_environment_deletion_or_choose_another_name',
            },
            409
          );
        }

        state.status = 'provisioning';
        state.error = null;
        state.logPath = await beginProgressLog(env, 'provision');
        clearProgress();
        state.config = config;
        addProgress(`Provisioning Cloudflare resources for ${env}...`);

        if (!existingIntent) {
          const remoteEnvironments = await detectEnvironments(addProgress, {
            requiredResources: PROVISIONING_COLLISION_INVENTORY,
            includeControlManagedResourcesForEnvironment: env,
          });
          if (remoteEnvironments.some((candidate) => candidate.env === env)) {
            state.status = 'error';
            state.error = 'cloudflare_environment_already_exists';
            return c.json(
              {
                success: false,
                error: 'Cloudflare resources already exist for this environment name.',
                errorCode: 'environment_already_exists',
                requiredAction: 'delete_existing_environment_or_choose_another_name',
              },
              409
            );
          }
        }
        provisioningAttempt ??= await beginOrResumeProvisioningIntent({
          baseDir: rootDir,
          environment: env,
          accountId,
          resourceSpec,
        });
        addProgress(
          provisioningAttempt.resumed
            ? `Resuming provisioning attempt ${provisioningAttempt.intent.id}`
            : `Provisioning attempt recorded: ${provisioningAttempt.intent.id}`
        );
        await recordProvisioningKeyId({
          baseDir: rootDir,
          environment: env,
          expectedIntentId: provisioningAttempt.intent.id,
          keyId: generatedKeys.keyPair.keyId,
        });

        await mkdir(dirname(envPaths.config), { recursive: true });
        await writePrivateFileAtomically(envPaths.config, `${JSON.stringify(config, null, 2)}\n`);
        const initialUiEnv = buildInitialUiEnvConfig(config);
        if (initialUiEnv) await saveUiEnv(envPaths.uiEnv, initialUiEnv);
        state.config = config;
        addProgress(
          `Prepared durable config before Cloudflare resource mutation: ${envPaths.config}`
        );

        const resources = await provisionResources({
          env,
          createD1: true,
          createKV: true,
          createQueues: config.features?.queue?.enabled === true,
          createR2: config.features?.r2?.enabled === true,
          provisioningIntentResources: provisioningAttempt.intent.resources,
          onProgress: addProgress,
          databaseConfig: config.database,
          onResourceCreateIssued: (resource) =>
            recordProvisioningResourceCreateIssued({
              baseDir: rootDir,
              environment: env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource,
            }),
          onResourceCreateRejected: (resource) =>
            recordProvisioningResourceCreateRejected({
              baseDir: rootDir,
              environment: env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource,
            }),
          onResourceIdentified: (resource) =>
            recordProvisioningResourceIdentified({
              baseDir: rootDir,
              environment: env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource,
            }),
          onResourceProvisioned: (resource) =>
            recordProvisionedResource({
              baseDir: rootDir,
              environment: env,
              expectedIntentId: provisioningAttempt.intent.id,
              resource,
            }),
        });

        addProgress('Creating lock file...');
        const provisionedLock = createLockFile(env, resources);
        const lock = operationLock.lock
          ? mergeProvisionedResourcesIntoLock(operationLock.lock, provisionedLock)
          : provisionedLock;
        // Generate wrangler.toml files
        addProgress('Generating wrangler.toml files...');
        const resourceIds = await buildWorkerDeploymentResourceIds({
          lock,
          config,
          environmentId: env,
          onProgress: addProgress,
        });

        const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
          baseDir: rootDir,
          env,
          dryRun: false,
          onProgress: addProgress,
        });

        if (!masterResult.success) {
          throw new Error(
            `Failed to save master wrangler configs: ${masterResult.errors.join(', ')}`
          );
        }

        const syncResult = await syncWranglerConfigs({
          baseDir: rootDir,
          env,
          packagesDir: join(rootDir, 'packages'),
          force: true,
          dryRun: false,
          onProgress: addProgress,
        });

        if (!syncResult.success && syncResult.errors.length > 0) {
          throw new Error(`Failed to sync wrangler configs: ${syncResult.errors.join(', ')}`);
        }

        // lock.json is the declaration that every required local artifact is durable. Keep it
        // last so a process restart sees a resumable intent instead of a false-complete environment.
        addProgress(`Saving final lock.json to ${envPaths.lock} ...`);
        await saveLockFile(lock, { env, baseDir: rootDir });
        await completeProvisioningIntent({
          baseDir: rootDir,
          environment: env,
          expectedIntentId: provisioningAttempt.intent.id,
        });

        state.status = 'complete';
        addProgress('Provisioning complete!');
        addProgress(`📁 Config saved: ${envPaths.config}`);
        addProgress(`📁 Lock saved:   ${envPaths.lock}`);
        addProgress(`📝 Progress log saved: ${state.logPath}`);
        await flushProgressLog();

        return c.json({
          success: true,
          resources,
          lock,
          config,
          savedPaths: {
            config: envPaths.config,
            lock: envPaths.lock,
            root: envPaths.root,
            log: state.logPath,
          },
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        addProgress(`❌ Provisioning failed: ${state.error}`);
        await flushProgressLog();
        return c.json({ success: false, error: sanitizeError(error), logPath: state.logPath }, 500);
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // Generate wrangler configs (with lock)
  api.post('/wrangler/generate', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const body = await c.req.json();
        const parseResult = EnvNameSchema.safeParse(body?.env);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        // The setup server owns its workspace. Never accept a request-controlled filesystem root
        // for generated deployment files, even from an authenticated loopback session.
        const rootDir = findAuthrimBaseDir(process.cwd());
        const env = parseResult.data;

        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: rootDir,
          env,
          operation: 'web-wrangler-generation',
          requireExisting: true,
        });
        deployConfigLock = await acquireDeployConfigLock({
          baseDir: rootDir,
          env,
          operation: 'web-wrangler-generation',
        });
        const lock = operationLock.lock;
        if (!lock) {
          return c.json({ success: false, error: 'Lock file not found' }, 400);
        }
        const targetProductVersion = await getRootProductVersion(rootDir);
        const decision = evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }

        // Persisted environment config is the source of truth after a server restart. Volatile
        // wizard state must never silently reset feature flags or topology during regeneration.
        const { config } = await loadEnvironmentConfigForUpdate(rootDir, env);

        addProgress('Generating wrangler.toml files...');

        // Build resource IDs from lock file
        const resourceIds = {
          d1: lock.d1,
          kv: Object.fromEntries(
            Object.entries(lock.kv).map(([k, v]) => [k, { id: v.id, name: v.name }])
          ),
          queues: lock.queues,
          r2: lock.r2,
        };

        // Generate and save wrangler configs for each component
        // Include optional components (ar-policy, ar-bridge, etc.) based on config
        const enabledComponents = getEnabledComponents({
          saml: config.components?.saml,
          async: config.components?.async,
          vc: config.components?.vc,
          bridge: config.components?.bridge,
          policy: config.components?.policy,
        });

        // Get workers.dev subdomain for CORS configuration
        // Workers.dev URLs must be in format: {name}.{subdomain}.workers.dev
        const workersSubdomain = await getWorkersSubdomain();

        const generatedComponents = Array.from(enabledComponents).filter((component) =>
          existsSync(join(rootDir, 'packages', component))
        );
        const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
          baseDir: rootDir,
          env,
          components: generatedComponents,
          onProgress: addProgress,
        });
        if (!masterResult.success) {
          throw new Error(`generated_wrangler_config_failed:${masterResult.errors.join(',')}`);
        }
        const syncResult = await syncWranglerConfigs({
          baseDir: rootDir,
          env,
          packagesDir: join(rootDir, 'packages'),
          force: true,
          components: generatedComponents,
          onProgress: addProgress,
        });
        if (!syncResult.success) {
          throw new Error(`wrangler_config_sync_failed:${syncResult.errors.join(',')}`);
        }

        // Bootstrap configs are bounded deploy artifacts and are regenerated for the target
        // environment on every deploy while the workspace lock is held.
        for (const component of enabledComponents) {
          const componentDir = join(rootDir, 'packages', component);
          if (!existsSync(componentDir)) {
            continue;
          }
          if (component === 'ar-control' || component === 'ar-auth' || component === 'ar-bridge') {
            const bootstrapConfig = generateWranglerConfig(
              component,
              config,
              resourceIds,
              workersSubdomain ?? undefined,
              component === 'ar-control'
                ? { includeControlSmokeBindings: false }
                : component === 'ar-auth'
                  ? { includeAuthAccountProvisioner: false }
                  : { includeExternalIdpAccountProvisioner: false }
            );
            await writePrivateFileAtomically(
              join(componentDir, 'wrangler.bootstrap.toml'),
              toToml(bootstrapConfig, env),
              0o644
            );
          }
        }

        addProgress('Wrangler configs generated!');

        return c.json({
          success: true,
          components: generatedComponents,
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // Deploy (with lock - long-running operation)
  api.post('/deploy', async (c) => {
    return withLock(async () => {
      let cleanupEnv: string | undefined;
      let cleanupKeysDir: string | undefined;
      let setupMachineAccessAttempted = false;
      let setupMachineAccessCleanupSuccess = true;
      let lockedCoreDatabaseIdentifier: string | undefined;
      let lockedAdminDatabaseIdentifier: string | undefined;
      const requireLockedCoreDatabaseIdentifier = (): string => {
        if (!lockedCoreDatabaseIdentifier) throw new Error('core_database_required_for_bootstrap');
        return lockedCoreDatabaseIdentifier;
      };
      const requireLockedAdminDatabaseIdentifier = (): string => {
        if (!lockedAdminDatabaseIdentifier) {
          throw new Error('admin_database_required_for_bootstrap');
        }
        return lockedAdminDatabaseIdentifier;
      };
      let bootstrapToken = '';
      let bootstrapOwnership: CloudflareTokenOwnership | null = null;
      let environmentOperationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const bodyResult = z
          .object({
            env: EnvNameSchema,
            dryRun: z.boolean().optional(),
            components: z.array(z.string().min(1).max(128)).max(32).optional(),
            skipBuild: z.boolean().optional(),
            runMigrations: z.boolean().optional(),
            externalSchemaReady: z.boolean().optional(),
            bootstrapToken: z.string().min(20).max(4096).regex(/^\S+$/u).optional(),
            tokenOwnership: z.enum(['account', 'user']).optional(),
          })
          .strict()
          .safeParse(await c.req.json());
        if (!bodyResult.success) {
          const invalidEnvironment = bodyResult.error.issues.some(
            (issue) => issue.path.length === 1 && issue.path[0] === 'env'
          );
          return c.json(
            {
              success: false,
              error: invalidEnvironment ? 'Invalid environment name' : 'Invalid deployment request',
            },
            400
          );
        }
        const body = bodyResult.data;
        if (body.bootstrapToken !== undefined || body.tokenOwnership !== undefined) {
          if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
            return c.json({ success: false, error: 'Invalid setup origin' }, 403);
          }
          if (!body.bootstrapToken || !body.tokenOwnership) {
            return c.json({ success: false, error: 'Invalid bootstrap token input' }, 400);
          }
          bootstrapToken = body.bootstrapToken;
          bootstrapOwnership = body.tokenOwnership;
        }
        const {
          dryRun = false,
          components: requestedComponents,
          skipBuild = false,
          runMigrations = true,
          externalSchemaReady = false,
        } = body;
        const env = body.env;
        const resolvedRootDir = resolve(findAuthrimBaseDir(process.cwd()));
        const rootDir = resolvedRootDir;
        cleanupEnv = env;

        let { lock: existingDeploymentLock, path: initialLockPath } = await loadLockFileAuto(
          resolvedRootDir,
          env
        );
        if (!existingDeploymentLock) {
          return c.json(
            {
              success: false,
              error: 'Initial deployment requires provisioned resource lock data.',
            },
            400
          );
        }
        if (!dryRun) {
          environmentOperationLock = await acquireEnvironmentOperationForEnvironment({
            baseDir: resolvedRootDir,
            env,
            operation: 'web-initial-deploy',
            requireExisting: true,
          });
          deployConfigLock = await acquireDeployConfigLock({
            baseDir: resolvedRootDir,
            env,
            operation: 'web-initial-deploy',
          });
          existingDeploymentLock = environmentOperationLock.lock;
          initialLockPath = environmentOperationLock.lockFilePath;
        }
        if (!existingDeploymentLock) {
          throw new Error('provisioned_environment_disappeared_while_acquiring_deploy_lock');
        }
        const interruptedInitialRelease =
          !existingDeploymentLock.productVersion &&
          existingDeploymentLock.releaseUpdate !== undefined &&
          existingDeploymentLock.releaseUpdate.phase !== 'verified';
        if (
          existingDeploymentLock.productVersion ||
          (Object.keys(existingDeploymentLock.workers ?? {}).length > 0 &&
            !interruptedInitialRelease)
        ) {
          return c.json(
            {
              success: false,
              error:
                'This environment is already deployed. Use the release update command so schemas are applied before Workers.',
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }
        const baseDir = findAuthrimBaseDir(resolvedRootDir);
        const resolved = resolvePaths({ baseDir, env });
        const configPath =
          resolved.type === 'new'
            ? (resolved.paths as EnvironmentPaths).config
            : (resolved.paths as LegacyPaths).config;
        if (!existsSync(configPath)) {
          throw new Error(`Initial deployment configuration was not found: ${configPath}`);
        }
        const releaseConfig = parseEnvironmentConfigForEnv(
          JSON.parse(await readFile(configPath, 'utf-8')),
          env
        );
        if (!dryRun) {
          const requiredQueues =
            releaseConfig.features.queue?.enabled === true ? getRequiredQueues(env) : [];
          const verifyQueues =
            requiredQueues.length > 0 ||
            Object.keys(existingDeploymentLock.queues ?? {}).length > 0;
          const requiredR2Buckets = [
            ...new Map(
              [
                ...Object.entries(existingDeploymentLock.r2 ?? {}).map(([binding, bucket]) => ({
                  binding,
                  name: bucket.name,
                })),
                ...getRequiredR2Buckets(env, {
                  includeFeatureBuckets: releaseConfig.features.r2?.enabled === true,
                }),
              ].map((bucket) => [bucket.name, bucket] as const)
            ).values(),
          ];
          const [databases, namespaces, queues, r2Buckets] = await Promise.all([
            listD1Databases(),
            listKVNamespaces(),
            verifyQueues
              ? listQueues({ strictOutput: true, requireIds: true })
              : Promise.resolve([]),
            listR2Buckets({ throwOnError: true }),
          ]);
          const d1Reconciliation = reconcileD1ResourcesInLock(
            existingDeploymentLock,
            env,
            databases
          );
          const kvReconciliation = reconcileSharedKVResourcesInLock(
            d1Reconciliation.lock,
            env,
            namespaces
          );
          const queueReconciliation = reconcileQueueResourcesInLock(
            kvReconciliation.lock,
            queues,
            requiredQueues
          );
          const identityMismatches = [
            ...d1Reconciliation.identityMismatches.map((mismatch) => ({
              type: 'D1',
              binding: mismatch.binding,
              name: mismatch.expectedName,
            })),
            ...kvReconciliation.identityMismatches.map((mismatch) => ({
              type: 'KV',
              binding: mismatch.binding,
              name: mismatch.expectedName,
            })),
            ...queueReconciliation.identityMismatches.map((mismatch) => ({
              type: 'Queue',
              binding: mismatch.binding,
              name: mismatch.expectedName,
              reason: mismatch.reason,
            })),
          ];
          if (identityMismatches.length > 0) {
            return c.json(
              {
                success: false,
                code: 'cloudflare_resource_identity_mismatch',
                error:
                  'A same-name Cloudflare resource has a different immutable ID. Setup will not adopt it automatically; restore the original resource or explicitly recreate the environment.',
                resources: identityMismatches,
              },
              409
            );
          }

          const missingResources = [
            ...d1Reconciliation.missingBindings.map((missing) => ({
              type: 'D1',
              ...missing,
            })),
            ...kvReconciliation.missingBindings.map((missing) => ({
              type: 'KV',
              ...missing,
            })),
            ...queueReconciliation.missingBindings.map((missing) => ({
              type: 'Queue',
              ...missing,
            })),
            ...requiredR2Buckets
              .filter((required) => !r2Buckets.some((bucket) => bucket.name === required.name))
              .map((missing) => ({ type: 'R2', ...missing })),
          ];
          if (missingResources.length > 0) {
            return c.json(
              {
                success: false,
                code: 'required_cloudflare_resources_missing',
                error: 'Required Cloudflare resources are missing.',
                resources: missingResources,
              },
              409
            );
          }
          lockedCoreDatabaseIdentifier = existingDeploymentLock.d1.DB?.id;
          lockedAdminDatabaseIdentifier = existingDeploymentLock.d1.DB_ADMIN?.id;
          requireLockedCoreDatabaseIdentifier();
          requireLockedAdminDatabaseIdentifier();
        }
        if (!dryRun && runMigrations !== true) {
          return c.json(
            {
              success: false,
              error: 'Initial Web deployment cannot skip database migrations.',
            },
            400
          );
        }
        const productVersion = await getRootProductVersion(resolvedRootDir);
        const migrationRootResult = await findMigrationsRoot(resolvedRootDir, addProgress, {
          strictRoot: true,
        });
        if (!migrationRootResult.path) {
          throw new Error(
            `Release migrations directory not found: ${migrationRootResult.searchPaths.join(', ')}`
          );
        }
        const initialRelease = loadTargetReleaseMigrationManifest({
          migrationsRoot: migrationRootResult.path,
          productVersion,
          allowDraft: true,
        });
        const initialManifestChecksum = calculateReleaseManifestChecksum(initialRelease.manifest);
        const initialTargets = resolveReleaseMigrationTargets({
          lock: existingDeploymentLock,
          config: releaseConfig,
        });
        const initialDeploymentGuard = evaluateReleaseDeploymentGuard(
          existingDeploymentLock,
          productVersion,
          'initial_deploy',
          {
            releaseManifestChecksum: initialManifestChecksum,
            ...(initialRelease.draft
              ? {
                  initialDraft: {
                    manifest: initialRelease.manifest,
                    targets: initialTargets,
                  },
                }
              : {}),
          }
        );
        if (!initialDeploymentGuard.allowed) {
          return c.json(
            {
              success: false,
              error: releaseDeploymentGuardMessage(initialDeploymentGuard, productVersion),
            },
            409
          );
        }
        state.status = 'deploying';
        state.error = null;
        state.logPath = await beginProgressLog(env, 'deploy');
        startInitialDeploymentProgress();

        // Debug: Log the resolved rootDir for migrations
        addProgress(`📂 Working directory: ${resolvedRootDir}`);

        const automaticProvisioning = releaseConfig.controlPlane?.automaticProvisioning === true;
        let existingControlTokenBootstrapReady = false;
        let recoveringControlTokenBootstrapOwnership: CloudflareTokenOwnership | null = null;
        if (automaticProvisioning && !bootstrapToken && interruptedInitialRelease) {
          const controlDatabaseId = existingDeploymentLock.d1.CONTROL_DB?.id;
          if (controlDatabaseId) {
            const wranglerAccountId = await getAccountId();
            if (
              !wranglerAccountId ||
              (releaseConfig.cloudflare?.accountId &&
                releaseConfig.cloudflare.accountId !== wranglerAccountId)
            ) {
              throw new Error('cloudflare_config_account_id_mismatch');
            }
            const [lockedAuthority, pendingArtifact] = await Promise.all([
              readControlProvisioningAuthority({
                environmentId: env,
                controlDatabaseName: controlDatabaseId,
              }),
              loadPendingControlBootstrap({ baseDir: resolvedRootDir, environment: env }),
            ]);
            if (
              pendingArtifact &&
              (pendingArtifact.accountId !== wranglerAccountId ||
                pendingArtifact.environment !== env)
            ) {
              throw new CloudflareTokenBootstrapError(
                'cloudflare_token_bootstrap_checkpoint_mismatch'
              );
            }
            if (
              lockedAuthority?.bootstrapPhase === 'pending_revocation' ||
              lockedAuthority?.bootstrapPhase === 'cutover_verified'
            ) {
              if (lockedAuthority.bootstrapTokenOwnership === 'none') {
                throw new CloudflareTokenBootstrapError(
                  'cloudflare_token_bootstrap_checkpoint_mismatch'
                );
              }
              recoveringControlTokenBootstrapOwnership = lockedAuthority.bootstrapTokenOwnership;
            } else if (
              pendingArtifact &&
              isTokenlessPendingControlProvisioningAuthority(lockedAuthority)
            ) {
              recoveringControlTokenBootstrapOwnership = pendingArtifact.ownership;
            } else if (pendingArtifact) {
              throw new CloudflareTokenBootstrapError(
                'cloudflare_token_bootstrap_checkpoint_mismatch'
              );
            } else {
              existingControlTokenBootstrapReady = await hasReadyControlTokenBootstrap({
                environmentId: env,
                controlDatabaseName: controlDatabaseId,
                resourceClasses: resolveControlTokenResourceClasses(releaseConfig),
                secretSink: new WranglerControlSecretSink({
                  workerName: `${env}-ar-control`,
                  cwd: resolvedRootDir,
                }),
              });
            }
          }
        }
        const hasBootstrapInput = bootstrapToken.length > 0 && bootstrapOwnership !== null;
        const hasRecoverableBootstrap = recoveringControlTokenBootstrapOwnership !== null;
        if (
          (!automaticProvisioning && hasBootstrapInput) ||
          (automaticProvisioning &&
            !existingControlTokenBootstrapReady &&
            !hasBootstrapInput &&
            !hasRecoverableBootstrap)
        ) {
          const bootstrapInputError = automaticProvisioning
            ? 'Automatic provisioning requires one bootstrap token or a durable Control cutover'
            : 'Bootstrap token input is not allowed when Automatic provisioning is off';
          markInitialDeploymentError(bootstrapInputError);
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: bootstrapInputError,
            },
            409
          );
        }
        state.config = releaseConfig;
        addProgress(`Loaded locked config from ${configPath}`);

        const enabledComponents = Array.from(
          getEnabledComponents({
            saml: releaseConfig.components.saml,
            async: releaseConfig.components.async,
            vc: releaseConfig.components.vc,
            bridge: releaseConfig.components.bridge,
            policy: releaseConfig.components.policy,
          })
        );
        if (requestedComponents !== undefined) {
          if (
            !Array.isArray(requestedComponents) ||
            requestedComponents.some((component) => typeof component !== 'string')
          ) {
            const invalidComponentsError = 'Invalid initial deployment components.';
            markInitialDeploymentError(invalidComponentsError);
            await flushProgressLog();
            return c.json({ success: false, error: invalidComponentsError }, 400);
          }
          const requested = [...new Set(requestedComponents)].sort();
          const required = [...enabledComponents].sort();
          if (JSON.stringify(requested) !== JSON.stringify(required)) {
            const incompleteComponentsError =
              'Initial deployment must include every enabled Worker component.';
            markInitialDeploymentError(incompleteComponentsError);
            await flushProgressLog();
            return c.json(
              {
                success: false,
                error: incompleteComponentsError,
                requiredComponents: required,
              },
              409
            );
          }
        }
        const locallyRecordedComponents = WORKER_COMPONENTS.filter(
          (component) => existingDeploymentLock?.workers?.[component] !== undefined
        );
        const remotelyVerifiedExistingComponents = dryRun
          ? locallyRecordedComponents
          : await resolveExistingWorkerComponents(
              {
                env,
                rootDir: resolvedRootDir,
                dryRun: false,
                concurrency: 2,
                existingComponents: locallyRecordedComponents,
                onProgress: addProgress,
              },
              WORKER_COMPONENTS
            );
        const canResumeExactInitialHandoff =
          !dryRun &&
          existingDeploymentLock.releaseUpdate?.initialWorkerRedeployRequired !== true &&
          existingDeploymentLock.releaseUpdate?.targetVersion === productVersion &&
          existingDeploymentLock.releaseUpdate.manifestChecksum === initialManifestChecksum;
        const reconciledWorkerVersions =
          canResumeExactInitialHandoff &&
          existingDeploymentLock.releaseUpdate?.phase === 'workers_deployed' &&
          existingDeploymentLock.d1.CONTROL_DB?.id
            ? await listInitialBootstrapReconciledWorkerVersions({
                environmentId: env,
                controlDatabaseName: existingDeploymentLock.d1.CONTROL_DB.id,
              })
            : undefined;
        const initialHandoffResumeSummary = canResumeExactInitialHandoff
          ? await buildWebInitialHandoffResumeSummary({
              lock: existingDeploymentLock,
              components: enabledComponents,
              productVersion,
              allowSecretTriggeredVersionAdvanceFor: automaticProvisioning ? ['ar-control'] : [],
              reconciledWorkerVersions,
            })
          : null;
        const cfg = releaseConfig;

        // Validate the locked environment and complete component set before doing build work.
        if (!dryRun && !skipBuild && !initialHandoffResumeSummary) {
          const buildResult = await buildApiPackages({
            rootDir: resolvedRootDir,
            onProgress: addProgress,
          });

          if (!buildResult.success) {
            state.status = 'error';
            state.error = `Build failed: ${buildResult.error}`;
            addProgress(`❌ ${state.error}`);
            await flushProgressLog();
            return c.json(
              {
                success: false,
                error: `Build failed: ${sanitizeError(new Error(buildResult.error))}`,
                logPath: state.logPath,
              },
              500
            );
          }
          addProgress('Packages built successfully');
        }

        const missingStreamTargets = initialTargets.filter((target) => !target.streamId);
        if (missingStreamTargets.length > 0) {
          const missingStreamError = `No release migration stream exists for: ${missingStreamTargets
            .map((target) => target.connectionRef ?? target.id)
            .join(', ')}`;
          markInitialDeploymentError(missingStreamError);
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: missingStreamError,
            },
            400
          );
        }
        const initialManualTargetIds = new Set(
          initialTargets.filter((target) => !target.automatic).map((target) => target.id)
        );
        if (initialManualTargetIds.size > 0 && externalSchemaReady !== true && !dryRun) {
          const externalSchemaError =
            'External database migrations must be verified before initial deployment.';
          markInitialDeploymentError(externalSchemaError);
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: externalSchemaError,
            },
            409
          );
        }

        const keysDir = resolveWebDeploymentKeysDir(baseDir, env, releaseConfig);
        cleanupKeysDir = keysDir;

        let deploymentSecrets: Record<string, string> = {};
        if (!dryRun) {
          if (existsSync(keysDir)) {
            await ensureSupplementalKeysForWebDeploy(keysDir);
          }
          deploymentSecrets = await loadDeploySecretsFromKeys(
            existsSync(keysDir) ? keysDir : undefined,
            enabledComponents
          );
          const missingControlSecrets = getMissingRequiredDeploySecrets(
            deploymentSecrets,
            enabledComponents.includes('ar-control') &&
              !remotelyVerifiedExistingComponents.includes('ar-control')
              ? ['ar-control']
              : [],
            { automaticProvisioning: automaticProvisioning && !bootstrapToken }
          );
          if (missingControlSecrets.length > 0) {
            const missingSecretsError = `Missing required Control Worker secrets: ${missingControlSecrets.join(', ')}`;
            markInitialDeploymentError(missingSecretsError);
            await flushProgressLog();
            return c.json(
              {
                success: false,
                error: missingSecretsError,
              },
              409
            );
          }
          addProgress(
            `Prepared ${Object.keys(deploymentSecrets).length} secret value(s) for Worker deployment.`
          );
        }

        let migrationsResult = null;
        if (!dryRun) {
          // The existing checkpoint is the proof that an interrupted initial deployment may
          // append to a draft manifest. Do not overwrite that proof until every appended migration
          // succeeds, otherwise a transient failure leaves the next retry permanently ineligible.
          let releaseLock = existingDeploymentLock;
          if (!initialDeploymentGuard.appendOnlyInitialDraftResume) {
            releaseLock = withReleaseUpdateState(releaseLock, {
              targetVersion: productVersion,
              phase: 'planned',
              manifestChecksum: initialManifestChecksum,
              manualTargets: [...initialManualTargetIds],
            });
            await saveLockFile(releaseLock, initialLockPath);
          }
          addProgress('📜 Running exact release migrations before Worker deployment...');
          const automaticInitialTargets = initialTargets.filter((target) => target.automatic);
          const initialSchemaPlan = buildReleaseSchemaUpdatePlan({
            targetManifest: initialRelease.manifest,
            targets: automaticInitialTargets,
          });
          migrationsResult = await applyReleaseSchemaUpdatePlan({
            plan: initialSchemaPlan,
            manifest: initialRelease.manifest,
            migrationsRoot: migrationRootResult.path,
            concurrency: 2,
            backfillLegacyChecksums: !initialRelease.draft,
            onProgress: addProgress,
          });
          if (!migrationsResult.success) {
            const failedMigration = migrationsResult.results.find((result) => !result.success);
            const failedTarget = failedMigration
              ? automaticInitialTargets.find((target) => target.id === failedMigration.targetId)
              : undefined;
            const failedTargetLabel =
              failedTarget?.binding ?? failedTarget?.databaseName ?? failedMigration?.targetId;
            const migrationError = failedMigration?.error ?? 'unknown migration error';
            const failureMessage = failedTargetLabel
              ? `Database migration failed before Worker deployment (${failedTargetLabel}): ${migrationError}`
              : `Database migration failed before Worker deployment: ${migrationError}`;
            markInitialDeploymentError(failureMessage);
            await flushProgressLog();
            return c.json(
              {
                success: false,
                error: state.error,
                migrations: migrationsResult,
                logPath: state.logPath,
              },
              500
            );
          }
          const migratedTargetIds = new Set(
            migrationsResult.results.map((target) => target.targetId)
          );
          const missingAutomaticTargets = automaticInitialTargets.filter(
            (target) => !migratedTargetIds.has(target.id)
          );
          if (missingAutomaticTargets.length > 0) {
            throw new Error(
              `initial_release_schema_evidence_incomplete:${missingAutomaticTargets
                .map((target) => target.id)
                .join(',')}`
            );
          }
          const appliedTargetIds = [
            ...migrationsResult.results.map((target) => target.targetId),
            ...initialManualTargetIds,
          ];
          releaseLock = withSchemaTargetStates(releaseLock, {
            targetIds: appliedTargetIds,
            manualTargetIds: initialManualTargetIds,
            productVersion,
            manifestChecksum: initialManifestChecksum,
            targetStreamIds: new Map(initialTargets.map((target) => [target.id, target.streamId])),
            manifest: initialRelease.manifest,
          });
          releaseLock = withReleaseUpdateState(releaseLock, {
            targetVersion: productVersion,
            phase: 'schema_applied',
            manifestChecksum: initialManifestChecksum,
            appliedTargets: appliedTargetIds,
            manualTargets: [...initialManualTargetIds],
          });
          await saveLockFile(releaseLock, initialLockPath);
          addProgress('✅ Exact release migrations completed before Worker deployment');
        }

        // Regenerate wrangler.toml files from the current config/lock before deploying.
        // This keeps bindings such as send_email aligned even when setup logic evolves.
        if (!dryRun) {
          const { loadLockFileAuto } = await import('../core/lock.js');
          let { lock, path: lockPath } = await loadLockFileAuto(rootDir, env);

          if (lock) {
            const { getWorkersSubdomain } = await import('../core/cloudflare.js');

            // Get enabled components
            const enabledForValidation = Array.from(
              getEnabledComponents({
                saml: cfg?.components?.saml,
                async: cfg?.components?.async,
                vc: cfg?.components?.vc,
                bridge: cfg?.components?.bridge,
                policy: cfg?.components?.policy,
              })
            );
            addProgress('Refreshing wrangler.toml files from current configuration...');

            const workersSubdomain = await getWorkersSubdomain();
            const config = releaseConfig;

            const controlDatabase = lock.d1.CONTROL_DB;
            const migrationReleaseBucket = lock.r2?.MIGRATION_RELEASES;
            if (!controlDatabase) {
              throw new Error('control_database_required_for_release_publication');
            }
            if (!migrationReleaseBucket) {
              throw new Error('migration_release_bucket_required_for_release_publication');
            }
            const verifyMigrationBucketOwnership = () =>
              assertR2BucketOwnershipForUse({
                ...migrationReleaseBucket,
                environment: env,
                binding: 'MIGRATION_RELEASES',
              });
            await verifyMigrationBucketOwnership();
            const publication = await publishAndActivateMigrationRelease({
              migrationsRoot: migrationRootResult.path,
              manifestPath: initialRelease.path,
              bucketName: migrationReleaseBucket.name,
              controlDatabaseId: controlDatabase.id,
              environmentId: env,
              actorId: 'setup:web-deploy',
              verifyBucketOwnership: verifyMigrationBucketOwnership,
              onProgress: addProgress,
            });
            addProgress(
              `✓ Migration release ${publication.artifact.releaseId} published and activated`
            );

            const controlPlaneBootstrapResult = await ensureInitialControlPlaneResources({
              env,
              config,
              lock,
              rootDir: resolve(rootDir),
              release: initialRelease,
              onProgress: addProgress,
            });
            if (!controlPlaneBootstrapResult.success) {
              throw new Error(
                `Initial Control Plane bootstrap failed: ${controlPlaneBootstrapResult.error || 'unknown error'}`
              );
            }

            // Keep the Web initial-deploy path in parity with the CLI path. Control must know
            // which smoke signing key is active before it can reconcile the first Worker
            // bindings; otherwise it can create binding targets but cannot issue smoke RPCs.
            const controlDatabaseId = controlDatabase.id;
            await initializeControlKeyState({
              controlDatabaseId,
              environmentId: env,
              keysDir,
              actorId: 'setup:web-deploy',
            });
            const keyState = await loadControlGeneratedKeyState({
              controlDatabaseName: controlDatabase.id,
              environmentId: env,
            });
            if (!keyState) throw new Error('control_generated_key_state_missing');
            const stagedSigningKeys = await loadControlStagedSigningKeys({
              controlDatabaseName: controlDatabase.id,
              environmentId: env,
            });
            await reconcileLocalControlKeyFiles({
              keysDir,
              controlKeyState: keyState,
              stagedSigningKeys,
            });
            const keyProjection = projectControlGeneratedKeyState(lock, keyState);
            lock = keyProjection.lock;
            if (keyProjection.changed && lockPath) {
              await saveLockFile(lock, lockPath);
            }
            addProgress(
              `✓ Control signing key state ready (smoke key: ${keyState.smokeRpc.activeKeyId})`
            );
            if (lockPath) {
              const tenantTargets = resolveReleaseMigrationTargets({ lock, config }).filter(
                (target) => target.scope === 'tenant' && target.automatic
              );
              const lockWithTenantSchemas = withRecordedReleaseSchemaTargets(lock, {
                productVersion,
                manifest: initialRelease.manifest,
                targets: tenantTargets,
              });
              Object.assign(lock, lockWithTenantSchemas);
              await saveLockFile(lockWithTenantSchemas, lockPath);
              addProgress(
                `✓ Initial Control Plane bindings and schema state ready (${controlPlaneBootstrapResult.createdCount ?? 0} created)`
              );
            }

            const lockResourceIds = await buildWorkerDeploymentResourceIds({
              lock,
              config,
              environmentId: env,
              components: enabledForValidation,
              onProgress: addProgress,
            });
            const masterResult = await saveMasterWranglerConfigs(config, lockResourceIds, {
              baseDir,
              env,
              capabilityManifestBaseDir: resolvedRootDir,
              components: enabledForValidation,
              onProgress: addProgress,
            });
            if (!masterResult.success) {
              throw new Error(`generated_wrangler_config_failed:${masterResult.errors.join(',')}`);
            }
            const syncResult = await syncWranglerConfigs({
              baseDir,
              env,
              packagesDir: join(resolvedRootDir, 'packages'),
              force: true,
              components: enabledForValidation,
              onProgress: addProgress,
            });
            if (!syncResult.success) {
              throw new Error(`wrangler_config_sync_failed:${syncResult.errors.join(',')}`);
            }

            for (const component of enabledForValidation) {
              const componentDir = join(resolve(rootDir), 'packages', component);
              if (!existsSync(componentDir)) {
                continue;
              }
              if (
                component === 'ar-control' ||
                component === 'ar-auth' ||
                component === 'ar-bridge'
              ) {
                const bootstrapConfig = generateWranglerConfig(
                  component,
                  config,
                  lockResourceIds,
                  workersSubdomain ?? undefined,
                  component === 'ar-control'
                    ? { includeControlSmokeBindings: false }
                    : component === 'ar-auth'
                      ? { includeAuthAccountProvisioner: false }
                      : { includeExternalIdpAccountProvisioner: false }
                );
                await writePrivateFileAtomically(
                  join(componentDir, 'wrangler.bootstrap.toml'),
                  toToml(bootstrapConfig, env),
                  0o644
                );
              }
            }

            const inventory = await compileControlWorkerInventoryFromArtifacts({
              baseDir: resolvedRootDir,
              environmentId: env,
              environmentName: env,
              components: enabledForValidation,
              artifactPaths: masterResult.files,
            });
            await registerControlWorkerInventory({
              controlDatabaseName: controlDatabase.id,
              records: inventory,
              environmentBootstrap: {
                defaultResidencyPolicyId: config.profiles.defaults.residency,
                automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
              },
              registeredBy: 'setup:web-deploy',
              onProgress: addProgress,
            });
            await registerInitialControlTopology({
              environmentId: env,
              tenantId: config.tenant?.name?.trim() || 'default',
              controlDatabaseName: controlDatabase.id,
              lock,
              release: initialRelease.manifest,
              releaseDraft: initialRelease.draft,
              automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
              placementPolicy: config.tenant.placementPolicy,
            });
            const externalSources = await discoverExternalCapabilities({
              baseDir: resolvedRootDir,
            });
            const pluginBundleBucket = lock.r2?.PLUGIN_BUNDLES;
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
              baseDir: resolvedRootDir,
              enabled: config.features.pluginDynamicWorkers.enabled,
              sources: externalSources,
              bucketName: pluginBundleBucket?.name,
              pluginRunnerDatabaseId: lock.d1?.PLUGIN_RUNNER_DB?.id,
              verifyBucketOwnership: verifyPluginBundleOwnership,
              onProgress: addProgress,
            });
            await registerExternalCapabilities({
              controlDatabaseName: controlDatabase.id,
              environmentId: env,
              sources: externalSources,
              registeredBy: 'setup:web-deploy',
            });

            addProgress('✓ wrangler.toml files refreshed');
          }
        }

        addProgress('Deploying workers...');

        if (!dryRun) {
          try {
            const dnsLockState = await loadLockFileAuto(rootDir, env);
            let dnsLock = dnsLockState.lock;
            if (!dnsLock || !dnsLockState.path) {
              throw new Error('dns_ownership_lock_unavailable');
            }
            await ensureWildcardDnsForMultiTenant(cfg, addProgress, undefined, {
              get: (role) => dnsLock?.dns?.[role],
              persist: async (entry) => {
                if (!dnsLock) throw new Error('dns_ownership_lock_unavailable');
                dnsLock = withDnsOwnershipEntry(dnsLock, entry);
                await saveLockFile(dnsLock, dnsLockState.path);
              },
            });
          } catch (error) {
            const manualAction = getWildcardDnsManualActionPayload(cfg);
            if (manualAction && isWildcardDnsPermissionError(error)) {
              state.status = 'error';
              state.error = 'Manual wildcard DNS setup required';
              addProgress('⚠️ Automatic wildcard DNS setup is unavailable.');
              addProgress('⚠️ Create the wildcard DNS record manually, then rerun deploy.');
              markInitialDeploymentManualAction();
              await flushProgressLog();
              return c.json(
                {
                  success: false,
                  error: 'Manual wildcard DNS setup required',
                  manualAction,
                  logPath: state.logPath,
                },
                409
              );
            }
            throw error;
          }
        }

        const existingComponents = remotelyVerifiedExistingComponents;
        const enabledUiBindingTargets = {
          loginUi: cfg?.components?.loginUi ?? true,
          adminUi: cfg?.components?.adminUi ?? true,
        };
        const routerSelected = enabledComponents?.includes('ar-router') === true;
        const missingUiBindingTargets = routerSelected
          ? dryRun
            ? enabledUiBindingTargets
            : await resolveMissingUiWorkerBindingTargets(
                { env, rootDir: resolve(rootDir), onProgress: addProgress },
                enabledUiBindingTargets
              )
          : { loginUi: false, adminUi: false };

        let initialWorkerOwnership: WorkerScriptOwnershipGuard | undefined;
        if (!dryRun && !initialHandoffResumeSummary) {
          const ownershipLockState = await loadLockFileAuto(rootDir, env);
          if (!ownershipLockState.lock || !ownershipLockState.path) {
            throw new Error('worker_script_ownership_lock_unavailable');
          }
          const ownership = await prepareManagedWorkerScriptOwnership({
            lock: ownershipLockState.lock,
            lockPath: ownershipLockState.path,
            targets: [
              ...enabledComponents.map((component) => ({
                component,
                workerName: getWorkerName(env, component),
              })),
              ...UI_WORKER_COMPONENTS.filter((component) =>
                component === 'ar-login-ui'
                  ? cfg?.components?.loginUi !== false
                  : cfg?.components?.adminUi !== false
              ).map((component) => ({ component, workerName: `${env}-${component}` })),
            ],
          });
          if (ownership.changed) {
            await saveLockFile(ownership.lock, ownershipLockState.path);
          }
          initialWorkerOwnership = ownership.guard;
        }

        if (
          (missingUiBindingTargets.loginUi || missingUiBindingTargets.adminUi) &&
          routerSelected
        ) {
          const placeholderSummary = await deployUiWorkerBindingTargets(
            {
              env,
              rootDir: resolve(rootDir),
              dryRun,
              apiBaseUrl: resolveIssuerUrl(cfg, { env }),
              deployConfigLockProof: deployConfigLock?.proof,
              workerScriptOwnership: initialWorkerOwnership,
              onProgress: addProgress,
            },
            missingUiBindingTargets
          );

          if (placeholderSummary.failedCount > 0) {
            addProgress(
              `⚠️ UI Worker pre-deploy failed: ${placeholderSummary.successCount}/${placeholderSummary.results.length} succeeded`
            );
            for (const result of placeholderSummary.results) {
              if (!result.success) {
                addProgress(`  ✗ ${result.component}: ${result.error || 'unknown error'}`);
              }
            }
            addProgress('  ar-router may fail if it references missing UI Worker bindings.');
          }
        }

        const resumeSummary = initialHandoffResumeSummary;
        const summary =
          resumeSummary ??
          (await deployAll(
            {
              env,
              rootDir: resolve(rootDir),
              dryRun,
              concurrency: 2,
              deploymentStrategy: 'auto',
              existingComponents,
              secrets: deploymentSecrets,
              automaticProvisioning: automaticProvisioning && !bootstrapToken,
              cleanupLegacyStaticSecrets: true,
              deployConfigLockProof: deployConfigLock?.proof,
              workerScriptOwnership: initialWorkerOwnership,
              onProgress: addProgress,
              onError: (comp, error) => {
                addProgress(`Error in ${comp}: ${sanitizeError(error)}`);
              },
            },
            enabledComponents
          ));
        if (resumeSummary) {
          addProgress(
            `Resuming initial deployment from ${resumeSummary.results.length} active Worker version(s); no Worker traffic was changed.`
          );
        }

        state.deployResults = summary.results;

        let uiWorkersSummary = null;
        let uiWorkersHealthReady = true;

        const successfulWorkerComponents = new Set(
          summary.results.filter((result) => result.success).map((result) => result.component)
        );
        const missingWorkerComponents = enabledComponents.filter(
          (component) => !successfulWorkerComponents.has(component)
        );
        const workersSuccess = summary.failedCount === 0 && missingWorkerComponents.length === 0;
        if (missingWorkerComponents.length > 0) {
          addProgress(
            `✗ Initial deployment did not complete required Workers: ${missingWorkerComponents.join(', ')}`
          );
        }
        let setupMachineAccessCleanupDone = false;
        const cleanupEphemeralSetupMachineAccess = async (): Promise<boolean> => {
          if (setupMachineAccessCleanupDone || dryRun || !setupMachineAccessAttempted) {
            return setupMachineAccessCleanupSuccess;
          }
          try {
            const cleanupResult = await cleanupSetupMachineAccessInD1(env, keysDir, addProgress, {
              databaseIdentifier: requireLockedAdminDatabaseIdentifier(),
            });
            if (cleanupResult.success) {
              setupMachineAccessCleanupDone = true;
              setupMachineAccessCleanupSuccess = true;
              return true;
            }
            setupMachineAccessCleanupSuccess = false;
            addProgress(
              `⚠️ Setup machine access cleanup failed: ${cleanupResult.error || 'unknown error'}`
            );
          } catch (error) {
            setupMachineAccessCleanupSuccess = false;
            addProgress(`⚠️ Setup machine access cleanup failed: ${sanitizeError(error)}`);
          }
          return false;
        };

        const apiBaseUrl = resolveIssuerUrl(cfg, { env });

        if (workersSuccess && !dryRun) {
          const workerDeploymentResult = await waitForWorkerDeploymentsReady({
            targets: summary.results
              .filter((result) => result.success)
              .map((result) => ({
                workerName: result.workerName,
                deployedAt: result.deployedAt,
                expectedVersionId: result.cloudflareVersionId,
              })),
            onProgress: addProgress,
          });
          if (!workerDeploymentResult.ready) {
            throw new Error(
              `Worker deployments did not become visible: ${workerDeploymentResult.error || 'unknown verification error'}`
            );
          }

          const { lock: checkpointLock, path: checkpointPath } = await loadLockFileAuto(
            rootDir,
            env
          );
          if (!checkpointLock || !checkpointPath) {
            throw new Error('Deployment lock disappeared before the handoff checkpoint was saved.');
          }
          let verifiedWorkerLock = withReleaseUpdateState(
            updateLockWithDeployments(checkpointLock, summary.results),
            {
              targetVersion: productVersion,
              phase: 'workers_deployed',
              manifestChecksum: initialManifestChecksum,
              initialWorkerRedeployRequired: false,
            }
          );

          if ((bootstrapToken && bootstrapOwnership) || recoveringControlTokenBootstrapOwnership) {
            const accountId = releaseConfig.cloudflare?.accountId ?? (await getAccountId());
            const controlDatabaseId = verifiedWorkerLock.d1.CONTROL_DB?.id;
            if (!accountId || !controlDatabaseId) {
              throw new Error('control_token_bootstrap_target_missing');
            }
            await completeControlTokenBootstrap({
              accountId,
              environment: env,
              rootDir: resolvedRootDir,
              controlDatabaseName: controlDatabaseId,
              ...(bootstrapToken ? { bootstrapToken } : {}),
              ownership: bootstrapOwnership ?? recoveringControlTokenBootstrapOwnership!,
              resourceClasses: resolveControlTokenResourceClasses(releaseConfig),
            });
            const readyAuthority = await readControlProvisioningAuthority({
              controlDatabaseName: controlDatabaseId,
              environmentId: env,
            });
            if (
              readyAuthority?.capabilityState !== 'ready' ||
              readyAuthority.tokenManagement !== 'setup' ||
              !readyAuthority.secretGeneration
            ) {
              throw new Error('control_token_bootstrap_ready_evidence_missing');
            }
            const reconciled = reconcileControlSecretGenerationWorkerLock({
              lock: verifiedWorkerLock,
              authority: readyAuthority,
            });
            const controlResult = summary.results.find(
              (result) => result.component === 'ar-control' && result.success
            );
            if (!controlResult) {
              throw new Error('control_token_bootstrap_deployment_result_missing');
            }
            controlResult.cloudflareVersionId = readyAuthority.secretGeneration.versionId;
            controlResult.deployedAt = new Date(readyAuthority.updatedAt * 1000).toISOString();
            verifiedWorkerLock = reconciled.lock;
            bootstrapToken = '';
            addProgress(
              'Automatic provisioning credentials registered and bootstrap token revoked.'
            );
          }

          const workersSubdomain = await getWorkersSubdomain();
          const workerHttpTargets = buildWorkerHttpReadinessTargets(
            summary.results.filter((result) => result.success),
            workersSubdomain,
            { workersDevEnabled: !cfg?.urls?.api?.custom }
          );
          if (workerHttpTargets.length > 0) {
            const workerHttpResult = await waitForWorkerHttpReady({
              targets: workerHttpTargets,
              onProgress: addProgress,
            });
            if (!workerHttpResult.ready) {
              throw new Error(
                `Worker HTTP health checks failed: ${workerHttpResult.error || 'unknown health check error'}`
              );
            }
          }

          const readinessResult = await waitForRouterWorkerReady({
            apiBaseUrl,
            onProgress: addProgress,
            onDetail: addDetailProgress,
          });
          if (!readinessResult.ready) {
            handleRouterReadinessFailure(
              cfg,
              readinessResult.checkedUrl,
              readinessResult.error,
              addProgress
            );
          }

          await saveLockFile(verifiedWorkerLock, checkpointPath);
          addProgress('Saved initial Worker identity and health checkpoint');

          const { lock: handoffLock } = await loadLockFileAuto(rootDir, env);
          const controlDatabaseId = handoffLock?.d1.CONTROL_DB?.id;
          if (!controlDatabaseId) {
            throw new Error('control_database_required');
          }
          const deployedWorkerCount = new Set(
            summary.results.filter((result) => result.success).map((result) => result.workerName)
          ).size;
          addProgress(
            `Waiting for Control bootstrap verification of ${deployedWorkerCount} Worker(s)...`
          );
          let acceleratorFallbackReported = false;
          const smokeKeyState = handoffLock.controlKeyState?.smokeRpc;
          await waitForInitialBootstrapHandoff({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
            timeoutMs: 30 * 60_000,
            stallTimeoutMs: 5 * 60_000,
            pollIntervalMs: 2_000,
            onProgress: addProgress,
            advanceBindings: automaticProvisioning
              ? smokeKeyState
                ? async () => {
                    try {
                      await requestInitialBootstrapAcceleration({
                        apiBaseUrl,
                        environmentId: env,
                        keysDir,
                        activeSlot: smokeKeyState.activeSlot,
                        activeKeyId: smokeKeyState.activeKeyId,
                      });
                    } catch {
                      if (!acceleratorFallbackReported) {
                        acceleratorFallbackReported = true;
                        addProgress(
                          'Control bootstrap acceleration unavailable; continuing with scheduled verification...'
                        );
                      }
                    }
                  }
                : undefined
              : () =>
                  advanceInitialBootstrapWorkerBindingsAsOperator({
                    controlDatabaseId,
                    controlDatabaseName: controlDatabaseId,
                    environmentId: env,
                  }),
            refreshEvidence: () =>
              recordInitialBootstrapWorkerEvidence({
                environmentId: env,
                controlDatabaseName: controlDatabaseId,
                deployments: summary.results,
                allowSecretTriggeredVersionAdvanceFor: automaticProvisioning
                  ? [`${env}-ar-control`]
                  : undefined,
              }),
            reconcile: () =>
              reconcileInitialBootstrapHandoffAsOperator({
                controlDatabaseId,
                executeWorkerBindings: false,
              }),
          });
          addProgress('✓ Initial D1 topology accepted by Control');
        }

        // Complete post-deploy bootstrap only after the schema-first step above.
        let initialTenantResult = null;
        let initialNotificationProviderSuccess = true;
        let initialNotificationProviderError: string | null = null;
        let initialAdminRolesResult = null;
        let setupMachineAccessResult = null;
        let adminUiBffMachineAccessResult = null;
        let defaultCanonicalCatalogSeedResult = null;
        let runtimeProfileSeedResult = null;
        if (migrationsResult?.success && !dryRun && workersSuccess) {
          const bootstrapConfig = cfg ? AuthrimConfigSchema.parse(cfg) : createDefaultConfig(env);
          if (migrationsResult.success) {
            addProgress(`🔧 Ensuring initial tenant exists (${bootstrapConfig.tenant.name})...`);
            initialTenantResult = await ensureInitialTenantInD1(env, bootstrapConfig, addProgress, {
              databaseIdentifier: requireLockedCoreDatabaseIdentifier(),
            });
            if (initialTenantResult.success) {
              addProgress(`✅ Initial tenant ready: ${bootstrapConfig.tenant.name}`);
            } else {
              addProgress(
                `⚠️ Initial tenant bootstrap failed: ${initialTenantResult.error || 'unknown error'}`
              );
            }

            if (initialTenantResult.success) {
              addProgress('🔧 Materializing initial notification provider order...');
              try {
                const notificationProviderResult =
                  await ensureInitialNotificationProviderConfiguration({
                    environmentId: env,
                    config: bootstrapConfig,
                    lock: existingDeploymentLock,
                    keysDir,
                  });
                addProgress(
                  notificationProviderResult.providerId
                    ? `✅ Initial notification provider ready: ${notificationProviderResult.providerId}`
                    : '✅ Notification delivery explicitly disabled'
                );
              } catch (error) {
                initialNotificationProviderSuccess = false;
                initialNotificationProviderError = sanitizeError(error);
                addProgress(
                  `⚠️ Initial notification provider bootstrap failed: ${initialNotificationProviderError}`
                );
              }
            }

            addProgress(
              `🔧 Ensuring initial admin roles exist (${bootstrapConfig.tenant.name})...`
            );
            initialAdminRolesResult = await ensureInitialAdminRolesInD1(
              env,
              bootstrapConfig,
              addProgress,
              { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
            );
            if (initialAdminRolesResult.success) {
              addProgress(`✅ Initial admin roles ready: ${bootstrapConfig.tenant.name}`);
            } else {
              addProgress(
                `⚠️ Initial admin role bootstrap failed: ${initialAdminRolesResult.error || 'unknown error'}`
              );
            }

            addProgress('🔧 Ensuring setup machine access exists...');
            setupMachineAccessAttempted = true;
            setupMachineAccessResult = await ensureSetupMachineAccessInD1(
              env,
              bootstrapConfig,
              keysDir,
              addProgress,
              { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
            );
            if (setupMachineAccessResult.success) {
              addProgress('✅ Setup machine access ready');
            } else {
              addProgress(
                `⚠️ Setup machine access bootstrap failed: ${setupMachineAccessResult.error || 'unknown error'}`
              );
            }

            if (bootstrapConfig.components.adminUi ?? true) {
              addProgress('🔧 Ensuring Admin UI BFF machine access exists...');
              adminUiBffMachineAccessResult = await ensureAdminUiBffMachineAccessInD1(
                env,
                bootstrapConfig,
                keysDir,
                addProgress,
                { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
              );
              if (adminUiBffMachineAccessResult.success) {
                addProgress('✅ Admin UI BFF machine access ready');
              } else {
                addProgress(
                  `⚠️ Admin UI BFF machine access bootstrap failed: ${adminUiBffMachineAccessResult.error || 'unknown error'}`
                );
              }
            }

            addProgress('🔧 Seeding default canonical field catalog...');
            defaultCanonicalCatalogSeedResult = await seedDefaultCanonicalCatalog(
              env,
              bootstrapConfig,
              addProgress,
              { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
            );
            if (defaultCanonicalCatalogSeedResult.success) {
              addProgress(
                `✅ Default canonical field catalog ready (${defaultCanonicalCatalogSeedResult.seededCount} fields)`
              );
            } else {
              addProgress(
                `⚠️ Default canonical field catalog seed failed: ${defaultCanonicalCatalogSeedResult.error || 'unknown error'}`
              );
            }

            addProgress('🔧 Seeding runtime profiles...');
            runtimeProfileSeedResult = await seedRuntimeProfiles(
              env,
              bootstrapConfig,
              addProgress,
              { databaseIdentifier: requireLockedCoreDatabaseIdentifier() }
            );
            if (runtimeProfileSeedResult.success) {
              addProgress(
                `✅ Runtime profiles ready (${runtimeProfileSeedResult.seededCount} seeded to ${runtimeProfileSeedResult.backend})`
              );
            } else {
              addProgress(
                `⚠️ Runtime profile seed failed: ${runtimeProfileSeedResult.error || 'unknown error'}`
              );
            }

            const { lock: latestLock } = await import('../core/lock.js').then((module) =>
              module.loadLockFileAuto(rootDir, env)
            );
            const controlPlaneSnapshotResult = await publishInitialControlPlaneRuntimeSnapshot({
              env,
              config: bootstrapConfig,
              lock: latestLock ?? createLockFile(env, { d1: [], kv: [], queues: [], r2: [] }),
              rootDir: resolve(rootDir),
              keysDir,
              release: initialRelease.manifest,
              onProgress: addProgress,
            });
            if (controlPlaneSnapshotResult.success) {
              if (!controlPlaneSnapshotResult.skipped) {
                addProgress('✅ Initial Control Plane runtime snapshot ready');
              }
            } else {
              throw new Error(
                `Initial Control Plane runtime snapshot failed: ${
                  controlPlaneSnapshotResult.error || 'unknown error'
                }`
              );
            }
          }
        }

        const migrationsSuccess = migrationsResult ? migrationsResult.success : true;
        const initialTenantSuccess = initialTenantResult ? initialTenantResult.success : true;
        const initialAdminRolesSuccess = initialAdminRolesResult
          ? initialAdminRolesResult.success
          : true;
        const setupMachineAccessSuccess = setupMachineAccessResult
          ? setupMachineAccessResult.success
          : true;
        const adminUiBffMachineAccessSuccess = adminUiBffMachineAccessResult
          ? adminUiBffMachineAccessResult.success
          : true;
        const runtimeProfileSeedSuccess = runtimeProfileSeedResult
          ? runtimeProfileSeedResult.success
          : true;
        const defaultCanonicalCatalogSeedSuccess = defaultCanonicalCatalogSeedResult
          ? defaultCanonicalCatalogSeedResult.success
          : true;

        const bootstrapSuccess =
          migrationsSuccess &&
          initialTenantSuccess &&
          initialNotificationProviderSuccess &&
          initialAdminRolesSuccess &&
          setupMachineAccessSuccess &&
          adminUiBffMachineAccessSuccess &&
          defaultCanonicalCatalogSeedSuccess &&
          runtimeProfileSeedSuccess;

        if (workersSuccess && bootstrapSuccess) {
          await maybeConfigureDownstreamIntrospectionForWebDeploy({
            env,
            rootDir: resolve(rootDir),
            config: cfg,
            components: enabledComponents ?? [],
            knownRouterReadyBaseUrls: [apiBaseUrl],
            dryRun,
            deployConfigLockProof: deployConfigLock?.proof,
          });
        }

        // Deploy UI Workers only after database and tenant bootstrap work has completed.
        if (
          workersSuccess &&
          bootstrapSuccess &&
          (cfg?.components?.loginUi || cfg?.components?.adminUi)
        ) {
          addProgress('Deploying Login/Admin UI to Cloudflare Workers...');

          let loginUiClientId: string | undefined;
          if (cfg?.components?.loginUi && !dryRun) {
            const loginUiUrl = resolveLoginUiExecutionOrigin(cfg, { env });

            const { ensureLoginUiClient } = await import('../core/login-ui-client.js');
            const clientResult = await ensureLoginUiClient({
              apiBaseUrl,
              loginUiUrl,
              keysDir,
              tenantId: cfg?.tenant?.name,
              onProgress: addProgress,
            });

            if (clientResult.success && clientResult.clientId) {
              loginUiClientId = clientResult.clientId;
              if (clientResult.alreadyExists) {
                addProgress(`  ✓ Login UI client exists: ${loginUiClientId}`);
              } else {
                addProgress(`  ✓ Login UI client created: ${loginUiClientId}`);
              }
            } else {
              await cleanupEphemeralSetupMachineAccess();
              throw new Error(
                `Login UI client creation failed: ${clientResult.error || 'unknown error'}`
              );
            }
          }

          if (await cleanupEphemeralSetupMachineAccess()) {
            const loginUiSettings = resolveUiDeploymentSettings({
              component: 'ar-login-ui',
              config: cfg as AuthrimConfig,
              apiBaseUrl,
              loginUiClientId,
            });
            if (loginUiClientId) {
              await mergeAndSaveUiEnv(
                getEnvironmentPaths({ baseDir: rootDir, env }).uiEnv,
                loginUiSettings.uiEnv
              );
              addProgress('Login UI env updated with client_id');
            }
            const adminUiSettings = resolveUiDeploymentSettings({
              component: 'ar-admin-ui',
              config: cfg as AuthrimConfig,
              apiBaseUrl,
            });
            const adminUiBffSecrets =
              (cfg?.components?.adminUi ?? true) && !dryRun
                ? await prepareAdminUiBffDeployment({
                    env,
                    config: cfg as AuthrimConfig,
                    keysDir,
                    databaseIdentifier: requireLockedAdminDatabaseIdentifier(),
                    onProgress: addProgress,
                  })
                : undefined;
            if ((cfg?.components?.adminUi ?? true) && adminUiSettings.adminUiApiMode) {
              addProgress(
                `Admin UI API mode: ${adminUiSettings.adminUiApiMode} - ${describeAdminUiApiMode(
                  adminUiSettings.adminUiApiMode
                )}`
              );
            }

            uiWorkersSummary = await deployAllUiWorkers(
              {
                env,
                rootDir: resolve(rootDir),
                dryRun,
                deployConfigLockProof: deployConfigLock?.proof,
                workerScriptOwnership: initialWorkerOwnership,
                onProgress: addProgress,
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
                loginUi: cfg?.components?.loginUi ?? true,
                adminUi: cfg?.components?.adminUi ?? true,
              }
            );

            if (!dryRun && uiWorkersSummary.failedCount === 0) {
              const missingExactVersion = uiWorkersSummary.results.find(
                (result) =>
                  !result.deployedAt || !result.cloudflareVersionId || !result.cloudflareScriptTag
              );
              if (missingExactVersion) {
                throw new Error(
                  `ui_worker_deployment_exact_version_unavailable:${missingExactVersion.component}`
                );
              }
              const visibility = await waitForWorkerDeploymentsReady({
                targets: uiWorkersSummary.results.map((result) => ({
                  workerName: result.projectName,
                  deployedAt: result.deployedAt,
                  expectedVersionId: result.cloudflareVersionId,
                })),
                onProgress: addProgress,
              });
              if (!visibility.ready) {
                uiWorkersHealthReady = false;
                addProgress(
                  `✗ UI Worker deployment visibility failed: ${visibility.error ?? 'unknown error'}`
                );
              } else {
                const workersSubdomain = await getWorkersSubdomain();
                const httpReadiness = await waitForWorkerHttpReady({
                  targets: uiWorkersSummary.results.map((result) => ({
                    workerName: result.projectName,
                    url:
                      result.component === 'ar-login-ui'
                        ? resolveLoginUiEntryUrl(releaseConfig, { env, workersSubdomain })
                        : resolveAdminUiEntryUrl(releaseConfig, { env, workersSubdomain }),
                  })),
                  onProgress: addProgress,
                });
                if (!httpReadiness.ready) {
                  uiWorkersHealthReady = false;
                  addProgress(
                    `✗ UI Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
                  );
                }
              }
            }

            if (
              !dryRun &&
              uiWorkersSummary.failedCount === 0 &&
              uiWorkersHealthReady &&
              uiWorkersSummary.results.some((result) => result.success)
            ) {
              const { lock: currentLock, path: currentLockPath } = await loadLockFileAuto(
                rootDir,
                env
              );
              if (currentLock && currentLockPath) {
                const workers = { ...currentLock.workers };
                for (const result of uiWorkersSummary.results) {
                  if (!result.success) continue;
                  if (
                    !result.deployedAt ||
                    !result.cloudflareVersionId ||
                    !result.cloudflareScriptTag
                  ) {
                    throw new Error(
                      `ui_worker_deployment_exact_version_unavailable:${result.component}`
                    );
                  }
                  workers[result.component] = {
                    name: result.projectName,
                    deployedAt: result.deployedAt,
                    version:
                      (await getPackageVersion(join(rootDir, 'packages', result.component))) ??
                      undefined,
                    cloudflareVersionId: result.cloudflareVersionId,
                    cloudflareScriptTag: result.cloudflareScriptTag,
                  };
                }
                await saveLockFile(
                  clearProvisionalWorkerScriptOwnership(
                    { ...currentLock, workers, updatedAt: new Date().toISOString() },
                    uiWorkersSummary.results.map((result) => result.component)
                  ),
                  currentLockPath
                );
              }
            }

            if (
              !dryRun &&
              uiWorkersSummary.failedCount === 0 &&
              uiWorkersHealthReady &&
              uiWorkersSummary.results.length > 0
            ) {
              const { lock: currentLock } = await loadLockFileAuto(rootDir, env);
              const controlDatabaseId = currentLock?.d1.CONTROL_DB?.id;
              if (!controlDatabaseId) {
                throw new Error('control_database_required_for_ui_worker_inventory');
              }
              await registerUiWorkerInventoryFromArtifacts({
                baseDir: resolve(rootDir),
                environmentId: env,
                environmentName: env,
                controlDatabaseName: controlDatabaseId,
                components: uiWorkersSummary.results.map((result) => result.component),
                environmentBootstrap: {
                  defaultResidencyPolicyId: (cfg as AuthrimConfig).profiles.defaults.residency,
                  automaticProvisioning:
                    (cfg as AuthrimConfig).controlPlane?.automaticProvisioning === true,
                },
                registeredBy: 'setup:web-deploy-ui',
                onProgress: addProgress,
              });
            }

            if (uiWorkersSummary.failedCount === 0) {
              addProgress('✓ All UI packages deployed to Workers');
              for (const result of uiWorkersSummary.results) {
                addProgress(`  • ${result.component}: ${result.projectName}`);
              }
            } else {
              addProgress(
                `✗ UI Worker deployment: ${uiWorkersSummary.successCount}/${uiWorkersSummary.results.length} succeeded`
              );
              for (const result of uiWorkersSummary.results) {
                if (!result.success) {
                  addProgress(`  ✗ ${result.component}: ${result.error}`);
                }
              }
            }
          }
        }

        if (!(await cleanupEphemeralSetupMachineAccess())) {
          await cleanupEphemeralSetupMachineAccess();
        }

        const uiWorkersSuccess = uiWorkersSummary
          ? uiWorkersSummary.failedCount === 0 && uiWorkersHealthReady
          : true;
        const deploymentSucceeded =
          workersSuccess &&
          uiWorkersSuccess &&
          migrationsSuccess &&
          initialTenantSuccess &&
          initialNotificationProviderSuccess &&
          initialAdminRolesSuccess &&
          setupMachineAccessSuccess &&
          setupMachineAccessCleanupSuccess &&
          adminUiBffMachineAccessSuccess &&
          defaultCanonicalCatalogSeedSuccess &&
          runtimeProfileSeedSuccess;

        if (deploymentSucceeded) {
          if (!dryRun) {
            const { lock: finalLock, path: finalLockPath } = await loadLockFileAuto(rootDir, env);
            if (!finalLock) throw new Error('Deployment lock disappeared before verification.');
            const finalTargets = resolveReleaseMigrationTargets({
              lock: finalLock,
              config: releaseConfig,
            });
            const verifiedLock = withVerifiedInitialReleaseState(finalLock, {
              productVersion,
              manifestChecksum: initialManifestChecksum,
              manifest: initialRelease.manifest,
              targets: finalTargets,
              acknowledgedManualTargetIds: initialManualTargetIds,
            });
            await saveLockFile(verifiedLock, finalLockPath);
            addProgress(`Release state verified at ${productVersion}.`);
          }
          state.status = 'complete';
          addProgress('Deployment complete!');
        } else {
          state.status = 'error';
          if (!workersSuccess) {
            state.error =
              missingWorkerComponents.length > 0
                ? `Required Worker components were not deployed: ${missingWorkerComponents.join(', ')}`
                : `${summary.failedCount} components failed to deploy`;
          } else if (!uiWorkersSuccess) {
            const failedUiWorkers = uiWorkersSummary?.results.filter((r) => !r.success) ?? [];
            state.error = `UI Worker deployment failed: ${failedUiWorkers.map((r) => `${r.component}: ${r.error}`).join(', ')}`;
          } else if (!migrationsSuccess) {
            const errors =
              migrationsResult?.results
                .filter((result) => !result.success)
                .map((result) => `${result.targetId}: ${result.error ?? 'unknown error'}`) ?? [];
            state.error = `Migrations failed: ${errors.join(', ')}`;
          } else if (!initialTenantSuccess) {
            state.error = `Initial tenant bootstrap failed: ${initialTenantResult?.error || 'unknown error'}`;
          } else if (!initialNotificationProviderSuccess) {
            state.error = `Initial notification provider bootstrap failed: ${initialNotificationProviderError || 'unknown error'}`;
          } else if (!initialAdminRolesSuccess) {
            state.error = `Initial admin role bootstrap failed: ${initialAdminRolesResult?.error || 'unknown error'}`;
          } else if (!setupMachineAccessSuccess) {
            state.error = `Setup machine access bootstrap failed: ${setupMachineAccessResult?.error || 'unknown error'}`;
          } else if (!setupMachineAccessCleanupSuccess) {
            state.error =
              'Setup machine access cleanup failed; retry deployment to remove temporary access';
          } else if (!adminUiBffMachineAccessSuccess) {
            state.error = `Admin UI BFF machine access bootstrap failed: ${adminUiBffMachineAccessResult?.error || 'unknown error'}`;
          } else if (!defaultCanonicalCatalogSeedSuccess) {
            state.error = `Default canonical field catalog seed failed: ${defaultCanonicalCatalogSeedResult?.error || 'unknown error'}`;
          } else if (!runtimeProfileSeedSuccess) {
            state.error = `Runtime profile seed failed: ${runtimeProfileSeedResult?.error || 'unknown error'}`;
          }
          addProgress(`❌ ${state.error}`);
        }

        addProgress(`📝 Progress log saved: ${state.logPath}`);
        await flushProgressLog();

        return c.json({
          success: deploymentSucceeded,
          error: state.error,
          summary,
          uiWorkersResult: uiWorkersSummary,
          migrationsResult,
          initialTenantResult,
          initialAdminRolesResult,
          defaultCanonicalCatalogSeedResult,
          runtimeProfileSeedResult,
          logPath: state.logPath,
        });
      } catch (error) {
        let cleanupFailure: string | null = null;
        try {
          if (setupMachineAccessAttempted && cleanupEnv && cleanupKeysDir) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                const cleanupResult = await cleanupSetupMachineAccessInD1(
                  cleanupEnv,
                  cleanupKeysDir,
                  addProgress,
                  { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
                );
                if (cleanupResult.success) {
                  cleanupFailure = null;
                  break;
                }
                cleanupFailure = cleanupResult.error || 'unknown cleanup error';
              } catch (cleanupError) {
                cleanupFailure = sanitizeError(cleanupError);
              }
            }
          }
        } catch (cleanupError) {
          cleanupFailure = sanitizeError(cleanupError);
        }
        state.status = 'error';
        const primaryError = sanitizeError(error);
        state.error = cleanupFailure
          ? `${primaryError}; setup machine access cleanup also failed: ${cleanupFailure}`
          : primaryError;
        addProgress(`❌ Deployment failed: ${state.error}`);
        await flushProgressLog();
        return c.json(
          {
            success: false,
            error: state.error,
            logPath: state.logPath,
            cleanupRequired:
              error instanceof CloudflareTokenBootstrapError && error.cleanupRequired,
            bootstrapRetainedForRetry:
              error instanceof CloudflareTokenBootstrapError && error.bootstrapRetainedForRetry,
            recoveryTokenRequired:
              error instanceof CloudflareTokenBootstrapError &&
              error.code === 'cloudflare_bootstrap_recovery_token_required',
          },
          500
        );
      } finally {
        bootstrapToken = '';
        try {
          await deployConfigLock?.release();
        } finally {
          await environmentOperationLock?.release();
        }
      }
    });
  });

  // Get deployment status (no auth required - read-only)
  api.get('/deploy/status', (c) => {
    return c.json({
      status: state.status,
      progress: state.progress,
      error: state.error,
      results: state.deployResults,
      logPath: state.logPath,
      operationProgress: state.operationProgress,
      deploymentProgress: state.deploymentProgress,
    });
  });

  // Reset state (with lock)
  api.post('/reset', async (c) => {
    return withLock(async () => {
      await flushProgressLog();
      progressLogState = null;
      state.status = 'idle';
      state.config = null;
      state.progress = [];
      state.error = null;
      state.deployResults = [];
      state.logPath = null;
      state.operationProgress = null;
      state.deploymentProgress = null;
      deploymentProgressTracking = false;

      return c.json({ success: true });
    });
  });

  // Complete initial admin setup (store setup token in KV)
  // Supports external (.authrim-keys/), internal (.authrim/{env}/keys/), and legacy (.keys/{env}/) structures
  api.post('/admin/setup', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const body = await c.req.json();
        const { env, baseUrl } = body;

        if (!env || !baseUrl) {
          addProgress('Error: env and baseUrl are required');
          return c.json({ success: false, error: 'env and baseUrl are required' }, 400);
        }

        const baseDir = findAuthrimBaseDir(process.cwd());
        const parsedEnv = EnvNameSchema.safeParse(env);
        if (!parsedEnv.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsedEnv.data,
          operation: 'web-admin-setup',
        });
        const targetProductVersion = operationLock.lock
          ? await getRootProductVersion(baseDir)
          : undefined;
        const decision = evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock: operationLock.lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }

        // Determine structure type
        const resolved = resolvePaths({ baseDir, env });
        const isLegacy = resolved.type === 'legacy';

        // Detect actual token path using 3-tier fallback (external → internal → legacy)
        const foundKeys = findKeysDirectory({
          env,
          sourceDir: baseDir,
          keysBaseDir: process.cwd(),
        });
        const tokenPath = foundKeys
          ? join(foundKeys.path, 'setup_token.txt')
          : isLegacy
            ? (resolved.paths as LegacyPaths).keyFiles.setupToken
            : (resolved.paths as EnvironmentPaths).keyFiles.setupToken;

        let resolvedBaseUrl = baseUrl;
        try {
          const configPath =
            resolved.type === 'new'
              ? (resolved.paths as EnvironmentPaths).config
              : (resolved.paths as LegacyPaths).config;
          if (existsSync(configPath)) {
            const cfg = parseEnvironmentConfigForEnv(
              JSON.parse(await readFile(configPath, 'utf-8')),
              env
            );
            resolvedBaseUrl = resolveIssuerUrl(cfg, { env });
          }
        } catch {
          // Config resolution failed, use the provided baseUrl
        }

        addProgress(
          `Admin setup request: env=${env}, baseUrl=${resolvedBaseUrl}, structure=${resolved.type}`
        );

        addProgress('Setting up initial admin...');
        addDetailProgress(`Looking for setup token at: ${tokenPath}`);

        const result = await completeInitialSetup({
          env,
          baseUrl: resolvedBaseUrl,
          baseDir,
          keysBaseDir: process.cwd(),
          legacy: isLegacy,
          onProgress: addProgress,
        });

        addProgress('Initial admin setup request completed');

        if (result.alreadyCompleted) {
          addProgress('Initial admin setup already completed');
          return c.json({
            success: true,
            alreadyCompleted: true,
            message: 'Initial admin setup was already completed',
          });
        }

        if (result.success && result.setupUrl) {
          addProgress('Setup token stored successfully');
          return c.json({
            success: true,
            setupUrl: result.setupUrl,
            expiresAt: result.expiresAt,
            message: 'Visit the setup URL to create the initial administrator',
          });
        }

        addProgress(`Admin setup failed: ${result.error}`);
        return c.json({ success: false, error: result.error }, 500);
      } catch (error) {
        addProgress(`Admin setup exception: ${sanitizeError(error)}`);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // Check admin setup status for an environment (no auth required - read-only)
  api.get('/admin/status/:kvNamespaceId', async (c) => {
    try {
      const kvNamespaceId = c.req.param('kvNamespaceId');
      if (!kvNamespaceId || !/^[a-f0-9]{32}$/i.test(kvNamespaceId)) {
        return c.json({ success: false, error: 'Invalid KV namespace ID' }, 400);
      }

      const status = await checkAdminSetupStatus(kvNamespaceId);
      return c.json({
        success: true,
        adminSetupCompleted: status.completed,
        error: status.error,
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Generate and store a new setup token (requires session validation)
  api.use('/admin/generate-token', validateSession);
  api.post('/admin/generate-token', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const body = await c.req.json();
        const { kvNamespaceId, baseUrl, env: envName } = body;

        if (!kvNamespaceId || !/^[a-f0-9]{32}$/i.test(kvNamespaceId)) {
          return c.json({ success: false, error: 'Invalid KV namespace ID' }, 400);
        }

        if (!baseUrl) {
          return c.json({ success: false, error: 'baseUrl is required' }, 400);
        }
        const parsedEnv = EnvNameSchema.safeParse(envName);
        if (!parsedEnv.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const baseDir = findAuthrimBaseDir(process.cwd());
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsedEnv.data,
          operation: 'web-admin-token-generation',
        });
        const targetProductVersion = operationLock.lock
          ? await getRootProductVersion(baseDir)
          : undefined;
        const decision = evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock: operationLock.lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${parsedEnv.data}`,
            },
            409
          );
        }

        // Check if admin setup is already completed
        const status = await checkAdminSetupStatus(kvNamespaceId);
        if (status.completed) {
          return c.json(
            {
              success: false,
              error: 'Admin setup has already been completed for this environment',
              alreadyCompleted: true,
            },
            400
          );
        }

        // Generate and store new token
        const result = await generateAndStoreSetupToken(kvNamespaceId);
        if (!result.success || !result.token) {
          return c.json({ success: false, error: result.error || 'Failed to generate token' }, 500);
        }

        // Resolve the best base URL: prefer custom API domain from config
        let resolvedBaseUrl = baseUrl;
        if (envName) {
          try {
            const resolved = resolvePaths({ baseDir, env: envName });
            const configPath =
              resolved.type === 'new'
                ? (resolved.paths as EnvironmentPaths).config
                : (resolved.paths as LegacyPaths).config;
            if (existsSync(configPath)) {
              const cfg = parseEnvironmentConfigForEnv(
                JSON.parse(await readFile(configPath, 'utf-8')),
                envName
              );
              resolvedBaseUrl = resolveIssuerUrl(cfg, { env: envName });
            }
          } catch {
            // Config not available, use the provided baseUrl
          }
        }

        const setupUrl = buildInitialAdminSetupUrl(resolvedBaseUrl, result.token);

        return c.json({
          success: true,
          setupUrl,
          expiresAt: result.expiresAt,
          message: 'Setup token generated. Visit the URL to create the initial administrator.',
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // =============================================================================
  // Environment Management
  // =============================================================================

  const WebCapacityRequestSchema = z
    .object({
      environmentId: EnvNameSchema,
      profile: z.enum(['minimum', 'recommended', 'extra_headroom']),
      scope: z.enum(['shared_pool', 'tenant_exclusive']),
      tenantId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
        .nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.scope === 'shared_pool' && value.tenantId !== null) ||
        (value.scope === 'tenant_exclusive' && value.tenantId === null)
      ) {
        context.addIssue({ code: 'custom', message: 'Invalid capacity scope owner' });
      }
    });

  async function loadWebCapacityContext(environmentId: string) {
    const baseDir = findAuthrimBaseDir(process.cwd());
    const paths = getEnvironmentPaths({ baseDir, env: environmentId });
    if (!existsSync(paths.config)) throw new Error('Control environment config is unavailable');
    const configContents = await readFile(paths.config, 'utf8');
    const config = parseEnvironmentConfigForEnv(JSON.parse(configContents), environmentId);
    const { lock } = await loadLockFileAuto(baseDir, environmentId);
    const controlDatabaseId = lock?.d1.CONTROL_DB?.id;
    if (!lock || !controlDatabaseId) throw new Error('Control database is not configured');
    return {
      baseDir,
      paths,
      configContents,
      config,
      lock,
      controlDatabaseId,
    };
  }

  function assertWebCapacityMutationState(lock: AuthrimLock): void {
    if (lock.topologyUpdate) {
      throw new Error('control_capacity_topology_update_in_progress');
    }
    const release = lock.releaseUpdate;
    if (release && release.phase !== 'verified' && release.phase !== 'database_only_verified') {
      throw new Error('control_capacity_release_update_in_progress');
    }
    const lifecycle = classifyEnvironmentLifecycle(lock);
    if (lifecycle !== 'deployed') {
      throw new Error(`control_capacity_environment_not_deployed:${lifecycle}`);
    }
  }

  async function loadLockedWebCapacityContext(
    environmentId: string,
    planned: Awaited<ReturnType<typeof loadWebCapacityContext>>,
    operationLock: Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
  ) {
    if (!existsSync(planned.paths.config)) {
      throw new Error('control_capacity_environment_changed_while_waiting_for_lock');
    }
    const configContents = await readFile(planned.paths.config, 'utf8');
    const loaded = await loadLockFileAuto(planned.baseDir, environmentId);
    if (
      configContents !== planned.configContents ||
      JSON.stringify(planned.lock) !== JSON.stringify(operationLock.lock) ||
      JSON.stringify(operationLock.lock) !== JSON.stringify(loaded.lock)
    ) {
      throw new Error('control_capacity_environment_changed_while_waiting_for_lock');
    }
    const lock = loaded.lock;
    if (!lock) throw new Error('Control environment is not configured');
    assertWebCapacityMutationState(lock);
    const config = parseEnvironmentConfigForEnv(JSON.parse(configContents), environmentId);
    assertFixedD1ResourceIdentities({
      environment: environmentId,
      lock,
      databases: await listD1Databases(),
    });
    const adminDatabase = lock.d1.DB_ADMIN;
    const controlDatabase = lock.d1.CONTROL_DB;
    if (!adminDatabase || !controlDatabase) {
      throw new Error('Control and Admin databases are not configured');
    }
    return {
      config,
      adminDatabase,
      controlDatabase,
      apiBaseUrl: resolveIssuerUrl(config, { env: environmentId }),
      keysDir: resolveWebDeploymentKeysDir(planned.baseDir, environmentId, config),
    };
  }

  api.get('/control/capacity/tenants', async (c) => {
    if (!sessionToken || c.req.header('X-Session-Token') !== sessionToken) {
      return c.json({ success: false, error: 'Invalid or missing session token' }, 401);
    }
    const parsed = EnvNameSchema.safeParse(c.req.query('environmentId'));
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid capacity environment' }, 400);
    }
    try {
      const context = await loadWebCapacityContext(parsed.data);
      const tenants = await listSetupExclusiveCapacityTenants({
        controlDatabaseName: context.controlDatabaseId,
        environmentId: parsed.data,
      });
      return c.json({ success: true, tenants });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  for (const action of ['preview', 'request'] as const) {
    api.post(`/control/capacity/${action}`, async (c) => {
      return withLock(async () => {
        if (!sessionToken || c.req.header('X-Session-Token') !== sessionToken) {
          return c.json({ success: false, error: 'Invalid or missing session token' }, 401);
        }
        if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
          return c.json({ success: false, error: 'Invalid setup origin' }, 403);
        }
        const parsed = WebCapacityRequestSchema.safeParse(await c.req.json());
        if (!parsed.success) {
          return c.json({ success: false, error: 'Invalid capacity request' }, 400);
        }
        let operationLock:
          | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
          | undefined;
        try {
          const planned = await loadWebCapacityContext(parsed.data.environmentId);
          operationLock = await acquireEnvironmentOperationForEnvironment({
            baseDir: planned.baseDir,
            env: parsed.data.environmentId,
            operation: `web-control-capacity:${action}`,
            requireExisting: true,
          });
          const context = await loadLockedWebCapacityContext(
            parsed.data.environmentId,
            planned,
            operationLock
          );
          const request = {
            profile: parsed.data.profile,
            scope: parsed.data.scope,
            tenantId: parsed.data.tenantId,
          };
          const capacityInput = {
            apiBaseUrl: context.apiBaseUrl,
            keysDir: context.keysDir,
            controlDatabaseName: context.controlDatabase.id,
            request,
          };
          if (action === 'preview') {
            const preview = await runEphemeralSetupMachineAccess({
              env: parsed.data.environmentId,
              config: context.config,
              keysDir: context.keysDir,
              databaseIdentifier: context.adminDatabase.id,
              action: () => previewSetupControlCapacity(capacityInput),
            });
            return c.json({ success: true, preview });
          }
          const result = await runEphemeralSetupMachineAccess({
            env: parsed.data.environmentId,
            config: context.config,
            keysDir: context.keysDir,
            databaseIdentifier: context.adminDatabase.id,
            action: () => requestSetupControlCapacity(capacityInput),
          });
          return c.json(
            {
              success: true,
              ...result,
            },
            202
          );
        } catch (error) {
          if (isEnvironmentOperationConflict(error instanceof Error ? error.message : error)) {
            return c.json(
              {
                success: false,
                error: 'Another setup operation is already in progress',
                errorCode: 'setup_operation_in_progress',
              },
              409
            );
          }
          return c.json({ success: false, error: sanitizeError(error) }, 500);
        } finally {
          await operationLock?.release();
        }
      });
    });
  }

  api.get('/control/pending-operations', async (c) => {
    if (!sessionToken || c.req.header('X-Session-Token') !== sessionToken) {
      return c.json({ error: 'Invalid or missing session token' }, 401);
    }
    try {
      const baseDir = findAuthrimBaseDir(process.cwd());
      const operations = [];
      const warnings: Array<{ environmentId: string; code: string }> = [];
      for (const environmentId of listEnvironments(baseDir, process.cwd())) {
        const { lock } = await loadLockFileAuto(baseDir, environmentId);
        const controlDatabaseId = lock?.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) continue;
        try {
          const [shardOperations, pluginOperations, pluginCleanupOperations, tenantDrOperations] =
            await Promise.all([
              listPendingControlOperatorOperations({ controlDatabaseName: controlDatabaseId }),
              listPendingPluginControlOperatorOperations({
                controlDatabaseName: controlDatabaseId,
              }),
              listPendingPluginControlCleanupOperations({
                controlDatabaseName: controlDatabaseId,
              }),
              listPendingTenantDisasterRecoveryOperatorOperations({
                controlDatabaseName: controlDatabaseId,
              }),
            ]);
          operations.push(
            ...shardOperations,
            ...pluginOperations,
            ...pluginCleanupOperations,
            ...tenantDrOperations
          );
        } catch {
          warnings.push({ environmentId, code: 'control_operation_status_unavailable' });
        }
      }
      return c.json({ success: true, operations, warnings });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.post('/control/pending-operations/execute', async (c) => {
    return withLock(async () => {
      if (!sessionToken || c.req.header('X-Session-Token') !== sessionToken) {
        return c.json({ success: false, error: 'Invalid or missing session token' }, 401);
      }
      if (!isSameLoopbackOrigin(c.req.url, c.req.header('Origin'))) {
        return c.json({ success: false, error: 'Invalid setup origin' }, 403);
      }
      const parsed = z
        .object({
          environmentId: EnvNameSchema,
          operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
        })
        .strict()
        .safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({ success: false, error: 'Invalid Control operation request' }, 400);
      }
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const baseDir = findAuthrimBaseDir(process.cwd());
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: parsed.data.environmentId,
          operation: `web-control-operation:${parsed.data.operationId}`,
        });
        const { lock, path: lockPath } = await loadLockFileAuto(baseDir, parsed.data.environmentId);
        const controlDatabase = lock?.d1.CONTROL_DB;
        if (!controlDatabase) {
          return c.json({ success: false, error: 'Control database is not configured' }, 409);
        }
        const [shardOperations, pluginOperations, pluginCleanupOperations, tenantDrOperations] =
          await Promise.all([
            listPendingControlOperatorOperations({ controlDatabaseName: controlDatabase.id }),
            listPendingPluginControlOperatorOperations({
              controlDatabaseName: controlDatabase.id,
            }),
            listPendingPluginControlCleanupOperations({
              controlDatabaseName: controlDatabase.id,
            }),
            listPendingTenantDisasterRecoveryOperatorOperations({
              controlDatabaseName: controlDatabase.id,
            }),
          ]);
        const operations = [
          ...shardOperations,
          ...pluginOperations,
          ...pluginCleanupOperations,
          ...tenantDrOperations,
        ];
        const operation = operations.find(
          (candidate) =>
            candidate.operationId === parsed.data.operationId &&
            candidate.environmentId === parsed.data.environmentId
        );
        if (!operation) {
          return c.json({ success: false, error: 'Pending Control operation was not found' }, 404);
        }
        if (
          operation.operationKind !== 'provision_plugin_resources' &&
          operation.operationKind !== 'cleanup_plugin_resources' &&
          operation.currentStep !== 'create_d1' &&
          operation.currentStep !== 'apply_migrations' &&
          operation.currentStep !== 'reconcile_worker_bindings'
        ) {
          return c.json(
            {
              success: false,
              error: 'This Control operation step is not executable by this setup version',
              operation,
            },
            409
          );
        }
        const resolved = resolvePaths({ baseDir, env: parsed.data.environmentId });
        const configPath =
          resolved.type === 'new'
            ? (resolved.paths as EnvironmentPaths).config
            : (resolved.paths as LegacyPaths).config;
        const config = existsSync(configPath)
          ? parseEnvironmentConfigForEnv(
              JSON.parse(await readFile(configPath, 'utf-8')),
              parsed.data.environmentId
            )
          : null;
        if (
          (operation.operationKind === 'provision_plugin_resources' ||
            operation.operationKind === 'cleanup_plugin_resources') &&
          !config
        ) {
          return c.json(
            { success: false, error: 'Control environment config is unavailable' },
            409
          );
        }
        const refreshesWorkerDeploymentArtifacts =
          operation.operationKind === 'provision_plugin_resources' ||
          operation.operationKind === 'cleanup_plugin_resources';
        if (refreshesWorkerDeploymentArtifacts) {
          deployConfigLock = await acquireDeployConfigLock({
            baseDir,
            env: parsed.data.environmentId,
            operation: `web-control-operation:${parsed.data.operationId}`,
          });
        }
        const needsMigrationReleaseBucket =
          operation.operationKind === 'provision_plugin_resources' ||
          operation.currentStep === 'apply_migrations';
        const migrationReleaseBucket = lock.r2?.MIGRATION_RELEASES;
        const verifyMigrationReleaseBucketOwnership = migrationReleaseBucket
          ? () =>
              assertR2BucketOwnershipForUse({
                ...migrationReleaseBucket,
                environment: parsed.data.environmentId,
                binding: 'MIGRATION_RELEASES',
              })
          : undefined;
        if (needsMigrationReleaseBucket) {
          if (!migrationReleaseBucket) throw new Error('migration_release_bucket_required');
          await verifyMigrationReleaseBucketOwnership!();
        }
        const result =
          operation.operationKind === 'provision_plugin_resources'
            ? await executeSetupPluginControlOperator({
                controlDatabaseId: controlDatabase.id,
                migrationReleaseBucketName: migrationReleaseBucket!.name,
                operation,
                expectedAccountId: config?.cloudflare?.accountId,
                verifyMigrationReleaseBucketOwnership,
              })
            : operation.operationKind === 'cleanup_plugin_resources'
              ? await executeSetupPluginCleanupOperator({
                  controlDatabaseId: controlDatabase.id,
                  operation,
                  expectedAccountId: config?.cloudflare?.accountId,
                })
              : operation.currentStep === 'create_d1'
                ? await executeSetupControlOperatorCreate({
                    controlDatabaseId: controlDatabase.id,
                    operation,
                    expectedAccountId: config?.cloudflare?.accountId,
                  })
                : operation.currentStep === 'apply_migrations'
                  ? await executeSetupControlOperatorMigration({
                      controlDatabaseId: controlDatabase.id,
                      migrationReleaseBucketName: migrationReleaseBucket!.name,
                      operation,
                      expectedAccountId: config?.cloudflare?.accountId,
                      verifyMigrationReleaseBucketOwnership,
                    })
                  : await executeSetupControlOperatorWorkerBindings({
                      controlDatabaseId: controlDatabase.id,
                      operation,
                      expectedAccountId: config?.cloudflare?.accountId,
                    });
        if (
          operation.operationKind === 'cleanup_plugin_resources' ||
          (operation.operationKind === 'provision_plugin_resources' &&
            result.state === 'awaiting_smoke')
        ) {
          await refreshWorkerDeploymentArtifacts({
            baseDir,
            env: parsed.data.environmentId,
            config: config!,
            lock,
            lockPath,
            components: ['ar-plugin-runner'],
            registeredBy: 'setup:web-control-provision-plugin-resources',
          });
        }
        return c.json({ success: true, result });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // List all detected Authrim environments (no auth required - read-only)
  api.get('/environments', async (c) => {
    try {
      const progress: string[] = [];
      const addLocalProgress = (message: string) => {
        progress.push(message);
      };
      addLocalProgress('Scanning Cloudflare account for Authrim environments...');

      const detectedEnvironments = await detectEnvironments(addLocalProgress);
      const baseDir = findAuthrimBaseDir(process.cwd());
      const targetVersion = await getRootProductVersion(baseDir);
      const environmentsByName = new Map<string, EnvironmentInfo>(
        detectedEnvironments.map((environment) => [environment.env, environment])
      );

      // Cloudflare inventory and local release state are complementary. A final deletion retry can
      // leave no remote resources while lock.json still records an environment that must either be
      // cleaned up or resumed. Keep that environment visible instead of letting the setup wizard
      // proceed until /provision rejects it after key generation.
      for (const localEnv of listEnvironments(baseDir)) {
        const { lock } = await loadLockFileAuto(baseDir, localEnv);
        const environment = environmentsByName.get(localEnv) ?? {
          env: localEnv,
          workers: [],
          d1: [],
          kv: [],
          queues: [],
          r2: [],
          pages: [],
        };
        if (lock) {
          const mergeByName = <T extends { name: string }>(current: T[], additions: T[]): T[] =>
            Array.from(
              new Map(
                [...current, ...additions].map((resource) => [resource.name, resource])
              ).values()
            );
          environment.workers = mergeByName(
            environment.workers,
            Object.values(lock.workers ?? {}).map((resource) => ({ name: resource.name }))
          );
          environment.d1 = mergeByName(environment.d1, Object.values(lock.d1));
          environment.kv = mergeByName(
            environment.kv,
            Object.values(lock.kv).map((resource) => ({ name: resource.name, id: resource.id }))
          );
          environment.queues = mergeByName(environment.queues, Object.values(lock.queues ?? {}));
          environment.r2 = mergeByName(environment.r2, Object.values(lock.r2 ?? {}));
        }
        environmentsByName.set(localEnv, environment);
      }
      const environments = Array.from(environmentsByName.values()).sort((left, right) =>
        left.env.localeCompare(right.env)
      );
      const environmentsWithRelease = await Promise.all(
        environments.map(async (environment) => {
          try {
            const { lock } = await loadLockFileAuto(baseDir, environment.env);
            return {
              ...environment,
              release: evaluateReleaseUpdateAvailability(lock, targetVersion),
            };
          } catch {
            return {
              ...environment,
              release: evaluateReleaseUpdateAvailability(undefined, targetVersion),
            };
          }
        })
      );

      return c.json({
        success: true,
        environments: environmentsWithRelease,
        targetVersion,
        progress,
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Check whether an interrupted initial deployment can be resumed from the Web UI.
  api.get('/deploy/recovery/:env', async (c) => {
    try {
      const envResult = EnvNameSchema.safeParse(c.req.param('env'));
      if (!envResult.success) {
        return c.json({ success: false, error: 'Invalid environment name' }, 400);
      }
      const env = envResult.data;
      const baseDir = findAuthrimBaseDir(process.cwd());
      const resolved = resolvePaths({ baseDir, env });
      const configPath =
        resolved.type === 'new'
          ? (resolved.paths as EnvironmentPaths).config
          : (resolved.paths as LegacyPaths).config;
      const { lock } = await loadLockFileAuto(baseDir, env);
      const configExists = existsSync(configPath);
      const phase = lock?.releaseUpdate?.phase ?? null;
      const completedSteps = {
        resourcesProvisioned: Boolean(lock),
        schemaApplied:
          phase === 'schema_applied' || phase === 'workers_deployed' || phase === 'verified',
        workersDeployed: phase === 'workers_deployed' || phase === 'verified',
        verificationComplete: Boolean(
          lock?.productVersion && lock.releaseUpdate?.phase === 'verified'
        ),
      };
      const responseBase = { success: true as const, env, configExists, phase, completedSteps };

      if (!lock) {
        return c.json({
          ...responseBase,
          status: configExists ? 'recreate_required' : 'not_started',
          canResume: false,
          requiresRecreate: configExists,
          reasonCode: configExists ? 'lock_missing' : 'environment_not_started',
        });
      }

      if (lock.productVersion && lock.releaseUpdate?.phase === 'verified') {
        return c.json({
          ...responseBase,
          status: 'complete',
          canResume: false,
          requiresRecreate: false,
          installedVersion: lock.productVersion,
          reasonCode: 'deployment_verified',
        });
      }

      if (!configExists || !lock.releaseUpdate || lock.releaseUpdate.phase === 'verified') {
        return c.json({
          ...responseBase,
          status: 'recreate_required',
          canResume: false,
          requiresRecreate: true,
          reasonCode: !configExists ? 'config_missing' : 'release_checkpoint_inconsistent',
        });
      }

      let releaseConfig: AuthrimConfig;
      let productVersion: string;
      let manifestChecksum: string;
      let releaseManifest: ReleaseMigrationManifest;
      let releaseManifestIsDraft: boolean;
      try {
        releaseConfig = parseEnvironmentConfigForEnv(
          JSON.parse(await readFile(configPath, 'utf-8')),
          env
        );
        productVersion = await getRootProductVersion(baseDir);
        const migrationsRoot = await findMigrationsRoot(baseDir, undefined, { strictRoot: true });
        if (!migrationsRoot.path) throw new Error('release_migrations_directory_missing');
        const release = loadTargetReleaseMigrationManifest({
          migrationsRoot: migrationsRoot.path,
          productVersion,
          allowDraft: true,
        });
        releaseManifest = release.manifest;
        releaseManifestIsDraft = release.draft;
        manifestChecksum = calculateReleaseManifestChecksum(release.manifest);
      } catch {
        return c.json({
          ...responseBase,
          status: 'blocked',
          canResume: false,
          requiresRecreate: false,
          reasonCode: 'local_recovery_evidence_unavailable',
        });
      }

      const recoveryTargets = resolveReleaseMigrationTargets({ lock, config: releaseConfig });
      const guard = evaluateReleaseDeploymentGuard(lock, productVersion, 'initial_deploy', {
        releaseManifestChecksum: manifestChecksum,
        ...(releaseManifestIsDraft
          ? { initialDraft: { manifest: releaseManifest, targets: recoveryTargets } }
          : {}),
      });
      if (!guard.allowed) {
        return c.json({
          ...responseBase,
          status: 'recreate_required',
          canResume: false,
          requiresRecreate: true,
          reasonCode: guard.reason ?? 'release_checkpoint_mismatch',
        });
      }
      if (recoveryTargets.some((target) => !target.streamId)) {
        return c.json({
          ...responseBase,
          status: 'recreate_required',
          canResume: false,
          requiresRecreate: true,
          reasonCode: 'release_migration_target_unavailable',
        });
      }

      const enabledComponents = Array.from(
        getEnabledComponents({
          saml: releaseConfig.components.saml,
          async: releaseConfig.components.async,
          vc: releaseConfig.components.vc,
          bridge: releaseConfig.components.bridge,
          policy: releaseConfig.components.policy,
        })
      );
      const recoveryWorkerTargets = [
        ...enabledComponents.map((component) => ({
          component,
          workerName: getWorkerName(env, component),
        })),
        ...UI_WORKER_COMPONENTS.filter((component) =>
          component === 'ar-login-ui'
            ? releaseConfig.components.loginUi !== false
            : releaseConfig.components.adminUi !== false
        ).map((component) => ({ component, workerName: `${env}-${component}` })),
      ];

      if (releaseConfig.cloudflare?.accountId) {
        let currentAccountId: string | null;
        try {
          currentAccountId = await getAccountId();
        } catch {
          currentAccountId = null;
        }
        if (!currentAccountId || currentAccountId !== releaseConfig.cloudflare.accountId) {
          return c.json({
            ...responseBase,
            status: 'blocked',
            canResume: false,
            requiresRecreate: false,
            reasonCode: currentAccountId
              ? 'cloudflare_account_mismatch'
              : 'cloudflare_account_verification_unavailable',
          });
        }
      }

      try {
        await assertLockedCloudflareResourcesForWebMutation({
          environment: env,
          config: releaseConfig,
          lock,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const checkpointInvalid =
          message.startsWith('cloudflare_resource_identity_mismatch:') ||
          message.startsWith('required_cloudflare_resources_missing:');
        return c.json({
          ...responseBase,
          status: checkpointInvalid ? 'recreate_required' : 'blocked',
          canResume: false,
          requiresRecreate: checkpointInvalid,
          reasonCode: checkpointInvalid
            ? 'cloudflare_resource_checkpoint_mismatch'
            : 'cloudflare_resource_verification_unavailable',
        });
      }

      try {
        await prepareWorkerScriptOwnership({ lock, targets: recoveryWorkerTargets });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const checkpointInvalid =
          /^worker_script_(?:provisional_name_mismatch|pending_version_mismatch|immutable_tag_(?:mismatch|unavailable|invalid)|missing|fresh_name_conflict|locked_name_mismatch|legacy_identity_insufficient|legacy_version_mismatch|inventory_(?:invalid|duplicate))/u.test(
            message
          );
        return c.json({
          ...responseBase,
          status: checkpointInvalid ? 'recreate_required' : 'blocked',
          canResume: false,
          requiresRecreate: checkpointInvalid,
          reasonCode: checkpointInvalid
            ? 'worker_ownership_checkpoint_mismatch'
            : 'worker_ownership_verification_unavailable',
        });
      }
      const checkExistingControlCredentials = async (): Promise<boolean> => {
        if (releaseConfig.controlPlane?.automaticProvisioning !== true) return true;
        const controlDatabaseId = lock.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) return false;
        try {
          const authority = await readControlProvisioningAuthority({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
          });
          if (
            authority?.bootstrapPhase === 'pending_revocation' ||
            authority?.bootstrapPhase === 'cutover_verified'
          ) {
            return authority.bootstrapTokenOwnership !== 'none';
          }
          return await hasReadyControlTokenBootstrap({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
            resourceClasses: resolveControlTokenResourceClasses(releaseConfig),
            secretSink: new WranglerControlSecretSink({
              workerName: `${env}-ar-control`,
              cwd: baseDir,
            }),
          });
        } catch {
          return false;
        }
      };

      if (guard.appendOnlyInitialDraftResume) {
        const controlCredentialsReady = await checkExistingControlCredentials();
        return c.json({
          ...responseBase,
          status: 'resumable',
          canResume: true,
          requiresRecreate: false,
          completedSteps: { ...completedSteps, schemaApplied: false, verificationComplete: false },
          resumeFrom: 'database_migrations',
          resumeMode: 'continue',
          requiresBootstrapToken: !controlCredentialsReady,
          reasonCode: 'append_only_draft_schema_pending',
        });
      }

      if (lock.releaseUpdate.phase === 'planned') {
        const controlCredentialsReady = await checkExistingControlCredentials();
        return c.json({
          ...responseBase,
          status: 'resumable',
          canResume: true,
          requiresRecreate: false,
          resumeFrom: 'database_migrations',
          resumeMode: 'continue',
          requiresBootstrapToken: !controlCredentialsReady,
          reasonCode: 'release_planned',
        });
      }

      if (lock.releaseUpdate.phase === 'schema_applied') {
        const controlCredentialsReady = await checkExistingControlCredentials();
        const controlPlaneTopologyIssues = inspectInitialControlPlaneTopology({
          env,
          config: releaseConfig,
          lock,
          productVersion,
          manifest: releaseManifest,
        });
        const controlPlaneReady = controlPlaneTopologyIssues.length === 0;
        return c.json({
          ...responseBase,
          status: 'resumable',
          canResume: true,
          requiresRecreate: false,
          completedSteps: {
            ...completedSteps,
            controlPlaneReady,
          },
          resumeFrom: controlPlaneReady ? 'worker_deployment' : 'control_plane_bootstrap',
          resumeMode: 'continue',
          requiresBootstrapToken: !controlCredentialsReady,
          reasonCode: controlPlaneReady
            ? 'schema_checkpoint_verified'
            : 'initial_control_plane_bootstrap_incomplete',
          ...(controlPlaneReady
            ? {}
            : {
                incompleteControlPlaneBindings: controlPlaneTopologyIssues.map(
                  (issue) => issue.binding
                ),
              }),
        });
      }

      let reconciledWorkerVersions: Set<string> | undefined;
      if (lock.releaseUpdate.phase === 'workers_deployed') {
        const controlDatabaseId = lock.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          return c.json({
            ...responseBase,
            status: 'recreate_required',
            canResume: false,
            requiresRecreate: true,
            reasonCode: 'control_database_checkpoint_missing',
          });
        }
        try {
          reconciledWorkerVersions = await listInitialBootstrapReconciledWorkerVersions({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
          });
        } catch {
          return c.json({
            ...responseBase,
            status: 'blocked',
            canResume: false,
            requiresRecreate: false,
            reasonCode: 'control_reconciliation_verification_unavailable',
          });
        }
      }
      try {
        const summary = await buildWebInitialHandoffResumeSummary({
          lock,
          components: enabledComponents,
          productVersion,
          allowSecretTriggeredVersionAdvanceFor:
            releaseConfig.controlPlane?.automaticProvisioning === true ? ['ar-control'] : [],
          reconciledWorkerVersions,
        });
        if (
          !summary ||
          summary.failedCount > 0 ||
          summary.results.length !== enabledComponents.length
        ) {
          throw new Error('initial_handoff_resume_worker_evidence_incomplete');
        }
      } catch {
        return c.json({
          ...responseBase,
          status: 'recreate_required',
          canResume: false,
          requiresRecreate: true,
          reasonCode: 'remote_worker_checkpoint_mismatch',
        });
      }

      let controlCredentialsReady = true;
      if (releaseConfig.controlPlane?.automaticProvisioning === true) {
        const controlDatabaseId = lock.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          return c.json({
            ...responseBase,
            status: 'recreate_required',
            canResume: false,
            requiresRecreate: true,
            reasonCode: 'control_database_checkpoint_missing',
          });
        }
        try {
          const authority = await readControlProvisioningAuthority({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
          });
          controlCredentialsReady =
            (authority?.bootstrapPhase === 'pending_revocation' ||
              authority?.bootstrapPhase === 'cutover_verified') &&
            authority.bootstrapTokenOwnership !== 'none'
              ? true
              : await hasReadyControlTokenBootstrap({
                  environmentId: env,
                  controlDatabaseName: controlDatabaseId,
                  resourceClasses: resolveControlTokenResourceClasses(releaseConfig),
                  secretSink: new WranglerControlSecretSink({
                    workerName: `${env}-ar-control`,
                    cwd: baseDir,
                  }),
                });
        } catch {
          return c.json({
            ...responseBase,
            status: 'blocked',
            canResume: false,
            requiresRecreate: false,
            reasonCode: 'control_credentials_verification_unavailable',
          });
        }
      }

      return c.json({
        ...responseBase,
        status: 'resumable',
        canResume: true,
        requiresRecreate: false,
        resumeFrom: 'post_deploy_verification',
        resumeMode: 'continue',
        requiresBootstrapToken: !controlCredentialsReady,
        reasonCode: controlCredentialsReady
          ? 'worker_checkpoint_verified'
          : 'control_credentials_repair_required',
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.get('/r2/:env/status', async (c) => {
    try {
      const envParam = c.req.param('env');
      const parseResult = EnvNameSchema.safeParse(envParam);
      if (!parseResult.success) {
        return c.json({ success: false, error: 'Invalid environment name' }, 400);
      }
      const env = parseResult.data;
      const baseDir = findAuthrimBaseDir(process.cwd());
      const { lock } = await loadLockFileAuto(baseDir, env);
      const cloudflareBucketNames = new Set(
        (await listR2Buckets({ throwOnError: true })).map((bucket) => bucket.name)
      );
      const status = buildR2BucketProvisioningStatus(env, lock?.r2, cloudflareBucketNames);

      return c.json({
        success: true,
        ...status,
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.post('/r2/:env/provision', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const envParam = c.req.param('env');
        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = parseResult.data;
        const baseDir = findAuthrimBaseDir(process.cwd());
        const envPaths = getEnvironmentPaths({ baseDir, env });
        if (!existsSync(envPaths.config)) {
          return c.json(
            { success: false, error: `Config file not found: ${envPaths.config}` },
            404
          );
        }
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env,
          operation: 'web-r2-provision',
        });
        const targetProductVersion = operationLock.lock
          ? await getRootProductVersion(baseDir)
          : undefined;
        const decision = evaluateEnvironmentOperation({
          operation: 'topology_change',
          lock: operationLock.lock,
          targetVersion: targetProductVersion,
        });
        if (!decision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(decision, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }
        const lock = operationLock.lock;
        const lockPath = operationLock.lockFilePath;
        if (!lock || !lockPath) {
          return c.json({ success: false, error: `Lock file not found for ${env}` }, 404);
        }

        const config = await readEffectiveTopologyConfig(lock, envPaths.config);
        const resuming = lock.topologyUpdate !== undefined;
        if (resuming) {
          assertPendingTopologyUpdate(lock, {
            kind: 'r2',
            targetProductVersion: targetProductVersion!,
            config,
          });
        }
        addProgress(`Provisioning dedicated R2 buckets for ${env}...`);
        const buckets = await provisionR2Buckets(env, {
          existing: lock.r2,
          onProgress: addProgress,
        });
        const resourceLock = mergeLockFiles(lock, {
          r2: Object.fromEntries(buckets.map((bucket) => [bucket.binding, { name: bucket.name }])),
        });

        const updatedConfig: AuthrimConfig = resuming
          ? config
          : {
              ...config,
              features: {
                ...config.features,
                r2: { enabled: true },
              },
              updatedAt: new Date().toISOString(),
            };
        const prepared = !resuming
          ? await commitTopologyConfigTransaction({
              lock: resourceLock,
              lockPath,
              configPath: envPaths.config,
              kind: 'r2',
              targetProductVersion: targetProductVersion!,
              config: updatedConfig,
            })
          : lock.topologyUpdate?.phase === 'config_staged'
            ? await recoverTopologyConfigTransaction({
                lock: resourceLock,
                lockPath,
                configPath: envPaths.config,
                kind: 'r2',
                targetProductVersion: targetProductVersion!,
              })
            : prepareTopologyUpdate(resourceLock, {
                kind: 'r2',
                targetProductVersion: targetProductVersion!,
                config: updatedConfig,
              });
        if (resuming && lock.topologyUpdate?.phase !== 'config_staged') {
          await saveLockFile(prepared.lock, lockPath);
        }
        state.config = updatedConfig;
        addProgress(`Dedicated R2 buckets configured: ${buckets.length}`);

        return c.json({
          success: true,
          env,
          buckets,
          configPath: envPaths.config,
          deployRequired: true,
          topologyDeploymentToken: prepared.authorizationToken,
          message:
            'Dedicated R2 buckets were created or verified. Run deploy to publish Worker bindings.',
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // Apply session validation to environment delete
  api.use('/environments/*/delete', validateSession);

  // Delete an environment (with lock)
  api.post('/environments/:env/delete', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const envResult = EnvNameSchema.safeParse(c.req.param('env'));
        if (!envResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = envResult.data;
        let requestBody: unknown;
        try {
          requestBody = await c.req.json();
        } catch {
          return c.json({ success: false, error: 'Invalid environment deletion request' }, 400);
        }
        const bodyResult = EnvironmentDeleteRequestSchema.safeParse(requestBody);
        if (!bodyResult.success) {
          return c.json({ success: false, error: 'Invalid environment deletion request' }, 400);
        }
        const {
          deleteWorkers,
          deleteD1,
          deleteKV,
          deleteQueues,
          deleteR2,
          deletePages: requestedDeletePages,
          finalizeEnvironment,
        } = bodyResult.data;
        let deletePages = requestedDeletePages;
        if (
          ![deleteWorkers, deleteD1, deleteKV, deleteQueues, deleteR2, deletePages].some(Boolean)
        ) {
          return c.json(
            { success: false, error: 'Select at least one resource type to delete' },
            400
          );
        }
        state.status = 'provisioning'; // Reuse provisioning status
        state.error = null;
        state.deployResults = [];
        clearProgress();
        state.operationProgress = { operation: 'delete', current: 0, total: 0 };

        const baseDir = findAuthrimBaseDir(process.cwd());
        const localEnvironmentState = inspectLocalEnvironmentState({
          baseDir,
          environment: env,
        });
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env,
          operation: 'web-delete',
        });
        deployConfigLock = await acquireDeployConfigLock({
          baseDir,
          env,
          operation: 'web-delete',
        });
        state.logPath = await beginProgressLog(env, 'delete');
        addProgress(`Preparing to delete environment: ${env}`);
        // A retired Pages project is outside the current Authrim topology, so a zero-count UI
        // deletion may finish when its best-effort inventory is unavailable. Exact Pages identities
        // already recorded in the lock remain a strict ownership boundary and cannot be skipped.
        if (finalizeEnvironment && Object.keys(operationLock.lock?.pages ?? {}).length > 0) {
          deletePages = true;
        }
        let environmentObservedRemotely = Boolean(operationLock.lock);
        if (!environmentObservedRemotely) {
          environmentObservedRemotely = await confirmEnvironmentObservedForDeletion(env, {
            deleteWorkers,
            deleteD1,
            deleteKV,
            deleteQueues,
            deleteR2,
            deletePages,
          });
        }
        const deleteDecision = evaluateEnvironmentOperation({
          operation: 'delete',
          lock: operationLock.lock,
          environmentObservedRemotely,
          environmentKnownLocally: localEnvironmentState.exists,
        });
        if (!deleteDecision.allowed) {
          const error = markOperationError(environmentOperationBlockMessage(deleteDecision));
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error,
            },
            409
          );
        }

        const resolvedDeleteEnvironment = resolvePaths({ baseDir, env });
        const deleteConfigPath =
          resolvedDeleteEnvironment.type === 'new'
            ? (resolvedDeleteEnvironment.paths as EnvironmentPaths).config
            : (resolvedDeleteEnvironment.paths as LegacyPaths).config;
        const deleteConfigText = await readPrivateFileSecurely(deleteConfigPath, {
          maxBytes: 1024 * 1024,
          invalidError: 'environment_config_invalid',
          permissionsError: 'environment_config_permissions_invalid',
          repairLegacyPublicReadPermissions: true,
        });
        const parsedDeleteConfig = deleteConfigText
          ? AuthrimConfigSchema.safeParse(JSON.parse(deleteConfigText))
          : null;
        if (
          deleteConfigText &&
          parsedDeleteConfig &&
          !parsedDeleteConfig.success &&
          operationLock.lock &&
          deleteWorkers &&
          deleteD1 &&
          deleteKV &&
          deleteQueues &&
          deleteR2 &&
          (deletePages || finalizeEnvironment)
        ) {
          throw new Error('environment_config_invalid_for_dns_cleanup');
        }
        const deleteConfig = parsedDeleteConfig?.success ? parsedDeleteConfig.data : null;
        if (deleteConfig && deleteConfig.environment.prefix !== env) {
          throw new Error('environment_config_identity_mismatch');
        }
        const requiredDnsRoles: Array<'api_base' | 'tenant_wildcard'> = [];
        const deleteDnsBaseDomain = deleteConfig?.tenant.baseDomain?.trim();
        if (deleteConfig?.tenant.multiTenant && deleteDnsBaseDomain) {
          requiredDnsRoles.push('tenant_wildcard');
          let apiAutoHostname: string | null = null;
          try {
            apiAutoHostname = deleteConfig.urls?.api.auto
              ? new URL(deleteConfig.urls.api.auto).hostname
              : null;
          } catch {
            apiAutoHostname = null;
          }
          if (
            apiAutoHostname &&
            apiAutoHostname !== deleteDnsBaseDomain &&
            deleteConfig.urls?.api.customDomainBinding !== true
          ) {
            requiredDnsRoles.push('api_base');
          }
        }

        let deletionLock = operationLock.lock;
        const unfinishedWorkerOwnershipCount = Object.keys(
          deletionLock?.workerScriptOwnership ?? {}
        ).length;
        if (deleteWorkers && unfinishedWorkerOwnershipCount > 0) {
          addProgress(
            `Using ${unfinishedWorkerOwnershipCount} unfinished Worker ownership checkpoint(s) for verified deletion recovery.`
          );
        }
        if (deletionLock && (deleteQueues || deleteWorkers)) {
          const queueIdentity = await reconcileLegacyQueueIdentitiesForDeletion({
            lock: deletionLock,
            environment: env,
            config: deleteConfig,
            lockFilePath: operationLock.lockFilePath,
          });
          deletionLock = queueIdentity.lock;
          if (queueIdentity.adopted.length > 0) {
            addProgress(
              `Verified legacy Queue identities: ${queueIdentity.adopted
                .map((queue) => queue.name)
                .join(', ')}`
            );
          }
        }
        const result = await deleteEnvironment({
          env,
          environmentKnownLocally: Boolean(operationLock.lock) || localEnvironmentState.exists,
          finalizeEnvironment,
          deleteWorkers,
          deleteD1,
          deleteKV,
          deleteQueues,
          deleteR2,
          deletePages,
          knownWorkerResources: deletionLock ? collectWorkerDeletionIdentities(deletionLock) : [],
          knownD1Resources: deletionLock ? Object.values(deletionLock.d1) : [],
          knownKVResources: deletionLock ? Object.values(deletionLock.kv) : [],
          knownQueueResources: deletionLock?.queues ? Object.values(deletionLock.queues) : [],
          knownR2Resources: deletionLock?.r2
            ? Object.entries(deletionLock.r2).map(([binding, resource]) => ({
                ...resource,
                environment: env,
                binding,
              }))
            : [],
          knownPagesResources: deletionLock?.pages ? Object.values(deletionLock.pages) : [],
          ...(deletionLock
            ? {
                onWorkerIdentityBackfill: async (
                  resources: ReadonlyArray<{
                    name: string;
                    cloudflareScriptTag?: string;
                    cloudflareVersionId?: string;
                  }>
                ) => {
                  if (!deletionLock) throw new Error('Worker identity lock is unavailable');
                  deletionLock = withBackfilledWorkerDeletionIdentities(deletionLock, resources);
                  await saveLockFile(deletionLock, operationLock!.lockFilePath);
                },
              }
            : {}),
          knownDnsOwnership: deletionLock?.dns,
          dnsCleanupRequired: Boolean(
            deleteConfig?.tenant.multiTenant && deleteConfig.tenant.baseDomain?.trim()
          ),
          requiredDnsRoles,
          ...(deleteD1
            ? {
                beforeD1Deletion: ({ observedD1Resources }) => {
                  const controlDatabaseId = deletionLock?.d1.CONTROL_DB?.id;
                  return cleanupSetupManagedControlTokens({
                    baseDir,
                    environment: env,
                    controlDatabaseIdentifier:
                      controlDatabaseId &&
                      observedD1Resources.some((resource) => resource.id === controlDatabaseId)
                        ? controlDatabaseId
                        : null,
                  }).then(() => undefined);
                },
              }
            : {}),
          onProgress: addProgress,
          onDetail: addDetailProgress,
          onResourceProgress: ({ current, total }) => {
            state.operationProgress = { operation: 'delete', current, total };
          },
        });

        const deletedLockResourceCount =
          result.deleted.workers.length +
          result.deleted.d1.length +
          result.deleted.kv.length +
          result.deleted.queues.length +
          result.deleted.r2.length +
          result.deleted.pages.length +
          (result.deleted.dns?.length ?? 0);
        if (deletionLock && deletedLockResourceCount > 0) {
          await saveLockFile(
            reconcileLockAfterResourceDeletion(deletionLock, result.deleted),
            operationLock.lockFilePath
          );
        }

        const environmentEmpty = result.environmentEmpty === true;
        if (result.success && environmentEmpty) {
          const cleanupResult = await cleanupLocalEnvironmentArtifacts({
            baseDir,
            env,
            packagesDir: join(findAuthrimBaseDir(process.cwd()), 'packages'),
            keysBaseDir: process.cwd(),
            onProgress: addProgress,
          });
          if (cleanupResult.errors.length > 0) {
            result.errors.push(...cleanupResult.errors);
          }
        } else if (!result.success) {
          addProgress('⚠️ Local environment state preserved for deletion retry and diagnosis');
        } else {
          addProgress('Local environment state preserved for resource types not selected');
        }
        result.success = result.errors.length === 0;
        result.completion = result.success
          ? result.manualR2.length > 0 || (result.manualDns?.length ?? 0) > 0
            ? 'manual_action_required'
            : 'complete'
          : 'failed';
        const manualDnsDashboardUrl = getCloudflareDnsRecordsDashboardUrl(
          deleteConfig?.cloudflare.accountId,
          deleteDnsBaseDomain
        );
        const manualDns = (result.manualDns ?? []).map((issue) => ({
          ...issue,
          dashboardUrl: manualDnsDashboardUrl,
        }));

        if (state.logPath) {
          addProgress(`📝 Progress log saved: ${state.logPath}`);
        }
        await flushProgressLog();
        state.status = result.success ? 'complete' : 'error';
        if (!result.success) {
          state.error = result.errors.join(', ');
        }

        return c.json(
          {
            success: result.success,
            error: state.error,
            completion: result.completion,
            environmentDeleted: result.success && environmentEmpty,
            retryable: result.retryable,
            postDeleteVerification: result.postDeleteVerification,
            deleted: result.deleted,
            manualR2: result.manualR2,
            manualDns,
            errors: result.errors,
            progress: state.progress,
            operationProgress: state.operationProgress,
            logPath: state.logPath,
          },
          result.success ? 200 : result.retryable ? 503 : 500
        );
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        addProgress(`❌ ${state.error}`);
        await flushProgressLog();
        const inventoryUnavailable = error instanceof EnvironmentInventoryUnavailableError;
        return c.json(
          {
            success: false,
            error: state.error,
            errors: [state.error],
            errorCode: inventoryUnavailable ? error.code : undefined,
            progress: state.progress,
            operationProgress: state.operationProgress,
            logPath: state.logPath,
          },
          inventoryUnavailable ? 503 : 500
        );
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // =============================================================================
  // Release and Worker Update
  // =============================================================================

  api.get('/update/release/:env', async (c) => {
    try {
      const envResult = EnvNameSchema.safeParse(c.req.param('env'));
      if (!envResult.success) {
        return c.json({ success: false, error: 'Invalid environment name' }, 400);
      }
      const baseDir = findAuthrimBaseDir(process.cwd());
      const targetVersion = await getRootProductVersion(baseDir);
      const { lock } = await loadLockFileAuto(baseDir, envResult.data);
      let databaseOnlyAvailable = false;
      if (lock?.productVersion && Object.keys(lock.workers ?? {}).length > 0) {
        try {
          const release = loadTargetReleaseMigrationManifest({
            migrationsRoot: join(baseDir, 'migrations'),
            productVersion: targetVersion,
            allowDraft: false,
          }).manifest;
          assertDatabaseOnlyWorkerCompatibility(release, lock.productVersion);
          databaseOnlyAvailable = Object.values(lock.workers ?? {}).every(
            (worker) => worker.version === lock.productVersion
          );
        } catch {
          databaseOnlyAvailable = false;
        }
      }
      return c.json({
        success: true,
        env: envResult.data,
        release: {
          ...evaluateReleaseUpdateAvailability(lock, targetVersion),
          databaseOnlyAvailable,
        },
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.use('/update/release', validateSession);
  api.post('/update/release', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const envResult = EnvNameSchema.safeParse(body.env);
        if (!envResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        if (body.databaseOnly !== undefined && typeof body.databaseOnly !== 'boolean') {
          return c.json({ success: false, error: 'databaseOnly must be a boolean' }, 400);
        }
        const env = envResult.data;
        const databaseOnly = body.databaseOnly === true;
        const baseDir = findAuthrimBaseDir(process.cwd());
        const targetVersion = await getRootProductVersion(baseDir);
        const { lock } = await loadLockFileAuto(baseDir, env);
        const availability = evaluateReleaseUpdateAvailability(lock, targetVersion);

        if (availability.status === 'up_to_date') {
          return c.json({ success: true, env, release: availability, progress: [] });
        }
        if (!availability.canUpdate) {
          return c.json(
            {
              success: false,
              error: `Release update is not available while the environment is ${availability.status}.`,
              release: availability,
            },
            409
          );
        }

        state.status = 'deploying';
        state.error = null;
        state.deployResults = [];
        clearProgress();
        state.logPath = await beginProgressLog(env, 'update');
        addProgress(
          availability.status === 'resume_available'
            ? `Resuming release update for ${env} to ${targetVersion}`
            : `Starting release update for ${env}: ${availability.currentVersion ?? 'legacy'} -> ${targetVersion}`
        );

        const result = await runReleaseUpdateCli({
          env,
          cwd: process.cwd(),
          databaseOnly,
          onProgress: addProgress,
        });
        if (!result.success) {
          state.status = 'error';
          state.error = `Release update exited with code ${result.exitCode}.`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              release: availability,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        const { lock: updatedLock } = await loadLockFileAuto(baseDir, env);
        if (
          updatedLock?.releaseUpdate?.targetVersion === targetVersion &&
          updatedLock.releaseUpdate.phase === 'control_handoff'
        ) {
          const continuing = evaluateReleaseUpdateAvailability(updatedLock, targetVersion);
          state.status = 'idle';
          addProgress(
            'Database migration continues in Control; this update can be resumed safely.'
          );
          await flushProgressLog();
          return c.json(
            {
              success: true,
              inProgress: true,
              env,
              release: continuing,
              progress: state.progress,
              logPath: state.logPath,
            },
            202
          );
        }
        const completedAsRequested = databaseOnly
          ? updatedLock?.releaseUpdate?.targetVersion === targetVersion &&
            updatedLock.releaseUpdate.phase === 'database_only_verified'
          : updatedLock?.productVersion === targetVersion &&
            updatedLock.releaseUpdate?.phase === 'verified';
        if (!completedAsRequested) {
          throw new Error('release_update_completed_without_verified_state');
        }
        const completed = evaluateReleaseUpdateAvailability(updatedLock, targetVersion);
        state.status = 'complete';
        addProgress(
          databaseOnly
            ? `Database-only update complete: schema ${targetVersion}; Workers retained`
            : `Release update complete: ${targetVersion}`
        );
        await flushProgressLog();
        return c.json({
          success: true,
          env,
          release: completed,
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        await flushProgressLog();
        return c.json(
          {
            success: false,
            error: state.error,
            progress: state.progress,
            logPath: state.logPath,
          },
          500
        );
      }
    });
  });

  // Get version comparison for an environment (no auth required - read-only, localhost only)
  api.get('/update/compare/:env', async (c) => {
    try {
      const envParam = c.req.param('env');

      // Validate environment name to prevent path traversal
      const parseResult = EnvNameSchema.safeParse(envParam);
      if (!parseResult.success) {
        return c.json({ success: false, error: 'Invalid environment name' }, 400);
      }
      const env = parseResult.data;
      const rootDir = process.cwd();

      // Load lock file to get deployed versions
      const { loadLockFileAuto } = await import('../core/lock.js');
      const { lock } = await loadLockFileAuto(rootDir, env);

      // Build deployed versions from lock file or fallback to wrangler check
      const deployedVersions: Record<string, { version?: string; deployedAt?: string }> = {};
      let hasLockWorkers = false;

      if (lock?.workers && Object.keys(lock.workers).length > 0) {
        // Use lock file data if available
        hasLockWorkers = true;
        for (const [component, info] of Object.entries(lock.workers)) {
          deployedVersions[component] = {
            version: info.version,
            deployedAt: info.deployedAt,
          };
        }
      }

      // Get local package versions
      const localVersions = await getLocalPackageVersions(rootDir);

      // If no lock file or no workers in lock, check wrangler for deployment status
      // Use parallel requests with timeout to avoid slow sequential API calls
      if (!hasLockWorkers) {
        const { WORKER_COMPONENTS } = await import('../core/naming.js');
        // Check core workers first (in parallel) to determine if environment is deployed
        const coreWorkers: WorkerComponent[] = ['ar-lib-core', 'ar-router', 'ar-auth'];

        const coreResults = await Promise.allSettled(
          coreWorkers.map(async (component) => {
            const workerName = `${env}-${component}`;
            const deployInfo = await getWorkerDeployments(workerName);
            return { component, deployInfo };
          })
        );

        for (const result of coreResults) {
          if (result.status === 'fulfilled' && result.value.deployInfo.exists) {
            deployedVersions[result.value.component] = {
              version: undefined,
              deployedAt: result.value.deployInfo.lastDeployedAt || undefined,
            };
          }
        }

        // If core workers are deployed, check remaining workers in parallel
        if (Object.keys(deployedVersions).length > 0) {
          const remainingComponents = WORKER_COMPONENTS.filter(
            (c) => !deployedVersions[c] && !coreWorkers.includes(c)
          );

          const remainingResults = await Promise.allSettled(
            remainingComponents.map(async (component) => {
              const workerName = `${env}-${component}`;
              const deployInfo = await getWorkerDeployments(workerName);
              return { component, deployInfo };
            })
          );

          for (const result of remainingResults) {
            if (result.status === 'fulfilled' && result.value.deployInfo.exists) {
              deployedVersions[result.value.component] = {
                version: undefined,
                deployedAt: result.value.deployInfo.lastDeployedAt || undefined,
              };
            }
          }
        }
      }

      // Compare versions
      const comparison = compareVersions(localVersions, deployedVersions);

      return c.json({
        success: true,
        env,
        comparison,
        hasLockFile: !!lock,
        hasLockWorkers,
        summary: {
          total: comparison.length,
          needsUpdate: comparison.filter((c) => c.needsUpdate).length,
          upToDate: comparison.filter((c) => !c.needsUpdate).length,
        },
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Apply session validation to update endpoint
  api.use('/update/workers', validateSession);

  // Update workers for an environment (with lock)
  api.post('/update/workers', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const body = await c.req.json();
        const {
          env: envParam,
          onlyChanged = true,
          includeUiWorkers = true,
          topologyDeploymentToken,
        } = body;
        const rootDir = process.cwd();

        // Validate environment name to prevent path traversal
        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = parseResult.data;
        const operationKind = topologyDeploymentToken ? 'topology_change' : 'worker_redeploy';

        state.status = 'deploying';
        state.error = null;
        state.deployResults = [];
        clearProgress();
        state.logPath = await beginProgressLog(env, 'update');
        addProgress(`Starting worker update for environment: ${env}`);

        // Load lock file
        const { loadLockFileAuto, saveLockFile: saveLock } = await import('../core/lock.js');
        let { lock, path: lockPath } = await loadLockFileAuto(rootDir, env);

        if (!lock) {
          state.status = 'error';
          state.error = `Environment "${env}" not found.`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            404
          );
        }

        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: rootDir,
          env,
          operation: 'web-worker-update',
          requireExisting: true,
        });
        deployConfigLock = await acquireDeployConfigLock({
          baseDir: rootDir,
          env,
          operation: 'web-worker-update',
        });
        lock = operationLock.lock!;
        lockPath = operationLock.lockFilePath;

        const targetProductVersion = await getRootProductVersion(rootDir);
        const deploymentGuard = evaluateReleaseDeploymentGuard(
          lock,
          targetProductVersion,
          operationKind
        );
        if (!deploymentGuard.allowed) {
          state.status = 'error';
          state.error = releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion);
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              requiredCommand: `authrim-setup update --env ${env}`,
              progress: state.progress,
              logPath: state.logPath,
            },
            409
          );
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

        // Get local package versions
        const localVersions = await getLocalPackageVersions(rootDir);

        // Compare and get components to update
        const comparison = compareVersions(localVersions, deployedVersions);
        // A topology change modifies bindings without changing package versions, so version-only
        // comparison must never turn the required binding publication into a no-op.
        const componentsToUpdate = getComponentsToUpdate(
          comparison,
          operationKind === 'topology_change' || !onlyChanged
        );
        if (operationKind === 'worker_redeploy' && onlyChanged) {
          for (const item of comparison) {
            const evidence = lock.workers?.[item.component];
            if (
              (!evidence?.deployedAt || !evidence.cloudflareVersionId) &&
              !componentsToUpdate.includes(item.component)
            ) {
              componentsToUpdate.push(item.component);
            }
          }
        }

        if (componentsToUpdate.length > 0) {
          addProgress(`${componentsToUpdate.length} worker(s) need updating`);
        }

        // Refresh master/package wrangler configs before building so new bindings
        // such as send_email are reflected even in existing environments.
        const envPaths = getEnvironmentPaths({ baseDir: rootDir, env });
        if (!existsSync(envPaths.config)) {
          state.status = 'error';
          state.error = `Config file not found: ${envPaths.config}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        const configContent = await readFile(envPaths.config, 'utf-8');
        const config = parseEnvironmentConfigForEnv(JSON.parse(configContent), env);
        if (operationKind === 'topology_change') {
          try {
            assertPendingTopologyUpdate(lock, {
              phase: 'pending_deploy',
              targetProductVersion,
              config,
              authorizationToken: topologyDeploymentToken,
            });
            const kind = lock.topologyUpdate?.kind;
            if (kind !== 'r2') {
              throw new Error(`unsupported_web_topology_update:${kind ?? 'missing'}`);
            }
          } catch {
            state.status = 'error';
            state.error = 'Invalid or stale topology deployment authorization.';
            await flushProgressLog();
            return c.json({ success: false, error: state.error }, 403);
          }
        }
        {
          const migrationsRoot = await findMigrationsRoot(rootDir, addProgress, {
            strictRoot: true,
          });
          if (!migrationsRoot.path) {
            throw new Error('Release migrations directory not found.');
          }
          const installedRelease = loadInstalledReleaseMigrationManifest({
            migrationsRoot: migrationsRoot.path,
            productVersion: targetProductVersion,
            lock,
          });
          const topologyIssues = inspectInitialControlPlaneTopology({
            env,
            config,
            lock,
            productVersion: targetProductVersion,
            manifest: installedRelease.manifest,
          });
          if (topologyIssues.length > 0) {
            state.status = 'error';
            state.error =
              'Initial deployment setup is incomplete. Run setup init again before final verification, or repair it from Admin UI after setup completes.';
            await flushProgressLog();
            return c.json(
              {
                success: false,
                error: state.error,
                topologyIssues,
                progress: state.progress,
                logPath: state.logPath,
              },
              409
            );
          }
        }
        await assertLockedCloudflareResourcesForWebMutation({
          environment: env,
          config,
          lock,
        });
        const updateOwnershipTargets = Array.from(
          new Map(
            [
              ...comparison
                .filter(
                  (item) =>
                    lock!.workers?.[item.component] !== undefined ||
                    componentsToUpdate.includes(item.component)
                )
                .map((item) => ({
                  component: item.component,
                  workerName: `${env}-${item.component}`,
                })),
              ...(includeUiWorkers !== false && componentsToUpdate.includes('ar-router')
                ? UI_WORKER_COMPONENTS.filter((component) =>
                    component === 'ar-login-ui'
                      ? config.components.loginUi !== false
                      : config.components.adminUi !== false
                  ).map((component) => ({ component, workerName: `${env}-${component}` }))
                : []),
            ].map((target) => [target.workerName, target] as const)
          ).values()
        );
        const workerOwnership = await prepareManagedWorkerScriptOwnership({
          lock,
          lockPath,
          targets: updateOwnershipTargets,
        });
        if (workerOwnership.changed) {
          lock = workerOwnership.lock;
          await saveLock(lock, lockPath);
        }
        if (componentsToUpdate.length === 0) {
          const retainedEvidence = comparison.map((item): WorkerUpdateReadinessEvidence => {
            const evidence = lock!.workers?.[item.component];
            if (
              !evidence?.deployedAt ||
              !evidence.cloudflareVersionId ||
              !evidence.cloudflareScriptTag
            ) {
              throw new Error(`worker_deployment_exact_version_unavailable:${item.component}`);
            }
            return {
              component: item.component,
              workerName: evidence.name,
              deployedAt: evidence.deployedAt,
              cloudflareVersionId: evidence.cloudflareVersionId,
              cloudflareScriptTag: evidence.cloudflareScriptTag,
            };
          });
          await verifyWorkerUpdateReadiness({
            config,
            results: retainedEvidence,
            verifyRouter: true,
            onProgress: addProgress,
          });
          state.status = 'complete';
          addProgress('All workers are up to date. No updates needed.');
          if (operationKind === 'topology_change') {
            lock = completeTopologyUpdate(lock, { targetProductVersion, config });
            await saveLock(lock, lockPath);
          }
          await flushProgressLog();
          return c.json({
            success: true,
            message: 'All workers are up to date',
            summary: { totalComponents: 0, successCount: 0, failedCount: 0 },
            progress: state.progress,
            logPath: state.logPath,
          });
        }
        const resourceIds = await buildWorkerDeploymentResourceIds({
          lock,
          config,
          environmentId: env,
          components: componentsToUpdate,
          onProgress: addProgress,
        });

        addProgress('Refreshing generated wrangler configs...');
        const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
          baseDir: rootDir,
          env,
          dryRun: false,
          components: componentsToUpdate,
          onProgress: addProgress,
        });

        if (!masterResult.success) {
          state.status = 'error';
          state.error = `Wrangler config generation failed: ${masterResult.errors.join(', ')}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        addProgress('Syncing wrangler configs...');
        const syncResult = await syncWranglerConfigs({
          baseDir: rootDir,
          env,
          packagesDir: join(rootDir, 'packages'),
          force: true,
          dryRun: false,
          components: componentsToUpdate,
          onProgress: addProgress,
        });

        if (!syncResult.success && syncResult.errors.length > 0) {
          state.status = 'error';
          state.error = `Wrangler config sync failed: ${syncResult.errors.join(', ')}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);

        const workerComponentsToUpdate = componentsToUpdate.filter(
          (component): component is WorkerComponent =>
            (WORKER_COMPONENTS as readonly string[]).includes(component)
        );
        let deploymentSecrets: Record<string, string> = {};
        if (workerComponentsToUpdate.length > 0) {
          const keysDir = resolveWebDeploymentKeysDir(rootDir, env, config);
          deploymentSecrets = await loadSupplementalSecretsForWorkers({
            env,
            baseDir: rootDir,
            config,
            keysDir,
            workers: workerComponentsToUpdate,
          });
        }

        // Build packages
        addProgress('Building packages...');
        const buildResult = await buildApiPackages({
          rootDir: resolve(rootDir),
          onProgress: addProgress,
        });

        if (!buildResult.success) {
          state.status = 'error';
          state.error = `Build failed: ${buildResult.error}`;
          await flushProgressLog();
          return c.json(
            {
              success: false,
              error: state.error,
              progress: state.progress,
              logPath: state.logPath,
            },
            500
          );
        }

        const workerDeployOptions = {
          env,
          rootDir: resolve(rootDir),
          concurrency: 2,
          deploymentStrategy: 'auto' as const,
          existingComponents: WORKER_COMPONENTS.filter(
            (component) => lock!.workers?.[component] !== undefined
          ),
          secrets: deploymentSecrets,
          cleanupLegacyStaticSecrets: true,
          deployConfigLockProof: deployConfigLock.proof,
          onProgress: addProgress,
          onError: (comp: string, error: Error) => {
            addProgress(`Error in ${comp}: ${sanitizeError(error)}`);
          },
          workerScriptOwnership: undefined as WorkerScriptOwnershipGuard | undefined,
        };
        workerDeployOptions.existingComponents = await resolveExistingWorkerComponents(
          workerDeployOptions,
          WORKER_COMPONENTS
        );

        workerDeployOptions.workerScriptOwnership = workerOwnership.guard;

        if (
          includeUiWorkers !== false &&
          (config.components.loginUi || config.components.adminUi) &&
          componentsToUpdate.includes('ar-router')
        ) {
          const missingUiBindingTargets = await resolveMissingUiWorkerBindingTargets(
            { env, rootDir: resolve(rootDir), onProgress: addProgress },
            {
              loginUi: config.components.loginUi ?? true,
              adminUi: config.components.adminUi ?? true,
            }
          );

          const placeholderSummary =
            missingUiBindingTargets.loginUi || missingUiBindingTargets.adminUi
              ? await deployUiWorkerBindingTargets(
                  {
                    env,
                    rootDir: resolve(rootDir),
                    apiBaseUrl: resolveIssuerUrl(config, { env }),
                    deployConfigLockProof: deployConfigLock.proof,
                    workerScriptOwnership: workerOwnership.guard,
                    onProgress: addProgress,
                  },
                  missingUiBindingTargets
                )
              : undefined;

          if (placeholderSummary && placeholderSummary.failedCount > 0) {
            addProgress(
              `⚠️ UI Worker pre-deploy failed: ${placeholderSummary.successCount}/${placeholderSummary.results.length} succeeded`
            );
            for (const result of placeholderSummary.results) {
              if (!result.success) {
                addProgress(`  ✗ ${result.component}: ${result.error || 'unknown error'}`);
              }
            }
            addProgress('  ar-router may fail if it references missing UI Worker bindings.');
          } else if (!placeholderSummary) {
            addProgress(
              'UI Worker binding targets already exist; skipping placeholder pre-deploy.'
            );
          }
        }

        // Deploy workers
        addProgress('Deploying workers...');
        const summary = await deployAll(workerDeployOptions, componentsToUpdate);
        state.deployResults = summary.results;

        const successfulResults = summary.results.filter((result) => result.success);
        const readinessEvidence = successfulResults.map((result): WorkerUpdateReadinessEvidence => {
          if (!result.deployedAt || !result.cloudflareVersionId || !result.cloudflareScriptTag) {
            throw new Error(`worker_deployment_exact_version_unavailable:${result.component}`);
          }
          return {
            component: result.component as WorkerComponent,
            workerName: result.workerName,
            deployedAt: result.deployedAt,
            cloudflareVersionId: result.cloudflareVersionId,
            cloudflareScriptTag: result.cloudflareScriptTag,
          };
        });

        // Cloudflare version visibility and health must be proven before the durable lock advances.
        // This keeps a failed verification retry from being misclassified as a version-only no-op.
        await verifyWorkerUpdateReadiness({
          config,
          results: readinessEvidence,
          verifyRouter: summary.failedCount === 0,
          onProgress: addProgress,
        });

        // Persist only deployments that passed exact-version and health verification.
        if (successfulResults.length > 0) {
          const workers = { ...lock.workers };
          for (const result of successfulResults) {
            workers[result.component] = {
              name: result.workerName,
              deployedAt: result.deployedAt!,
              version: localVersions[result.component] || result.version,
              cloudflareVersionId: result.cloudflareVersionId!,
              cloudflareScriptTag: result.cloudflareScriptTag!,
            };
          }

          const updatedLock = clearProvisionalWorkerScriptOwnership(
            {
              ...lock,
              workers,
              updatedAt: new Date().toISOString(),
            },
            successfulResults.map((result) => result.component)
          );

          await saveLock(updatedLock, lockPath);
          lock = updatedLock;
          addProgress(`Lock file updated: ${lockPath}`);
        }

        state.status = summary.failedCount === 0 ? 'complete' : 'error';

        if (summary.failedCount === 0) {
          addProgress(`Successfully updated ${summary.successCount} worker(s)`);
          if (operationKind === 'topology_change') {
            lock = completeTopologyUpdate(lock, { targetProductVersion, config });
            await saveLock(lock, lockPath);
          }
        } else {
          state.error = `Worker update failed for ${summary.failedCount} of ${summary.totalComponents} component(s).`;
          addProgress(
            `❌ Updated ${summary.successCount}/${summary.totalComponents}, ${summary.failedCount} failed`
          );
        }
        await flushProgressLog();

        return c.json({
          success: summary.failedCount === 0,
          summary,
          error: state.error,
          updatedComponents: componentsToUpdate,
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        addProgress(`❌ Worker update failed: ${state.error}`);
        await flushProgressLog();
        return c.json(
          { success: false, error: state.error, progress: state.progress, logPath: state.logPath },
          500
        );
      } finally {
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // =============================================================================
  // Resource Details
  // =============================================================================

  // Get D1 database details (no auth required - read-only)
  api.get('/d1/:name/info', async (c) => {
    try {
      const name = c.req.param('name');
      const { getD1Info } = await import('../core/cloudflare.js');
      const info = await getD1Info(name);
      return c.json({ success: true, info });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Get Worker deployment info (no auth required - read-only)
  api.get('/worker/:name/deployments', async (c) => {
    try {
      const name = c.req.param('name');
      const { getWorkerDeployments } = await import('../core/cloudflare.js');
      const deployments = await getWorkerDeployments(name);
      return c.json({ success: true, deployments });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // =============================================================================
  // Individual Component Deployment
  // =============================================================================

  // Apply session validation to component deploy
  api.use('/deploy/component/*', validateSession);

  // Deploy a single component (worker or UI Worker)
  api.post('/deploy/component/:name', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
      try {
        const componentName = c.req.param('name');
        const bodyResult = z
          .object({
            env: EnvNameSchema,
            skipBuild: z.boolean().optional(),
            dryRun: z.boolean().optional(),
          })
          .strict()
          .safeParse(await c.req.json());
        if (!bodyResult.success) {
          return c.json({ success: false, error: 'Invalid deployment request' }, 400);
        }
        const { env, skipBuild = false, dryRun = false } = bodyResult.data;
        const rootDir = findAuthrimBaseDir(process.cwd());

        state.status = 'deploying';
        state.error = null;
        state.deployResults = [];
        clearProgress();
        state.logPath = await beginProgressLog(env, 'update');
        addProgress(`Deploying component: ${componentName}`);

        // Check if it's a UI Worker component or API Worker component.
        const isUiWorkerComponent = UI_WORKER_COMPONENTS.includes(
          componentName as UiWorkerComponent
        );
        const isWorkerComponent = WORKER_COMPONENTS.includes(componentName as WorkerComponent);

        if (!isUiWorkerComponent && !isWorkerComponent) {
          const error = markOperationError(
            `Unknown component: ${componentName}. Valid components: ${[...WORKER_COMPONENTS, ...UI_WORKER_COMPONENTS].join(', ')}`
          );
          return c.json(
            {
              success: false,
              error,
            },
            400
          );
        }

        let { lock: componentDeploymentLock } = await loadLockFileAuto(rootDir, env);
        if (!componentDeploymentLock) {
          const error = markOperationError(`Environment "${env}" not found.`);
          return c.json({ success: false, error }, 404);
        }
        if (!dryRun) {
          operationLock = await acquireEnvironmentOperationForEnvironment({
            baseDir: rootDir,
            env,
            operation: `web-component-deploy:${componentName}`,
            requireExisting: true,
          });
          deployConfigLock = await acquireDeployConfigLock({
            baseDir: rootDir,
            env,
            operation: `web-component-deploy:${componentName}`,
          });
          componentDeploymentLock = operationLock.lock!;
        }
        const targetProductVersion = await getRootProductVersion(rootDir);
        const deploymentGuard = evaluateReleaseDeploymentGuard(
          componentDeploymentLock,
          targetProductVersion,
          'worker_redeploy'
        );
        if (!deploymentGuard.allowed) {
          const error = markOperationError(
            releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion)
          );
          return c.json(
            {
              success: false,
              error,
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }

        // Load config for API URL (needed for UI Worker deployment)
        const baseDir = findAuthrimBaseDir(process.cwd());
        const resolved = resolvePaths({ baseDir, env });
        let cfg = getStateConfigForEnv(env);
        if (!cfg) {
          try {
            const configPath =
              resolved.type === 'new'
                ? (resolved.paths as EnvironmentPaths).config
                : (resolved.paths as LegacyPaths).config;
            if (existsSync(configPath)) {
              const configContent = await readFile(configPath, 'utf-8');
              cfg = parseEnvironmentConfigForEnv(JSON.parse(configContent), env);
              state.config = cfg;
            }
          } catch {
            // Config is optional for worker deployment
          }
        }

        if (!dryRun) {
          if (!cfg) throw new Error('component_deployment_config_missing');
          await assertLockedCloudflareResourcesForWebMutation({
            environment: env,
            config: AuthrimConfigSchema.parse(cfg),
            lock: componentDeploymentLock,
          });
        }

        if (isUiWorkerComponent) {
          // Deploy UI Worker component (ar-admin-ui or ar-login-ui).
          // deployUiWorkerComponent is kept as an internal compatibility alias.
          if (!cfg) {
            const error = markOperationError('Environment config is required for UI deployment');
            return c.json({ success: false, error }, 400);
          }
          const parsedUiConfig = AuthrimConfigSchema.parse(cfg);
          const componentAdminDatabaseIdentifier = componentDeploymentLock.d1.DB_ADMIN?.id;
          if (!dryRun && !componentAdminDatabaseIdentifier) {
            throw new Error('admin_database_required_for_ui_component_deployment');
          }
          if (skipBuild && !dryRun) {
            const error = markOperationError(
              'UI builds contain environment-specific configuration and cannot be safely reused. Build the UI for this environment.'
            );
            return c.json({ success: false, error }, 400);
          }
          const keysDir = resolveWebDeploymentKeysDir(rootDir, env, parsedUiConfig);
          if (!dryRun) {
            await ensureSupplementalKeysForWebDeploy(keysDir);
          }

          // Build first (unless skipped)
          if (!dryRun) {
            addProgress(
              skipBuild
                ? `Reusing the existing ${componentName} build output...`
                : `Building ${componentName}...`
            );
            const uiDir = join(rootDir, 'packages', componentName);

            if (!existsSync(uiDir)) {
              const error = markOperationError(`Package not found: ${componentName}`);
              return c.json({ success: false, error }, 404);
            }

            // Get the tenant-aware API base URL.
            const apiBaseUrl = resolveIssuerUrl(cfg, { env });

            let loginUiClientId: string | undefined;
            if (componentName === 'ar-login-ui' && !dryRun) {
              const coreDatabaseIdentifier = componentDeploymentLock.d1.DB?.id;
              if (!coreDatabaseIdentifier || !componentAdminDatabaseIdentifier) {
                throw new Error('fixed_bootstrap_databases_required_for_login_ui_deployment');
              }
              let setupMachineReady = false;
              try {
                const initialTenantResult = await ensureInitialTenantInD1(
                  env,
                  cfg as AuthrimConfig,
                  addProgress,
                  { databaseIdentifier: coreDatabaseIdentifier }
                );
                if (!initialTenantResult.success) {
                  throw new Error(
                    `Initial tenant prerequisite failed: ${initialTenantResult.error || 'unknown error'}`
                  );
                }
                const migrationRoot = await findMigrationsRoot(rootDir, addProgress, {
                  strictRoot: true,
                });
                if (!migrationRoot.path) {
                  throw new Error('Release migrations directory not found');
                }
                const installedRelease = loadInstalledReleaseMigrationManifest({
                  migrationsRoot: migrationRoot.path,
                  productVersion: targetProductVersion,
                  lock: componentDeploymentLock,
                });
                const snapshotResult = await publishInitialControlPlaneRuntimeSnapshot({
                  env,
                  config: cfg as AuthrimConfig,
                  lock: componentDeploymentLock,
                  rootDir,
                  keysDir,
                  release: installedRelease.manifest,
                  onProgress: addProgress,
                });
                if (!snapshotResult.success) {
                  throw new Error(
                    `Initial tenant runtime snapshot failed: ${snapshotResult.error || 'unknown error'}`
                  );
                }
                // Treat a failed ensure as an ambiguous partial mutation and always run the exact-ID
                // cleanup before releasing the environment operation lock.
                setupMachineReady = true;
                const setupMachineResult = await ensureSetupMachineAccessInD1(
                  env,
                  cfg as AuthrimConfig,
                  keysDir,
                  addProgress,
                  { databaseIdentifier: componentAdminDatabaseIdentifier }
                );
                if (!setupMachineResult.success) {
                  throw new Error(
                    `Setup machine access bootstrap failed: ${setupMachineResult.error || 'unknown error'}`
                  );
                }
                const readinessResult = await waitForRouterWorkerReady({
                  apiBaseUrl,
                  onProgress: addProgress,
                  onDetail: addDetailProgress,
                });
                if (!readinessResult.ready) {
                  handleRouterReadinessFailure(
                    cfg,
                    readinessResult.checkedUrl,
                    readinessResult.error,
                    addProgress
                  );
                }

                const loginUiUrl = resolveLoginUiExecutionOrigin(cfg, { env });

                const { ensureLoginUiClient } = await import('../core/login-ui-client.js');
                const clientResult = await ensureLoginUiClient({
                  apiBaseUrl,
                  loginUiUrl,
                  keysDir,
                  tenantId: cfg?.tenant?.name,
                  onProgress: addProgress,
                });

                if (clientResult.success && clientResult.clientId) {
                  loginUiClientId = clientResult.clientId;
                  if (clientResult.alreadyExists) {
                    addProgress(`  ✓ Login UI client exists: ${loginUiClientId}`);
                  } else {
                    addProgress(`  ✓ Login UI client created: ${loginUiClientId}`);
                  }
                } else {
                  throw new Error(
                    `Login UI client creation failed: ${clientResult.error || 'unknown error'}`
                  );
                }
              } finally {
                if (setupMachineReady) {
                  const cleanupResult = await cleanupSetupMachineAccessInD1(
                    env,
                    keysDir,
                    addProgress,
                    { databaseIdentifier: componentAdminDatabaseIdentifier }
                  );
                  if (!cleanupResult.success) {
                    addProgress(
                      `⚠️ Setup machine access cleanup failed: ${cleanupResult.error || 'unknown error'}`
                    );
                  }
                }
              }
            }

            const uiSettings = resolveUiDeploymentSettings({
              component: componentName as UiWorkerComponent,
              config: cfg as AuthrimConfig,
              apiBaseUrl,
              loginUiClientId,
            });
            if (componentName === 'ar-login-ui' && loginUiClientId) {
              await mergeAndSaveUiEnv(
                getEnvironmentPaths({ baseDir: rootDir, env }).uiEnv,
                uiSettings.uiEnv
              );
              addProgress('Login UI env updated with client_id');
            }
            if (componentName === 'ar-admin-ui' && uiSettings.adminUiApiMode) {
              addProgress(
                `Admin UI API mode: ${uiSettings.adminUiApiMode} - ${describeAdminUiApiMode(
                  uiSettings.adminUiApiMode
                )}`
              );
            }
            const adminUiBffSecrets =
              componentName === 'ar-admin-ui' && !dryRun
                ? await prepareAdminUiBffDeployment({
                    env,
                    config: cfg as AuthrimConfig,
                    keysDir,
                    databaseIdentifier: componentAdminDatabaseIdentifier,
                    onProgress: addProgress,
                  })
                : undefined;

            let uiWorkerOwnership: WorkerScriptOwnershipGuard | undefined;
            if (!dryRun) {
              const uiOwnershipLock = await loadLockFileAuto(rootDir, env);
              if (!uiOwnershipLock.lock || !uiOwnershipLock.path) {
                throw new Error('ui_worker_ownership_lock_unavailable');
              }
              const ownership = await prepareManagedWorkerScriptOwnership({
                lock: uiOwnershipLock.lock,
                lockPath: uiOwnershipLock.path,
                targets: [{ component: componentName, workerName: `${env}-${componentName}` }],
              });
              if (ownership.changed) {
                await saveLockFile(ownership.lock, uiOwnershipLock.path);
              }
              uiWorkerOwnership = ownership.guard;
            }

            const result = await deployUiWorkerComponent(componentName as UiWorkerComponent, {
              env,
              rootDir,
              dryRun,
              apiBaseUrl: uiSettings.apiBaseUrl,
              runtimeApiBackendUrl: uiSettings.runtimeApiBackendUrl,
              uiEnvConfig: uiSettings.uiEnv,
              serviceBindingName: uiSettings.serviceBindingName,
              workersDev: uiSettings.workersDev,
              routes: uiSettings.routes,
              adminUiBffSecrets,
              skipBuild,
              deployConfigLockProof: deployConfigLock?.proof,
              workerScriptOwnership: uiWorkerOwnership,
              onProgress: addProgress,
            });

            if (result.success && !dryRun) {
              if (
                !result.deployedAt ||
                !result.cloudflareVersionId ||
                !result.cloudflareScriptTag
              ) {
                throw new Error(`ui_worker_deployment_exact_version_unavailable:${componentName}`);
              }
              const visibility = await waitForWorkerDeploymentsReady({
                targets: [
                  {
                    workerName: result.projectName,
                    deployedAt: result.deployedAt,
                    expectedVersionId: result.cloudflareVersionId,
                  },
                ],
                onProgress: addProgress,
              });
              if (!visibility.ready) {
                throw new Error(
                  `UI Worker deployment did not become visible: ${visibility.error ?? 'unknown error'}`
                );
              }
              const workersSubdomain = await getWorkersSubdomain();
              const entryUrl =
                componentName === 'ar-login-ui'
                  ? resolveLoginUiEntryUrl(cfg, { env, workersSubdomain })
                  : resolveAdminUiEntryUrl(cfg, { env, workersSubdomain });
              const httpReadiness = await waitForWorkerHttpReady({
                targets: [{ workerName: result.projectName, url: entryUrl }],
                onProgress: addProgress,
              });
              if (!httpReadiness.ready) {
                throw new Error(
                  `UI Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
                );
              }
              const controlDatabaseId = componentDeploymentLock.d1.CONTROL_DB?.id;
              if (!controlDatabaseId) {
                throw new Error('control_database_required_for_ui_worker_inventory');
              }
              await registerUiWorkerInventoryFromArtifacts({
                baseDir: rootDir,
                environmentId: env,
                environmentName: env,
                controlDatabaseName: controlDatabaseId,
                components: [componentName as UiWorkerComponent],
                environmentBootstrap: {
                  defaultResidencyPolicyId: (cfg as AuthrimConfig).profiles.defaults.residency,
                  automaticProvisioning:
                    (cfg as AuthrimConfig).controlPlane?.automaticProvisioning === true,
                },
                registeredBy: 'setup:web-upgrade-ui',
                disableMissing: false,
                onProgress: addProgress,
              });

              const { lock: currentLock, path: lockPath } = await loadLockFileAuto(rootDir, env);
              if (!currentLock || !lockPath) {
                throw new Error('ui_worker_deployment_lock_unavailable');
              }
              const version = await getPackageVersion(join(rootDir, 'packages', componentName));
              const workers = { ...currentLock.workers };
              workers[componentName] = {
                name: result.projectName,
                deployedAt: result.deployedAt,
                version: version ?? undefined,
                cloudflareVersionId: result.cloudflareVersionId,
                cloudflareScriptTag: result.cloudflareScriptTag,
              };
              await saveLockFile(
                clearProvisionalWorkerScriptOwnership({ ...currentLock, workers }, [componentName]),
                lockPath
              );
              addProgress('Lock file updated');
            }

            if (result.success) {
              state.status = 'complete';
              addProgress(`✓ ${componentName} deployed successfully`);
              return c.json({
                success: true,
                component: componentName,
                type: 'ui-worker',
                projectName: result.projectName,
                deployedAt: result.deployedAt,
                logPath: state.logPath,
              });
            } else {
              const error = markOperationError(
                result.error || `${componentName} deployment failed`
              );
              return c.json(
                {
                  success: false,
                  component: componentName,
                  type: 'ui-worker',
                  error,
                },
                500
              );
            }
          }

          // Dry run for UI Worker
          state.status = 'complete';
          return c.json({
            success: true,
            component: componentName,
            type: 'ui-worker',
            dryRun: true,
            message: `Would deploy ${componentName} to Workers`,
            logPath: state.logPath,
          });
        } else {
          // Deploy Worker component
          // deployWorker and buildApiPackages are already imported at the top

          // Refresh master/package wrangler configs before deploying.
          // The .authrim/{env}/wrangler master copy is the source of truth.
          if (!dryRun) {
            addProgress('Refreshing generated wrangler configs...');
            const { loadLockFileAuto } = await import('../core/lock.js');
            const { getEnvironmentPaths } = await import('../core/paths.js');

            const envPaths = getEnvironmentPaths({ baseDir: rootDir, env });
            const { lock: currentLock } = await loadLockFileAuto(rootDir, env);

            if (!existsSync(envPaths.config) || !currentLock) {
              throw new Error('component_deployment_config_or_lock_missing');
            }
            const configContent = await readFile(envPaths.config, 'utf-8');
            const parsedConfig = parseEnvironmentConfigForEnv(JSON.parse(configContent), env);
            const resourceIds = await buildWorkerDeploymentResourceIds({
              lock: currentLock,
              config: parsedConfig,
              environmentId: env,
              components: [componentName as WorkerComponent],
              onProgress: addProgress,
            });

            const masterResult = await saveMasterWranglerConfigs(parsedConfig, resourceIds, {
              baseDir: rootDir,
              env,
              dryRun: false,
              components: [componentName as WorkerComponent],
              onProgress: addProgress,
            });
            if (!masterResult.success) {
              throw new Error(
                `component_wrangler_generation_failed:${masterResult.errors.join(',')}`
              );
            }

            addProgress('Syncing wrangler configs...');
            const syncResult = await syncWranglerConfigs({
              baseDir: rootDir,
              env,
              packagesDir: join(rootDir, 'packages'),
              force: true,
              dryRun: false,
              components: [componentName as WorkerComponent],
              onProgress: addProgress,
            });
            if (!syncResult.success) {
              throw new Error(`component_wrangler_sync_failed:${syncResult.errors.join(',')}`);
            }
            addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);
          }

          const { lock: componentLock, path: componentLockPath } = await loadLockFileAuto(
            rootDir,
            env
          );
          let deploymentSecrets: Record<string, string> = {};
          if (!dryRun) {
            const keysDir = resolveWebDeploymentKeysDir(rootDir, env, cfg);
            deploymentSecrets = await loadSupplementalSecretsForWorkers({
              env,
              baseDir: rootDir,
              config: cfg ? AuthrimConfigSchema.parse(cfg) : undefined,
              keysDir,
              workers: [componentName as WorkerComponent],
            });
          }

          // Build first (unless skipped)
          if (!skipBuild && !dryRun) {
            addProgress('Building packages...');
            const buildResult = await buildApiPackages({
              rootDir,
              components: componentLock?.workers?.[componentName]
                ? [componentName as WorkerComponent]
                : undefined,
              onProgress: addProgress,
            });

            if (!buildResult.success) {
              const error = markOperationError(`Build failed: ${buildResult.error}`);
              return c.json({ success: false, error }, 500);
            }
          }

          const componentDeployOptions = {
            env,
            rootDir,
            dryRun,
            concurrency: 2,
            deploymentStrategy: 'auto' as const,
            existingComponents: WORKER_COMPONENTS.filter(
              (component) => componentLock?.workers?.[component] !== undefined
            ),
            secrets: deploymentSecrets,
            cleanupLegacyStaticSecrets: true,
            deployConfigLockProof: deployConfigLock?.proof,
            onProgress: addProgress,
            workerScriptOwnership: undefined as WorkerScriptOwnershipGuard | undefined,
          };
          if (!dryRun) {
            componentDeployOptions.existingComponents = await resolveExistingWorkerComponents(
              componentDeployOptions,
              WORKER_COMPONENTS
            );
          }

          if (!dryRun) {
            if (!componentLock || !componentLockPath) {
              throw new Error('worker_deployment_lock_unavailable');
            }
            const componentOwnership = await prepareManagedWorkerScriptOwnership({
              lock: componentLock,
              lockPath: componentLockPath,
              targets: [
                {
                  component: componentName,
                  workerName: getWorkerName(env, componentName as WorkerComponent),
                },
                ...(componentName === 'ar-router'
                  ? UI_WORKER_COMPONENTS.filter((component) =>
                      component === 'ar-login-ui'
                        ? cfg?.components?.loginUi !== false
                        : cfg?.components?.adminUi !== false
                    ).map((component) => ({
                      component,
                      workerName: `${env}-${component}`,
                    }))
                  : []),
              ],
            });
            if (componentOwnership.changed) {
              await saveLockFile(componentOwnership.lock, componentLockPath);
            }
            componentDeployOptions.workerScriptOwnership = componentOwnership.guard;
          }

          if (!dryRun && componentName === 'ar-router') {
            try {
              let dnsLock = componentLock;
              if (!dnsLock || !componentLockPath) {
                throw new Error('dns_ownership_lock_unavailable');
              }
              await ensureWildcardDnsForMultiTenant(cfg, addProgress, undefined, {
                get: (role) => dnsLock?.dns?.[role],
                persist: async (entry) => {
                  if (!dnsLock) throw new Error('dns_ownership_lock_unavailable');
                  dnsLock = withDnsOwnershipEntry(dnsLock, entry);
                  await saveLockFile(dnsLock, componentLockPath);
                },
              });
            } catch (error) {
              const manualAction = getWildcardDnsManualActionPayload(cfg);
              if (manualAction && isWildcardDnsPermissionError(error)) {
                state.status = 'error';
                state.error = 'Manual wildcard DNS setup required';
                addProgress('⚠️ Automatic wildcard DNS setup is unavailable.');
                addProgress('⚠️ Create the wildcard DNS record manually, then rerun deploy.');
                return c.json(
                  {
                    success: false,
                    component: componentName,
                    type: 'worker',
                    error: 'Manual wildcard DNS setup required',
                    manualAction,
                  },
                  409
                );
              }
              throw error;
            }
          }

          if (!dryRun && componentName === 'ar-router') {
            const missingUiBindingTargets = await resolveMissingUiWorkerBindingTargets(
              { env, rootDir, onProgress: addProgress },
              {
                loginUi: cfg?.components?.loginUi ?? true,
                adminUi: cfg?.components?.adminUi ?? true,
              }
            );
            if (missingUiBindingTargets.loginUi || missingUiBindingTargets.adminUi) {
              const placeholder = await deployUiWorkerBindingTargets(
                {
                  env,
                  rootDir,
                  apiBaseUrl: resolveIssuerUrl(cfg, { env }),
                  deployConfigLockProof: deployConfigLock?.proof,
                  workerScriptOwnership: componentDeployOptions.workerScriptOwnership,
                  onProgress: addProgress,
                },
                missingUiBindingTargets
              );
              if (placeholder.failedCount > 0) {
                const error = markOperationError('UI Worker binding-target deployment failed');
                return c.json({ success: false, error }, 500);
              }
            }
          }

          const summary = await deployAll(componentDeployOptions, [
            componentName as WorkerComponent,
          ]);
          const result = summary.results.find((candidate) => candidate.component === componentName);

          if (summary.failedCount === 0 && result?.success) {
            if (!dryRun) {
              if (!result.deployedAt || !result.cloudflareVersionId) {
                throw new Error(`worker_deployment_exact_version_unavailable:${componentName}`);
              }
              const visibility = await waitForWorkerDeploymentsReady({
                targets: [
                  {
                    workerName: result.workerName,
                    deployedAt: result.deployedAt,
                    expectedVersionId: result.cloudflareVersionId,
                  },
                ],
                onProgress: addProgress,
              });
              if (!visibility.ready) {
                throw new Error(
                  `Worker deployment did not become visible: ${visibility.error ?? 'unknown error'}`
                );
              }
              const workersSubdomain = await getWorkersSubdomain();
              const httpTargets = buildWorkerHttpReadinessTargets([result], workersSubdomain, {
                workersDevEnabled: !cfg?.urls?.api?.custom,
              });
              if (httpTargets.length > 0) {
                const httpReadiness = await waitForWorkerHttpReady({
                  targets: httpTargets,
                  onProgress: addProgress,
                });
                if (!httpReadiness.ready) {
                  throw new Error(
                    `Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
                  );
                }
              }
              if (componentName === 'ar-router') {
                const routerReadiness = await waitForRouterWorkerReady({
                  apiBaseUrl: resolveIssuerUrl(cfg, { env }),
                  onProgress: addProgress,
                  onDetail: addDetailProgress,
                });
                if (!routerReadiness.ready) {
                  handleRouterReadinessFailure(
                    cfg,
                    routerReadiness.checkedUrl,
                    routerReadiness.error,
                    addProgress
                  );
                }
              }

              if (!componentLock || !componentLockPath) {
                throw new Error('worker_deployment_lock_unavailable');
              }
              await saveLockFile(
                updateLockWithDeployments(componentLock, summary.results),
                componentLockPath
              );
              addProgress('Lock file updated');

              await maybeConfigureDownstreamIntrospectionForWebDeploy({
                env,
                rootDir,
                config: cfg,
                components: [componentName],
                dryRun,
                deployConfigLockProof: deployConfigLock?.proof,
              });
            }
            state.status = 'complete';
            addProgress(`✓ ${componentName} deployed successfully`);
            return c.json({
              success: true,
              component: componentName,
              type: 'worker',
              workerName: result.workerName,
              deployedAt: result.deployedAt,
              version: result.version,
              logPath: state.logPath,
            });
          } else {
            const error = markOperationError(result?.error || 'dependency deployment failed');
            return c.json(
              {
                success: false,
                component: componentName,
                type: 'worker',
                error,
              },
              500
            );
          }
        }
      } catch (error) {
        const sanitizedError = markOperationError(sanitizeError(error));
        return c.json({ success: false, error: sanitizedError, logPath: state.logPath }, 500);
      } finally {
        await flushProgressLog();
        try {
          await deployConfigLock?.release();
        } finally {
          await operationLock?.release();
        }
      }
    });
  });

  // Get list of all deployable components
  api.get('/components', async (c) => {
    const { WORKER_COMPONENTS } = await import('../core/naming.js');
    const { UI_WORKER_COMPONENTS } = await import('../core/deploy.js');

    return c.json({
      workers: WORKER_COMPONENTS,
      uiWorkers: UI_WORKER_COMPONENTS,
      all: [...WORKER_COMPONENTS, ...UI_WORKER_COMPONENTS],
    });
  });

  // =============================================================================
  // D1 Migration Management
  // =============================================================================

  // Apply session validation to migrations
  api.use('/migrations/*', validateSession);

  api.get('/migrations/status/:env', async (c) => {
    try {
      const envParam = c.req.param('env');
      const parseResult = EnvNameSchema.safeParse(envParam);
      if (!parseResult.success) {
        return c.json({ success: false, error: 'Invalid environment name' }, 400);
      }

      const env = parseResult.data;
      const rootDir = process.cwd();
      const { lock } = await loadLockFileAuto(rootDir, env);
      if (!lock) return c.json({ success: false, error: `Environment "${env}" not found.` }, 404);
      assertFixedD1ResourceIdentities({
        environment: env,
        lock,
        databases: await listD1Databases(),
      });
      const migrationDatabaseIdentifiers = {
        core: lock.d1.DB?.id,
        pii: lock.d1.DB_PII?.id,
        admin: lock.d1.DB_ADMIN?.id,
      };
      if (
        !migrationDatabaseIdentifiers.core ||
        !migrationDatabaseIdentifiers.pii ||
        !migrationDatabaseIdentifiers.admin
      ) {
        throw new Error('fixed_migration_databases_required');
      }
      const productVersion = await getRootProductVersion(rootDir);
      const migrationsRoot = await findMigrationsRoot(rootDir, undefined, { strictRoot: true });
      if (!migrationsRoot.path) throw new Error('Migrations directory not found.');
      const installedRelease =
        !lock.productVersion && Object.keys(lock.workers ?? {}).length === 0
          ? loadTargetReleaseMigrationManifest({
              migrationsRoot: migrationsRoot.path,
              productVersion,
              allowDraft: true,
            })
          : loadInstalledReleaseMigrationManifest({
              migrationsRoot: migrationsRoot.path,
              productVersion,
              lock,
            });
      const result = await getD1MigrationStatusForEnvironment(env, rootDir, undefined, {
        productVersion,
        allowDraft: installedRelease.draft,
        databaseIdentifiers: migrationDatabaseIdentifiers,
        strictMigrationsRoot: true,
      });
      return c.json({ ...result, success: result.success });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  api.post('/migrations/apply', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const bodyResult = z
          .object({
            env: EnvNameSchema,
            role: z.enum(['core', 'pii', 'admin']).optional(),
            filenames: z
              .array(z.string().regex(/^[0-9]{3}_[a-z0-9_]+\.sql$/u))
              .max(256)
              .optional(),
          })
          .strict()
          .safeParse(await c.req.json());
        if (!bodyResult.success) {
          return c.json({ success: false, error: 'Invalid migration request' }, 400);
        }
        const { env, role, filenames: safeFilenames } = bodyResult.data;
        const rootDir = process.cwd();
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: rootDir,
          env,
          operation: 'web-d1-migration-selection',
        });
        const lock = operationLock.lock;
        if (!lock) {
          return c.json({ success: false, error: `Environment "${env}" not found.` }, 404);
        }
        const targetProductVersion = await getRootProductVersion(rootDir);
        const deploymentGuard = evaluateReleaseDeploymentGuard(
          lock,
          targetProductVersion,
          'manual_migration'
        );
        if (!deploymentGuard.allowed) {
          return c.json(
            {
              success: false,
              error: releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }

        assertFixedD1ResourceIdentities({
          environment: env,
          lock,
          databases: await listD1Databases(),
        });
        const migrationDatabaseIdentifiers = {
          core: lock.d1.DB?.id,
          pii: lock.d1.DB_PII?.id,
          admin: lock.d1.DB_ADMIN?.id,
        };
        if (
          !migrationDatabaseIdentifiers.core ||
          !migrationDatabaseIdentifiers.pii ||
          !migrationDatabaseIdentifiers.admin
        ) {
          throw new Error('fixed_migration_databases_required');
        }

        state.status = 'deploying';
        state.error = null;
        clearProgress();
        state.logPath = await beginProgressLog(env, 'update');
        addProgress(`📜 Applying database migrations for environment: ${env}`);
        const migrationsRoot = await findMigrationsRoot(rootDir, addProgress, {
          strictRoot: true,
        });
        if (!migrationsRoot.path) throw new Error('Migrations directory not found.');
        const installedRelease = loadInstalledReleaseMigrationManifest({
          migrationsRoot: migrationsRoot.path,
          productVersion: targetProductVersion,
          lock,
        });
        const result = await runD1MigrationsForEnvironmentSelection({
          env,
          rootDir,
          role,
          filenames: safeFilenames,
          onProgress: addProgress,
          release: {
            productVersion: targetProductVersion,
            allowDraft: installedRelease.draft,
            databaseIdentifiers: migrationDatabaseIdentifiers,
            strictMigrationsRoot: true,
          },
        });

        if (result.success) {
          state.status = 'complete';
          addProgress('✅ Database migrations completed successfully');
        } else {
          state.status = 'error';
          state.error = 'Database migrations failed';
          addProgress('❌ Database migrations failed');
        }

        return c.json({
          ...result,
          success: result.success,
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        const sanitizedError = markOperationError(sanitizeError(error));
        return c.json({ success: false, error: sanitizedError, logPath: state.logPath }, 500);
      } finally {
        await flushProgressLog();
        await operationLock?.release();
      }
    });
  });

  // Run D1 migrations for an environment
  api.post('/migrations/run', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const bodyResult = z
          .object({ env: EnvNameSchema })
          .strict()
          .safeParse(await c.req.json());
        if (!bodyResult.success) {
          return c.json({ success: false, error: 'Invalid migration request' }, 400);
        }
        const env = bodyResult.data.env;
        const resolvedRootDir = findAuthrimBaseDir(process.cwd());
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: resolvedRootDir,
          env,
          operation: 'web-d1-migration',
        });
        const lock = operationLock.lock;
        if (!lock) {
          return c.json({ success: false, error: `Environment "${env}" not found.` }, 404);
        }
        const targetProductVersion = await getRootProductVersion(resolvedRootDir);
        const deploymentGuard = evaluateReleaseDeploymentGuard(
          lock,
          targetProductVersion,
          'manual_migration'
        );
        if (!deploymentGuard.allowed) {
          return c.json(
            {
              success: false,
              error: releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion),
              requiredCommand: `authrim-setup update --env ${env}`,
            },
            409
          );
        }
        assertFixedD1ResourceIdentities({
          environment: env,
          lock,
          databases: await listD1Databases(),
        });
        const migrationDatabaseIdentifiers = {
          core: lock.d1.DB?.id,
          pii: lock.d1.DB_PII?.id,
          admin: lock.d1.DB_ADMIN?.id,
        };
        if (
          !migrationDatabaseIdentifiers.core ||
          !migrationDatabaseIdentifiers.pii ||
          !migrationDatabaseIdentifiers.admin
        ) {
          throw new Error('fixed_migration_databases_required');
        }

        state.status = 'deploying';
        state.error = null;
        clearProgress();
        state.logPath = await beginProgressLog(env, 'update');
        addProgress(`📜 Running D1 migrations for environment: ${env}`);
        const migrationsRoot = await findMigrationsRoot(resolvedRootDir, addProgress, {
          strictRoot: true,
        });
        if (!migrationsRoot.path) throw new Error('Migrations directory not found.');
        const installedRelease = loadInstalledReleaseMigrationManifest({
          migrationsRoot: migrationsRoot.path,
          productVersion: targetProductVersion,
          lock,
        });
        const result = await runMigrationsForEnvironment(env, resolvedRootDir, addProgress, {
          productVersion: targetProductVersion,
          allowDraft: installedRelease.draft,
          databaseIdentifiers: migrationDatabaseIdentifiers,
          strictMigrationsRoot: true,
        });

        if (result.success) {
          state.status = 'complete';
          addProgress('✅ All migrations completed successfully');
        } else {
          state.status = 'error';
          state.error = 'Some migrations failed';
          addProgress('❌ Some migrations failed');
        }

        return c.json({
          success: result.success,
          core: result.core,
          pii: result.pii,
          admin: result.admin,
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        const sanitizedError = markOperationError(sanitizeError(error));
        return c.json({ success: false, error: sanitizedError, logPath: state.logPath }, 500);
      } finally {
        await flushProgressLog();
        await operationLock?.release();
      }
    });
  });

  return api;
}
