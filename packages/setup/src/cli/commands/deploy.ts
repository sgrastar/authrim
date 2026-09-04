/**
 * Deploy Command
 *
 * Handles deployment of Authrim workers to Cloudflare.
 */

import chalk from 'chalk';
import ora from 'ora';
import { confirm, password, select } from '@inquirer/prompts';
import { t, getLocale } from '../../i18n/index.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { consumePrivateFileSecurely, writePrivateFileAtomically } from '../../core/atomic-file.js';
import { assertFixedD1ResourceIdentities } from '../../core/fixed-d1-identity.js';

function updateOraSpinner(spinner: ReturnType<typeof ora>, message: string): void {
  if (spinner.isSpinning === false) {
    console.log(message);
    return;
  }
  spinner.text = message;
}
import {
  saveLockFile,
  loadLockFile,
  loadLockFileAuto,
  reconcileD1ResourcesInLock,
  reconcileQueueResourcesInLock,
  reconcileSharedKVResourcesInLock,
  acquireDeployConfigLock,
  acquireEnvironmentOperationLock,
  clearProvisionalWorkerScriptOwnership,
  withDnsOwnershipEntry,
  type AuthrimLock,
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
  reconcileWorkerCronTriggers,
  updateLockWithDeployments,
  buildApiPackages,
  loadDeploySecretsFromKeys,
  UI_WORKER_COMPONENTS,
  hasBlockingDeploymentFailures,
  type DeployOptions,
  type DeploymentSummary,
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
  listQueues,
  listR2Buckets,
  getRequiredR2Buckets,
  getRequiredQueues,
  findMigrationsRoot,
  getAccountId,
  getCloudflareApiToken,
  assertR2BucketOwnershipForUse,
} from '../../core/cloudflare.js';
import { type WorkerComponent, CORE_WORKER_COMPONENTS, getWorkerName } from '../../core/naming.js';
import {
  prepareManagedWorkerScriptOwnership,
  type WorkerScriptOwnershipGuard,
} from '../../core/worker-script-ownership.js';
import {
  assertLocalDeploymentCapacity,
  MINIMUM_BUILD_FREE_BYTES,
} from '../../core/local-deployment-capacity.js';
import { generateWranglerConfig, toToml, buildResourceIdsFromLock } from '../../core/wrangler.js';
import { buildWorkerDeploymentResourceIds } from '../../core/deployment-resource-ids.js';
import {
  compileControlWorkerInventoryFromArtifacts,
  registerControlWorkerInventory,
  registerUiWorkerInventoryFromArtifacts,
} from '../../core/control-worker-inventory.js';
import {
  loadControlGeneratedKeyState,
  loadControlStagedSigningKeys,
  projectControlGeneratedKeyState,
  refreshLockFromControlGeneratedState,
} from '../../core/control-generated-state.js';
import {
  initializeControlKeyState,
  reconcileLocalControlKeyFiles,
} from '../../core/control-key-state.js';
import {
  discoverExternalCapabilities,
  registerExternalCapabilities,
} from '../../core/external-capability-registration.js';
import { publishDynamicPluginWorkerBundles } from '../../core/dynamic-plugin-publication.js';
import { publishAndActivateMigrationRelease } from '../../core/migration-release-publication.js';
import { completeInitialSetup, displaySetupInstructions } from '../../core/admin.js';
import { ensureLoginUiClient } from '../../core/login-ui-client.js';
import { prepareAdminUiBffDeployment } from '../../core/admin-ui-bff-deployment.js';
import {
  configureDownstreamIntrospectionDeployment,
  createDownstreamIntrospectionFailure,
  resolveDownstreamIntrospectionKeysDir,
  type ConfigureDownstreamIntrospectionDeploymentResult,
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
import { promotePendingEmailSecrets } from '../../core/pending-email-secrets.js';
import { getPackageVersion, getRootProductVersion } from '../../core/version.js';
import {
  calculateReleaseManifestChecksum,
  loadInstalledReleaseMigrationManifest,
  loadTargetReleaseMigrationManifest,
  resolveReleaseMigrationTargets,
} from '../../core/release-migrations.js';
import {
  applyReleaseSchemaUpdatePlan,
  buildReleaseSchemaUpdatePlan,
} from '../../core/release-update.js';
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
  ensureInitialControlPlaneResources,
  ensureInitialTenantRegionShardConfig,
  inspectInitialControlPlaneTopology,
  publishInitialControlPlaneRuntimeSnapshot,
} from '../../core/control-plane-bootstrap.js';
import {
  advanceInitialBootstrapWorkerBindingsAsOperator,
  isInitialBootstrapHandoffAccepted,
  reconcileInitialBootstrapHandoffAsOperator,
  recordInitialBootstrapWorkerEvidence,
  registerInitialControlTopology,
  requestInitialBootstrapAcceleration,
  waitForInitialBootstrapHandoff,
} from '../../core/control-bootstrap-handoff.js';
import { ensureInitialNotificationProviderConfiguration } from '../../core/notification-provider-bootstrap.js';
import { getMissingRequiredDeploySecrets } from '../../core/secrets.js';
import {
  buildCloudflareBootstrapTokenEndDate,
  buildCloudflareBootstrapTemplateUrl,
  CloudflareTokenBootstrapError,
  detectCloudflareTokenOwnership,
  selectPreferredCloudflareTokenOwnership,
  validateDirectControlTokensWithEvidence,
  type CloudflareTokenOwnership,
  type DirectControlTokenEvidence,
  WranglerControlSecretSink,
} from '../../core/cloudflare-control-token-bootstrap.js';
import { openExternalHttpsUrl } from '../../core/open-external-url.js';
import {
  isTokenlessPendingControlProvisioningAuthority,
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
} from '../../core/control-provisioning-authority.js';
import { loadPendingControlBootstrap } from '../../core/pending-control-bootstrap.js';
import {
  completeControlTokenBootstrap,
  hasReadyControlTokenBootstrap,
  reconcileControlSecretGenerationWorkerLock,
  resolveControlTokenResourceClasses,
} from '../../core/control-token-bootstrap-orchestrator.js';
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
import {
  updateDeploymentProgress,
  type DeploymentProgressSnapshot,
} from '../../core/deployment-progress.js';
import {
  adoptLegacyQueueIdentities,
  assertLegacyQueueIdentityAdoptionPersisted,
  type LegacyQueueIdentityAdoptionEvidence,
} from '../../core/legacy-queue-identity-adoption.js';
import {
  adoptLegacyWorkerDeployments,
  assertLegacyWorkerDeploymentAdoptionPersisted,
  type LegacyWorkerDeploymentTarget,
} from '../../core/legacy-worker-deployment-adoption.js';

// =============================================================================
// Types
// =============================================================================

export interface DeployCommandOptions {
  config?: string;
  env?: string;
  source?: string;
  component?: string;
  /** Internal focused API Worker set used by bounded maintenance operations. */
  components?: readonly WorkerComponent[];
  dryRun?: boolean;
  skipSecrets?: boolean;
  skipBuild?: boolean;
  skipUi?: boolean;
  skipMigrations?: boolean;
  parallel?: boolean;
  yes?: boolean;
  keysDir?: string;
  /** One-use secret file consumed before Control token bootstrap. */
  cloudflareBootstrapTokenFile?: string;
  externalSchemaReady?: boolean;
  /** Test-only operator experiment; never inferred from normal environment configuration. */
  placement?: string;
  /** Test-only load/conformance endpoint override for one ar-management deployment. */
  testEndpoints?: string;
  /** Internal authorization context supplied by explicit topology commands. */
  operationKind?: 'worker_redeploy' | 'topology_change';
  /** Internal maintenance callers require a thrown error instead of process exit state only. */
  throwOnFailure?: boolean;
  /** Explicit one-time checkpoint upgrade for historical Queue entries whose id equaled name. */
  adoptLegacyQueueIdentities?: boolean;
  /** Explicitly recover exact Worker ownership after a pre-checkpoint initial deployment. */
  recoverLegacyWorkerDeployments?: boolean;
}

export function resolveDeployOperationKind(input: {
  isInitialDeployment: boolean;
  operationKind?: DeployCommandOptions['operationKind'];
}): 'initial_deploy' | 'worker_redeploy' | 'topology_change' {
  if (input.isInitialDeployment) return 'initial_deploy';
  return input.operationKind ?? 'worker_redeploy';
}

export function isInitialDeploymentLock(lock: AuthrimLock): boolean {
  return lock.productVersion === undefined;
}

export function assertExplicitLegacyInitialWorkerRecoveryState(input: {
  lock: AuthrimLock;
  environment: string;
  targetVersion: string;
  enabledComponents: readonly string[];
}): void {
  if (
    input.lock.productVersion !== undefined ||
    input.lock.releaseUpdate !== undefined ||
    Object.keys(input.lock.workers ?? {}).length === 0
  ) {
    throw new Error('legacy_worker_recovery_state_invalid');
  }
  const enabled = new Set(input.enabledComponents);
  for (const [component, worker] of Object.entries(input.lock.workers ?? {})) {
    if (
      !enabled.has(component) ||
      worker.name !== `${input.environment}-${component}` ||
      worker.version !== input.targetVersion ||
      (!worker.cloudflareScriptTag && !worker.cloudflareVersionId)
    ) {
      throw new Error(`legacy_worker_recovery_state_invalid:${component}`);
    }
  }
  for (const [component, ownership] of Object.entries(input.lock.workerScriptOwnership ?? {})) {
    if (!enabled.has(component) || ownership.name !== `${input.environment}-${component}`) {
      throw new Error(`legacy_worker_recovery_state_invalid:${component}`);
    }
  }
}

export function resolveDeployFailureAction(input: {
  blockingDeploymentFailures: boolean;
  throwOnFailure?: boolean;
}): 'continue' | 'set_exit_code' | 'throw' {
  if (!input.blockingDeploymentFailures) return 'continue';
  return input.throwOnFailure ? 'throw' : 'set_exit_code';
}

/** Non-interactive deploys must apply the freshly generated target-environment section. */
export function getAutomaticWranglerSyncAction(
  options: Pick<DeployCommandOptions, 'yes'>
): SyncAction | null {
  return options.yes === true ? 'overwrite' : null;
}

export function buildInitialHandoffResumeSummary(input: {
  lock: AuthrimLock;
  components?: readonly WorkerComponent[];
  now?: string;
}): DeploymentSummary {
  const components = input.components ?? CORE_WORKER_COMPONENTS;
  const completedAt = input.now ?? new Date().toISOString();
  const results = components.map((component) => {
    const worker = input.lock.workers?.[component];
    const expectedName = `${input.lock.env}-${component}`;
    if (
      !worker ||
      worker.name !== expectedName ||
      !worker.deployedAt ||
      !worker.cloudflareVersionId ||
      !worker.cloudflareScriptTag
    ) {
      throw new Error(`initial_handoff_resume_worker_evidence_missing:${component}`);
    }
    return {
      component,
      workerName: worker.name,
      success: true,
      deployedAt: worker.deployedAt,
      version: worker.version,
      cloudflareVersionId: worker.cloudflareVersionId,
      cloudflareScriptTag: worker.cloudflareScriptTag,
    };
  });
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

/** Ignore a stale config default while preserving an explicit CLI override for strict validation. */
export function getDeployKeysDirHint(input: {
  baseDir: string;
  explicitKeysDir?: string;
  configuredKeysDir?: string;
}): string | undefined {
  if (input.explicitKeysDir) return input.explicitKeysDir;
  if (!input.configuredKeysDir) return undefined;
  const configuredPath = resolve(input.baseDir, input.configuredKeysDir);
  // Fresh-install configs retain ./keys/ as a portable placeholder while generated secrets live
  // under .authrim-keys/{env}. Never let an unrelated legacy/root keys directory shadow the
  // environment-scoped discovery performed by resolveDownstreamIntrospectionKeysDir().
  if (configuredPath === resolve(input.baseDir, 'keys')) return undefined;
  return existsSync(configuredPath) ? input.configuredKeysDir : undefined;
}

export function resolveApiDeployComponents(
  options: Pick<DeployCommandOptions, 'component' | 'components'>
): WorkerComponent[] {
  const selected = options.component
    ? [options.component]
    : options.components
      ? [...options.components]
      : [...CORE_WORKER_COMPONENTS];
  const unique = [...new Set(selected)];
  if (
    unique.length === 0 ||
    unique.length !== selected.length ||
    unique.some((component) => !(CORE_WORKER_COMPONENTS as readonly string[]).includes(component))
  ) {
    throw new Error('focused_deployment_components_invalid');
  }
  return unique as WorkerComponent[];
}

export function requiresInitialControlTokenBootstrap(input: {
  isInitialDeployment: boolean;
  dryRun: boolean;
  controlIncluded: boolean;
  automaticProvisioningEnabled: boolean;
}): boolean {
  return (
    input.isInitialDeployment &&
    !input.dryRun &&
    input.controlIncluded &&
    input.automaticProvisioningEnabled
  );
}

function isDisposableTestEnvironment(environmentId: string): boolean {
  return /^test(?:[-_][a-z0-9][a-z0-9_-]{0,119})?$/u.test(environmentId);
}

export function resolveTestPlacementOverrides(input: {
  environmentId: string;
  component?: string;
  components?: readonly WorkerComponent[];
  placement?: string;
}): Partial<Record<WorkerComponent, 'off' | 'smart'>> {
  if (input.placement === undefined) return {};
  if (!isDisposableTestEnvironment(input.environmentId)) {
    throw new Error('worker_placement_override_test_environment_required');
  }
  if (input.components !== undefined || !input.component) {
    throw new Error('worker_placement_override_single_component_required');
  }
  if (!(CORE_WORKER_COMPONENTS as readonly string[]).includes(input.component)) {
    throw new Error('worker_placement_override_component_invalid');
  }
  if (input.placement !== 'off' && input.placement !== 'smart') {
    throw new Error('worker_placement_override_mode_invalid');
  }
  return {
    [input.component]: input.placement,
  } as Partial<Record<WorkerComponent, 'off' | 'smart'>>;
}

export function resolveTestEndpointVarOverrides(input: {
  environmentId: string;
  component?: string;
  components?: readonly WorkerComponent[];
  testEndpoints?: string;
}): Partial<Record<WorkerComponent, Readonly<Record<string, string>>>> {
  if (input.testEndpoints === undefined) return {};
  if (!isDisposableTestEnvironment(input.environmentId)) {
    throw new Error('worker_test_endpoint_override_test_environment_required');
  }
  if (input.components !== undefined || input.component !== 'ar-management') {
    throw new Error('worker_test_endpoint_override_management_component_required');
  }
  if (input.testEndpoints !== 'enabled' && input.testEndpoints !== 'disabled') {
    throw new Error('worker_test_endpoint_override_mode_invalid');
  }
  return {
    'ar-management': {
      ENABLE_TEST_ENDPOINTS: input.testEndpoints === 'enabled' ? 'true' : 'false',
    },
  };
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
    throw new Error(`deployment_config_invalid:${resolve(configPath)}`, { cause: error });
  }
}

