/**
 * API Routes for Authrim Setup Web UI
 *
 * Provides REST API endpoints for the setup wizard.
 *
 * Security Notes:
 * - This API is designed to be accessed from localhost only
 * - A session token is generated on server start to prevent unauthorized access
 * - Operations are serialized to prevent race conditions
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
  detectEnvironments,
  deleteEnvironment,
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
  hasControlManagedResourcesForEnvironment,
  type CloudflareAuth,
  findMigrationsRoot,
  getAccountId,
  getCloudflareApiToken,
} from '../core/cloudflare.js';
import { isWildcardDnsPermissionError } from '../core/wildcard-dns-manual-action.js';
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
  acquireEnvironmentOperationForEnvironment,
  createLockFile,
  loadLockFileAuto,
  mergeLockFiles,
  saveLockFile,
} from '../core/lock.js';
import {
  getEnvironmentPaths,
  getExternalKeysDir,
  findKeysDirectory,
  resolvePaths,
  listEnvironments,
  findAuthrimBaseDir,
  findLegacyConfigPath,
  AUTHRIM_DIR,
  type EnvironmentPaths,
  type LegacyPaths,
} from '../core/paths.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';
import { saveMasterWranglerConfigs, syncWranglerConfigs } from '../core/wrangler-sync.js';
import { buildWorkerDeploymentResourceIds } from '../core/deployment-resource-ids.js';
import { refreshWorkerDeploymentArtifacts } from '../core/worker-deployment-artifacts.js';
import { cleanupLocalEnvironmentArtifacts } from '../core/environment-cleanup.js';
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
  reconcileInitialBootstrapHandoffAsOperator,
  recordInitialBootstrapWorkerEvidence,
  registerInitialControlTopology,
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
  type UiWorkerComponent,
} from '../core/deploy.js';
import { getEnabledComponents, WORKER_COMPONENTS, type WorkerComponent } from '../core/naming.js';
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
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from '../core/environment-operation-policy.js';
import { hasDatabaseTopologyChange } from '../core/environment-config-policy.js';
import {
  calculateReleaseManifestChecksum,
  loadInstalledReleaseMigrationManifest,
  loadTargetReleaseMigrationManifest,
  resolveReleaseMigrationTargets,
} from '../core/release-migrations.js';
import {
  applyReleaseSchemaUpdatePlan,
  buildReleaseSchemaUpdatePlan,
} from '../core/release-update.js';
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
import { getMissingRequiredDeploySecrets } from '../core/secrets.js';
import {
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
  resolveControlTokenResourceClasses,
} from '../core/control-token-bootstrap-orchestrator.js';
import {
  isTokenlessPendingControlProvisioningAuthority,
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
} from '../core/control-provisioning-authority.js';
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
import { withEphemeralSetupMachineAccess } from '../core/setup-machine-access-lifecycle.js';
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
  resolveDownstreamIntrospectionKeysDir,
} from '../core/downstream-introspection-deploy.js';
import { appendFile, writeFile, chmod, mkdir } from 'node:fs/promises';
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

// =============================================================================
// Operation Lock (prevents concurrent state mutations)
// =============================================================================

let operationLock: Promise<void> = Promise.resolve();

/**
 * Acquire operation lock to serialize state mutations
 */
async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  const previousOperation = operationLock;
  let releaseLock!: () => void;
  operationLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  await previousOperation;

  try {
    return await operation();
  } finally {
    releaseLock();
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
};

let progressLogState: ProgressLogState | null = null;

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
    const baseName = `${formatLogTimestamp()}-${operation}`;
    const filePath = join(logsDir, `${baseName}.log`);
    const detailFilePath = join(logsDir, `${baseName}.detail.log`);
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
  await writeFile(envPaths.config, JSON.stringify(config, null, 2));
}

async function saveEmailBootstrapFiles(
  envPaths: EnvironmentPaths,
  options: {
    provider: 'cloudflare' | 'resend' | 'sendgrid' | 'ses';
    fromAddress: string;
    fromName?: string;
    apiKey?: string;
  }
): Promise<void> {
  await mkdir(envPaths.keys, { recursive: true, mode: 0o700 });

  await writeFile(envPaths.keyFiles.emailFrom, options.fromAddress.trim());
  await chmod(envPaths.keyFiles.emailFrom, 0o600);

  const emailFromNamePath = join(envPaths.keys, 'email_from_name.txt');
  const normalizedFromName = options.fromName?.trim();
  if (normalizedFromName) {
    await writeFile(emailFromNamePath, normalizedFromName);
    await chmod(emailFromNamePath, 0o600);
  } else if (existsSync(emailFromNamePath)) {
    await writeFile(emailFromNamePath, '');
    await chmod(emailFromNamePath, 0o600);
  }

  if (options.provider === 'resend' && options.apiKey?.trim()) {
    await writeFile(envPaths.keyFiles.resendApiKey, options.apiKey.trim());
    await chmod(envPaths.keyFiles.resendApiKey, 0o600);
  }
}