export async function getInitialDeploymentWorkspaceVersionMismatches(input: {
  rootDir: string;
  productVersion: string;
  config: AuthrimConfig;
}): Promise<string[]> {
  const requiredComponents = [
    ...CORE_WORKER_COMPONENTS,
    ...(input.config.components.loginUi !== false ? (['ar-login-ui'] as const) : []),
    ...(input.config.components.adminUi !== false ? (['ar-admin-ui'] as const) : []),
  ];
  const mismatches: string[] = [];
  for (const component of requiredComponents) {
    const version = await getPackageVersion(join(input.rootDir, 'packages', component));
    if (version !== input.productVersion) {
      mismatches.push(`${component}=${version ?? 'missing'}`);
    }
  }
  return mismatches;
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
  onProgress: (message: string) => void,
  options: {
    includeSetupMachineKeyPair: boolean;
    baseDir: string;
    environment: string;
    configuredEmail: AuthrimConfig['features']['email'];
  }
): Promise<void> {
  if (!existsSync(keysDir)) {
    return;
  }

  await promotePendingEmailSecrets({
    baseDir: options.baseDir,
    environment: options.environment,
    keysDir,
    configuredEmail: options.configuredEmail,
  });
  const result = await ensureSupplementalKeyFiles(keysDir, {
    includeSetupMachineKeyPair: options.includeSetupMachineKeyPair,
  });
  if (result.createdFiles.length === 0) {
    return;
  }

  onProgress(`Created ${result.createdFiles.length} supplemental key file(s) in ${keysDir}`);
  for (const filePath of result.createdFiles) {
    onProgress(`  - ${filePath.replace(`${keysDir}/`, '')}`);
  }
}

async function promptForMissingControlTokens(
  secrets: Record<string, string>,
  missing: readonly string[]
): Promise<Record<string, string>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return secrets;

  const next = { ...secrets };
  console.log(
    chalk.yellow(
      [
        'Create two distinct account-scoped tokens once in Cloudflare Dashboard > My Profile > API Tokens.',
        'Wrangler OAuth is temporary and is not stored as a Control Worker secret.',
        'These masked values are uploaded directly to ar-control and are not written to generated files.',
      ].join('\n')
    )
  );
  if (missing.includes('CLOUDFLARE_D1_API_TOKEN')) {
    next.CLOUDFLARE_D1_API_TOKEN = (
      await password({
        message: 'Cloudflare D1 Edit token for the Control Worker:',
        mask: '*',
        validate: (value) => (value.trim() ? true : 'The D1 token is required.'),
      })
    ).trim();
  }
  if (missing.includes('CLOUDFLARE_WORKERS_API_TOKEN')) {
    next.CLOUDFLARE_WORKERS_API_TOKEN = (
      await password({
        message: 'Cloudflare Workers Scripts Edit token for the Control Worker:',
        mask: '*',
        validate: (value) => {
          const normalized = value.trim();
          if (!normalized) return 'The Workers token is required.';
          if (normalized === next.CLOUDFLARE_D1_API_TOKEN) {
            return 'Use a distinct token so D1 and Workers permissions remain separated.';
          }
          return true;
        },
      })
    ).trim();
  }
  return next;
}

interface PendingControlTokenBootstrap {
  ownership: CloudflareTokenOwnership;
  /** A fully staged generation must resume without asking for or issuing another bootstrap token. */
  recoverWithoutBootstrapToken?: boolean;
}

async function prepareControlTokenBootstrap(input: {
  accountId: string;
}): Promise<PendingControlTokenBootstrap> {
  const wranglerCredential = await getCloudflareApiToken();
  const ownership =
    wranglerCredential?.source === 'oauth'
      ? await selectPreferredCloudflareTokenOwnership({
          accountId: input.accountId,
          wranglerOAuthToken: wranglerCredential.token,
        })
      : 'user';
  return { ownership };
}

async function promptForControlTokenBootstrap(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  openTemplate?: boolean;
}): Promise<string> {
  const endDate = buildCloudflareBootstrapTokenEndDate();
  const templateUrl = buildCloudflareBootstrapTemplateUrl({
    accountId: input.accountId,
    environment: input.environment,
    ownership: input.ownership,
  });
  if (input.openTemplate !== false) {
    console.log(
      chalk.gray(
        'Cloudflare Dashboard login is independent from Wrangler OAuth, so Dashboard may ask you to sign in again.'
      )
    );
    if (!(await openExternalHttpsUrl(templateUrl))) {
      console.log(chalk.yellow('Open this Cloudflare token template URL:'));
      console.log(templateUrl);
    } else {
      console.log(chalk.gray(`Opened Cloudflare ${input.ownership}-owned token template.`));
    }
    console.log(
      chalk.yellow(
        `Before creating the token, set End Date to ${endDate} (UTC). Cloudflare template links cannot pre-fill TTL fields.`
      )
    );
  } else {
    console.log(
      chalk.yellow(
        'Resuming a checkpointed token cutover. Enter the exact same bootstrap token; do not create a replacement.'
      )
    );
  }
  return (
    await password({
      message: 'One-time Cloudflare bootstrap token:',
      mask: '*',
      validate: (value) => (value.trim() ? true : 'The one-time bootstrap token is required.'),
    })
  ).trim();
}

export async function consumeControlBootstrapTokenFile(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const invalidPathError = 'The Cloudflare bootstrap token path must be a regular file.';
  const invalidTokenError = 'The Cloudflare bootstrap token file contains an invalid token.';
  const token = await consumePrivateFileSecurely(
    absolutePath,
    {
      // The largest accepted token plus a trailing CRLF. Bound the read before allocating/parsing.
      maxBytes: 4098,
      invalidError: invalidPathError,
      permissionsError: 'The Cloudflare bootstrap token file must have mode 0600.',
      tooLargeError: invalidTokenError,
    },
    (content) => {
      const value = content.trim();
      if (value.length < 20 || value.length > 4096 || /\s/u.test(value)) {
        throw new Error(invalidTokenError);
      }
      return value;
    }
  );
  if (token === null) throw new Error(invalidPathError);
  return token;
}

// =============================================================================
// Deploy Command
// =============================================================================

export async function deployCommand(options: DeployCommandOptions): Promise<void> {
  console.log(chalk.bold('\n🚀 Authrim Deploy\n'));

  // Check prerequisites
  const spinner = ora(t('prereq.checking')).start();
  let prerequisiteSpinnerSettled = false;
  let auth: Awaited<ReturnType<typeof checkAuth>>;
  try {
    if (!(await isWranglerInstalled())) {
      spinner.fail(t('prereq.wranglerNotInstalled'));
      prerequisiteSpinnerSettled = true;
      console.log(chalk.yellow('\n' + t('prereq.wranglerInstallHint')));
      console.log('  npm install -g wrangler');
      process.exit(1);
    }

    auth = await checkAuth();
    if (!auth.isLoggedIn) {
      spinner.fail(t('prereq.notLoggedIn'));
      prerequisiteSpinnerSettled = true;
      console.log(chalk.yellow('\n' + t('prereq.loginHint')));
      console.log('  wrangler login');
      process.exit(1);
    }

    spinner.succeed(t('prereq.loggedInAs', { email: auth.email || '-' }));
    prerequisiteSpinnerSettled = true;
  } catch (error) {
    if (!prerequisiteSpinnerSettled) {
      spinner.fail(t('error.generic'));
    }
    throw error;
  }

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

  if (options.env && !options.config) {
    // Environment specified - try the canonical structure first, then legacy. A parent checkout
    // and its nested authrim source can both contain `.authrim/<env>`; selecting the first one
    // would make the same command target different resources depending on cwd traversal order.
    const searchDirs = [baseDir, join(baseDir, 'authrim')];
    const canonicalCandidates = searchDirs.flatMap((searchDir) => {
      if (!existsSync(searchDir)) return [];
      const paths = getEnvironmentPaths({ baseDir: searchDir, env: options.env! });
      return existsSync(paths.config) || existsSync(paths.lock) ? [{ searchDir, paths }] : [];
    });
    if (canonicalCandidates.length > 1) {
      throw new Error('deployment_environment_source_root_ambiguous');
    }
    const canonicalCandidate = canonicalCandidates[0];
    if (canonicalCandidate) {
      const { searchDir, paths } = canonicalCandidate;
      configPath = paths.config;
      if (existsSync(paths.config)) {
        config = await loadConfig(paths.config);
      } else if (existsSync(paths.lock)) {
        throw new Error(`deployment_config_recovery_required:${paths.config}`);
      }
      baseDir = searchDir;
      if (!options.source) rootDir = findAuthrimSource(searchDir) || searchDir;
    } else {
      for (const searchDir of searchDirs) {
        if (!existsSync(searchDir)) continue;
        configPath = findLegacyConfigPath(searchDir, options.env);
        if (!existsSync(configPath)) continue;
        config = await loadConfig(configPath);
        if (!config) continue;
        baseDir = searchDir;
        if (!options.source) rootDir = findAuthrimSource(searchDir) || searchDir;
        break;
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
    const canonicalCandidates = searchDirs.flatMap((searchDir) =>
      existsSync(searchDir)
        ? listEnvironments(searchDir).flatMap((environment) => {
            const paths = getEnvironmentPaths({ baseDir: searchDir, env: environment });
            return existsSync(paths.config) || existsSync(paths.lock)
              ? [{ searchDir, environment, paths }]
              : [];
          })
        : []
    );
    if (canonicalCandidates.length > 1) {
      throw new Error('deployment_environment_selection_ambiguous_use_env');
    }
    const canonicalCandidate = canonicalCandidates[0];
    if (canonicalCandidate) {
      const { searchDir, paths } = canonicalCandidate;
      configPath = paths.config;
      if (existsSync(paths.config)) config = await loadConfig(configPath);
      if (config || existsSync(paths.lock)) {
        baseDir = searchDir;
        if (!options.source) rootDir = findAuthrimSource(searchDir) || searchDir;
        if (!config && existsSync(paths.lock)) {
          throw new Error(`deployment_config_recovery_required:${paths.config}`);
        }
      }
    }

    // Legacy layouts have no canonical environment index. Search them only when no canonical
    // candidate exists; otherwise a malformed canonical config must fail closed.
    if (!canonicalCandidate) {
      for (const searchDir of searchDirs) {
        if (!existsSync(searchDir)) continue;
        configPath = findLegacyConfigPath(searchDir, options.env);
        if (!existsSync(configPath)) continue;
        config = await loadConfig(configPath);
        if (!config) continue;
        baseDir = searchDir;
        if (!options.source) rootDir = findAuthrimSource(searchDir) || searchDir;
        break;
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
  const resolvedConfigPath = resolve(configPath);
  const canonicalConfigPath = resolve(getEnvironmentPaths({ baseDir, env }).config);
  const configDirectory = dirname(resolvedConfigPath);
  const canonicalEnvironmentDirectory = dirname(canonicalConfigPath);
  const configIsUnderCanonicalEnvironmentRoot =
    dirname(configDirectory) === dirname(canonicalEnvironmentDirectory);
  if (
    config.environment.prefix !== env ||
    (configIsUnderCanonicalEnvironmentRoot && resolvedConfigPath !== canonicalConfigPath)
  ) {
    throw new Error('deployment_config_environment_mismatch');
  }
  const packagesDir = join(rootDir, 'packages');
  if (!existsSync(packagesDir) || !existsSync(join(packagesDir, 'ar-auth'))) {
    throw new Error(`deployment_source_not_found:${rootDir}`);
  }
  const targetProductVersion = await getRootProductVersion(rootDir);
  const placementModeByComponent = resolveTestPlacementOverrides({
    environmentId: env,
    component: options.component,
    components: options.components,
    placement: options.placement,
  });
  const testEndpointVarsByComponent = resolveTestEndpointVarOverrides({
    environmentId: env,
    component: options.component,
    components: options.components,
    testEndpoints: options.testEndpoints,
  });
  const loadedLock = await loadLockFileAuto(baseDir, env);
  if (!loadedLock.lock) {
    console.error(chalk.red('\nLock file not found'));
    console.log(chalk.yellow('Run "authrim-setup init" first to provision resources.'));
    process.exit(1);
  }
  if (loadedLock.lock.env !== env) {
    throw new Error('deployment_lock_environment_mismatch');
  }
  const initialDeploymentFromLock = isInitialDeploymentLock(loadedLock.lock);
  if (initialDeploymentFromLock) {
    const workspaceVersionMismatches = await getInitialDeploymentWorkspaceVersionMismatches({
      rootDir,
      productVersion: targetProductVersion,
      config,
    });
    if (workspaceVersionMismatches.length > 0) {
      throw new Error(
        `deployment_workspace_version_mismatch:${targetProductVersion}:${workspaceVersionMismatches.join(',')}`
      );
    }
  }
  const authenticatedAccountId = auth.accountId ?? (await getAccountId());
  if (!authenticatedAccountId) {
    throw new Error('cloudflare_account_id_required_for_deployment');
  }
  if (config.cloudflare?.accountId && config.cloudflare.accountId !== authenticatedAccountId) {
    throw new Error('cloudflare_config_account_id_mismatch');
  }
  let configPersistenceRequired = false;
  if (!config.cloudflare?.accountId) {
    config = AuthrimConfigSchema.parse({
      ...config,
      cloudflare: { accountId: authenticatedAccountId },
      updatedAt: new Date().toISOString(),
    });
    configPersistenceRequired = true;
  }
  // A newly provisioned environment has an empty Control D1. Its authority table is
  // created by the schema phase below, so querying it here would abort the first deploy
  // with `no such table: control_environments`. Resumed initial deployments have either
  // a release checkpoint or deployed workers and can safely inspect the authority.
  const hasInitialDeploymentProgress =
    Object.keys(loadedLock.lock.workers ?? {}).length > 0 ||
    loadedLock.lock.releaseUpdate !== undefined;

  let pendingControlTokenBootstrap: PendingControlTokenBootstrap | null = null;
  let directControlTokenEvidence: DirectControlTokenEvidence | null = null;
  let promptedDirectControlSecrets: Record<string, string> = {};
  let existingControlTokenBootstrapReady = false;
  let checkpointedControlTokenAuthority:
    | Awaited<ReturnType<typeof readControlProvisioningAuthority>>
    | undefined;
  let controlTokenBootstrapPlanningDeferred = false;
  const focusedDeployment = Boolean(options.component || options.components);
  if (options.adoptLegacyQueueIdentities && options.dryRun) {
    throw new Error('legacy_queue_adoption_dry_run_unsupported');
  }
  if (options.adoptLegacyQueueIdentities && focusedDeployment) {
    throw new Error('legacy_queue_adoption_full_deploy_required');
  }
  if (options.recoverLegacyWorkerDeployments && options.dryRun) {
    throw new Error('legacy_worker_recovery_dry_run_unsupported');
  }
  if (options.recoverLegacyWorkerDeployments && (focusedDeployment || options.skipUi)) {
    throw new Error('legacy_worker_recovery_full_deploy_required');
  }
  const controlIncluded = options.component
    ? options.component === 'ar-control'
    : options.components
      ? options.components.includes('ar-control')
      : true;
  const planMissingControlProvisioningCredentials = async (): Promise<void> => {
    controlTokenBootstrapPlanningDeferred = false;
    // A one-use token file is the non-interactive equivalent of choosing the default
    // bootstrap flow at the prompt. Keep the secret unread until the Control Worker is
    // deployed and ready; consumeControlBootstrapTokenFile() then validates and unlinks it.
    if (options.cloudflareBootstrapTokenFile) {
      pendingControlTokenBootstrap = await prepareControlTokenBootstrap({
        accountId: authenticatedAccountId,
      });
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'The Control Worker needs Cloudflare API credentials for automatic provisioning. Non-interactive setup cannot prompt for a one-time bootstrap token, so provide --cloudflare-bootstrap-token-file or distinct CLOUDFLARE_D1_API_TOKEN and CLOUDFLARE_WORKERS_API_TOKEN values.'
      );
    }
    const mode = await select({
      message: 'Control Worker provisioning mode',
      choices: [
        {
          value: 'bootstrap',
          name: 'Automatic provisioning (one-time bootstrap token)',
          description:
            'The Control Worker needs this temporary token to create scoped D1, Workers, KV, and R2 credentials.',
        },
        {
          value: 'skip',
          name: 'Skip Automatic provisioning',
          description: 'Store no Cloudflare token on Control; setup remains the operator executor.',
        },
        {
          value: 'direct',
          name: 'Direct split tokens (advanced)',
          description: 'Enter distinct pre-created D1 and Workers Scripts tokens.',
        },
      ],
      default: 'bootstrap',
    });
    if (mode === 'skip') {
      const disabledConfig = AuthrimConfigSchema.parse({
        ...config,
        updatedAt: new Date().toISOString(),
        controlPlane: { automaticProvisioning: false },
      });
      Object.assign(config, disabledConfig);
      configPersistenceRequired = true;
      console.log(
        chalk.yellow(
          'Automatic provisioning is OFF. Pending Admin operations can be executed by setup.'
        )
      );
    } else if (mode === 'direct') {
      promptedDirectControlSecrets = await promptForMissingControlTokens({}, [
        'CLOUDFLARE_D1_API_TOKEN',
        'CLOUDFLARE_WORKERS_API_TOKEN',
      ]);
    } else {
      pendingControlTokenBootstrap = await prepareControlTokenBootstrap({
        accountId: authenticatedAccountId,
      });
    }
  };
  if (
    requiresInitialControlTokenBootstrap({
      isInitialDeployment: initialDeploymentFromLock,
      dryRun: options.dryRun === true,
      controlIncluded,
      automaticProvisioningEnabled: config.controlPlane?.automaticProvisioning === true,
    })
  ) {
    const controlDatabaseId = loadedLock.lock.d1.CONTROL_DB?.id;
    if (controlDatabaseId && hasInitialDeploymentProgress) {
      checkpointedControlTokenAuthority = await readControlProvisioningAuthority({
        environmentId: env,
        controlDatabaseName: controlDatabaseId,
      });
      existingControlTokenBootstrapReady = await hasReadyControlTokenBootstrap({
        environmentId: env,
        controlDatabaseName: controlDatabaseId,
        resourceClasses: resolveControlTokenResourceClasses(config),
        secretSink: new WranglerControlSecretSink({
          workerName: `${env}-ar-control`,
          cwd: rootDir,
        }),
      });
    }
    const directD1 = process.env.CLOUDFLARE_D1_API_TOKEN?.trim();
    const directWorkers = process.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim();
    if (
      checkpointedControlTokenAuthority &&
      checkpointedControlTokenAuthority.bootstrapPhase !== 'none'
    ) {
      if (checkpointedControlTokenAuthority.bootstrapTokenOwnership === 'none') {
        throw new Error('control_token_bootstrap_checkpoint_invalid');
      }
      pendingControlTokenBootstrap = {
        ownership: checkpointedControlTokenAuthority.bootstrapTokenOwnership,
      };
    } else if (
      isTokenlessPendingControlProvisioningAuthority(checkpointedControlTokenAuthority ?? null)
    ) {
      // A staged generation may exist locally even though the process stopped before the
      // corresponding Control authority write. Defer all prompts until the artifact is securely
      // loaded again under the environment operation lock.
      controlTokenBootstrapPlanningDeferred = true;
    } else if (
      !existingControlTokenBootstrapReady &&
      !(directD1 && directWorkers && directD1 !== directWorkers)
    ) {
      await planMissingControlProvisioningCredentials();
    }
  }

  console.log(chalk.cyan(`\nEnvironment: ${env}`));
  console.log(chalk.cyan(`Source: ${rootDir}`));
  console.log(chalk.cyan(`Config: ${configPath}`));
  const plannedConfigText = existsSync(configPath) ? await readFile(configPath, 'utf-8') : null;

  // Load lock file (support both structures)
  const { lock, path: lockPath, type: structureType } = loadedLock;
  console.log(chalk.cyan(`Lock: ${lockPath}`));
  let currentLock = lock!;
  const isInitialDeployment = initialDeploymentFromLock;
  if (options.recoverLegacyWorkerDeployments && !isInitialDeployment) {
    throw new Error('legacy_worker_recovery_initial_deploy_required');
  }
  if (isInitialDeployment && focusedDeployment) {
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
  const migrationsRootResult = await findMigrationsRoot(rootDir, undefined, { strictRoot: true });
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
  const hasInitialWorkerCheckpoint =
    isInitialDeployment && currentLock.releaseUpdate?.phase === 'workers_deployed';
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
  const deploymentOperationKind = resolveDeployOperationKind({
    isInitialDeployment,
    operationKind: options.operationKind,
  });
  const hasUnversionedLegacyWorkerState =
    isInitialDeployment &&
    currentLock.releaseUpdate === undefined &&
    Object.keys(currentLock.workers ?? {}).length > 0;
  let explicitLegacyInitialRecoveryVerified = false;
  if (hasUnversionedLegacyWorkerState && options.recoverLegacyWorkerDeployments) {
    assertExplicitLegacyInitialWorkerRecoveryState({
      lock: currentLock,
      environment: env,
      targetVersion: targetProductVersion,
      enabledComponents: [
        ...CORE_WORKER_COMPONENTS,
        ...(config.components.loginUi !== false ? ['ar-login-ui'] : []),
        ...(config.components.adminUi !== false ? ['ar-admin-ui'] : []),
      ],
    });
    explicitLegacyInitialRecoveryVerified = true;
  }
  const deploymentGuard = evaluateReleaseDeploymentGuard(
    currentLock,
    targetProductVersion,
    deploymentOperationKind,
    isInitialDeployment && initialManifestChecksum
      ? {
          releaseManifestChecksum: initialManifestChecksum,
          ...(initialRelease?.draft
            ? {
                initialDraft: {
                  manifest: initialRelease.manifest,
                  targets: initialTargets,
                },
              }
            : {}),
          ...(explicitLegacyInitialRecoveryVerified
            ? { explicitLegacyInitialRecoveryVerified: true }
            : {}),
        }
      : undefined
  );
  if (!deploymentGuard.allowed) {
    console.error(
      chalk.red(`\n${releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion)}`)
    );
    process.exit(1);
  }
  let resumeInitialHandoff =
    hasInitialWorkerCheckpoint &&
    currentLock.releaseUpdate?.initialWorkerRedeployRequired !== true &&
    currentLock.releaseUpdate?.targetVersion === targetProductVersion &&
    currentLock.releaseUpdate.manifestChecksum === initialManifestChecksum;
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
    let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
    let uiSetupMachineAccessAttempted = false;
    let uiSetupMachineAccessCleanupDone = false;
    let uiSetupMachineAccessKeysDir: string | undefined;
    let uiAdminDatabaseIdentifier: string | undefined;
    let uiSetupMachineAccessCleanupError: Error | undefined;
    let uiDeploymentError: Error | undefined;
    const cleanupUiSetupMachineAccess = async (): Promise<boolean> => {
      if (
        !uiSetupMachineAccessAttempted ||
        uiSetupMachineAccessCleanupDone ||
        !uiSetupMachineAccessKeysDir ||
        !uiAdminDatabaseIdentifier
      ) {
        return uiSetupMachineAccessCleanupDone || !uiSetupMachineAccessAttempted;
      }
      try {
        const result = await cleanupSetupMachineAccessInD1(
          env,
          uiSetupMachineAccessKeysDir,
          undefined,
          { databaseIdentifier: uiAdminDatabaseIdentifier }
        );
        if (result.success) {
          uiSetupMachineAccessCleanupDone = true;
          uiSetupMachineAccessCleanupError = undefined;
          return true;
        }
        uiSetupMachineAccessCleanupError = new Error(
          `setup_machine_access_cleanup_failed:${result.error ?? 'unknown'}`
        );
      } catch (error) {
        uiSetupMachineAccessCleanupError =
          error instanceof Error ? error : new Error('setup_machine_access_cleanup_failed');
      }
      return false;
    };
    try {
      if (operationLock) {
        // Package-level UI build inputs and wrangler.toml are shared by every environment in this
        // checkout. Keep the environment lock outermost, then hold the workspace lock through
        // config generation, build, deployment, verification, and temporary-file cleanup.
        deployConfigLock = await acquireDeployConfigLock({
          baseDir: rootDir,
          env,
          operation: `deploy:${uiComponent}`,
        });
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
        assertFixedD1ResourceIdentities({
          environment: env,
          lock: currentLock,
          databases: await listD1Databases(),
        });
        uiAdminDatabaseIdentifier = currentLock.d1.DB_ADMIN?.id;
        if (!uiAdminDatabaseIdentifier) {
          throw new Error('admin_database_required_for_ui_deployment');
        }
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
        await ensureSupplementalKeysForDeploy(
          uiKeysDir,
          (message) => {
            console.log(chalk.gray(message));
          },
          {
            includeSetupMachineKeyPair: uiComponent === 'ar-login-ui',
            baseDir,
            environment: env,
            configuredEmail: config.features.email,
          }
        );
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
          throw new Error('router_readiness_failed');
        }

        uiSetupMachineAccessAttempted = true;
        uiSetupMachineAccessKeysDir = keysDir;
        const setupMachineResult = await ensureSetupMachineAccessInD1(
          env,
          config,
          keysDir,
          (msg) => console.log(chalk.gray(`  ${msg}`)),
          { databaseIdentifier: uiAdminDatabaseIdentifier }
        );
        if (!setupMachineResult.success) {
          console.error(
            chalk.red(
              `Setup machine access bootstrap failed: ${setupMachineResult.error || 'unknown error'}`
            )
          );
          throw new Error('setup_machine_access_bootstrap_failed');
        }

        let loginUiClientError: Error | undefined;
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
            throw new Error('login_ui_client_creation_failed');
          }
        } catch (error) {
          loginUiClientError =
            error instanceof Error ? error : new Error('login_ui_client_creation_failed');
        }

        // A successful second cleanup is a recovered transient, not a failed deployment. This is
        // deliberately separate from Wrangler's inner D1 retry because OAuth credential refresh
        // can complete only after the first command invocation has returned.
        if (!(await cleanupUiSetupMachineAccess())) {
          await cleanupUiSetupMachineAccess();
        }

        if (loginUiClientError && uiSetupMachineAccessCleanupError) {
          throw new AggregateError(
            [loginUiClientError, uiSetupMachineAccessCleanupError],
            'Login UI client setup and temporary machine-access cleanup both failed.'
          );
        }
        if (uiSetupMachineAccessCleanupError) throw uiSetupMachineAccessCleanupError;
        if (loginUiClientError) throw loginUiClientError;
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
              databaseIdentifier: uiAdminDatabaseIdentifier,
              onProgress: (message) => console.log(chalk.gray(`  ${message}`)),
            })
          : undefined;

      let uiWorkerOwnership: WorkerScriptOwnershipGuard | undefined;
      if (!options.dryRun) {
        const prepared = await prepareManagedWorkerScriptOwnership({
          lock: currentLock,
          lockPath,
          targets: [{ component: uiComponent, workerName: `${env}-${uiComponent}` }],
        });
        if (prepared.changed) {
          currentLock = prepared.lock;
          await saveLockFile(currentLock, lockPath);
        }
        uiWorkerOwnership = prepared.guard;
      }

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
        deployConfigLockProof: deployConfigLock?.proof,
        workerScriptOwnership: uiWorkerOwnership,
        onProgress: (msg) => console.log(chalk.gray(`  ${msg}`)),
      });

      if (!result.success) {
        console.error(chalk.red(`\n${uiComponent} deployment failed: ${result.error}`));
        throw new Error('ui_worker_deployment_failed');
      }

      if (!options.dryRun) {
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
          allowPublicDnsFallback: Boolean(
            uiComponent === 'ar-login-ui'
              ? config.urls?.loginUi?.custom
              : config.urls?.adminUi?.custom
          ),
        });
        if (!httpReadiness.ready) {
          throw new Error(
            `UI Worker HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
          );
        }
        if (!result.deployedAt || !result.cloudflareVersionId || !result.cloudflareScriptTag) {
          throw new Error(`ui_worker_deployment_exact_identity_unavailable:${uiComponent}`);
        }
        const version = await getPackageVersion(join(rootDir, 'packages', uiComponent));
        currentLock = clearProvisionalWorkerScriptOwnership(
          {
            ...currentLock,
            workers: {
              ...currentLock.workers,
              [uiComponent]: {
                name: result.projectName,
                deployedAt: result.deployedAt,
                version: version ?? undefined,
                cloudflareVersionId: result.cloudflareVersionId,
                cloudflareScriptTag: result.cloudflareScriptTag,
              },
            },
            updatedAt: new Date().toISOString(),
          },
          [uiComponent]
        );
        await saveLockFile(currentLock, lockPath);
      }

      console.log(chalk.green(`\n✓ ${uiComponent} deployed successfully`));
      console.log(chalk.gray(`  Project: ${result.projectName}`));
    } catch (error) {
      uiDeploymentError = error instanceof Error ? error : new Error('ui_worker_deployment_failed');
    } finally {
      if (!(await cleanupUiSetupMachineAccess())) {
        await cleanupUiSetupMachineAccess();
      }
      try {
        await deployConfigLock?.release();
      } finally {
        await operationLock?.release();
      }
    }

    if (uiDeploymentError && uiSetupMachineAccessCleanupError) {
      throw new AggregateError(
        [uiDeploymentError, uiSetupMachineAccessCleanupError],
        'UI deployment and temporary machine-access cleanup both failed.'
      );
    }
    if (uiSetupMachineAccessCleanupError) throw uiSetupMachineAccessCleanupError;
    if (uiDeploymentError) throw uiDeploymentError;
    return;
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
    componentsToDeply = resolveApiDeployComponents(options);
    console.log(chalk.cyan(`\nDeploying single component: ${options.component}`));
  } else if (options.components) {
    componentsToDeply = resolveApiDeployComponents(options);
    console.log(chalk.cyan(`\nComponents to deploy: ${componentsToDeply.length}`));
    for (const component of componentsToDeply) console.log(chalk.gray(`  • ${component}`));
  } else {
    componentsToDeply = resolveApiDeployComponents(options);

    console.log(chalk.cyan(`\nComponents to deploy: ${componentsToDeply.length}`));
    for (const comp of componentsToDeply) {
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
  if (options.adoptLegacyQueueIdentities && !options.yes) {
    const confirmed = await confirm({
      message:
        'Replace only legacy Queue lock sentinels (id == name) with the exact immutable IDs from this Cloudflare account?',
      default: false,
    });
    if (!confirmed) {
      console.log(chalk.yellow('Legacy Queue identity adoption cancelled.'));
      return;
    }
  }
  if (options.recoverLegacyWorkerDeployments && !options.yes) {
    const confirmed = await confirm({
      message:
        'Recover exact ownership of canonical Workers left by an interrupted initial deployment, then redeploy and verify them?',
      default: false,
    });
    if (!confirmed) {
      console.log(chalk.yellow('Legacy Worker deployment recovery cancelled.'));
      return;
    }
  }

  const legacyWorkerRecoveryTargets: LegacyWorkerDeploymentTarget[] = [
    ...(componentsToDeply ?? []).map((component) => ({
      component,
      workerName: getWorkerName(env, component),
      expectedPackageVersion: targetProductVersion,
    })),
    ...UI_WORKER_COMPONENTS.filter((component) =>
      component === 'ar-login-ui'
        ? config.components.loginUi !== false
        : config.components.adminUi !== false
    ).map((component) => ({
      component,
      workerName: `${env}-${component}`,
      expectedPackageVersion: targetProductVersion,
    })),
  ];

  const operationLock = options.dryRun
    ? undefined
    : await acquireEnvironmentOperationLock(lockPath, 'deploy');
  let deployConfigLock: Awaited<ReturnType<typeof acquireDeployConfigLock>> | undefined;
  let deploymentSecrets: Record<string, string> = {};
  let cleanupEphemeralSetupMachineAccess: (() => Promise<boolean>) | undefined;
  let lockedCoreDatabaseIdentifier: string | undefined;
  let lockedPiiDatabaseIdentifier: string | undefined;
  let lockedAdminDatabaseIdentifier: string | undefined;
  const requireLockedCoreDatabaseIdentifier = (): string => {
    if (!lockedCoreDatabaseIdentifier) {
      throw new Error('core_database_required_for_bootstrap');
    }
    return lockedCoreDatabaseIdentifier;
  };
  const requireLockedAdminDatabaseIdentifier = (): string => {
    if (!lockedAdminDatabaseIdentifier) {
      throw new Error('admin_database_required_for_bootstrap');
    }
    return lockedAdminDatabaseIdentifier;
  };
  const requireLockedPiiDatabaseIdentifier = (): string => {
    if (!lockedPiiDatabaseIdentifier) {
      throw new Error('pii_database_required_for_migration');
    }
    return lockedPiiDatabaseIdentifier;
  };
  const abortLockedDeployment = (reason: string): never => {
    process.exitCode = 1;
    throw new Error(reason);
  };
  let activeDeploySpinner: ReturnType<typeof ora> | undefined;
  const startDeploySpinner = (text: string): ReturnType<typeof ora> => {
    const nextSpinner = ora(text).start();
    activeDeploySpinner = nextSpinner;
    return nextSpinner;
  };
  const failUnexpectedActiveSpinner = (): void => {
    if (activeDeploySpinner?.isSpinning) {
      activeDeploySpinner.fail(t('error.deployFailed'));
    }
  };
  let apiBuildCompleted = false;
  const buildPackagesForDeployment = async (): Promise<void> => {
    const buildSpinner = startDeploySpinner('Building packages...');
    const buildResult = await buildApiPackages({
      rootDir,
      onProgress: (msg) => {
        updateOraSpinner(buildSpinner, msg);
      },
    });

    if (!buildResult.success) {
      buildSpinner.fail('Failed to build packages');
      console.error(chalk.red(`\nBuild error: ${buildResult.error}`));
      console.log(chalk.yellow('\nYou can try building manually:'));
      console.log(chalk.cyan('  pnpm install'));
      console.log(chalk.cyan('  pnpm run build:api'));
      abortLockedDeployment('worker_package_build_failed');
    }

    buildSpinner.succeed('Packages built successfully');
    apiBuildCompleted = true;
    console.log('');
  };
  try {
    if (operationLock) {
      // The package wrangler files, bootstrap configs, UI build inputs, and build outputs are
      // workspace-global. Acquire this only after the environment lock and release it first.
      deployConfigLock = await acquireDeployConfigLock({
        baseDir: rootDir,
        env,
        operation: 'deploy',
      });
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
      if (configPersistenceRequired) {
        const persistedConfig = AuthrimConfigSchema.parse({
          ...config,
          updatedAt: new Date().toISOString(),
        });
        Object.assign(config, persistedConfig);
        await writePrivateFileAtomically(
          configPath,
          `${JSON.stringify(persistedConfig, null, 2)}\n`
        );
        configPersistenceRequired = false;
      }

      if (options.recoverLegacyWorkerDeployments) {
        const recoveredCompletedWorkerPhase = resumeInitialHandoff;
        const recovery = await adoptLegacyWorkerDeployments({
          lock: currentLock,
          environment: env,
          authenticatedAccountId,
          configuredAccountId: config.cloudflare?.accountId,
          productVersion: targetProductVersion,
          targets: legacyWorkerRecoveryTargets,
          requireAllTargets: recoveredCompletedWorkerPhase,
          allowNoop: explicitLegacyInitialRecoveryVerified,
        });
        currentLock = recovery.lock;
        if (recoveredCompletedWorkerPhase) {
          if (!initialManifestChecksum) {
            throw new Error('legacy_worker_recovery_release_manifest_required');
          }
          // Provider metadata cannot prove that the orphaned active version contains the exact
          // local build artifacts. Persist this before continuing so a crash after adoption still
          // forces every recovered Worker through the normal deploy and readiness gates.
          currentLock = withReleaseUpdateState(currentLock, {
            targetVersion: targetProductVersion,
            phase: 'workers_deployed',
            manifestChecksum: initialManifestChecksum,
            initialWorkerRedeployRequired: true,
          });
          resumeInitialHandoff = false;
        }
        if (recovery.adopted.length > 0 || recoveredCompletedWorkerPhase) {
          await saveLockFile(currentLock, lockPath);
          const checkpoint = await loadLockFile(lockPath);
          if (!checkpoint) {
            throw new Error('legacy_worker_recovery_checkpoint_verification_failed');
          }
          if (recovery.adopted.length > 0) {
            assertLegacyWorkerDeploymentAdoptionPersisted(checkpoint, env, recovery.adopted);
          }
          currentLock = checkpoint;
        }

        // Re-enter the normal immutable-tag ownership guard after the explicit checkpoint. This
        // performs a fresh provider read and catches delete/recreate races before any schema or
        // Worker mutation proceeds.
        const verifiedOwnership = await prepareManagedWorkerScriptOwnership({
          lock: currentLock,
          lockPath,
          targets: legacyWorkerRecoveryTargets,
        });
        currentLock = verifiedOwnership.lock;
      }

      // Bootstrap planning happens before waiting for the cross-process environment lock. Re-read
      // both durable authority and the active Worker secret generation under that lock so a
      // concurrent CLI/Web completion cannot cause another token generation or token prompt.
      const lockedControlDatabaseId = currentLock.d1.CONTROL_DB?.id;
      if (
        lockedControlDatabaseId &&
        hasInitialDeploymentProgress &&
        config.controlPlane?.automaticProvisioning === true
      ) {
        const [lockedAuthority, lockedPendingArtifact] = await Promise.all([
          readControlProvisioningAuthority({
            environmentId: env,
            controlDatabaseName: lockedControlDatabaseId,
          }),
          loadPendingControlBootstrap({ baseDir: rootDir, environment: env }),
        ]);
        if (lockedPendingArtifact?.accountId !== undefined) {
          if (
            lockedPendingArtifact.accountId !== authenticatedAccountId ||
            lockedPendingArtifact.environment !== env
          ) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_token_bootstrap_checkpoint_mismatch'
            );
          }
        }
        if (
          lockedAuthority?.automaticProvisioningEnabled === true &&
          lockedAuthority.capabilityState === 'ready'
        ) {
          const lockedReady = await hasReadyControlTokenBootstrap({
            environmentId: env,
            controlDatabaseName: lockedControlDatabaseId,
            resourceClasses: resolveControlTokenResourceClasses(config),
            secretSink: new WranglerControlSecretSink({
              workerName: `${env}-ar-control`,
              cwd: rootDir,
            }),
          });
          if (!lockedReady) {
            throw new Error('control_token_bootstrap_ready_generation_mismatch');
          }
          const reconciled = reconcileControlSecretGenerationWorkerLock({
            lock: currentLock,
            authority: lockedAuthority,
          });
          if (reconciled.changed) {
            currentLock = reconciled.lock;
            await saveLockFile(currentLock, lockPath);
          }
          pendingControlTokenBootstrap = null;
          existingControlTokenBootstrapReady = true;
        } else if (
          lockedAuthority?.bootstrapPhase === 'pending_revocation' ||
          lockedAuthority?.bootstrapPhase === 'cutover_verified'
        ) {
          if (lockedAuthority.bootstrapTokenOwnership === 'none') {
            throw new Error('control_token_bootstrap_checkpoint_invalid');
          }
          pendingControlTokenBootstrap = {
            ownership: lockedAuthority.bootstrapTokenOwnership,
          };
          controlTokenBootstrapPlanningDeferred = false;
        } else if (
          lockedPendingArtifact &&
          isTokenlessPendingControlProvisioningAuthority(lockedAuthority)
        ) {
          pendingControlTokenBootstrap = {
            ownership: lockedPendingArtifact.ownership,
            recoverWithoutBootstrapToken: true,
          };
          controlTokenBootstrapPlanningDeferred = false;
        } else if (lockedPendingArtifact) {
          // A staged child-token generation is authority only for the exact tokenless pending
          // Control transition. Never ignore it and issue a replacement generation.
          throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
        }
      }
      if (controlTokenBootstrapPlanningDeferred) {
        const directD1 = process.env.CLOUDFLARE_D1_API_TOKEN?.trim();
        const directWorkers = process.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim();
        if (!(directD1 && directWorkers && directD1 !== directWorkers)) {
          await planMissingControlProvisioningCredentials();
        } else {
          controlTokenBootstrapPlanningDeferred = false;
        }
      }
    }

    // A deterministic local build failure must not leave a new environment with a partially
    // migrated schema or Control-plane state. Existing environments keep the previous ordering
    // so release-update compatibility checks continue to run before a potentially expensive build.
    if (isInitialDeployment && !resumeInitialHandoff && !options.skipBuild && !options.dryRun) {
      await buildPackagesForDeployment();
    }

    console.log('');

    if (!options.dryRun) {
      await ensureSupplementalKeysForDeploy(
        getResolvedKeysDir(),
        (message) => {
          console.log(chalk.gray(message));
        },
        {
          includeSetupMachineKeyPair: !focusedDeployment,
          baseDir,
          environment: env,
          configuredEmail: config.features.email,
        }
      );
    }

    // Control API credentials are intentionally process-only. Validate them before schema,
    // resource, DNS, or Worker mutations so an initial deployment cannot stop half configured.
    if (!resumeInitialHandoff && !options.skipSecrets) {
      const keysDir = getResolvedKeysDir();
      deploymentSecrets = await loadDeploySecretsFromKeys(
        existsSync(keysDir) ? keysDir : undefined,
        componentsToDeply
      );
      deploymentSecrets = { ...deploymentSecrets, ...promptedDirectControlSecrets };
    }
    const automaticProvisioning = config.controlPlane?.automaticProvisioning === true;
    if (
      isInitialDeployment &&
      !options.dryRun &&
      componentsToDeply?.includes('ar-control') &&
      automaticProvisioning &&
      pendingControlTokenBootstrap === null &&
      !existingControlTokenBootstrapReady
    ) {
      let missingControlSecrets = getMissingRequiredDeploySecrets(
        deploymentSecrets,
        ['ar-control'],
        { automaticProvisioning }
      );
      deploymentSecrets = await promptForMissingControlTokens(
        deploymentSecrets,
        missingControlSecrets
      );
      missingControlSecrets = getMissingRequiredDeploySecrets(deploymentSecrets, ['ar-control'], {
        automaticProvisioning,
      });
      if (missingControlSecrets.length > 0) {
        console.error(
          chalk.red(
            `\nMissing required Control Worker secrets: ${missingControlSecrets.join(', ')}`
          )
        );
        console.error(
          chalk.gray(
            'Provide the Cloudflare control-plane tokens in the setup process environment and rerun deploy.'
          )
        );
        abortLockedDeployment('required_control_worker_secrets_missing');
      }
      const accountId = config.cloudflare?.accountId ?? (await getAccountId());
      if (!accountId) throw new Error('cloudflare_account_id_required_for_token_validation');
      directControlTokenEvidence = await validateDirectControlTokensWithEvidence({
        accountId,
        d1Token: deploymentSecrets.CLOUDFLARE_D1_API_TOKEN!,
        workersToken: deploymentSecrets.CLOUDFLARE_WORKERS_API_TOKEN!,
      });
    }

    if (!options.dryRun) {
      const resourceReconciliationSpinner = startDeploySpinner(
        'Refreshing Cloudflare resource IDs...'
      );
      try {
        const canonicalQueues = getRequiredQueues(env);
        const requiredQueues = config.features.queue?.enabled === true ? canonicalQueues : [];
        const verifyQueues =
          options.adoptLegacyQueueIdentities === true ||
          requiredQueues.length > 0 ||
          Object.keys(currentLock.queues ?? {}).length > 0;
        const requiredR2Buckets = [
          ...new Map(
            [
              ...Object.entries(currentLock.r2 ?? {}).map(([binding, bucket]) => ({
                binding,
                name: bucket.name,
              })),
              ...getRequiredR2Buckets(env, {
                includeFeatureBuckets: config.features.r2?.enabled === true,
              }),
            ].map((bucket) => [bucket.name, bucket] as const)
          ).values(),
        ];
        const [databases, namespaces, queues, r2Buckets] = await Promise.all([
          listD1Databases(),
          listKVNamespaces(),
          verifyQueues ? listQueues({ strictOutput: true, requireIds: true }) : Promise.resolve([]),
          listR2Buckets({ throwOnError: true }),
        ]);
        const d1Reconciliation = reconcileD1ResourcesInLock(currentLock, env, databases);
        const kvReconciliation = reconcileSharedKVResourcesInLock(
          d1Reconciliation.lock,
          env,
          namespaces
        );
        let legacyQueueAdoptionEvidence: LegacyQueueIdentityAdoptionEvidence[] = [];
        let queueReconciliationLock = kvReconciliation.lock;
        if (options.adoptLegacyQueueIdentities) {
          const adoption = adoptLegacyQueueIdentities({
            lock: queueReconciliationLock,
            environment: env,
            authenticatedAccountId,
            configuredAccountId: config.cloudflare?.accountId,
            liveQueues: queues,
            canonicalQueues,
          });
          queueReconciliationLock = adoption.lock;
          legacyQueueAdoptionEvidence = adoption.adopted;
        }
        const queueReconciliation = reconcileQueueResourcesInLock(
          queueReconciliationLock,
          queues,
          requiredQueues
        );
        const missingResources = [
          ...d1Reconciliation.missingBindings.map((missing) => ({ type: 'D1', ...missing })),
          ...kvReconciliation.missingBindings.map((missing) => ({ type: 'KV', ...missing })),
          ...queueReconciliation.missingBindings.map((missing) => ({
            type: 'Queue',
            ...missing,
          })),
          ...requiredR2Buckets
            .filter((required) => !r2Buckets.some((bucket) => bucket.name === required.name))
            .map((missing) => ({ type: 'R2', ...missing })),
        ];
        const identityMismatches = [
          ...d1Reconciliation.identityMismatches.map((mismatch) => ({
            type: 'D1',
            ...mismatch,
          })),
          ...kvReconciliation.identityMismatches.map((mismatch) => ({
            type: 'KV',
            ...mismatch,
          })),
          ...queueReconciliation.identityMismatches.map((mismatch) => ({
            type: 'Queue',
            ...mismatch,
          })),
        ];

        if (identityMismatches.length > 0) {
          resourceReconciliationSpinner.fail('Cloudflare resource identity changed');
          for (const mismatch of identityMismatches) {
            console.log(
              chalk.red(
                `  • ${mismatch.type} ${mismatch.binding}: ${mismatch.expectedName} ` +
                  `(locked ${mismatch.lockedId ?? 'missing'}, live ${mismatch.liveId ?? 'unavailable'})`
              )
            );
          }
          console.error(
            chalk.gray(
              'A same-name resource has a different immutable ID. Setup will not adopt it automatically; restore the original resource or explicitly recreate the environment.'
            )
          );
          abortLockedDeployment('cloudflare_resource_identity_mismatch');
        }

        if (missingResources.length > 0) {
          resourceReconciliationSpinner.fail('Required Cloudflare resources are missing');
          for (const missing of missingResources) {
            console.log(chalk.red(`  • ${missing.type} ${missing.binding}: ${missing.name}`));
          }
          abortLockedDeployment('required_cloudflare_resources_missing');
        }

        currentLock = queueReconciliation.lock;
        lockedCoreDatabaseIdentifier = currentLock.d1.DB?.id;
        lockedPiiDatabaseIdentifier = currentLock.d1.DB_PII?.id;
        lockedAdminDatabaseIdentifier = currentLock.d1.DB_ADMIN?.id;
        if (
          !lockedCoreDatabaseIdentifier ||
          !lockedPiiDatabaseIdentifier ||
          !lockedAdminDatabaseIdentifier
        ) {
          throw new Error('fixed_bootstrap_databases_required');
        }
        const updatedResources = [
          ...d1Reconciliation.updatedBindings.map((binding) => `D1 ${binding}`),
          ...kvReconciliation.updatedBindings.map((binding) => `KV ${binding}`),
          ...legacyQueueAdoptionEvidence.map((adopted) => `Queue ${adopted.binding}`),
        ];
        if (updatedResources.length > 0) {
          await saveLockFile(currentLock, lockPath);
          if (legacyQueueAdoptionEvidence.length > 0) {
            const checkpoint = await loadLockFile(lockPath);
            if (!checkpoint) {
              throw new Error('legacy_queue_adoption_checkpoint_verification_failed');
            }
            assertLegacyQueueIdentityAdoptionPersisted(
              checkpoint,
              env,
              legacyQueueAdoptionEvidence
            );
            currentLock = checkpoint;
          }
          resourceReconciliationSpinner.succeed(
            `Refreshed Cloudflare bindings: ${updatedResources.join(', ')}`
          );
        } else {
          resourceReconciliationSpinner.succeed('D1, KV, Queue, and R2 resources are current');
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'cloudflare_resource_identity_mismatch' ||
            error.message === 'required_cloudflare_resources_missing')
        ) {
          throw error;
        }
        resourceReconciliationSpinner.fail('Failed to refresh Cloudflare resource IDs');
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        abortLockedDeployment('cloudflare_resource_reconciliation_failed');
      }
    }

    // A new environment is schema-first: no Worker (including a temporary UI binding target)
    // may be published until every automatically managed D1 database is on the exact
    // release manifest selected by the product version.
    if (
      isInitialDeployment &&
      !resumeInitialHandoff &&
      !options.dryRun &&
      initialRelease &&
      initialManifestChecksum
    ) {
      // An append-only draft resume is authorized by the exact schema/release evidence in the
      // existing checkpoint. Keep that evidence durable until the newly appended migrations have
      // all succeeded; replacing it with a new `planned` checksum first would make a failed run
      // impossible to authenticate and retry.
      if (!deploymentGuard.appendOnlyInitialDraftResume) {
        currentLock = withReleaseUpdateState(currentLock, {
          targetVersion: targetProductVersion,
          phase: 'planned',
          manifestChecksum: initialManifestChecksum,
          manualTargets: [...initialManualTargetIds],
        });
        await saveLockFile(currentLock, lockPath);
      }

      const initialMigrationSpinner = startDeploySpinner('Applying initial release schema...');
      const automaticInitialTargets = initialTargets.filter((target) => target.automatic);
      const initialSchemaPlan = buildReleaseSchemaUpdatePlan({
        targetManifest: initialRelease.manifest,
        targets: automaticInitialTargets,
      });
      const result = await applyReleaseSchemaUpdatePlan({
        plan: initialSchemaPlan,
        manifest: initialRelease.manifest,
        migrationsRoot: migrationsRootResult.path,
        concurrency: 2,
        backfillLegacyChecksums: !initialRelease.draft,
        onProgress: (message) => {
          updateOraSpinner(initialMigrationSpinner, message);
        },
      });
      if (!result.success) {
        initialMigrationSpinner.fail('Initial release schema failed');
        for (const failed of result.results.filter((candidate) => !candidate.success)) {
          console.error(
            chalk.red(`  ${failed.targetId}: ${failed.error ?? 'unknown migration error'}`)
          );
        }
        abortLockedDeployment('initial_release_schema_failed');
      }
      const migratedTargetIds = new Set(result.results.map((target) => target.targetId));
      const missingAutomaticTargets = automaticInitialTargets.filter(
        (target) => !migratedTargetIds.has(target.id)
      );
      if (missingAutomaticTargets.length > 0) {
        initialMigrationSpinner.fail('Initial release schema evidence is incomplete');
        for (const target of missingAutomaticTargets) {
          console.error(chalk.red(`  Missing migration result: ${target.id}`));
        }
        abortLockedDeployment('initial_release_schema_evidence_incomplete');
      }
      initialMigrationSpinner.succeed('Initial release schema applied');

      const appliedTargetIds = [
        ...result.results.map((target) => target.targetId),
        ...initialManualTargetIds,
      ];
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

    if (
      structureType === 'new' &&
      lock &&
      !options.dryRun &&
      !resumeInitialHandoff &&
      deploymentOperationKind !== 'worker_redeploy'
    ) {
      const controlDatabase = currentLock.d1.CONTROL_DB;
      const migrationReleaseBucket = currentLock.r2?.MIGRATION_RELEASES;
      if (!controlDatabase) throw new Error('control_database_required_for_release_publication');
      if (!migrationReleaseBucket) {
        throw new Error('migration_release_bucket_required_for_release_publication');
      }
      const releaseSpinner = startDeploySpinner('Publishing migration release artifact...');
      try {
        const verifyMigrationBucketOwnership = () =>
          assertR2BucketOwnershipForUse({
            ...migrationReleaseBucket,
            environment: env,
            binding: 'MIGRATION_RELEASES',
          });
        await verifyMigrationBucketOwnership();
        const publication = await publishAndActivateMigrationRelease({
          migrationsRoot: migrationsRootResult.path,
          manifestPath: deploymentRelease.path,
          bucketName: migrationReleaseBucket.name,
          controlDatabaseId: controlDatabase.id,
          environmentId: env,
          actorId: 'setup:deploy',
          verifyBucketOwnership: verifyMigrationBucketOwnership,
          onProgress: (message) => {
            updateOraSpinner(releaseSpinner, message);
          },
        });
        releaseSpinner.succeed(
          `Migration release ${publication.artifact.releaseId} published (${publication.artifact.streamIds.length} D1 streams)`
        );
      } catch (error) {
        releaseSpinner.fail('Migration release publication failed');
        throw error;
      }
    }

    // Refresh generated wrangler configs from the current config/lock before deployment.
    // This prevents stale bindings such as send_email from surviving across setup upgrades.
    if (structureType === 'new' && lock && !resumeInitialHandoff) {
      const mayMutateTenantTopology = deploymentOperationKind !== 'worker_redeploy';
      if (mayMutateTenantTopology) {
        const controlPlaneBootstrapSpinner = startDeploySpinner(
          'Checking Control Plane D1 bindings...'
        );
        if (options.dryRun) {
          // A fresh Control DB has no bootstrap tables until the schema-first deploy runs.
          // Keep dry-run mutation-free and avoid querying or creating tenant resources here.
          controlPlaneBootstrapSpinner.succeed(
            'Control Plane bootstrap planned after schema apply'
          );
        } else {
          const controlPlaneBootstrapResult = await ensureInitialControlPlaneResources({
            env,
            config,
            lock: currentLock,
            rootDir,
            release: deploymentRelease,
            onProgress: (msg) => {
              updateOraSpinner(controlPlaneBootstrapSpinner, msg);
            },
          });
          if (controlPlaneBootstrapResult.success) {
            if (controlPlaneBootstrapResult.skipped) {
              controlPlaneBootstrapSpinner.succeed('Control Plane bootstrap not required');
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
              controlPlaneBootstrapSpinner.succeed(
                `Control Plane bindings ready (${controlPlaneBootstrapResult.createdCount ?? 0} created)`
              );
            }
          } else {
            controlPlaneBootstrapSpinner.fail('Control Plane bootstrap failed');
            console.log(chalk.red(`  ${controlPlaneBootstrapResult.error || 'unknown error'}`));
            abortLockedDeployment('initial_control_plane_bootstrap_failed');
          }
        }
      } else {
        const topologyIssues = inspectInitialControlPlaneTopology({
          env,
          config,
          lock: currentLock,
          productVersion: targetProductVersion,
          manifest: deploymentRelease.manifest,
        });
        if (topologyIssues.length > 0) {
          console.error(
            chalk.red(
              '\nControl Plane topology is incomplete. A Worker-only redeploy cannot create databases or apply schema.'
            )
          );
          for (const issue of topologyIssues) {
            console.error(chalk.red(`  • ${issue.binding}: ${issue.reason}`));
          }
          console.log(
            chalk.yellow(
              `Rerun authrim-setup init --env ${env} before bootstrap handoff acceptance, or repair the resource from Admin UI after handoff.`
            )
          );
          abortLockedDeployment('initial_control_plane_topology_incomplete');
        }
      }

      const masterSpinner = startDeploySpinner('Refreshing generated wrangler configs...');
      if (!options.dryRun && currentLock.workers?.['ar-control']) {
        try {
          const projected = await refreshLockFromControlGeneratedState({
            lock: currentLock,
            environmentId: env,
          });
          currentLock = projected.lock;
          await saveLockFile(currentLock, lockPath);
          updateOraSpinner(
            masterSpinner,
            `Loaded Control DB bindings (+${projected.added.length} ~${projected.changed.length} -${projected.removed.length})`
          );
        } catch (error) {
          masterSpinner.fail('Control DB generated-state projection failed');
          console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
          abortLockedDeployment('control_generated_state_projection_failed');
        }
      }
      if (!options.dryRun && currentLock.workers?.['ar-control']) {
        try {
          const controlDatabaseId = currentLock.d1.CONTROL_DB?.id;
          if (!controlDatabaseId) throw new Error('control_database_id_required');
          const keyState = await loadControlGeneratedKeyState({
            controlDatabaseName: controlDatabaseId,
            environmentId: env,
          });
          if (!keyState) throw new Error('control_generated_key_state_missing');
          const stagedSigningKeys = await loadControlStagedSigningKeys({
            controlDatabaseName: controlDatabaseId,
            environmentId: env,
          });
          await reconcileLocalControlKeyFiles({
            keysDir: getResolvedKeysDir(),
            controlKeyState: keyState,
            stagedSigningKeys,
          });
          const keyProjection = projectControlGeneratedKeyState(currentLock, keyState);
          currentLock = keyProjection.lock;
          if (keyProjection.changed) await saveLockFile(currentLock, lockPath);
        } catch (error) {
          masterSpinner.fail('Control DB key-state projection failed');
          console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
          abortLockedDeployment('control_key_state_projection_failed');
        }
      }
      const resourceIds = await buildWorkerDeploymentResourceIds({
        lock: currentLock,
        config,
        environmentId: env,
        components: CORE_WORKER_COMPONENTS,
        onProgress: (message) => {
          updateOraSpinner(masterSpinner, message);
        },
      });
      const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
        baseDir,
        env,
        dryRun: options.dryRun,
        capabilityManifestBaseDir: rootDir,
        placementModeByComponent,
        onProgress: (msg) => {
          updateOraSpinner(masterSpinner, msg);
        },
      });

      if (!masterResult.success) {
        masterSpinner.fail('Failed to refresh generated wrangler configs');
        for (const error of masterResult.errors) {
          console.log(chalk.red(`  • ${error}`));
        }
        abortLockedDeployment('generated_wrangler_config_refresh_failed');
      }

      masterSpinner.succeed(`Refreshed ${masterResult.files.length} generated wrangler config(s)`);

      if (!options.dryRun) {
        const controlDatabaseId = currentLock.d1?.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          console.error(chalk.red('\nCONTROL_DB is required for desired Worker inventory.'));
          abortLockedDeployment('control_database_required_for_worker_inventory');
        }
        const inventorySpinner = startDeploySpinner('Registering desired Worker inventory...');
        try {
          const inventory = await compileControlWorkerInventoryFromArtifacts({
            baseDir: rootDir,
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
            registeredBy: 'setup:deploy',
            onProgress: (message) => {
              updateOraSpinner(inventorySpinner, message);
            },
          });
          if (isInitialDeployment) {
            await registerInitialControlTopology({
              environmentId: env,
              tenantId: config.tenant?.name?.trim() || 'default',
              controlDatabaseName: controlDatabaseId,
              lock: currentLock,
              release: deploymentRelease.manifest,
              releaseDraft: deploymentRelease.draft,
              automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
              placementPolicy: config.tenant.placementPolicy,
            });
            const configNamespaceId = currentLock.kv.AUTHRIM_CONFIG?.id;
            if (!configNamespaceId) {
              throw new Error('authrim_config_namespace_required_for_region_policy');
            }
            await ensureInitialTenantRegionShardConfig({
              environmentId: env,
              tenantId: config.tenant?.name?.trim() || 'default',
              controlDatabaseName: controlDatabaseId,
              configNamespaceId,
            });
          }
          await initializeControlKeyState({
            controlDatabaseId,
            environmentId: env,
            keysDir: getResolvedKeysDir(),
            actorId: 'setup:deploy',
          });
          const keyState = await loadControlGeneratedKeyState({
            controlDatabaseName: controlDatabaseId,
            environmentId: env,
          });
          if (!keyState) throw new Error('control_generated_key_state_missing');
          const stagedSigningKeys = await loadControlStagedSigningKeys({
            controlDatabaseName: controlDatabaseId,
            environmentId: env,
          });
          await reconcileLocalControlKeyFiles({
            keysDir: getResolvedKeysDir(),
            controlKeyState: keyState,
            stagedSigningKeys,
          });
          const keyProjection = projectControlGeneratedKeyState(currentLock, keyState);
          currentLock = keyProjection.lock;
          if (keyProjection.changed) await saveLockFile(currentLock, lockPath);
          const externalSources = await discoverExternalCapabilities({ baseDir: rootDir });
          const pluginBundleBucket = currentLock.r2?.PLUGIN_BUNDLES;
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
            baseDir: rootDir,
            enabled: config.features.pluginDynamicWorkers.enabled,
            sources: externalSources,
            bucketName: pluginBundleBucket?.name,
            pluginRunnerDatabaseId: currentLock.d1?.PLUGIN_RUNNER_DB?.id,
            verifyBucketOwnership: verifyPluginBundleOwnership,
            onProgress: (message) => {
              updateOraSpinner(inventorySpinner, message);
            },
          });
          await registerExternalCapabilities({
            controlDatabaseName: controlDatabaseId,
            environmentId: env,
            sources: externalSources,
            registeredBy: 'setup:deploy',
          });
          inventorySpinner.succeed(`Registered ${inventory.length} desired Worker(s)`);
        } catch (error) {
          inventorySpinner.fail('Desired Worker inventory registration failed');
          console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
          abortLockedDeployment('desired_worker_inventory_registration_failed');
        }
      }
    }

    // Check wrangler.toml sync status (only for new structure)
    if (structureType === 'new' && !resumeInitialHandoff) {
      const packagesDir = join(rootDir, 'packages');

      if (existsSync(packagesDir)) {
        const syncSpinner = startDeploySpinner('Checking wrangler.toml sync status...');

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
              const resyncSpinner = startDeploySpinner('Syncing wrangler configs...');
              const syncResult = await syncWranglerConfigs(
                {
                  baseDir,
                  env,
                  packagesDir,
                  force: true,
                  dryRun: options.dryRun,
                  onProgress: (msg) => {
                    updateOraSpinner(resyncSpinner, msg);
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
              updateOraSpinner(syncSpinner, 'Syncing wrangler configs to packages...');
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
    if (!existsSync(sampleWranglerPath) && lock && !resumeInitialHandoff) {
      const genSpinner = startDeploySpinner('Generating wrangler configs from lock file...');

      try {
        const resourceIds = await buildWorkerDeploymentResourceIds({
          lock: currentLock,
          config,
          environmentId: env,
          components: CORE_WORKER_COMPONENTS,
          onProgress: (message) => {
            updateOraSpinner(genSpinner, message);
          },
        });
        const masterResult = await saveMasterWranglerConfigs(config, resourceIds, {
          baseDir,
          env,
          dryRun: options.dryRun,
          capabilityManifestBaseDir: rootDir,
          components: [...CORE_WORKER_COMPONENTS],
          onProgress: (message) => updateOraSpinner(genSpinner, message),
        });
        if (!masterResult.success) {
          throw new Error(`generated_wrangler_config_failed:${masterResult.errors.join(',')}`);
        }
        const { syncWranglerConfigs } = await import('../../core/wrangler-sync.js');
        const syncResult = await syncWranglerConfigs({
          baseDir,
          env,
          packagesDir: join(rootDir, 'packages'),
          force: true,
          dryRun: options.dryRun,
          components: [...CORE_WORKER_COMPONENTS],
          onProgress: (message) => updateOraSpinner(genSpinner, message),
        });
        if (!syncResult.success) {
          throw new Error(`wrangler_config_sync_failed:${syncResult.errors.join(',')}`);
        }

        genSpinner.succeed(`Generated ${syncResult.synced.length} wrangler config(s)`);
      } catch (error) {
        genSpinner.fail('Failed to generate wrangler configs');
        console.error(chalk.red(`\nError: ${error}`));
        abortLockedDeployment('generated_wrangler_config_generation_failed');
      }
    }

    // The bootstrap Auth config is an initial-deploy artifact, not a fallback generated only when
    // the full configs are absent. Recreate it from the same lock projection on every deploy so an
    // interrupted first deployment can resume without accepting a stale binding set.
    if (lock && !options.dryRun && !resumeInitialHandoff) {
      const controlDir = join(rootDir, 'packages', 'ar-control');
      if (existsSync(controlDir)) {
        const resourceIds = buildResourceIdsFromLock(currentLock, config);
        const bootstrapConfig = generateWranglerConfig(
          'ar-control',
          config,
          resourceIds,
          workersSubdomain ?? undefined,
          { includeControlSmokeBindings: false }
        );
        await writePrivateFileAtomically(
          join(controlDir, 'wrangler.bootstrap.toml'),
          toToml(bootstrapConfig, env),
          0o644
        );
      }
      const authDir = join(rootDir, 'packages', 'ar-auth');
      if (existsSync(authDir)) {
        const resourceIds = buildResourceIdsFromLock(currentLock, config);
        const bootstrapConfig = generateWranglerConfig(
          'ar-auth',
          config,
          resourceIds,
          workersSubdomain ?? undefined,
          { includeAuthAccountProvisioner: false }
        );
        await writePrivateFileAtomically(
          join(authDir, 'wrangler.bootstrap.toml'),
          toToml(bootstrapConfig, env),
          0o644
        );
      }
      const bridgeDir = join(rootDir, 'packages', 'ar-bridge');
      if (existsSync(bridgeDir)) {
        const resourceIds = buildResourceIdsFromLock(currentLock, config);
        const bootstrapConfig = generateWranglerConfig(
          'ar-bridge',
          config,
          resourceIds,
          workersSubdomain ?? undefined,
          { includeExternalIdpAccountProvisioner: false }
        );
        await writePrivateFileAtomically(
          join(bridgeDir, 'wrangler.bootstrap.toml'),
          toToml(bootstrapConfig, env),
          0o644
        );
      }
    }

    // Build packages first (unless skipped or dry-run)
    if (!resumeInitialHandoff && !options.skipBuild && !options.dryRun && !apiBuildCompleted) {
      await buildPackagesForDeployment();
    }

    if (!options.dryRun) {
      await assertLocalDeploymentCapacity({
        rootDir,
        phase: 'release deployment',
        minimumFreeBytes: MINIMUM_BUILD_FREE_BYTES,
      });
    }

    // Load secrets once; Wrangler uploads each Worker's subset with its code/version.
    if (!options.skipSecrets) {
      const keysDir = getResolvedKeysDir();
      if (Object.keys(deploymentSecrets).length > 0) {
        console.log(
          chalk.gray(
            `Prepared ${Object.keys(deploymentSecrets).length} secret value(s) for atomic Worker deployment.`
          )
        );
      } else {
        console.log(
          chalk.yellow(`No deployment secrets found in ${keysDir} or process environment`)
        );
      }
      console.log('');
    }

    console.log(
      chalk.bold(
        resumeInitialHandoff ? 'Resuming initial deployment...\n' : '🔨 Deploying workers...\n'
      )
    );

    const shouldEnsureWildcardDns =
      !resumeInitialHandoff && !options.dryRun && componentsToDeply.includes('ar-router');

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
        await ensureWildcardDnsForMultiTenant(
          config,
          (message) => {
            console.log(chalk.gray(message));
          },
          undefined,
          {
            get: (role) => currentLock.dns?.[role],
            persist: async (entry) => {
              currentLock = withDnsOwnershipEntry(currentLock, entry);
              await saveLockFile(currentLock, lockPath);
            },
          }
        );
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
          abortLockedDeployment('wildcard_dns_manual_action_required');
        }
        console.error(
          chalk.red(
            `Failed to prepare wildcard DNS: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        abortLockedDeployment('wildcard_dns_preparation_failed');
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
      automaticProvisioning: automaticProvisioning && pendingControlTokenBootstrap === null,
      cloudflareAccountId: config.cloudflare?.accountId,
      varsByComponent: testEndpointVarsByComponent,
      ...(!isInitialDeployment
        ? {
            deploymentLease: {
              controlDatabaseId:
                currentLock.d1.CONTROL_DB?.id ??
                (() => {
                  throw new Error('control_database_required_for_worker_deployment_lease');
                })(),
              environmentId: env,
              actorId: 'setup:deploy',
              accountId: config.cloudflare?.accountId,
              required: true,
            },
          }
        : {}),
      cleanupLegacyStaticSecrets: true,
      deployConfigLockProof: deployConfigLock?.proof,
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

    if (!options.dryRun) {
      const workerOwnershipTargets = [
        ...componentsToDeply.map((component) => ({
          component,
          workerName: getWorkerName(env, component),
        })),
        ...(!focusedDeployment && !options.skipUi
          ? UI_WORKER_COMPONENTS.filter((component) =>
              component === 'ar-login-ui'
                ? config.components.loginUi !== false
                : config.components.adminUi !== false
            ).map((component) => ({ component, workerName: `${env}-${component}` }))
          : []),
        ...(!resumeInitialHandoff &&
        missingUiBindingTargets.loginUi &&
        (focusedDeployment || options.skipUi)
          ? [{ component: 'ar-login-ui', workerName: `${env}-ar-login-ui` }]
          : []),
        ...(!resumeInitialHandoff &&
        missingUiBindingTargets.adminUi &&
        (focusedDeployment || options.skipUi)
          ? [{ component: 'ar-admin-ui', workerName: `${env}-ar-admin-ui` }]
          : []),
      ];
      const ownership = await prepareManagedWorkerScriptOwnership({
        lock: currentLock,
        lockPath,
        targets: workerOwnershipTargets,
      });
      if (ownership.changed) {
        currentLock = ownership.lock;
        await saveLockFile(currentLock, lockPath);
      }
      deployOptions.workerScriptOwnership = ownership.guard;
    }

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

    const summary = resumeInitialHandoff
      ? buildInitialHandoffResumeSummary({ lock: currentLock })
      : await deployAll(deployOptions, componentsToDeply);
    if (resumeInitialHandoff) {
      console.log(
        chalk.cyan(
          `Resuming initial deployment from ${summary.results.length} locked Worker version(s); no Worker traffic was changed.`
        )
      );
      console.log(chalk.cyan('Verifying Worker Cron Triggers before continuing deployment...'));
      await reconcileWorkerCronTriggers(deployOptions, componentsToDeply);
    }

    // Re-resolve workers.dev URLs with the current account subdomain. Init may have run while
    // Wrangler OAuth was expired and therefore persisted the unsuffixed fallback URL.
    const deploymentWorkersSubdomain = await getWorkersSubdomain();
    let deploymentApiBaseUrl = resolveIssuerUrl(config, {
      env,
      workersSubdomain: deploymentWorkersSubdomain,
    });
    if (!options.dryRun && !options.component && summary.failedCount === 0) {
      const workerDeploymentSpinner = startDeploySpinner('Verifying Worker deployments...');
      const workerDeploymentResult = await waitForWorkerDeploymentsReady({
        targets: summary.results
          .filter((result) => result.success)
          .map((result) => ({
            workerName: result.workerName,
            deployedAt: result.deployedAt,
            expectedVersionId: result.cloudflareVersionId,
          })),
        onProgress: (msg) => {
          updateOraSpinner(workerDeploymentSpinner, msg);
        },
      });
      if (workerDeploymentResult.ready) {
        workerDeploymentSpinner.succeed('Worker deployments are visible');
      } else {
        workerDeploymentSpinner.fail('Worker deployments did not become visible');
        console.error(
          chalk.red(`  ${workerDeploymentResult.error || 'unknown verification error'}`)
        );
        abortLockedDeployment('worker_deployment_visibility_failed');
      }

      if (!resumeInitialHandoff && summary.results.some((result) => result.success)) {
        currentLock = updateLockWithDeployments(currentLock, summary.results);
      }

      if (
        isInitialDeployment &&
        !resumeInitialHandoff &&
        initialRelease &&
        initialManifestChecksum
      ) {
        buildInitialHandoffResumeSummary({ lock: currentLock });
        currentLock = withReleaseUpdateState(currentLock, {
          targetVersion: targetProductVersion,
          phase: 'workers_deployed',
          manifestChecksum: initialManifestChecksum,
          initialWorkerRedeployRequired: false,
        });
      }

      if (pendingControlTokenBootstrap) {
        const pendingBootstrap = pendingControlTokenBootstrap;
        const accountId = config.cloudflare?.accountId ?? (await getAccountId());
        const controlDatabaseId = currentLock.d1.CONTROL_DB?.id;
        if (!accountId || !controlDatabaseId) {
          throw new Error('control_token_bootstrap_target_missing');
        }
        const tokenSpinner = startDeploySpinner('Registering scoped Control Worker tokens...');
        let bootstrapToken = '';
        try {
          const checkpointedAuthority = await readControlProvisioningAuthority({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
          });
          const recoveringCutover =
            checkpointedAuthority?.bootstrapPhase === 'pending_revocation' ||
            checkpointedAuthority?.bootstrapPhase === 'cutover_verified';
          const stagedRecovery = pendingBootstrap.recoverWithoutBootstrapToken
            ? await loadPendingControlBootstrap({ baseDir: rootDir, environment: env })
            : null;
          const recoveringBeforeAuthorityWrite =
            pendingBootstrap.recoverWithoutBootstrapToken === true &&
            stagedRecovery !== null &&
            isTokenlessPendingControlProvisioningAuthority(checkpointedAuthority);
          if (pendingBootstrap.recoverWithoutBootstrapToken) {
            if (
              !recoveringBeforeAuthorityWrite ||
              stagedRecovery.accountId !== accountId ||
              stagedRecovery.environment !== env ||
              stagedRecovery.ownership !== pendingBootstrap.ownership
            ) {
              throw new CloudflareTokenBootstrapError(
                'cloudflare_token_bootstrap_checkpoint_mismatch'
              );
            }
          }
          const recoveringBootstrap = recoveringCutover || recoveringBeforeAuthorityWrite;
          const expectedOwnership = recoveringCutover
            ? checkpointedAuthority.bootstrapTokenOwnership === 'none'
              ? pendingBootstrap.ownership
              : checkpointedAuthority.bootstrapTokenOwnership
            : pendingBootstrap.ownership;
          if (!recoveringBootstrap) {
            tokenSpinner.stop();
            console.log(
              chalk.yellow(
                'The Control Worker needs a one-time Cloudflare API token to create its scoped D1, Workers, KV, and R2 credentials.'
              )
            );
            bootstrapToken = options.cloudflareBootstrapTokenFile
              ? await consumeControlBootstrapTokenFile(options.cloudflareBootstrapTokenFile)
              : await promptForControlTokenBootstrap({
                  accountId,
                  environment: env,
                  ownership: expectedOwnership,
                  openTemplate: true,
                });
          }
          const detectedOwnership = recoveringBootstrap
            ? expectedOwnership
            : await detectCloudflareTokenOwnership({
                accountId,
                token: bootstrapToken,
              });
          if (!detectedOwnership) {
            throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_inactive');
          }
          tokenSpinner.start('Registering scoped Control Worker tokens...');
          const completeBootstrap = (token?: string) =>
            completeControlTokenBootstrap({
              accountId,
              environment: env,
              rootDir,
              controlDatabaseName: controlDatabaseId,
              ...(token ? { bootstrapToken: token } : {}),
              ownership: detectedOwnership,
              resourceClasses: resolveControlTokenResourceClasses(config),
            });
          try {
            await completeBootstrap(bootstrapToken || undefined);
          } catch (error) {
            if (
              !recoveringBootstrap ||
              !(error instanceof CloudflareTokenBootstrapError) ||
              error.code !== 'cloudflare_bootstrap_recovery_token_required'
            ) {
              throw error;
            }
            tokenSpinner.stop();
            console.log(
              chalk.yellow(
                'The previous token was revoked before its local confirmation was saved. Enter a new one-time token so setup can verify the old token ID and finish cleanup.'
              )
            );
            bootstrapToken = options.cloudflareBootstrapTokenFile
              ? await consumeControlBootstrapTokenFile(options.cloudflareBootstrapTokenFile)
              : await promptForControlTokenBootstrap({
                  accountId,
                  environment: env,
                  ownership: expectedOwnership,
                  openTemplate: true,
                });
            const recoveryOwnership = await detectCloudflareTokenOwnership({
              accountId,
              token: bootstrapToken,
            });
            if (recoveryOwnership !== expectedOwnership) {
              throw new CloudflareTokenBootstrapError(
                'cloudflare_bootstrap_token_ownership_mismatch'
              );
            }
            tokenSpinner.start('Reconciling revoked bootstrap credentials...');
            await completeBootstrap(bootstrapToken);
          }
          const readyAuthority = await readControlProvisioningAuthority({
            environmentId: env,
            controlDatabaseName: controlDatabaseId,
          });
          if (
            readyAuthority?.capabilityState !== 'ready' ||
            readyAuthority.tokenManagement !== 'setup' ||
            !readyAuthority.secretGeneration
          ) {
            throw new Error('control_token_bootstrap_ready_evidence_missing');
          }
          const reconciled = reconcileControlSecretGenerationWorkerLock({
            lock: currentLock,
            authority: readyAuthority,
          });
          currentLock = reconciled.lock;
          const controlResult = summary.results.find(
            (result) => result.component === 'ar-control' && result.success
          );
          if (!controlResult) {
            throw new Error('control_token_bootstrap_deployment_result_missing');
          }
          controlResult.cloudflareVersionId = readyAuthority.secretGeneration.versionId;
          controlResult.deployedAt = new Date(readyAuthority.updatedAt * 1000).toISOString();
          bootstrapToken = '';
          pendingControlTokenBootstrap = null;
          tokenSpinner.succeed(
            'Automatic provisioning credentials registered and bootstrap revoked'
          );
        } catch (error) {
          bootstrapToken = '';
          tokenSpinner.fail('Automatic provisioning credential bootstrap failed');
          const cleanupRequired =
            error !== null &&
            typeof error === 'object' &&
            'cleanupRequired' in error &&
            error.cleanupRequired === true;
          const bootstrapRetainedForRetry =
            error instanceof CloudflareTokenBootstrapError && error.bootstrapRetainedForRetry;
          console.error(
            bootstrapRetainedForRetry
              ? chalk.yellow(
                  'Cloudflare returned a temporary error. The staged bootstrap transaction remains available for an automatic retry.'
                )
              : chalk.red(
                  cleanupRequired
                    ? 'Cloudflare token cleanup could not be confirmed. Revoke the named Authrim bootstrap/child tokens in Dashboard before retrying.'
                    : 'The bootstrap was rejected or safely cleaned up. Retry Automatic provisioning setup.'
                )
          );
          if (error instanceof CloudflareTokenBootstrapError && error.capabilityDiagnostic) {
            const { issuedFor, probes } = error.capabilityDiagnostic;
            console.error(
              chalk.red(
                `Scoped token capability mismatch (${issuedFor}): ${Object.entries(probes)
                  .map(([resourceClass, capability]) => `${resourceClass}=${capability}`)
                  .join(', ')}`
              )
            );
          }
          throw error;
        }
      } else if (automaticProvisioning && directControlTokenEvidence) {
        const controlDatabaseId = currentLock.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) throw new Error('control_database_id_required');
        const controlDeployment = summary.results.find(
          (result) => result.component === 'ar-control' && result.success
        );
        if (!controlDeployment?.cloudflareVersionId) {
          throw new Error('control_direct_token_deployment_evidence_missing');
        }
        const secretGeneration = await new WranglerControlSecretSink({
          workerName: `${env}-ar-control`,
          cwd: rootDir,
        }).readActiveGeneration();
        if (secretGeneration.versionId !== controlDeployment.cloudflareVersionId) {
          throw new Error('control_direct_token_secret_generation_mismatch');
        }
        await writeControlProvisioningAuthority({
          controlDatabaseName: controlDatabaseId,
          environmentId: env,
          automaticProvisioningEnabled: true,
          tokenOwnership: directControlTokenEvidence.ownership,
          tokenManagement: 'operator',
          capabilityState: 'ready',
          childTokens: directControlTokenEvidence.childTokens,
          secretGeneration,
        });
      }

      const workersSubdomain = await getWorkersSubdomain();
      const workerHttpTargets = buildWorkerHttpReadinessTargets(
        summary.results.filter((result) => result.success),
        workersSubdomain,
        { workersDevEnabled: !config.urls?.api?.custom }
      );
      if (workerHttpTargets.length > 0) {
        const workerHttpSpinner = startDeploySpinner('[5/10] Verifying Worker HTTP health...');
        let workerHttpResult: Awaited<ReturnType<typeof waitForWorkerHttpReady>>;
        try {
          workerHttpResult = await waitForWorkerHttpReady({
            targets: workerHttpTargets,
            allowTenantRegistryBootstrapGap: isInitialDeployment,
            onProgress: (msg) => {
              updateOraSpinner(workerHttpSpinner, `[5/10] ${msg}`);
            },
          });
        } catch (error) {
          workerHttpSpinner.fail('[5/10] Worker HTTP health checks failed unexpectedly');
          throw error;
        }
        if (workerHttpResult.ready) {
          workerHttpSpinner.succeed('[5/10] Worker HTTP health checks passed');
        } else {
          workerHttpSpinner.fail('[5/10] Worker HTTP health checks failed');
          console.error(chalk.red(`  ${workerHttpResult.error || 'unknown health check error'}`));
          abortLockedDeployment('worker_http_health_check_failed');
        }
      }

      if (!resumeInitialHandoff && summary.results.some((result) => result.success)) {
        await saveLockFile(currentLock, lockPath);
        console.log(
          chalk.gray(`\nLock file updated after identity and health checks: ${lockPath}`)
        );
      }

      if (!deploymentApiBaseUrl) {
        deploymentApiBaseUrl = workersSubdomain
          ? `https://${env}-ar-router.${workersSubdomain}.workers.dev`
          : `https://${env}-ar-router.workers.dev`;
      }

      const readinessSpinner = startDeploySpinner(
        '[5/10] Waiting for API router to become reachable...'
      );
      let readinessResult: Awaited<ReturnType<typeof waitForRouterWorkerReady>>;
      try {
        readinessResult = await waitForRouterWorkerReady({
          apiBaseUrl: deploymentApiBaseUrl,
          onProgress: (msg) => {
            updateOraSpinner(readinessSpinner, `[5/10] ${msg}`);
          },
        });
      } catch (error) {
        readinessSpinner.fail('[5/10] API router readiness check failed unexpectedly');
        throw error;
      }

      if (readinessResult.ready) {
        readinessSpinner.succeed('[5/10] API router is reachable');
      } else {
        readinessSpinner.fail('[5/10] API router did not become reachable');
        console.error(
          chalk.red(
            `  ${readinessResult.checkedUrl}: ${readinessResult.error || 'unknown readiness error'}`
          )
        );
        abortLockedDeployment('router_readiness_failed');
      }

      if (isInitialDeployment) {
        const controlDatabaseId = currentLock.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          throw new Error('control_database_required');
        }
        const handoffSpinner = startDeploySpinner(
          '[6/10] Handing initial D1 topology to Control...'
        );
        try {
          const alreadyAccepted =
            resumeInitialHandoff &&
            (await isInitialBootstrapHandoffAccepted({
              environmentId: env,
              controlDatabaseName: controlDatabaseId,
            }));
          if (alreadyAccepted) {
            handoffSpinner.succeed('[6/10] Initial D1 topology was already accepted by Control');
          } else {
            const deployedWorkerCount = new Set(
              summary.results.filter((result) => result.success).map((result) => result.workerName)
            ).size;
            updateOraSpinner(
              handoffSpinner,
              config.controlPlane?.automaticProvisioning === true
                ? `[6/10] Control is verifying ${deployedWorkerCount} Worker(s)...`
                : `[6/10] Setup operator is reconciling ${deployedWorkerCount} Worker(s) with Wrangler OAuth...`
            );
            let acceleratorFallbackReported = false;
            const smokeKeyState = currentLock.controlKeyState?.smokeRpc;
            await waitForInitialBootstrapHandoff({
              environmentId: env,
              controlDatabaseName: controlDatabaseId,
              timeoutMs: 30 * 60_000,
              stallTimeoutMs: 5 * 60_000,
              pollIntervalMs: 2_000,
              onProgress: (message) => {
                updateOraSpinner(handoffSpinner, `[6/10] ${message}`);
              },
              advanceBindings:
                config.controlPlane?.automaticProvisioning === true
                  ? smokeKeyState
                    ? async () => {
                        try {
                          await requestInitialBootstrapAcceleration({
                            apiBaseUrl: deploymentApiBaseUrl!,
                            environmentId: env,
                            keysDir: getResolvedKeysDir(),
                            activeSlot: smokeKeyState.activeSlot,
                            activeKeyId: smokeKeyState.activeKeyId,
                          });
                        } catch (error) {
                          if (!acceleratorFallbackReported) {
                            acceleratorFallbackReported = true;
                            const diagnostic = error instanceof Error ? ` (${error.message})` : '';
                            updateOraSpinner(
                              handoffSpinner,
                              `[6/10] Control bootstrap acceleration unavailable${diagnostic}; continuing with scheduled verification...`
                            );
                          }
                        }
                      }
                    : undefined
                  : async () => {
                      await advanceInitialBootstrapWorkerBindingsAsOperator({
                        controlDatabaseId,
                        controlDatabaseName: controlDatabaseId,
                        environmentId: env,
                        onProgress: (message) => {
                          updateOraSpinner(handoffSpinner, `[6/10] ${message}`);
                        },
                      });
                      if (smokeKeyState) {
                        try {
                          await requestInitialBootstrapAcceleration({
                            apiBaseUrl: deploymentApiBaseUrl!,
                            environmentId: env,
                            keysDir: getResolvedKeysDir(),
                            activeSlot: smokeKeyState.activeSlot,
                            activeKeyId: smokeKeyState.activeKeyId,
                          });
                        } catch (error) {
                          if (!acceleratorFallbackReported) {
                            acceleratorFallbackReported = true;
                            const diagnostic = error instanceof Error ? ` (${error.message})` : '';
                            updateOraSpinner(
                              handoffSpinner,
                              `[6/10] Immediate binding smoke unavailable${diagnostic}; continuing with scheduled verification...`
                            );
                          }
                        }
                      }
                    },
              refreshEvidence: () =>
                recordInitialBootstrapWorkerEvidence({
                  environmentId: env,
                  controlDatabaseName: controlDatabaseId,
                  deployments: summary.results,
                  allowSecretTriggeredVersionAdvanceFor:
                    config.controlPlane?.automaticProvisioning === true
                      ? [`${env}-ar-control`]
                      : undefined,
                }),
              reconcile: () =>
                reconcileInitialBootstrapHandoffAsOperator({
                  controlDatabaseId,
                  executeWorkerBindings: false,
                }),
            });
            handoffSpinner.succeed('[6/10] Initial D1 topology accepted by Control');
          }
        } catch (error) {
          handoffSpinner.fail('[6/10] Initial D1 topology handoff failed');
          throw error;
        }
      }
    }

    // Initial schema was applied before Worker publication. Existing same-version redeploys may
    // still reconcile their installed manifest here; both paths then run post-deploy bootstrap.
    let migrationsSuccess = true;
    let initialTenantSuccess = true;
    let initialNotificationProviderSuccess = true;
    let initialAdminRolesSuccess = true;
    let setupMachineAccessSuccess = true;
    let setupMachineAccessAttempted = false;
    let setupMachineAccessCleanupSuccess = true;
    let setupMachineAccessCleanupDone = false;
    let adminUiBffMachineAccessSuccess = true;
    let defaultCanonicalCatalogSeedSuccess = true;
    let runtimeProfileSeedSuccess = true;
    let uiWorkersSuccess = true;
    cleanupEphemeralSetupMachineAccess = async (): Promise<boolean> => {
      if (
        setupMachineAccessCleanupDone ||
        options.dryRun ||
        focusedDeployment ||
        !setupMachineAccessAttempted
      ) {
        return setupMachineAccessCleanupSuccess;
      }
      const cleanupSpinner = startDeploySpinner('Removing setup machine access...');
      try {
        const cleanupResult = await cleanupSetupMachineAccessInD1(
          env,
          getResolvedKeysDir(),
          (msg) => {
            updateOraSpinner(cleanupSpinner, msg);
          },
          { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
        );
        if (cleanupResult.success) {
          setupMachineAccessCleanupDone = true;
          setupMachineAccessCleanupSuccess = true;
          cleanupSpinner.succeed('Setup machine access removed');
          return true;
        }
        setupMachineAccessCleanupSuccess = false;
        cleanupSpinner.warn('Setup machine access cleanup failed');
        if (cleanupResult.error) {
          console.log(chalk.yellow(`  ${cleanupResult.error}`));
        }
      } catch (error) {
        // Wrangler OAuth and D1 may fail transiently after a successful mutation. Keep the
        // cleanup idempotent and let the bounded same-run retry confirm that access is absent.
        setupMachineAccessCleanupSuccess = false;
        cleanupSpinner.warn('Setup machine access cleanup failed');
        console.log(chalk.yellow(`  ${error instanceof Error ? error.message : String(error)}`));
      }
      return false;
    };
    if (
      !options.skipMigrations &&
      !options.dryRun &&
      !focusedDeployment &&
      summary.failedCount === 0
    ) {
      if (!isInitialDeployment) {
        console.log(chalk.bold('\n📜 Running D1 database migrations...\n'));
      }
      const migrationsSpinner = isInitialDeployment
        ? undefined
        : startDeploySpinner('Running migrations...');

      try {
        const migrationsResult = isInitialDeployment
          ? undefined
          : await runMigrationsForEnvironment(
              env,
              rootDir,
              (msg) => {
                if (migrationsSpinner) updateOraSpinner(migrationsSpinner, msg);
              },
              {
                productVersion: targetProductVersion,
                allowDraft: deploymentRelease.draft,
                databaseIdentifiers: {
                  core: requireLockedCoreDatabaseIdentifier(),
                  pii: requireLockedPiiDatabaseIdentifier(),
                  admin: requireLockedAdminDatabaseIdentifier(),
                },
                strictMigrationsRoot: true,
              }
            );

        if (isInitialDeployment || migrationsResult?.success) {
          if (migrationsResult && migrationsSpinner) {
            migrationsSpinner.succeed(
              `Migrations completed - core: ${migrationsResult.core.appliedCount}, pii: ${migrationsResult.pii.appliedCount}, admin: ${migrationsResult.admin.appliedCount} applied`
            );
          }

          const bootstrapSpinner = startDeploySpinner('Ensuring initial tenant exists...');
          const bootstrapResult = await ensureInitialTenantInD1(
            env,
            config,
            (msg) => {
              updateOraSpinner(bootstrapSpinner, msg);
            },
            { databaseIdentifier: requireLockedCoreDatabaseIdentifier() }
          );

          if (bootstrapResult.success) {
            bootstrapSpinner.succeed(`Initial tenant ready: ${config.tenant.name}`);
          } else {
            bootstrapSpinner.fail('Initial tenant bootstrap failed');
            if (bootstrapResult.error) {
              console.log(chalk.red(`  ${bootstrapResult.error}`));
            }
            initialTenantSuccess = false;
          }

          if (isInitialDeployment && initialTenantSuccess) {
            const notificationProviderSpinner = startDeploySpinner(
              'Materializing initial notification provider order...'
            );
            try {
              const notificationProviderResult =
                await ensureInitialNotificationProviderConfiguration({
                  environmentId: env,
                  config,
                  lock: currentLock,
                  keysDir: getResolvedKeysDir(),
                });
              notificationProviderSpinner.succeed(
                notificationProviderResult.providerId
                  ? `Initial notification provider ready: ${notificationProviderResult.providerId}`
                  : 'Notification delivery explicitly disabled'
              );
            } catch (error) {
              notificationProviderSpinner.fail('Initial notification provider bootstrap failed');
              console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
              initialNotificationProviderSuccess = false;
            }
          }

          const adminRolesSpinner = startDeploySpinner('Ensuring initial admin roles exist...');
          const adminRolesResult = await ensureInitialAdminRolesInD1(
            env,
            config,
            (msg) => {
              updateOraSpinner(adminRolesSpinner, msg);
            },
            { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
          );

          if (adminRolesResult.success) {
            adminRolesSpinner.succeed(`Initial admin roles ready: ${config.tenant.name}`);
          } else {
            adminRolesSpinner.fail('Initial admin role bootstrap failed');
            if (adminRolesResult.error) {
              console.log(chalk.red(`  ${adminRolesResult.error}`));
            }
            initialAdminRolesSuccess = false;
          }

          const setupMachineSpinner = startDeploySpinner('Ensuring setup machine access exists...');
          setupMachineAccessAttempted = true;
          const setupMachineResult = await ensureSetupMachineAccessInD1(
            env,
            config,
            getResolvedKeysDir(),
            (msg) => {
              updateOraSpinner(setupMachineSpinner, msg);
            },
            { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
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
            const adminUiBffSpinner = startDeploySpinner(
              'Ensuring Admin UI BFF machine access exists...'
            );
            const adminUiBffResult = await ensureAdminUiBffMachineAccessInD1(
              env,
              config,
              getResolvedKeysDir(),
              (msg) => {
                updateOraSpinner(adminUiBffSpinner, msg);
              },
              { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
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

          const catalogSeedSpinner = startDeploySpinner(
            'Seeding default canonical field catalog...'
          );
          const catalogSeedResult = await seedDefaultCanonicalCatalog(
            env,
            config,
            (msg) => {
              updateOraSpinner(catalogSeedSpinner, msg);
            },
            { databaseIdentifier: requireLockedAdminDatabaseIdentifier() }
          );

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

          const profileSeedSpinner = startDeploySpinner('Seeding runtime profiles...');
          const profileSeedResult = await seedRuntimeProfiles(
            env,
            config,
            (msg) => {
              updateOraSpinner(profileSeedSpinner, msg);
            },
            { databaseIdentifier: requireLockedCoreDatabaseIdentifier() }
          );

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

          const controlPlaneSnapshotSpinner = startDeploySpinner(
            'Publishing initial Control Plane runtime snapshot...'
          );
          const controlPlaneSnapshotResult = await publishInitialControlPlaneRuntimeSnapshot({
            env,
            config,
            lock: currentLock,
            rootDir,
            keysDir: getResolvedKeysDir(),
            release: deploymentRelease.manifest,
            onProgress: (msg) => {
              updateOraSpinner(controlPlaneSnapshotSpinner, msg);
            },
          });
          if (controlPlaneSnapshotResult.success) {
            if (controlPlaneSnapshotResult.skipped) {
              controlPlaneSnapshotSpinner.succeed(
                'Initial Control Plane runtime snapshot not required'
              );
            } else {
              controlPlaneSnapshotSpinner.succeed('Initial Control Plane runtime snapshot ready');
            }
            if (isInitialDeployment) {
              const workersSubdomain = await getWorkersSubdomain();
              const postBootstrapTargets = buildWorkerHttpReadinessTargets(
                summary.results.filter((result) => result.success),
                workersSubdomain,
                { workersDevEnabled: !config.urls?.api?.custom }
              );
              if (postBootstrapTargets.length > 0) {
                const postBootstrapHealthSpinner = startDeploySpinner(
                  'Verifying tenant-aware Worker health after runtime snapshot...'
                );
                const postBootstrapHealth = await waitForWorkerHttpReady({
                  targets: postBootstrapTargets,
                  onProgress: (msg) => {
                    updateOraSpinner(postBootstrapHealthSpinner, msg);
                  },
                });
                if (!postBootstrapHealth.ready) {
                  postBootstrapHealthSpinner.fail(
                    'Tenant-aware Worker health checks failed after runtime snapshot'
                  );
                  console.error(
                    chalk.red(`  ${postBootstrapHealth.error || 'unknown health check error'}`)
                  );
                  abortLockedDeployment('post_bootstrap_worker_health_check_failed');
                }
                postBootstrapHealthSpinner.succeed(
                  'Tenant-aware Worker health checks passed after runtime snapshot'
                );
              }
            }
          } else {
            controlPlaneSnapshotSpinner.fail('Initial Control Plane runtime snapshot failed');
            if (controlPlaneSnapshotResult.error) {
              console.log(chalk.red(`  ${controlPlaneSnapshotResult.error}`));
            }
            abortLockedDeployment('initial_control_plane_runtime_snapshot_failed');
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
      initialNotificationProviderSuccess &&
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
      !options.components &&
      (!options.component || options.component === 'ar-userinfo');

    if (shouldConfigureDownstreamIntrospectionClient) {
      const keysDir = getResolvedKeysDir();
      const downstreamSpinner = startDeploySpinner(
        '[8/10] Checking tenant routing for optional integrations...'
      );
      let downstreamProgress: DeploymentProgressSnapshot | null = null;
      let downstreamSetupResult: ConfigureDownstreamIntrospectionDeploymentResult;
      try {
        downstreamSetupResult = await configureDownstreamIntrospectionDeployment({
          env,
          rootDir,
          keysDir,
          apiBaseUrl: deploymentApiBaseUrl,
          apiBaseUrls: resolveApiBaseUrlCandidates(config, {
            env,
            purpose: 'tenant-scoped-admin',
          }),
          knownRouterReadyBaseUrls: deploymentApiBaseUrl ? [deploymentApiBaseUrl] : undefined,
          tenantId: config.tenant?.name,
          dryRun: options.dryRun,
          deployConfigLockProof: deployConfigLock?.proof,
          workerScriptOwnership: deployOptions.workerScriptOwnership,
          onProgress: (msg) => {
            downstreamProgress = updateDeploymentProgress(downstreamProgress, msg);
            updateOraSpinner(
              downstreamSpinner,
              `[${downstreamProgress.step}/${downstreamProgress.totalSteps}] ${msg}`
            );
          },
        });
      } catch (error) {
        downstreamSetupResult = createDownstreamIntrospectionFailure(
          error instanceof Error ? error.message : String(error)
        );
      }

      if (downstreamSetupResult.success && downstreamSetupResult.redeployResult?.deployedAt) {
        downstreamSpinner.succeed('[9/10] Downstream grant introspection is ready');
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
        downstreamSpinner.warn('[9/10] Optional downstream grant introspection was deferred');
        console.log(
          chalk.yellow(
            `  ${downstreamSetupResult.impact ?? 'Core login, Admin UI, and token issuance remain available.'}`
          )
        );
        console.log(
          chalk.gray(
            `  Reason: ${downstreamSetupResult.error ?? 'Unknown optional integration error'}`
          )
        );
        console.log(
          chalk.gray(
            `  ${downstreamSetupResult.nextAction ?? 'Rerun deploy to retry the optional integration.'}`
          )
        );
        for (const error of downstreamSetupResult.secretUploadErrors ?? []) {
          console.log(chalk.red(`  • ${error}`));
        }
      } else {
        downstreamSpinner.succeed('[9/10] Downstream grant introspection is ready');
      }
    }

    // Deploy UI Workers only after database and tenant bootstrap work has completed.
    if (
      !options.skipUi &&
      !focusedDeployment &&
      summary.failedCount === 0 &&
      bootstrapSuccess &&
      (config.components.loginUi || config.components.adminUi)
    ) {
      console.log(chalk.bold('\n📱 [10/10] Deploying UI to Cloudflare Workers...\n'));

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
          abortLockedDeployment('login_ui_client_creation_failed');
        }
      }

      if (!(await cleanupEphemeralSetupMachineAccess())) {
        abortLockedDeployment('setup_machine_access_cleanup_failed');
      }

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
              databaseIdentifier: requireLockedAdminDatabaseIdentifier(),
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

      uiWorkersSuccess = uiWorkersResult.failedCount === 0;
      if (uiWorkersSuccess && !options.dryRun) {
        const visibility = await waitForWorkerDeploymentsReady({
          targets: uiWorkersResult.results.map((result) => ({
            workerName: result.projectName,
            deployedAt: result.deployedAt,
            expectedVersionId: result.cloudflareVersionId,
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
            allowPublicDnsFallback: Boolean(
              config.urls?.loginUi?.custom || config.urls?.adminUi?.custom
            ),
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
      if (uiWorkersSuccess && !options.dryRun && uiWorkersResult.results.length > 0) {
        const workers = { ...currentLock.workers };
        for (const result of uiWorkersResult.results) {
          if (!result.success) continue;
          if (!result.deployedAt || !result.cloudflareVersionId || !result.cloudflareScriptTag) {
            throw new Error(`ui_worker_deployment_exact_identity_unavailable:${result.component}`);
          }
          workers[result.component] = {
            name: result.projectName,
            deployedAt: result.deployedAt,
            version:
              (await getPackageVersion(join(rootDir, 'packages', result.component))) ?? undefined,
            cloudflareVersionId: result.cloudflareVersionId,
            cloudflareScriptTag: result.cloudflareScriptTag,
          };
        }
        currentLock = clearProvisionalWorkerScriptOwnership(
          {
            ...currentLock,
            workers,
            updatedAt: new Date().toISOString(),
          },
          uiWorkersResult.results.map((result) => result.component)
        );
        await saveLockFile(currentLock, lockPath);

        const controlDatabaseId = currentLock.d1.CONTROL_DB?.id;
        if (!controlDatabaseId) {
          throw new Error('control_database_required_for_ui_worker_inventory');
        }
        await registerUiWorkerInventoryFromArtifacts({
          baseDir: rootDir,
          environmentId: env,
          environmentName: env,
          controlDatabaseName: controlDatabaseId,
          components: uiWorkersResult.results.map((result) => result.component),
          environmentBootstrap: {
            defaultResidencyPolicyId: config.profiles.defaults.residency,
            automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
          },
          registeredBy: 'setup:deploy-ui',
          onProgress: (message) => console.log(chalk.gray(`  ${message}`)),
        });
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

    // Temporary setup authority must be removed before reporting success or performing any
    // remaining post-bootstrap mutation. The finally block retries cleanup after a failed attempt.
    // A command-level retry can still exhaust just before Wrangler refreshes an OAuth
    // credential. Re-run the idempotent DELETE once before classifying cleanup as blocking.
    if (
      !(await cleanupEphemeralSetupMachineAccess()) &&
      !(await cleanupEphemeralSetupMachineAccess())
    ) {
      abortLockedDeployment('setup_machine_access_cleanup_failed');
    }

    // Report component results now, but do not claim the deployment is complete until the
    // durable release/topology verification state has been persisted below.
    console.log(chalk.bold('\n━━━ Deployment Results ━━━\n'));

    if (summary.failedCount === 0 && bootstrapSuccess && uiWorkersSuccess) {
      console.log(chalk.green('✓ All components deployed and migrations applied.\n'));
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
    if (!options.dryRun && !focusedDeployment && summary.failedCount === 0) {
      const baseUrl = resolveIssuerUrl(config, { env });

      if (baseUrl) {
        const setupSpinner = startDeploySpinner('Setting up initial admin...');

        try {
          // Use appropriate keys directory based on structure
          const setupOptions: Parameters<typeof completeInitialSetup>[0] = {
            env,
            baseUrl,
            baseDir,
            legacy: structureType === 'legacy',
            onProgress: (msg) => {
              updateOraSpinner(setupSpinner, msg);
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

    const blockingDeploymentFailures = hasBlockingDeploymentFailures({
      workerFailedCount: summary.failedCount,
      migrationsSuccess,
      initialTenantSuccess,
      initialNotificationProviderSuccess,
      initialAdminRolesSuccess,
      setupMachineAccessSuccess,
      setupMachineAccessCleanupSuccess,
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

    if (!blockingDeploymentFailures) {
      console.log(
        chalk.bold(
          options.dryRun
            ? '\n━━━ Deployment Dry Run Complete ━━━\n'
            : '\n━━━ Deployment Complete ━━━\n'
        )
      );
      if (!options.dryRun && isInitialDeployment && initialRelease) {
        console.log(chalk.green('✅ Durable release state verified.\n'));
      }
    }

    const failureAction = resolveDeployFailureAction({
      blockingDeploymentFailures,
      throwOnFailure: options.throwOnFailure,
    });
    if (failureAction !== 'continue') {
      // Let CI fail at the deploy step while still giving cleanup a chance to run.
      process.exitCode = 1;
      if (failureAction === 'throw') throw new Error('deploy_command_blocking_failure');
    }
  } finally {
    if (cleanupEphemeralSetupMachineAccess) {
      try {
        if (!(await cleanupEphemeralSetupMachineAccess())) {
          await cleanupEphemeralSetupMachineAccess();
        }
      } catch (error) {
        console.error(
          chalk.red(
            `Setup machine access cleanup failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    }
    failUnexpectedActiveSpinner();
    try {
      await deployConfigLock?.release();
    } finally {
      await operationLock?.release();
    }
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