function resolveWebDeploymentKeysDir(rootDir: string, env: string): string {
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
  keysDir: string;
  workers: WorkerComponent[];
}): Promise<Record<string, string>> {
  const { env, keysDir, workers } = options;
  if (!existsSync(keysDir)) {
    addProgress(`Warning: Keys directory not found at ${keysDir}`);
    return {};
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
  dryRun?: boolean;
}): Promise<void> {
  const { env, rootDir, config, components, dryRun } = options;
  if (dryRun || !components.includes('ar-userinfo')) {
    return;
  }

  const keysDir = resolveWebDeploymentKeysDir(rootDir, env);
  const downstreamSetupResult = await configureDownstreamIntrospectionDeployment({
    env,
    rootDir,
    keysDir,
    apiBaseUrl: resolveIssuerUrl(config, { env }),
    apiBaseUrls: resolveApiBaseUrlCandidates(config, { env, purpose: 'tenant-scoped-admin' }),
    tenantId: config?.tenant?.name,
    dryRun,
    onProgress: addProgress,
  });

  if (!downstreamSetupResult.success) {
    addProgress(
      `⚠️ Downstream introspection client setup skipped: ${downstreamSetupResult.error ?? 'Unknown error'}`
    );
    for (const error of downstreamSetupResult.secretUploadErrors ?? []) {
      addProgress(`⚠️ ${error}`);
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

// =============================================================================
// API Routes
// =============================================================================

export function createApiRoutes(): Hono {
  const api = new Hono();

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
      const controlDatabaseName = lock?.d1.CONTROL_DB?.name;
      const authority = controlDatabaseName
        ? await readControlProvisioningAuthority({
            controlDatabaseName,
            environmentId: parsed.data,
          })
        : null;
      const requiredResourceClasses = resolveControlTokenResourceClasses(config);
      const missingResourceClasses =
        authority?.automaticProvisioningEnabled === true && authority.capabilityState === 'ready'
          ? await findMissingControlTokenResourceClasses({
              resourceClasses: requiredResourceClasses,
              secretSink: new WranglerControlSecretSink({
                workerName: `${parsed.data}-ar-control`,
                cwd: baseDir,
              }),
            })
          : [];
      const effectiveAuthority =
        authority && missingResourceClasses.length > 0
          ? { ...authority, capabilityState: 'blocked' as const }
          : authority;
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
        const controlDatabaseName = operationLock.lock?.d1.CONTROL_DB?.name;
        if (!controlDatabaseName) {
          return c.json({ success: false, error: 'Control database is not configured' }, 409);
        }
        const updatedConfig = AuthrimConfigSchema.parse({
          ...config,
          controlPlane: { automaticProvisioning: true },
          updatedAt: new Date().toISOString(),
        });
        await saveEnvironmentConfig(envPaths, updatedConfig);
        try {
          await writeControlProvisioningAuthority({
            controlDatabaseName,
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
        const controlDatabaseName = operationLock.lock?.d1.CONTROL_DB?.name;
        if (!controlDatabaseName) {
          return c.json({ success: false, error: 'Control database is not configured' }, 409);
        }
        const authority = await readControlProvisioningAuthority({
          controlDatabaseName,
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
            controlDatabaseName,
            environmentId: parsed.data.env,
            automaticProvisioningEnabled: false,
            tokenOwnership: 'none',
            capabilityState: 'disabled',
          });
          state.config = disabledConfig;
          return c.json({ success: true, enabled: false, authority: disabledAuthority });
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
        bootstrapToken: z.string().min(20).max(4096).regex(/^\S+$/u),
        ownership: z.enum(['account', 'user']).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid bootstrap token input' }, 400);
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
        const controlDatabaseName = lock?.d1.CONTROL_DB?.name;
        const controlWorker = lock?.workers?.['ar-control'];
        if (!controlDatabaseName || !controlWorker) {
          return c.json(
            { success: false, error: 'Control Worker deployment is not available' },
            409
          );
        }
        const pendingAuthority = await readControlProvisioningAuthority({
          controlDatabaseName,
          environmentId: parsed.data.env,
        });
        const deployedAt = controlWorker.deployedAt
          ? Date.parse(controlWorker.deployedAt)
          : Number.NaN;
        if (
          pendingAuthority?.automaticProvisioningEnabled !== true ||
          pendingAuthority.capabilityState !== 'pending' ||
          pendingAuthority.tokenOwnership !== 'none' ||
          !Number.isFinite(deployedAt) ||
          deployedAt <= pendingAuthority.updatedAt * 1000
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

        const detectedOwnership = await detectCloudflareTokenOwnership({
          accountId: wranglerAccountId,
          token: bootstrapToken,
        });
        if (!detectedOwnership) {
          throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_inactive');
        }
        if (parsed.data.ownership && parsed.data.ownership !== detectedOwnership) {
          throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_ownership_mismatch');
        }

        await completeControlTokenBootstrap({
          accountId: wranglerAccountId,
          environment: parsed.data.env,
          rootDir: baseDir,
          controlDatabaseName,
          bootstrapToken,
          ownership: detectedOwnership,
          resourceClasses: resolveControlTokenResourceClasses(config),
        });
        bootstrapToken = '';
        const authority = await readControlProvisioningAuthority({
          controlDatabaseName,
          environmentId: parsed.data.env,
        });
        if (
          authority?.automaticProvisioningEnabled !== true ||
          authority.capabilityState !== 'ready' ||
          authority.tokenOwnership !== detectedOwnership
        ) {
          throw new Error('control_provisioning_authority_reflection_failed');
        }
        return c.json({ success: true, authority });
      } catch (error) {
        return c.json(
          {
            success: false,
            error: sanitizeError(error),
            cleanupRequired:
              error instanceof CloudflareTokenBootstrapError && error.cleanupRequired,
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
      try {
        const baseDir = findAuthrimBaseDir(process.cwd());
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
          return c.json({ success: true, revoked: true });
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
        await writeFile(configPath, JSON.stringify(config, null, 2));
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
        const keysBaseDir = process.cwd();
        const baseDir = findAuthrimBaseDir(keysBaseDir);
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env: envName,
          operation: 'web-key-generation',
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
              requiredCommand: `authrim-setup update --env ${envName}`,
            },
            409
          );
        }

        addProgress('Generating cryptographic keys...');
        const secrets = generateAllSecrets(keyId);

        // Save to external keys directory: {cwd}/.authrim-keys/{env}/
        const externalKeysDir = getExternalKeysDir(envName, keysBaseDir);
        addProgress(`Saving keys to directory: ${externalKeysDir}/`);
        await saveKeysToDirectory(secrets, { keysBaseDir, env: envName });

        addProgress('Keys generated successfully');

        // Only return public information
        return c.json({
          success: true,
          keyId: secrets.keyPair.keyId,
          publicKeyJwk: secrets.keyPair.publicKeyJwk,
          keysPath: externalKeysDir,
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

        // Save secrets to external keys directory: {cwd}/.authrim-keys/{env}/
        const keysBaseDir = process.cwd();
        const keysDir = getExternalKeysDir(env, keysBaseDir);
        const baseDir = findAuthrimBaseDir(keysBaseDir);
        const envPaths = getEnvironmentPaths({ baseDir, env, keysBaseDir });
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

        // Ensure directory exists with restrictive permissions
        await mkdir(keysDir, { recursive: true, mode: 0o700 });
        await saveEmailBootstrapFiles(envPaths, {
          provider,
          fromAddress,
          fromName,
          apiKey,
        });

        const emailConfig = {
          provider,
          fromAddress: fromAddress.trim(),
          fromName: fromName?.trim() || undefined,
          configured: true,
        };

        if (existsSync(envPaths.config)) {
          const currentConfig = parseEnvironmentConfigForEnv(
            JSON.parse(await readFile(envPaths.config, 'utf-8')),
            env
          );
          const updatedConfig = AuthrimConfigSchema.parse({
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
          await saveEnvironmentConfig(envPaths, updatedConfig);
          state.config = updatedConfig;
          addProgress(`Updated config: ${envPaths.config}`);
        } else {
          const stateConfig = getStateConfigForEnv(env);
          if (!stateConfig) {
            return c.json(
              {
                success: false,
                error: `Config file not found for environment "${env}"`,
              },
              404
            );
          }
          const defaultFeatures = createDefaultConfig(env).features;
          state.config = {
            ...stateConfig,
            features: {
              queue: stateConfig.features?.queue ?? defaultFeatures.queue,
              r2: stateConfig.features?.r2 ?? defaultFeatures.r2,
              pluginDynamicWorkers:
                stateConfig.features?.pluginDynamicWorkers ?? defaultFeatures.pluginDynamicWorkers,
              email: {
                ...stateConfig.features?.email,
                ...emailConfig,
              },
            },
          };
        }

        if (provider === 'resend' && apiKey) {
          addProgress(`Saved ${provider} API key to ${envPaths.keyFiles.resendApiKey}`);
        }
        addProgress(`Saved email from address to ${envPaths.keyFiles.emailFrom}`);
        if (fromName) {
          addProgress(`Saved email from name to ${join(keysDir, 'email_from_name.txt')}`);
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
        await writeFile(envPaths.config, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');
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

        const visibility = await waitForWorkerDeploymentsReady({
          targets: [{ workerName: deployResult.workerName, deployedAt: deployResult.deployedAt }],
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

        const packageVersion = await getPackageVersion(join(baseDir, 'packages', 'ar-router'));
        await saveLockFile(
          {
            ...lock,
            workers: {
              ...lock.workers,
              'ar-router': {
                name: deployResult.workerName,
                deployedAt: deployResult.deployedAt,
                version: packageVersion ?? deployResult.version,
              },
            },
            updatedAt: new Date().toISOString(),
          },
          lockPath
        );
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
        await operationLock?.release();
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

        await saveEnvironmentConfig(envPaths, updatedConfig);
        addProgress(`Updated config: ${envPaths.config}`);

        await saveEmailBootstrapFiles(envPaths, {
          provider: 'cloudflare',
          fromAddress,
          fromName,
        });
        addProgress(`Saved email bootstrap files to ${envPaths.keys}`);

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
        const updatedLock = updateLockWithDeployments(lock, deployResults);
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
        await operationLock?.release();
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
        const provisionDecision = evaluateEnvironmentOperation({
          operation: 'provision',
          lock: operationLock.lock,
        });
        if (!provisionDecision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(provisionDecision),
            },
            409
          );
        }

        state.status = 'provisioning';
        state.error = null;
        state.logPath = await beginProgressLog(env, 'provision');
        clearProgress();

        addProgress(`Provisioning Cloudflare resources for ${env}...`);

        if (
          databaseConfig ||
          createQueues !== undefined ||
          createR2 !== undefined ||
          automaticProvisioning !== undefined
        ) {
          const baseConfig = getStateConfigForEnv(env) ?? createDefaultConfig(env);
          state.config = AuthrimConfigSchema.parse({
            ...baseConfig,
            database: databaseConfig
              ? { ...baseConfig.database, ...databaseConfig }
              : baseConfig.database,
            features: {
              ...baseConfig.features,
              queue: {
                enabled:
                  createQueues === undefined
                    ? baseConfig.features?.queue?.enabled === true
                    : createQueues === true,
              },
              r2: {
                enabled:
                  createR2 === undefined
                    ? baseConfig.features?.r2?.enabled === true
                    : createR2 === true,
              },
            },
            controlPlane: {
              automaticProvisioning:
                automaticProvisioning === undefined
                  ? baseConfig.controlPlane?.automaticProvisioning === true
                  : automaticProvisioning,
            },
          });
        }

        const resources = await provisionResources({
          env,
          createD1: true,
          createKV: true,
          createQueues: createQueues || false,
          createR2: createR2 || false,
          onProgress: addProgress,
          databaseConfig,
        });

        addProgress('Creating lock file...');
        const lock = createLockFile(env, resources);
        addProgress(`Saving lock.json to ${envPaths.lock} ...`);
        await saveLockFile(lock, { env, baseDir: rootDir });

        // Save config.json
        addProgress('Saving config.json...');
        // Use existing state.config if available (from /config/default), otherwise create new
        // Merge with default config to ensure all required fields are present
        const baseConfig = createDefaultConfig(env);
        const stateConfig = getStateConfigForEnv(env);
        const config = stateConfig
          ? {
              ...baseConfig,
              ...stateConfig,
              // Preserve components from state.config
              components: { ...baseConfig.components, ...stateConfig.components },
            }
          : baseConfig;
        config.createdAt = new Date().toISOString();
        config.updatedAt = new Date().toISOString();
        const wranglerAccountId = await getAccountId();
        if (!wranglerAccountId) throw new Error('cloudflare_account_id_required_for_provisioning');
        if (config.cloudflare?.accountId && config.cloudflare.accountId !== wranglerAccountId) {
          throw new Error('cloudflare_config_account_id_mismatch');
        }
        config.cloudflare = { accountId: wranglerAccountId };

        // The Web UI generates the key archive in a separate step. Keep the key ID in the
        // environment config as well, so a first Web deployment can configure the Control
        // Worker's SMOKE_RPC_SIGNING_ACTIVE_KID before it starts reconciling bindings.
        const generatedKeys = await loadKeysFromDirectory({
          baseDir: rootDir,
          env,
          keysBaseDir: process.cwd(),
        });
        if (!config.keys.keyId && generatedKeys.keyPair?.keyId) {
          config.keys = {
            ...config.keys,
            keyId: generatedKeys.keyPair.keyId,
            ...(generatedKeys.keyPair.publicKeyJwk
              ? { publicKeyJwk: generatedKeys.keyPair.publicKeyJwk as Record<string, unknown> }
              : {}),
          };
          addProgress(`Loaded generated key metadata: ${generatedKeys.keyPair.keyId}`);
        }

        // Get workers subdomain and set auto-detected URLs
        const workersSubdomain = await getWorkersSubdomain();
        // Always set URLs - use workersSubdomain if available, otherwise use default workers.dev pattern
        const apiUrl = workersSubdomain
          ? `https://${env}-ar-router.${workersSubdomain}.workers.dev`
          : `https://${env}-ar-router.workers.dev`;

        config.urls = buildUrlsConfig({
          env,
          apiDomain: config.urls?.api?.custom || null,
          loginUiDomain: config.urls?.loginUi?.custom || null,
          adminUiDomain: config.urls?.adminUi?.custom || null,
          zoneId: config.urls?.api?.zoneId ?? null,
          customDomainBinding: config.urls?.api?.customDomainBinding ?? false,
          workersSubdomain,
          existingUrls: {
            api: {
              ...config.urls?.api,
              auto: apiUrl,
            },
            loginUi: config.urls?.loginUi,
            adminUi: config.urls?.adminUi,
          },
        });
        addProgress(`Configured URLs: API=${apiUrl}`);

        // Explicitly ensure directory exists (defense in depth; saveLockFile also creates it)
        await mkdir(dirname(envPaths.config), { recursive: true });
        addProgress(`Saving config.json to ${envPaths.config} ...`);
        await writeFile(envPaths.config, JSON.stringify(config, null, 2), 'utf-8');
        const initialUiEnv = buildInitialUiEnvConfig(config);
        if (initialUiEnv) {
          await saveUiEnv(envPaths.uiEnv, initialUiEnv);
        }
        state.config = config;

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

        state.status = 'configuring';
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
        await operationLock?.release();
      }
    });
  });

  // Generate wrangler configs (with lock)
  api.post('/wrangler/generate', async (c) => {
    return withLock(async () => {
      let operationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const body = await c.req.json();
        const parseResult = EnvNameSchema.safeParse(body?.env);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const { rootDir = '.' } = body;
        const env = parseResult.data;

        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir: rootDir,
          env,
          operation: 'web-wrangler-generation',
          requireExisting: true,
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

        // Load config
        let config: AuthrimConfig;
        const stateConfig = getStateConfigForEnv(env);
        if (stateConfig) {
          config = AuthrimConfigSchema.parse(stateConfig);
        } else {
          config = createDefaultConfig(env);
        }

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

        const generatedComponents: string[] = [];
        for (const component of enabledComponents) {
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
          // Generate TOML with [env.{env}] section format
          const tomlContent = toToml(wranglerConfig, env);
          const tomlPath = join(componentDir, 'wrangler.toml');
          await writeFile(tomlPath, tomlContent, 'utf-8');
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
            await writeFile(
              join(componentDir, 'wrangler.bootstrap.toml'),
              toToml(bootstrapConfig, env),
              'utf-8'
            );
          }
          generatedComponents.push(component);
        }

        addProgress('Wrangler configs generated!');

        return c.json({
          success: true,
          components: generatedComponents,
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // Deploy (with lock - long-running operation)
  api.post('/deploy', async (c) => {
    return withLock(async () => {
      let cleanupEnv: string | undefined;
      let cleanupKeysDir: string | undefined;
      let bootstrapToken = '';
      let bootstrapOwnership: CloudflareTokenOwnership | null = null;
      let environmentOperationLock:
        | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
        | undefined;
      try {
        const bodyResult = z
          .object({
            env: EnvNameSchema,
            rootDir: z.string().min(1).max(4096).optional(),
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
          rootDir = process.cwd(),
          dryRun = false,
          components: requestedComponents,
          skipBuild = false,
          runMigrations = true,
          externalSchemaReady = false,
        } = body;
        const env = body.env;
        const resolvedRootDir = resolve(rootDir);
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
        const migrationRootResult = await findMigrationsRoot(resolvedRootDir, addProgress);
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
        const initialDeploymentGuard = evaluateReleaseDeploymentGuard(
          existingDeploymentLock,
          productVersion,
          'initial_deploy',
          { releaseManifestChecksum: initialManifestChecksum }
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
        clearProgress();

        // Debug: Log the resolved rootDir for migrations
        addProgress(`📂 Working directory: ${resolvedRootDir}`);

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
        const automaticProvisioning = releaseConfig.controlPlane?.automaticProvisioning === true;
        if (automaticProvisioning !== Boolean(bootstrapToken && bootstrapOwnership)) {
          return c.json(
            {
              success: false,
              error: automaticProvisioning
                ? 'Automatic provisioning requires one bootstrap token'
                : 'Bootstrap token input is not allowed when Automatic provisioning is off',
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
            return c.json({ success: false, error: 'Invalid initial deployment components.' }, 400);
          }
          const requested = [...new Set(requestedComponents)].sort();
          const required = [...enabledComponents].sort();
          if (JSON.stringify(requested) !== JSON.stringify(required)) {
            return c.json(
              {
                success: false,
                error: 'Initial deployment must include every enabled Worker component.',
                requiredComponents: required,
              },
              409
            );
          }
        }
        const cfg = releaseConfig;

        // Validate the locked environment and complete component set before doing build work.
        if (!dryRun && !skipBuild) {
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

        const initialTargets = resolveReleaseMigrationTargets({
          lock: existingDeploymentLock,
          config: releaseConfig,
        });
        const missingStreamTargets = initialTargets.filter((target) => !target.streamId);
        if (missingStreamTargets.length > 0) {
          return c.json(
            {
              success: false,
              error: `No release migration stream exists for: ${missingStreamTargets
                .map((target) => target.connectionRef ?? target.id)
                .join(', ')}`,
            },
            400
          );
        }
        const initialManualTargetIds = new Set(
          initialTargets.filter((target) => !target.automatic).map((target) => target.id)
        );
        if (initialManualTargetIds.size > 0 && externalSchemaReady !== true && !dryRun) {
          return c.json(
            {
              success: false,
              error: 'External database migrations must be verified before initial deployment.',
            },
            409
          );
        }

        let keysDir: string;
        const foundKeys = findKeysDirectory({
          env,
          sourceDir: baseDir,
          keysBaseDir: process.cwd(),
        });
        if (foundKeys) {
          keysDir = foundKeys.path;
        } else if (resolved.type === 'new') {
          keysDir = (resolved.paths as EnvironmentPaths).keys;
        } else {
          keysDir = (resolved.paths as LegacyPaths).keys;
        }
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
            ['ar-control'],
            { automaticProvisioning: automaticProvisioning && !bootstrapToken }
          );
          if (missingControlSecrets.length > 0) {
            return c.json(
              {
                success: false,
                error: `Missing required Control Worker secrets: ${missingControlSecrets.join(', ')}`,
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
          let releaseLock = withReleaseUpdateState(existingDeploymentLock, {
            targetVersion: productVersion,
            phase: 'planned',
            manifestChecksum: initialManifestChecksum,
            manualTargets: [...initialManualTargetIds],
          });
          await saveLockFile(releaseLock, initialLockPath);
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
            state.status = 'error';
            state.error = 'Database migration failed before Worker deployment.';
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
            const publication = await publishAndActivateMigrationRelease({
              migrationsRoot: migrationRootResult.path,
              manifestPath: initialRelease.path,
              bucketName: migrationReleaseBucket.name,
              controlDatabaseId: controlDatabase.id,
              environmentId: env,
              actorId: 'setup:web-deploy',
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
              controlDatabaseName: controlDatabase.name,
              environmentId: env,
            });
            if (!keyState) throw new Error('control_generated_key_state_missing');
            const stagedSigningKeys = await loadControlStagedSigningKeys({
              controlDatabaseName: controlDatabase.name,
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

            for (const component of enabledForValidation) {
              const componentDir = join(resolve(rootDir), 'packages', component);
              if (!existsSync(componentDir)) {
                continue;
              }

              const wranglerConfig = generateWranglerConfig(
                component,
                config,
                lockResourceIds,
                workersSubdomain ?? undefined
              );
              const tomlContent = toToml(wranglerConfig, env);
              const tomlPath = join(componentDir, 'wrangler.toml');
              await writeFile(tomlPath, tomlContent, 'utf-8');
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
                await writeFile(
                  join(componentDir, 'wrangler.bootstrap.toml'),
                  toToml(bootstrapConfig, env),
                  'utf-8'
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
              controlDatabaseName: controlDatabase.name,
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
              controlDatabaseName: controlDatabase.name,
              lock,
              release: initialRelease.manifest,
              releaseDraft: initialRelease.draft,
              automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
              placementPolicy: config.tenant.placementPolicy,
            });
            const externalSources = await discoverExternalCapabilities({
              baseDir: resolvedRootDir,
            });
            await publishDynamicPluginWorkerBundles({
              baseDir: resolvedRootDir,
              enabled: config.features.pluginDynamicWorkers.enabled,
              sources: externalSources,
              bucketName: lock.r2?.PLUGIN_BUNDLES?.name,
              pluginRunnerDatabaseName: lock.d1?.PLUGIN_RUNNER_DB?.name,
              onProgress: addProgress,
            });
            await registerExternalCapabilities({
              controlDatabaseName: controlDatabase.name,
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
            await ensureWildcardDnsForMultiTenant(cfg, addProgress);
          } catch (error) {
            const manualAction = getWildcardDnsManualActionPayload(cfg);
            if (manualAction && isWildcardDnsPermissionError(error)) {
              state.status = 'error';
              state.error = 'Manual wildcard DNS setup required';
              addProgress('⚠️ Automatic wildcard DNS setup is unavailable.');
              addProgress('⚠️ Create the wildcard DNS record manually, then rerun deploy.');
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

        const { lock: deploymentLock } = await loadLockFileAuto(rootDir, env);
        let existingComponents = WORKER_COMPONENTS.filter(
          (component) => deploymentLock?.workers?.[component] !== undefined
        );
        const remoteProbeOptions = {
          env,
          rootDir: resolve(rootDir),
          dryRun,
          concurrency: 2,
          existingComponents,
          onProgress: addProgress,
        };
        if (!dryRun) {
          existingComponents = await resolveExistingWorkerComponents(
            remoteProbeOptions,
            WORKER_COMPONENTS
          );
        }
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

        const summary = await deployAll(
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
            onProgress: addProgress,
            onError: (comp, error) => {
              addProgress(`Error in ${comp}: ${sanitizeError(error)}`);
            },
          },
          enabledComponents
        );

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
        const cleanupEphemeralSetupMachineAccess = async (): Promise<void> => {
          if (setupMachineAccessCleanupDone || dryRun) {
            return;
          }
          setupMachineAccessCleanupDone = true;
          const cleanupResult = await cleanupSetupMachineAccessInD1(env, keysDir, addProgress);
          if (!cleanupResult.success) {
            addProgress(
              `⚠️ Setup machine access cleanup failed: ${cleanupResult.error || 'unknown error'}`
            );
          }
        };

        // Update lock file with deployed workers information
        if (
          !dryRun &&
          summary.results.some((result) => result.success || result.trafficCommitted)
        ) {
          const { lock: currentLock, path: lockPath } = await loadLockFileAuto(rootDir, env);
          if (!currentLock || !lockPath) {
            throw new Error('Deployment lock disappeared before Worker evidence was recorded.');
          }
          const now = new Date().toISOString();
          const workers: Record<string, { name: string; deployedAt?: string; version?: string }> = {
            ...currentLock.workers,
          };
          for (const result of summary.results) {
            if (result.success && result.deployedAt) {
              workers[result.component] = {
                name: result.workerName,
                deployedAt: result.deployedAt,
                version: result.version,
              };
            }
          }
          await saveLockFile({ ...currentLock, workers, updatedAt: now }, lockPath);
          addProgress('Lock file updated with deployment info');
        }

        const apiBaseUrl = resolveIssuerUrl(cfg, { env });

        if (workersSuccess && !dryRun) {
          const workerDeploymentResult = await waitForWorkerDeploymentsReady({
            targets: summary.results
              .filter((result) => result.success)
              .map((result) => ({
                workerName: result.workerName,
                deployedAt: result.deployedAt,
              })),
            onProgress: addProgress,
          });
          if (!workerDeploymentResult.ready) {
            throw new Error(
              `Worker deployments did not become visible: ${workerDeploymentResult.error || 'unknown verification error'}`
            );
          }

          if (bootstrapToken && bootstrapOwnership) {
            const accountId = releaseConfig.cloudflare?.accountId ?? (await getAccountId());
            const { lock: bootstrapLock } = await loadLockFileAuto(rootDir, env);
            const controlDatabaseName = bootstrapLock?.d1.CONTROL_DB?.name;
            if (!accountId || !controlDatabaseName) {
              throw new Error('control_token_bootstrap_target_missing');
            }
            await completeControlTokenBootstrap({
              accountId,
              environment: env,
              rootDir: resolvedRootDir,
              controlDatabaseName,
              bootstrapToken,
              ownership: bootstrapOwnership,
              resourceClasses: resolveControlTokenResourceClasses(releaseConfig),
            });
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
          });
          if (!readinessResult.ready) {
            handleRouterReadinessFailure(
              cfg,
              readinessResult.checkedUrl,
              readinessResult.error,
              addProgress
            );
          }

          const { lock: handoffLock } = await loadLockFileAuto(rootDir, env);
          const controlDatabaseName = handoffLock?.d1.CONTROL_DB?.name;
          const controlDatabaseId = handoffLock?.d1.CONTROL_DB?.id;
          if (!controlDatabaseName || !controlDatabaseId) {
            throw new Error('control_database_required');
          }
          const evidence = await recordInitialBootstrapWorkerEvidence({
            environmentId: env,
            controlDatabaseName,
            deployments: summary.results,
            allowSecretTriggeredVersionAdvanceFor: automaticProvisioning
              ? [`${env}-ar-control`]
              : undefined,
          });
          addProgress(
            `Waiting for Control bootstrap verification of ${evidence.workerCount} Worker(s)...`
          );
          await waitForInitialBootstrapHandoff({
            environmentId: env,
            controlDatabaseName,
            timeoutMs: 15 * 60_000,
            pollIntervalMs: 30_000,
            onProgress: addProgress,
            reconcile: () =>
              reconcileInitialBootstrapHandoffAsOperator({
                controlDatabaseId,
                controlDatabaseName,
                environmentId: env,
                executeWorkerBindings: !automaticProvisioning,
              }),
          });
          addProgress('✓ Initial D1 topology accepted by Control');
        }

        // Complete post-deploy bootstrap only after the schema-first step above.
        let initialTenantResult = null;
        let initialNotificationProviderSuccess = true;
        let initialAdminRolesResult = null;
        let setupMachineAccessResult = null;
        let adminUiBffMachineAccessResult = null;
        let defaultCanonicalCatalogSeedResult = null;
        let runtimeProfileSeedResult = null;
        if (migrationsResult?.success && !dryRun && workersSuccess) {
          const bootstrapConfig = cfg ? AuthrimConfigSchema.parse(cfg) : createDefaultConfig(env);
          if (migrationsResult.success) {
            addProgress(`🔧 Ensuring initial tenant exists (${bootstrapConfig.tenant.name})...`);
            initialTenantResult = await ensureInitialTenantInD1(env, bootstrapConfig, addProgress);
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
                addProgress(
                  `⚠️ Initial notification provider bootstrap failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
              }
            }

            addProgress(
              `🔧 Ensuring initial admin roles exist (${bootstrapConfig.tenant.name})...`
            );
            initialAdminRolesResult = await ensureInitialAdminRolesInD1(
              env,
              bootstrapConfig,
              addProgress
            );
            if (initialAdminRolesResult.success) {
              addProgress(`✅ Initial admin roles ready: ${bootstrapConfig.tenant.name}`);
            } else {
              addProgress(
                `⚠️ Initial admin role bootstrap failed: ${initialAdminRolesResult.error || 'unknown error'}`
              );
            }

            addProgress('🔧 Ensuring setup machine access exists...');
            setupMachineAccessResult = await ensureSetupMachineAccessInD1(
              env,
              bootstrapConfig,
              keysDir,
              addProgress
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
                addProgress
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
              addProgress
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
            runtimeProfileSeedResult = await seedRuntimeProfiles(env, bootstrapConfig, addProgress);
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
            dryRun,
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

          await cleanupEphemeralSetupMachineAccess();

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
            const visibility = await waitForWorkerDeploymentsReady({
              targets: uiWorkersSummary.results.map((result) => ({
                workerName: result.projectName,
                deployedAt: result.deployedAt,
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
            uiWorkersSummary.results.some((result) => result.success || result.trafficCommitted)
          ) {
            const { lock: currentLock, path: currentLockPath } = await loadLockFileAuto(
              rootDir,
              env
            );
            if (currentLock && currentLockPath) {
              const workers = { ...currentLock.workers };
              for (const result of uiWorkersSummary.results) {
                if ((!result.success && !result.trafficCommitted) || !result.deployedAt) {
                  continue;
                }
                workers[result.component] = {
                  name: result.projectName,
                  deployedAt: result.deployedAt,
                  version:
                    (await getPackageVersion(join(rootDir, 'packages', result.component))) ??
                    undefined,
                };
              }
              await saveLockFile(
                { ...currentLock, workers, updatedAt: new Date().toISOString() },
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
            const controlDatabaseName = currentLock?.d1.CONTROL_DB?.name;
            if (!controlDatabaseName) {
              throw new Error('control_database_required_for_ui_worker_inventory');
            }
            await registerUiWorkerInventoryFromArtifacts({
              baseDir: resolve(rootDir),
              environmentId: env,
              environmentName: env,
              controlDatabaseName,
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

        await cleanupEphemeralSetupMachineAccess();

        const uiWorkersSuccess = uiWorkersSummary
          ? uiWorkersSummary.failedCount === 0 && uiWorkersHealthReady
          : true;
        const deploymentSucceeded =
          workersSuccess &&
          uiWorkersSuccess &&
          migrationsSuccess &&
          initialTenantSuccess &&
          initialAdminRolesSuccess &&
          setupMachineAccessSuccess &&
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
          } else if (!initialAdminRolesSuccess) {
            state.error = `Initial admin role bootstrap failed: ${initialAdminRolesResult?.error || 'unknown error'}`;
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
        try {
          if (cleanupEnv && cleanupKeysDir) {
            await cleanupSetupMachineAccessInD1(cleanupEnv, cleanupKeysDir, addProgress);
          }
        } catch {
          // Cleanup is best-effort in the error path; the primary deploy error is more useful.
        }
        state.status = 'error';
        state.error = sanitizeError(error);
        addProgress(`❌ Deployment failed: ${state.error}`);
        await flushProgressLog();
        return c.json({ success: false, error: sanitizeError(error), logPath: state.logPath }, 500);
      } finally {
        bootstrapToken = '';
        await environmentOperationLock?.release();
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
        addProgress(`Looking for setup token at: ${tokenPath}`);

        const result = await completeInitialSetup({
          env,
          baseUrl: resolvedBaseUrl,
          baseDir,
          keysBaseDir: process.cwd(),
          legacy: isLegacy,
          onProgress: addProgress,
        });

        addProgress(`completeInitialSetup result: ${JSON.stringify(result)}`);

        if (result.alreadyCompleted) {
          addProgress('Initial admin setup already completed');
          return c.json({
            success: true,
            alreadyCompleted: true,
            message: 'Initial admin setup was already completed',
          });
        }

        if (result.success && result.setupUrl) {
          addProgress(`Setup token stored successfully. URL: ${result.setupUrl}`);
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
    const config = AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
    const { lock } = await loadLockFileAuto(baseDir, environmentId);
    const controlDatabaseName = lock?.d1.CONTROL_DB?.name;
    if (!controlDatabaseName) throw new Error('Control database is not configured');
    return {
      baseDir,
      apiBaseUrl: resolveIssuerUrl(config, { env: environmentId }),
      keysDir: resolveWebDeploymentKeysDir(baseDir, environmentId),
      controlDatabaseName,
      config,
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
        controlDatabaseName: context.controlDatabaseName,
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
        try {
          const context = await loadWebCapacityContext(parsed.data.environmentId);
          const request = {
            profile: parsed.data.profile,
            scope: parsed.data.scope,
            tenantId: parsed.data.tenantId,
          };
          const capacityInput = {
            apiBaseUrl: context.apiBaseUrl,
            keysDir: context.keysDir,
            controlDatabaseName: context.controlDatabaseName,
            request,
          };
          if (action === 'preview') {
            const preview = await withEphemeralSetupMachineAccess({
              baseDir: context.baseDir,
              env: parsed.data.environmentId,
              config: context.config,
              keysDir: context.keysDir,
              action: () => previewSetupControlCapacity(capacityInput),
            });
            return c.json({ success: true, preview });
          }
          const result = await withEphemeralSetupMachineAccess({
            baseDir: context.baseDir,
            env: parsed.data.environmentId,
            config: context.config,
            keysDir: context.keysDir,
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
          return c.json({ success: false, error: sanitizeError(error) }, 500);
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
        const controlDatabaseName = lock?.d1.CONTROL_DB?.name;
        if (!controlDatabaseName) continue;
        try {
          const [shardOperations, pluginOperations, pluginCleanupOperations, tenantDrOperations] =
            await Promise.all([
              listPendingControlOperatorOperations({ controlDatabaseName }),
              listPendingPluginControlOperatorOperations({ controlDatabaseName }),
              listPendingPluginControlCleanupOperations({ controlDatabaseName }),
              listPendingTenantDisasterRecoveryOperatorOperations({ controlDatabaseName }),
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
    try {
      const baseDir = findAuthrimBaseDir(process.cwd());
      const { lock, path: lockPath } = await loadLockFileAuto(baseDir, parsed.data.environmentId);
      const controlDatabase = lock?.d1.CONTROL_DB;
      if (!controlDatabase) {
        return c.json({ success: false, error: 'Control database is not configured' }, 409);
      }
      const [shardOperations, pluginOperations, pluginCleanupOperations, tenantDrOperations] =
        await Promise.all([
          listPendingControlOperatorOperations({ controlDatabaseName: controlDatabase.name }),
          listPendingPluginControlOperatorOperations({ controlDatabaseName: controlDatabase.name }),
          listPendingPluginControlCleanupOperations({
            controlDatabaseName: controlDatabase.name,
          }),
          listPendingTenantDisasterRecoveryOperatorOperations({
            controlDatabaseName: controlDatabase.name,
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
        return c.json({ success: false, error: 'Control environment config is unavailable' }, 409);
      }
      const result =
        operation.operationKind === 'provision_plugin_resources'
          ? await executeSetupPluginControlOperator({
              controlDatabaseId: controlDatabase.id,
              migrationReleaseBucketName:
                lock.r2?.MIGRATION_RELEASES?.name ??
                `${parsed.data.environmentId}-migration-releases`,
              operation,
              expectedAccountId: config?.cloudflare?.accountId,
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
                    migrationReleaseBucketName:
                      lock.r2?.MIGRATION_RELEASES?.name ??
                      `${parsed.data.environmentId}-migration-releases`,
                    operation,
                    expectedAccountId: config?.cloudflare?.accountId,
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
    }
  });

  // List all detected Authrim environments (no auth required - read-only)
  api.get('/environments', async (c) => {
    try {
      const progress: string[] = [];
      const addLocalProgress = (message: string) => {
        progress.push(message);
      };
      addLocalProgress('Scanning Cloudflare account for Authrim environments...');

      const environments = await detectEnvironments(addLocalProgress);

      return c.json({
        success: true,
        environments,
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
      const interruptedInitialRelease = Boolean(
        lock &&
        !lock.productVersion &&
        lock.releaseUpdate !== undefined &&
        lock.releaseUpdate.phase !== 'verified'
      );

      return c.json({
        success: true,
        env,
        configExists: existsSync(configPath),
        canResume: existsSync(configPath) && interruptedInitialRelease,
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
      try {
        const envResult = EnvNameSchema.safeParse(c.req.param('env'));
        if (!envResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = envResult.data;
        const body = await c.req.json();
        const {
          deleteWorkers = true,
          deleteD1 = true,
          deleteKV = true,
          deleteQueues = true,
          deleteR2 = true,
          deletePages = true,
        } = body;

        state.status = 'provisioning'; // Reuse provisioning status
        state.error = null;
        state.deployResults = [];
        clearProgress();
        state.logPath = await beginProgressLog(env, 'delete');
        addProgress(`Preparing to delete environment: ${env}`);

        const baseDir = findAuthrimBaseDir(process.cwd());
        operationLock = await acquireEnvironmentOperationForEnvironment({
          baseDir,
          env,
          operation: 'web-delete',
        });
        let environmentObservedRemotely = Boolean(operationLock.lock);
        if (!environmentObservedRemotely) {
          try {
            environmentObservedRemotely = (await detectEnvironments()).some(
              (candidate) => candidate.env === env
            );
            if (!environmentObservedRemotely) {
              environmentObservedRemotely = await hasControlManagedResourcesForEnvironment(env);
            }
          } catch {
            // Without a local lock, only allow deletion recovery when remote resources can be
            // confirmed. Authentication or inventory failures must not bypass this guard.
            environmentObservedRemotely = false;
          }
        }
        const deleteDecision = evaluateEnvironmentOperation({
          operation: 'delete',
          lock: operationLock.lock,
          environmentObservedRemotely,
        });
        if (!deleteDecision.allowed) {
          return c.json(
            {
              success: false,
              error: environmentOperationBlockMessage(deleteDecision),
            },
            409
          );
        }

        const result = await deleteEnvironment({
          env,
          deleteWorkers,
          deleteD1,
          deleteKV,
          deleteQueues,
          deleteR2,
          deletePages,
          onProgress: addProgress,
        });

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
        result.success = result.errors.length === 0;

        if (state.logPath) {
          addProgress(`📝 Progress log saved: ${state.logPath}`);
        }
        await flushProgressLog();
        state.status = result.success ? 'complete' : 'error';
        if (!result.success) {
          state.error = result.errors.join(', ');
        }

        return c.json({
          success: result.success,
          deleted: result.deleted,
          manualR2: result.manualR2,
          errors: result.errors,
          progress: state.progress,
          logPath: state.logPath,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        await flushProgressLog();
        return c.json({ success: false, error: sanitizeError(error), logPath: state.logPath }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  // =============================================================================
  // Worker Update
  // =============================================================================

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
          const migrationsRoot = await findMigrationsRoot(rootDir, addProgress);
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
              'Control Plane bootstrap topology is incomplete. Re-run setup init before handoff acceptance or repair it from Admin UI after handoff.';
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
        if (componentsToUpdate.length === 0) {
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
          const keysDir = resolveWebDeploymentKeysDir(rootDir, env);
          deploymentSecrets = await loadSupplementalSecretsForWorkers({
            env,
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
          onProgress: addProgress,
          onError: (comp: string, error: Error) => {
            addProgress(`Error in ${comp}: ${sanitizeError(error)}`);
          },
        };
        workerDeployOptions.existingComponents = await resolveExistingWorkerComponents(
          workerDeployOptions,
          WORKER_COMPONENTS
        );

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

        // Update lock file with new versions
        if (summary.results.some((result) => result.success || result.trafficCommitted)) {
          const workers = { ...lock.workers };
          for (const result of summary.results) {
            if ((result.success || result.trafficCommitted) && result.deployedAt) {
              workers[result.component] = {
                name: result.workerName,
                deployedAt: result.deployedAt,
                version: localVersions[result.component] || result.version,
              };
            }
          }

          const updatedLock = {
            ...lock,
            workers,
            updatedAt: new Date().toISOString(),
          };

          await saveLock(updatedLock, lockPath);
          lock = updatedLock;
          addProgress(`Lock file updated: ${lockPath}`);
        }

        if (summary.failedCount === 0) {
          const workerDeploymentResult = await waitForWorkerDeploymentsReady({
            targets: summary.results
              .filter((result) => result.success)
              .map((result) => ({
                workerName: result.workerName,
                deployedAt: result.deployedAt,
              })),
            onProgress: addProgress,
          });
          if (!workerDeploymentResult.ready) {
            throw new Error(
              `Worker deployments did not become visible: ${workerDeploymentResult.error || 'unknown verification error'}`
            );
          }

          const workersSubdomain = await getWorkersSubdomain();
          const workerHttpTargets = buildWorkerHttpReadinessTargets(
            summary.results.filter((result) => result.success),
            workersSubdomain,
            { workersDevEnabled: !config.urls?.api?.custom }
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
        }

        if (summary.failedCount === 0 && componentsToUpdate.includes('ar-router')) {
          const apiBaseUrl = resolveIssuerUrl(config, { env });
          const readinessResult = await waitForRouterWorkerReady({
            apiBaseUrl,
            onProgress: addProgress,
          });
          if (!readinessResult.ready) {
            handleRouterReadinessFailure(
              config,
              readinessResult.checkedUrl,
              readinessResult.error,
              addProgress
            );
          }
        }

        state.status = summary.failedCount === 0 ? 'complete' : 'error';

        if (summary.failedCount === 0) {
          addProgress(`Successfully updated ${summary.successCount} worker(s)`);
          if (operationKind === 'topology_change') {
            lock = completeTopologyUpdate(lock, { targetProductVersion, config });
            await saveLock(lock, lockPath);
          }
        } else {
          addProgress(
            `Updated ${summary.successCount}/${summary.totalComponents}, ${summary.failedCount} failed`
          );
        }
        await flushProgressLog();

        return c.json({
          success: summary.failedCount === 0,
          summary,
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
        await operationLock?.release();
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
      try {
        const componentName = c.req.param('name');
        const body = await c.req.json();
        const { env: envParam, skipBuild = false, dryRun = false } = body;
        const rootDir = process.cwd();

        // Validate environment name
        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = parseResult.data;

        state.status = 'deploying';
        clearProgress();
        addProgress(`Deploying component: ${componentName}`);

        // Check if it's a UI Worker component or API Worker component.
        const isUiWorkerComponent = UI_WORKER_COMPONENTS.includes(
          componentName as UiWorkerComponent
        );
        const isWorkerComponent = WORKER_COMPONENTS.includes(componentName as WorkerComponent);

        if (!isUiWorkerComponent && !isWorkerComponent) {
          state.status = 'error';
          return c.json(
            {
              success: false,
              error: `Unknown component: ${componentName}. Valid components: ${[...WORKER_COMPONENTS, ...UI_WORKER_COMPONENTS].join(', ')}`,
            },
            400
          );
        }

        let { lock: componentDeploymentLock } = await loadLockFileAuto(rootDir, env);
        if (!componentDeploymentLock) {
          state.status = 'error';
          return c.json({ success: false, error: `Environment "${env}" not found.` }, 404);
        }
        if (!dryRun) {
          operationLock = await acquireEnvironmentOperationForEnvironment({
            baseDir: rootDir,
            env,
            operation: `web-component-deploy:${componentName}`,
            requireExisting: true,
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
          state.status = 'error';
          return c.json(
            {
              success: false,
              error: releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion),
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

        if (isUiWorkerComponent) {
          // Deploy UI Worker component (ar-admin-ui or ar-login-ui).
          // deployUiWorkerComponent is kept as an internal compatibility alias.
          const keysDir = resolveWebDeploymentKeysDir(rootDir, env);
          if (!dryRun) {
            await ensureSupplementalKeysForWebDeploy(keysDir);
          }
          if (!cfg) {
            state.status = 'error';
            return c.json(
              { success: false, error: 'Environment config is required for UI deployment' },
              400
            );
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
              state.status = 'error';
              return c.json({ success: false, error: `Package not found: ${componentName}` }, 404);
            }

            // Get the tenant-aware API base URL.
            const apiBaseUrl = resolveIssuerUrl(cfg, { env });

            let loginUiClientId: string | undefined;
            if (componentName === 'ar-login-ui' && !dryRun) {
              let setupMachineReady = false;
              try {
                const initialTenantResult = await ensureInitialTenantInD1(
                  env,
                  cfg as AuthrimConfig,
                  addProgress
                );
                if (!initialTenantResult.success) {
                  throw new Error(
                    `Initial tenant prerequisite failed: ${initialTenantResult.error || 'unknown error'}`
                  );
                }
                const migrationRoot = await findMigrationsRoot(rootDir, addProgress);
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
                const setupMachineResult = await ensureSetupMachineAccessInD1(
                  env,
                  cfg as AuthrimConfig,
                  keysDir,
                  addProgress
                );
                if (!setupMachineResult.success) {
                  throw new Error(
                    `Setup machine access bootstrap failed: ${setupMachineResult.error || 'unknown error'}`
                  );
                }
                setupMachineReady = true;

                const readinessResult = await waitForRouterWorkerReady({
                  apiBaseUrl,
                  onProgress: addProgress,
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
                    addProgress
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
                    onProgress: addProgress,
                  })
                : undefined;

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
              onProgress: addProgress,
            });

            if (!dryRun && result.deployedAt && (result.success || result.trafficCommitted)) {
              try {
                const { lock: currentLock, path: lockPath } = await loadLockFileAuto(rootDir, env);

                if (currentLock && lockPath) {
                  const version = await getPackageVersion(join(rootDir, 'packages', componentName));
                  const workers = { ...currentLock.workers };
                  workers[componentName] = {
                    name: result.projectName,
                    deployedAt: result.deployedAt,
                    version: version ?? undefined,
                  };

                  await saveLockFile({ ...currentLock, workers }, lockPath);
                  addProgress('Lock file updated');
                }
              } catch (lockError) {
                addProgress(`Warning: Could not update lock file: ${sanitizeError(lockError)}`);
              }
            }

            if (result.success) {
              const visibility = await waitForWorkerDeploymentsReady({
                targets: [{ workerName: result.projectName, deployedAt: result.deployedAt }],
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
              const controlDatabaseName = componentDeploymentLock.d1.CONTROL_DB?.name;
              if (!controlDatabaseName) {
                throw new Error('control_database_required_for_ui_worker_inventory');
              }
              await registerUiWorkerInventoryFromArtifacts({
                baseDir: rootDir,
                environmentId: env,
                environmentName: env,
                controlDatabaseName,
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
              state.status = 'complete';
              addProgress(`✓ ${componentName} deployed successfully`);
              return c.json({
                success: true,
                component: componentName,
                type: 'ui-worker',
                projectName: result.projectName,
                deployedAt: result.deployedAt,
              });
            } else {
              state.status = 'error';
              return c.json(
                {
                  success: false,
                  component: componentName,
                  type: 'ui-worker',
                  error: result.error,
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
          });
        } else {
          // Deploy Worker component
          // deployWorker and buildApiPackages are already imported at the top

          // Refresh master/package wrangler configs before deploying.
          // The .authrim/{env}/wrangler master copy is the source of truth.
          addProgress('Refreshing generated wrangler configs...');
          try {
            const { loadLockFileAuto } = await import('../core/lock.js');
            const { getEnvironmentPaths } = await import('../core/paths.js');

            const envPaths = getEnvironmentPaths({ baseDir: rootDir, env });
            const { lock: currentLock } = await loadLockFileAuto(rootDir, env);

            if (!existsSync(envPaths.config) || !currentLock) {
              addProgress('Warning: No lock file or config found, wrangler config may be missing');
            } else {
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

              if (!masterResult.success && masterResult.errors.length > 0) {
                addProgress(
                  `Warning: Master wrangler generation had errors: ${masterResult.errors.join(', ')}`
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

              if (syncResult.success) {
                addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);
              } else if (syncResult.errors.length > 0) {
                addProgress(`Warning: Sync had errors: ${syncResult.errors.join(', ')}`);
              }
            }
          } catch (syncError) {
            addProgress(`Warning: Could not sync wrangler configs: ${sanitizeError(syncError)}`);
            // Continue anyway - the config might already exist
          }

          const { lock: componentLock, path: componentLockPath } = await loadLockFileAuto(
            rootDir,
            env
          );
          let deploymentSecrets: Record<string, string> = {};
          if (!dryRun) {
            const keysDir = resolveWebDeploymentKeysDir(rootDir, env);
            deploymentSecrets = await loadSupplementalSecretsForWorkers({
              env,
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
              state.status = 'error';
              return c.json({ success: false, error: `Build failed: ${buildResult.error}` }, 500);
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
            onProgress: addProgress,
          };
          if (!dryRun) {
            componentDeployOptions.existingComponents = await resolveExistingWorkerComponents(
              componentDeployOptions,
              WORKER_COMPONENTS
            );
          }

          if (!dryRun && componentName === 'ar-router') {
            try {
              await ensureWildcardDnsForMultiTenant(cfg, addProgress);
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
                  onProgress: addProgress,
                },
                missingUiBindingTargets
              );
              if (placeholder.failedCount > 0) {
                state.status = 'error';
                return c.json(
                  { success: false, error: 'UI Worker binding-target deployment failed' },
                  500
                );
              }
            }
          }

          const summary = await deployAll(componentDeployOptions, [
            componentName as WorkerComponent,
          ]);
          const result = summary.results.find((candidate) => candidate.component === componentName);

          // Update lock file if successful
          if (
            summary.results.some((candidate) => candidate.success || candidate.trafficCommitted) &&
            !dryRun
          ) {
            try {
              if (componentLock && componentLockPath) {
                await saveLockFile(
                  updateLockWithDeployments(componentLock, summary.results),
                  componentLockPath
                );
                addProgress('Lock file updated');
              }
            } catch (lockError) {
              addProgress(`Warning: Could not update lock file: ${sanitizeError(lockError)}`);
            }
          }

          if (!dryRun && summary.failedCount === 0 && result?.success) {
            await maybeConfigureDownstreamIntrospectionForWebDeploy({
              env,
              rootDir,
              config: cfg,
              components: [componentName],
              dryRun,
            });
          }

          if (summary.failedCount === 0 && result?.success) {
            if (!dryRun) {
              const visibility = await waitForWorkerDeploymentsReady({
                targets: [{ workerName: result.workerName, deployedAt: result.deployedAt }],
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
            });
          } else {
            state.status = 'error';
            return c.json(
              {
                success: false,
                component: componentName,
                type: 'worker',
                error: result?.error || 'dependency deployment failed',
              },
              500
            );
          }
        }
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
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
      const productVersion = await getRootProductVersion(rootDir);
      const migrationsRoot = await findMigrationsRoot(rootDir, addProgress);
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
      const result = await getD1MigrationStatusForEnvironment(env, rootDir, addProgress, {
        productVersion,
        allowDraft: installedRelease.draft,
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
        const body = await c.req.json();
        const { env: envParam, role, filenames } = body;

        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        if (role !== undefined && !['core', 'pii', 'admin'].includes(role)) {
          return c.json({ success: false, error: 'Invalid migration database role' }, 400);
        }
        if (
          filenames !== undefined &&
          (!Array.isArray(filenames) || filenames.some((file) => typeof file !== 'string'))
        ) {
          return c.json({ success: false, error: 'Invalid migration filenames' }, 400);
        }

        const safeFilenames = Array.isArray(filenames)
          ? filenames.filter((file) => file.endsWith('.sql') && !file.includes('..'))
          : undefined;
        if (Array.isArray(filenames) && safeFilenames?.length !== filenames.length) {
          return c.json({ success: false, error: 'Invalid migration filenames' }, 400);
        }

        const env = parseResult.data;
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

        clearProgress();
        addProgress(`📜 Applying database migrations for environment: ${env}`);
        const migrationsRoot = await findMigrationsRoot(rootDir, addProgress);
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
          },
        });

        if (result.success) {
          addProgress('✅ Database migrations completed successfully');
        } else {
          addProgress('❌ Database migrations failed');
        }

        return c.json({ ...result, success: result.success, progress: state.progress });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
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
        const body = await c.req.json();
        const { env: envParam, rootDir = process.cwd() } = body;

        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = parseResult.data;
        const resolvedRootDir = resolve(rootDir);
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

        clearProgress();
        addProgress(`📜 Running D1 migrations for environment: ${env}`);
        const migrationsRoot = await findMigrationsRoot(resolvedRootDir, addProgress);
        if (!migrationsRoot.path) throw new Error('Migrations directory not found.');
        const installedRelease = loadInstalledReleaseMigrationManifest({
          migrationsRoot: migrationsRoot.path,
          productVersion: targetProductVersion,
          lock,
        });
        const result = await runMigrationsForEnvironment(env, resolvedRootDir, addProgress, {
          productVersion: targetProductVersion,
          allowDraft: installedRelease.draft,
        });

        if (result.success) {
          addProgress('✅ All migrations completed successfully');
        } else {
          addProgress('❌ Some migrations failed');
        }

        return c.json({
          success: result.success,
          core: result.core,
          pii: result.pii,
          admin: result.admin,
          progress: state.progress,
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      } finally {
        await operationLock?.release();
      }
    });
  });

  return api;
}
