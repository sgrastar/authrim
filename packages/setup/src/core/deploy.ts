/**
 * Authrim Deployment Module
 *
 * Handles the deployment order, parallel execution, and retry logic
 * for Authrim Workers.
 */

import { execa, type ExecaError } from 'execa';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  getWorkerName,
  getDeploymentOrder,
  CORE_WORKER_COMPONENTS,
  WORKER_COMPONENTS,
  WORKER_DEPLOYMENT_DEPENDENCIES,
  type WorkerComponent,
} from './naming.js';
import {
  assertDeployConfigLockProofOwned,
  loadLockFileAuto,
  type AuthrimLock,
  type DeployConfigLockProof,
  type WorkerEntry,
} from './lock.js';
import {
  saveUiEnv,
  copyUiEnvToPackage,
  cleanupPackageEnv,
  uiEnvExists,
  type UiEnvConfig,
} from './ui-env.js';
import { DISABLED_API_BACKEND_URL } from './ui-deployment.js';
import { generateUiWorkersWranglerConfig, parseWranglerToml } from './wrangler.js';
import { getPackageVersion } from './version.js';
import {
  EPHEMERAL_ENV_SECRET_NAMES,
  getMissingRequiredDeploySecrets,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  SECRET_KEY_FILES,
} from './secrets.js';
import type { AdminUiBffWorkerSecrets } from './admin-machine-access.js';
import {
  SetupWorkerDeploymentLeaseCoordinator,
  type SetupWorkerDeploymentLease,
} from './worker-deployment-lease.js';
import {
  createManagedWorkerDeployTicket,
  hasManagedWorkerDeployGuard,
} from './managed-worker-deploy.js';
import { checkWranglerStatus } from './wrangler-sync.js';
import { writePrivateFileAtomically } from './atomic-file.js';
import {
  prepareManagedWorkerScriptOwnership,
  type WorkerScriptOwnershipGuard,
} from './worker-script-ownership.js';
import {
  assertLocalDeploymentCapacity,
  isInsufficientLocalDiskSpaceError,
  MINIMUM_BUILD_FREE_BYTES,
  MINIMUM_WORKER_DEPLOY_FREE_BYTES,
  type ReadAvailableDiskBytes,
} from './local-deployment-capacity.js';
import { listWorkerCronTriggers } from './cloudflare.js';

export {
  DEFAULT_SECRET_TARGET_WORKERS,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  SECRET_KEY_FILES,
  SECRET_UPLOAD_PLAN,
  type SecretName,
} from './secrets.js';

// Keep deploy-time optimization independent from wrangler.toml so local `wrangler dev`
// remains debuggable and stale generated configs cannot silently disable production minification.
const WORKER_BUNDLE_UPLOAD_ARGS = ['--minify', '--upload-source-maps'] as const;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate that a component is a valid WorkerComponent
 * Prevents path traversal attacks by ensuring component is from allowed list
 */
function isValidComponent(component: string): component is WorkerComponent {
  return WORKER_COMPONENTS.includes(component as WorkerComponent);
}

/**
 * Validate environment name to prevent injection
 */
function isValidEnv(env: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(env);
}

function sanitizeDeploymentErrorMessage(message: string): string {
  return message.replace(/\/[^\s:]+/g, '[path]').replace(/\\[^\s:]+/g, '[path]');
}

interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface NodeEngineMismatch {
  packageName: string;
  requirement: string;
}

function parseNodeVersion(value: string): NodeVersion | null {
  const match = String(value)
    .trim()
    .replace(/^v/u, '')
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function parseRangeVersion(value: string): NodeVersion | null {
  const match = value.match(/^(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/u);
  if (!match || /[xX*]/u.test(match[1])) return null;
  return {
    major: Number(match[1]),
    minor: match[2] && !/[xX*]/u.test(match[2]) ? Number(match[2]) : 0,
    patch: match[3] && !/[xX*]/u.test(match[3]) ? Number(match[3]) : 0,
  };
}

function satisfiesNodeComparator(version: NodeVersion, comparator: string): boolean {
  const normalized = comparator.trim();
  if (!normalized || normalized === '*' || normalized.toLowerCase() === 'x') return true;

  const operatorMatch = normalized.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/u);
  if (!operatorMatch) return false;
  const operator = operatorMatch[1] ?? '=';
  const versionSpec = operatorMatch[2];
  const target = parseRangeVersion(versionSpec);
  if (!target) {
    const wildcard = versionSpec.match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/u);
    if (!wildcard) return false;
    if (version.major !== Number(wildcard[1])) return false;
    if (!wildcard[2] || /[xX*]/u.test(wildcard[2])) return true;
    if (version.minor !== Number(wildcard[2])) return false;
    return !wildcard[3] || /[xX*]/u.test(wildcard[3]) || version.patch === Number(wildcard[3]);
  }

  const comparison = compareNodeVersions(version, target);
  if (operator === '=') return comparison === 0;
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '<=') return comparison <= 0;

  if (operator === '~') {
    return comparison >= 0 && version.major === target.major && version.minor === target.minor;
  }

  const upperBound: NodeVersion =
    target.major > 0
      ? { major: target.major + 1, minor: 0, patch: 0 }
      : target.minor > 0
        ? { major: 0, minor: target.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: target.patch + 1 };
  return comparison >= 0 && compareNodeVersions(version, upperBound) < 0;
}

/** Check the Node.js version against the common npm engines.node range syntax. */
export function nodeVersionSatisfiesEngine(version: string, range: string): boolean {
  const parsedVersion = parseNodeVersion(version);
  if (!parsedVersion || !range.trim()) return true;
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .every((comparator) => satisfiesNodeComparator(parsedVersion, comparator))
  );
}

function readNodeEngineRequirement(packageJsonPath: string): {
  packageName: string;
  requirement: string;
} | null {
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: unknown;
      engines?: { node?: unknown };
    };
    if (typeof manifest.name !== 'string' || typeof manifest.engines?.node !== 'string') {
      return null;
    }
    return { packageName: manifest.name, requirement: manifest.engines.node };
  } catch {
    return null;
  }
}

export function findNodeEngineMismatches(
  rootDir: string,
  components?: readonly string[],
  runtimeVersion = process.version
): NodeEngineMismatch[] {
  const packageJsonPaths = [join(rootDir, 'package.json')];
  const packagesDir = join(rootDir, 'packages');
  const packageNames = components?.length
    ? new Set(components.map((component) => `@authrim/${component}`))
    : null;

  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = join(packagesDir, entry.name, 'package.json');
      if (!existsSync(packageJsonPath)) continue;
      const requirement = readNodeEngineRequirement(packageJsonPath);
      if (requirement && (!packageNames || packageNames.has(requirement.packageName))) {
        packageJsonPaths.push(packageJsonPath);
      }
    }
  }

  return packageJsonPaths
    .map((packageJsonPath) => readNodeEngineRequirement(packageJsonPath))
    .filter(
      (requirement): requirement is NodeEngineMismatch =>
        requirement !== null && !nodeVersionSatisfiesEngine(runtimeVersion, requirement.requirement)
    );
}

function formatNodeEngineMismatchError(
  runtimeVersion: string,
  mismatches: readonly NodeEngineMismatch[]
): string {
  const packageLines = mismatches
    .map(({ packageName, requirement }) => `  - ${packageName}: node ${requirement}`)
    .join('\n');
  return [
    `Node.js version check failed (running ${runtimeVersion}).`,
    'The following package requirements are not satisfied:',
    packageLines,
    'Install a compatible Node.js version and restart Setup before deploying.',
  ].join('\n');
}

// =============================================================================
// Types
// =============================================================================

export interface DeployOptions {
  env: string;
  rootDir: string;
  configFile?: string;
  dryRun?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** @deprecated Fixed inter-deployment delays are intentionally ignored. */
  interDeploymentDelayMs?: number;
  /** Maximum number of simultaneous Cloudflare mutations. Clamped to 1..4. */
  concurrency?: number;
  /**
   * direct: wrangler deploy (required for a first deployment)
   * staged: upload all versions before promoting any of them
   * auto: staged only when every selected Worker is known to exist
   */
  deploymentStrategy?: 'auto' | 'direct' | 'staged';
  /** Worker entries already known to exist remotely, normally sourced from authrim.lock. */
  existingComponents?: readonly WorkerComponent[];
  /** Secret values keyed by Wrangler secret name. Only each Worker's allow-list is written. */
  secrets?: Readonly<Record<string, string>>;
  /** Whether ar-control must receive scoped Cloudflare provisioning tokens. */
  automaticProvisioning?: boolean;
  /** Optional non-secret CLI vars, scoped per Worker. */
  varsByComponent?: Partial<Record<WorkerComponent, Readonly<Record<string, string>>>>;
  onProgress?: (message: string) => void;
  onError?: (component: string, error: Error) => void;
  /** Test hook for deterministic retry behavior. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Test hook for deterministic full-jitter retry behavior. */
  random?: () => number;
  /** Test/embedding hook for deterministic local capacity checks. */
  readAvailableDiskBytes?: ReadAvailableDiskBytes;
  /** Optional cancellation signal. Gradual rollouts use it to roll traffic back on interruption. */
  signal?: AbortSignal;
  /** Remove retired static bearer secrets after the replacement Worker code is live. */
  cleanupLegacyStaticSecrets?: boolean;
  /** Shared Control DB lease for mutations of Workers that already exist. */
  deploymentLease?: {
    controlDatabaseId: string;
    environmentId: string;
    actorId: string;
    /** Target account from environment config; avoids repeated Wrangler account discovery. */
    accountId?: string;
    required: boolean;
    /** Test/embedding hook; production setup constructs the Control DB coordinator. */
    coordinator?: WorkerDeploymentLeaseCoordinator;
  };
  /** Internal state shared by one deployment operation and its rollback/cleanup paths. */
  deploymentLeaseSession?: WorkerDeploymentLeaseSession;
  /** Refresh generated deployment artifacts before deployment contexts and Cloudflare baselines. */
  beforeWorkerMutations?: () => Promise<void>;
  /** Require the generated .authrim/<env> config to still match the package config at mutation time. */
  requireManagedArtifactVerification?: boolean;
  /** Opaque runtime proof returned by the currently held workspace deploy-config lock. */
  deployConfigLockProof?: DeployConfigLockProof;
  /** Exact immutable Worker script ownership established and durably checkpointed by Setup. */
  workerScriptOwnership?: WorkerScriptOwnershipGuard;
  /** Account pinned by the environment config for provider-side trigger verification. */
  cloudflareAccountId?: string;
  /** Test/embedding hook for deterministic provider-side Cron Trigger readback. */
  readWorkerCronTriggers?: (workerName: string, accountId?: string) => Promise<string[]>;
}

export interface DeployResult {
  component: WorkerComponent;
  workerName: string;
  success: boolean;
  error?: string;
  deployedAt?: string;
  version?: string;
  /** Cloudflare Version ID; deliberately separate from the package semver in version. */
  cloudflareVersionId?: string;
  /** Cloudflare's immutable script identity, read back after the provider mutation. */
  cloudflareScriptTag?: string;
  /** The new code is live even though a post-traffic step (normally trigger sync) failed. */
  trafficCommitted?: boolean;
  duration?: number;
}

export interface DeploymentSummary {
  totalComponents: number;
  successCount: number;
  failedCount: number;
  results: DeployResult[];
  startedAt: string;
  completedAt: string;
  duration: number;
}

async function ensureWorkerScriptOwnershipGuard(
  options: DeployOptions,
  targets: readonly { component: string; workerName: string }[]
): Promise<void> {
  if (options.dryRun || options.workerScriptOwnership) return;
  const lockState = await loadLockFileAuto(options.rootDir, options.env);
  if (!lockState.lock || !lockState.path) {
    throw new Error(`worker_script_ownership_lock_unavailable:${options.env}`);
  }
  const prepared = await prepareManagedWorkerScriptOwnership({
    lock: lockState.lock,
    lockPath: lockState.path,
    targets,
  });
  options.workerScriptOwnership = prepared.guard;
}

const LEGACY_STATIC_SECRET_CLEANUP_PLAN: Partial<Record<WorkerComponent, readonly string[]>> = {
  'ar-lib-core': ['KEY_MANAGER_SECRET', 'VERSION_MANAGER_SECRET'],
  'ar-auth': ['ADMIN_API_SECRET', 'KEY_MANAGER_SECRET'],
  'ar-token': ['ADMIN_API_SECRET', 'KEY_MANAGER_SECRET'],
  'ar-management': ['KEY_MANAGER_SECRET', 'VERSION_MANAGER_SECRET'],
};

interface LatchedDeployConfigLockRequirement {
  proof: DeployConfigLockProof;
  rootDir: string;
  env: string;
}

// Once a non-dry-run operation is identified as managed, latch the exact capability and scope.
// Later filesystem deletion or option mutation must not downgrade or swap its ownership proof.
const DEPLOY_CONFIG_LOCK_REQUIREMENTS = new WeakMap<
  DeployOptions,
  LatchedDeployConfigLockRequirement
>();

function requiresDeployConfigLockProof(options: DeployOptions): boolean {
  if (DEPLOY_CONFIG_LOCK_REQUIREMENTS.has(options)) return true;
  if (options.dryRun === true) return false;
  return (
    options.deployConfigLockProof !== undefined ||
    options.requireManagedArtifactVerification === true ||
    existsSync(join(options.rootDir, '.authrim', options.env))
  );
}

async function assertDeployConfigLockProof(options: DeployOptions): Promise<void> {
  if (!requiresDeployConfigLockProof(options)) return;
  const latched = DEPLOY_CONFIG_LOCK_REQUIREMENTS.get(options);
  if (latched) {
    if (
      options.deployConfigLockProof !== latched.proof ||
      resolve(options.rootDir) !== latched.rootDir ||
      options.env !== latched.env
    ) {
      throw new Error(`managed_worker_deploy_config_lock_proof_changed:${latched.env}`);
    }
    await assertDeployConfigLockProofOwned(latched.proof, {
      baseDir: latched.rootDir,
      env: latched.env,
    });
    return;
  }
  if (!options.deployConfigLockProof) {
    throw new Error(`managed_worker_deploy_config_lock_proof_required:${options.env}`);
  }
  const requirement = {
    proof: options.deployConfigLockProof,
    rootDir: resolve(options.rootDir),
    env: options.env,
  };
  await assertDeployConfigLockProofOwned(requirement.proof, {
    baseDir: requirement.rootDir,
    env: requirement.env,
  });
  DEPLOY_CONFIG_LOCK_REQUIREMENTS.set(options, requirement);
}

class DeployConfigLockProofLostAfterMutationError extends Error {
  constructor(cause: unknown) {
    super('managed_worker_deploy_config_lock_proof_lost_after_mutation', { cause });
    this.name = 'DeployConfigLockProofLostAfterMutationError';
  }
}

async function assertDeployConfigLockProofAfterMutation(options: DeployOptions): Promise<void> {
  try {
    await assertDeployConfigLockProof(options);
  } catch (error) {
    if (error instanceof DeployConfigLockProofLostAfterMutationError) throw error;
    throw new DeployConfigLockProofLostAfterMutationError(error);
  }
}

export interface LegacyStaticSecretCleanupFailure {
  component: WorkerComponent;
  error: string;
}

export interface LegacyStaticSecretCleanupResult {
  failures: LegacyStaticSecretCleanupFailure[];
  activeVersionIds: Partial<Record<WorkerComponent, string>>;
}

function parseWranglerSecretNames(stdout: unknown): Set<string> {
  const output = String(stdout).trim();
  if (output.length === 0) {
    throw new Error('Wrangler secret list returned empty JSON output');
  }

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Wrangler secret list returned a non-array JSON response');
  }

  return new Set(
    parsed
      .map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'name' in entry
          ? (entry as { name?: unknown }).name
          : undefined
      )
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  );
}

/** Delete retired static bearer bindings only after their replacement Worker deployed successfully. */
async function cleanupLegacyStaticSecretsWithoutLease(
  options: DeployOptions,
  components: readonly WorkerComponent[]
): Promise<LegacyStaticSecretCleanupResult> {
  const failures: LegacyStaticSecretCleanupFailure[] = [];
  const activeVersionIds: Partial<Record<WorkerComponent, string>> = {};
  const throttle = makeThrottle(options);
  const completedComponents = new Set(components);

  await runBoundedPool(components, throttle, async (component) => {
    const retiredNames = LEGACY_STATIC_SECRET_CLEANUP_PLAN[component];
    if (!retiredNames || retiredNames.length === 0) {
      return;
    }

    // KeyManager and VersionManager are shared providers. Keep their compatibility
    // secrets during a partial rollout so an older caller can continue serving traffic.
    if (
      component === 'ar-lib-core' &&
      !['ar-auth', 'ar-token', 'ar-management'].every((caller) =>
        completedComponents.has(caller as WorkerComponent)
      )
    ) {
      options.onProgress?.(
        '  ↷ Deferred ar-lib-core legacy secret cleanup until all former callers are deployed'
      );
      return;
    }

    const packageDir = join(options.rootDir, 'packages', component);
    if (!existsSync(packageDir)) {
      return;
    }

    try {
      const listed = await runWithAdaptiveRetry(
        `Listing retired secrets for ${getWorkerName(options.env, component)}`,
        options,
        throttle,
        () =>
          execa(
            'pnpm',
            [
              'exec',
              'wrangler',
              'secret',
              'list',
              '--format',
              'json',
              ...getConfigArgs(options),
              '--env',
              options.env,
            ],
            {
              cwd: packageDir,
              reject: true,
              cancelSignal: options.signal,
              // Wrangler emits command results through its `log` channel. The deployment
              // workflow uses WRANGLER_LOG=warn globally, so enable captured JSON output only
              // for this subprocess without increasing the surrounding CI log verbosity.
              env: { WRANGLER_LOG: 'log' },
            }
          )
      );
      const existingNames = parseWranglerSecretNames(listed.stdout);
      const namesToDelete = retiredNames.filter((name) => existingNames.has(name));
      const context = await getWorkerDeploymentContext(component, options);
      if (isDeployResult(context)) {
        throw new Error(context.error || 'Failed to resolve Worker deployment context');
      }

      if (namesToDelete.length === 0) {
        // A prior secret-bulk response may have been lost after Cloudflare committed it. On the
        // next operation, held under a fresh exact deploy-config capability, reconcile the current
        // active version even though there is no remaining secret name to delete.
        const snapshot = await readWorkerTrafficSnapshot(context, options, throttle);
        if (snapshot.specs.length !== 1 || !snapshot.specs[0].endsWith('@100%')) {
          throw new Error(
            `Legacy secret cleanup reconciliation did not find one active version: ${snapshot.specs.join(', ')}`
          );
        }
        activeVersionIds[component] = snapshot.specs[0].split('@')[0];
        return;
      }

      await runWithAdaptiveRetry(
        `Deleting retired secrets from ${getWorkerName(options.env, component)}`,
        options,
        throttle,
        () =>
          runAuthorizedWorkerMutation(context, options, throttle, () =>
            execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'secret',
                'bulk',
                ...getConfigArgs(options),
                '--env',
                options.env,
              ],
              {
                cwd: packageDir,
                reject: true,
                cancelSignal: options.signal,
                input: JSON.stringify(
                  Object.fromEntries(namesToDelete.map((name) => [name, null]))
                ),
              }
            )
          )
      );
      for (const secretName of namesToDelete) {
        options.onProgress?.(
          `  ✓ Removed retired ${secretName} from ${getWorkerName(options.env, component)}`
        );
      }

      // `wrangler secret bulk` creates and immediately deploys a new Worker version.
      // Report that final active version instead of the pre-cleanup code version.
      const snapshot = await readWorkerTrafficSnapshot(context, options, throttle);
      if (snapshot.specs.length !== 1 || !snapshot.specs[0].endsWith('@100%')) {
        throw new Error(
          `Legacy secret cleanup did not finish on one active version: ${snapshot.specs.join(', ')}`
        );
      }
      activeVersionIds[component] = snapshot.specs[0].split('@')[0];
    } catch (error) {
      failures.push({ component, error: sanitizeDeploymentErrorMessage(getErrorText(error)) });
    }
  });

  return { failures, activeVersionIds };
}

export async function cleanupLegacyStaticSecrets(
  options: DeployOptions,
  components: readonly WorkerComponent[]
): Promise<LegacyStaticSecretCleanupResult> {
  await assertDeployConfigLockProof(options);
  if (options.deploymentLeaseSession || options.dryRun || !options.deploymentLease) {
    return cleanupLegacyStaticSecretsWithoutLease(options, components);
  }
  const contexts = new Map<WorkerComponent, WorkerDeploymentContext>();
  for (const component of components) {
    const context = await getWorkerDeploymentContext(component, options);
    if (!isDeployResult(context)) contexts.set(component, context);
  }
  const throttle = makeThrottle(options);
  const session = await createWorkerDeploymentLeaseSession(options, components, contexts, throttle);
  if (!session) return cleanupLegacyStaticSecretsWithoutLease(options, components);
  options.deploymentLeaseSession = session;
  let success = false;
  try {
    const result = await cleanupLegacyStaticSecretsWithoutLease(options, components);
    success = result.failures.length === 0;
    return result;
  } finally {
    options.deploymentLeaseSession = undefined;
    await closeWorkerDeploymentLeaseSession(session, success);
  }
}

export interface DeploymentCompletionState {
  workerFailedCount: number;
  migrationsSuccess: boolean;
  initialTenantSuccess: boolean;
  initialNotificationProviderSuccess: boolean;
  initialAdminRolesSuccess: boolean;
  setupMachineAccessSuccess: boolean;
  setupMachineAccessCleanupSuccess: boolean;
  adminUiBffMachineAccessSuccess: boolean;
  defaultCanonicalCatalogSeedSuccess: boolean;
  runtimeProfileSeedSuccess: boolean;
  uiWorkersSuccess: boolean;
}

export interface BuildOptions {
  rootDir: string;
  components?: WorkerComponent[];
  onProgress?: (message: string) => void;
  /** Test/embedding hook for deterministic local capacity checks. */
  readAvailableDiskBytes?: ReadAvailableDiskBytes;
}

export interface BuildResult {
  success: boolean;
  error?: string;
  errorCode?: 'insufficient_local_disk_space';
}

export const DEFAULT_INTER_DEPLOY_DELAY_MS = 0;
export const DEFAULT_DEPLOY_CONCURRENCY = 2;

export function hasBlockingDeploymentFailures(state: DeploymentCompletionState): boolean {
  return (
    state.workerFailedCount > 0 ||
    !state.migrationsSuccess ||
    !state.initialTenantSuccess ||
    !state.initialNotificationProviderSuccess ||
    !state.initialAdminRolesSuccess ||
    !state.setupMachineAccessSuccess ||
    !state.setupMachineAccessCleanupSuccess ||
    !state.adminUiBffMachineAccessSuccess ||
    !state.defaultCanonicalCatalogSeedSuccess ||
    !state.runtimeProfileSeedSuccess ||
    !state.uiWorkersSuccess
  );
}

const UI_BUILD_ENV_KEYS = [
  'PUBLIC_API_BASE_URL',
  'PUBLIC_API_PROXY_BACKEND_URL',
  'PUBLIC_AUTHRIM_ISSUER',
  'PUBLIC_LOGIN_UI_CLIENT_ID',
  'API_BACKEND_URL',
] as const;

/**
 * Prepare build-time env for UI Workers.
 * When a package-local .env exists, strip conflicting PUBLIC_* variables from
 * the parent process so Vite uses the generated file instead of leaked shell/CI values.
 */
export function buildUiWorkerBuildEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: {
    apiBaseUrl?: string;
    preferPackageEnv: boolean;
  }
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };

  for (const key of UI_BUILD_ENV_KEYS) {
    delete env[key];
  }

  if (!options.preferPackageEnv && options.apiBaseUrl) {
    env.PUBLIC_API_BASE_URL = options.apiBaseUrl;
  }

  return env;
}

// =============================================================================
// Build Helper
// =============================================================================

/**
 * Build API packages with proper dependency handling
 *
 * This function:
 * 1. Checks if node_modules exists, runs pnpm install if missing
 * 2. Clears turbo cache for fresh builds
 * 3. Uses pnpm exec turbo (works even if turbo isn't globally installed)
 */
export async function buildApiPackages(options: BuildOptions): Promise<BuildResult> {
  const { rootDir, components, onProgress } = options;

  try {
    onProgress?.('Checking Node.js version requirements...');
    const nodeEngineMismatches = findNodeEngineMismatches(rootDir, components);
    if (nodeEngineMismatches.length > 0) {
      const error = formatNodeEngineMismatchError(process.version, nodeEngineMismatches);
      onProgress?.(`❌ ${error}`);
      return { success: false, error };
    }

    // Clear turbo cache to ensure fresh builds
    onProgress?.('Clearing build cache...');
    await execa('rm', ['-rf', '.turbo', 'node_modules/.cache'], {
      cwd: rootDir,
      reject: false, // Don't fail if directories don't exist
    });

    onProgress?.('Checking local disk space before package build...');
    await assertLocalDeploymentCapacity({
      rootDir,
      phase: 'package build',
      minimumFreeBytes: MINIMUM_BUILD_FREE_BYTES,
      readAvailableBytes: options.readAvailableDiskBytes,
    });

    // Check if node_modules exists only after the capacity preflight. Dependency installation can
    // consume substantially more space than a normal incremental build.
    const nodeModulesPath = join(rootDir, 'node_modules');
    if (!existsSync(nodeModulesPath)) {
      onProgress?.('Installing dependencies (node_modules not found)...');
      await execa('pnpm', ['install'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      onProgress?.('Dependencies installed');
      onProgress?.('Rechecking local disk space after dependency installation...');
      await assertLocalDeploymentCapacity({
        rootDir,
        phase: 'package build',
        minimumFreeBytes: MINIMUM_BUILD_FREE_BYTES,
        readAvailableBytes: options.readAvailableDiskBytes,
      });
    }

    const filters =
      components && components.length > 0
        ? components.map((component) => `--filter=@authrim/${component}`)
        : ['--filter=!@authrim/ui-*', '--filter=!@authrim/setup'];

    // Use pnpm exec turbo instead of relying on global turbo.
    onProgress?.(
      components && components.length > 0
        ? `Building ${components.join(', ')}...`
        : 'Building packages...'
    );
    await execa('pnpm', ['exec', 'turbo', 'run', 'build', ...filters], {
      cwd: rootDir,
      stdio: 'pipe',
    });

    onProgress?.('Checking local disk space before Worker deployment...');
    await assertLocalDeploymentCapacity({
      rootDir,
      phase: 'Worker deployment',
      minimumFreeBytes: MINIMUM_WORKER_DEPLOY_FREE_BYTES,
      readAvailableBytes: options.readAvailableDiskBytes,
    });

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
      ...(isInsufficientLocalDiskSpaceError(error)
        ? { errorCode: 'insufficient_local_disk_space' as const }
        : {}),
    };
  }
}

// =============================================================================
// Deployment Order
// =============================================================================

/**
 * Get deployment levels - components that can be deployed in parallel
 */
export function getDeploymentLevels(enabledComponents?: WorkerComponent[]): WorkerComponent[][] {
  // Convert array to Set for getDeploymentOrder
  const componentSet = enabledComponents
    ? new Set<WorkerComponent>(enabledComponents)
    : new Set<WorkerComponent>(CORE_WORKER_COMPONENTS);

  // getDeploymentOrder already returns components grouped by level
  return getDeploymentOrder(componentSet);
}

// =============================================================================
// Deployment Runtime
// =============================================================================

interface DeploymentThrottle {
  configuredConcurrency: number;
  currentConcurrency: number;
  blockedUntil: number;
  transientFailures: number;
}

interface WorkerDeploymentContext {
  component: WorkerComponent;
  workerName: string;
  packageDir: string;
  packageVersion?: string;
  requiresDirectDeployment: boolean;
  startedAt: number;
}

interface TemporarySecretFile {
  path: string;
  cleanup: () => Promise<void>;
}

type RetryKind = 'rate-limit' | 'transient' | 'fatal';

class NonRetryableDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableDeploymentError';
  }
}

const DEPLOYMENT_PRIORITY: readonly WorkerComponent[] = [
  'ar-lib-core',
  'ar-control',
  'ar-plugin-runner',
  'ar-bridge',
  'ar-auth',
  'ar-management',
  'ar-discovery',
  'ar-token',
  'ar-agent-access',
  'ar-userinfo',
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-vc',
  'ar-router',
];

const AUTH_BOOTSTRAP_CONFIG_FILE = 'wrangler.bootstrap.toml';
const CONTROL_SMOKE_TARGET_COMPONENTS = [
  'ar-lib-core',
  'ar-auth',
  'ar-token',
  'ar-userinfo',
  'ar-management',
  'ar-agent-access',
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
  'ar-plugin-runner',
] as const satisfies readonly WorkerComponent[];

function initialControlBootstrapConfig(
  options: DeployOptions,
  components: readonly WorkerComponent[],
  strategy: 'direct' | 'staged'
): string | undefined {
  const existing = new Set(options.existingComponents ?? []);
  if (
    strategy !== 'direct' ||
    !components.includes('ar-control') ||
    options.existingComponents === undefined ||
    existing.has('ar-control') ||
    CONTROL_SMOKE_TARGET_COMPONENTS.every((component) => existing.has(component))
  ) {
    return undefined;
  }
  const fullConfigPath = join(options.rootDir, 'packages', 'ar-control', 'wrangler.toml');
  if (
    !existsSync(fullConfigPath) ||
    !readFileSync(fullConfigPath, 'utf-8').includes('binding = "SMOKE_AR_')
  ) {
    return undefined;
  }
  const path = join(options.rootDir, 'packages', 'ar-control', AUTH_BOOTSTRAP_CONFIG_FILE);
  if (!options.dryRun && !existsSync(path)) {
    throw new Error('initial_control_bootstrap_config_missing');
  }
  return path;
}

function initialAuthBootstrapConfig(
  options: DeployOptions,
  components: readonly WorkerComponent[],
  strategy: 'direct' | 'staged'
): string | undefined {
  if (
    strategy !== 'direct' ||
    !components.includes('ar-auth') ||
    !components.includes('ar-management') ||
    options.existingComponents?.includes('ar-management')
  ) {
    return undefined;
  }
  const fullConfigPath = options.configFile
    ? options.configFile
    : join(options.rootDir, 'packages', 'ar-auth', 'wrangler.toml');
  if (
    !existsSync(fullConfigPath) ||
    !readFileSync(fullConfigPath, 'utf-8').includes('binding = "ACCOUNT_PROVISIONER"')
  ) {
    return undefined;
  }
  const path = join(options.rootDir, 'packages', 'ar-auth', AUTH_BOOTSTRAP_CONFIG_FILE);
  if (!options.dryRun && !existsSync(path)) {
    throw new Error('initial_auth_bootstrap_config_missing');
  }
  return path;
}

function initialBridgeBootstrapConfig(
  options: DeployOptions,
  components: readonly WorkerComponent[],
  strategy: 'direct' | 'staged'
): string | undefined {
  if (
    strategy !== 'direct' ||
    !components.includes('ar-bridge') ||
    !components.includes('ar-management') ||
    options.existingComponents?.includes('ar-management')
  ) {
    return undefined;
  }
  const fullConfigPath = options.configFile
    ? options.configFile
    : join(options.rootDir, 'packages', 'ar-bridge', 'wrangler.toml');
  if (
    !existsSync(fullConfigPath) ||
    !readFileSync(fullConfigPath, 'utf-8').includes('binding = "EXTERNAL_IDP_ACCOUNT_PROVISIONER"')
  ) {
    return undefined;
  }
  const path = join(options.rootDir, 'packages', 'ar-bridge', AUTH_BOOTSTRAP_CONFIG_FILE);
  if (!options.dryRun && !existsSync(path)) {
    throw new Error('initial_bridge_bootstrap_config_missing');
  }
  return path;
}

function clampConcurrency(value: number | undefined): number {
  return Math.min(4, Math.max(1, Math.floor(value ?? DEFAULT_DEPLOY_CONCURRENCY)));
}

function makeThrottle(options: DeployOptions): DeploymentThrottle {
  const concurrency = clampConcurrency(options.concurrency);
  return {
    configuredConcurrency: concurrency,
    currentConcurrency: concurrency,
    blockedUntil: 0,
    transientFailures: 0,
  };
}

function getSleep(options: DeployOptions): (delayMs: number) => Promise<void> {
  return options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
}

function deploymentAbortError(options: DeployOptions): Error {
  const reason = options.signal?.reason;
  return reason instanceof Error ? reason : new Error('Deployment cancelled');
}

function throwIfDeploymentAborted(options: DeployOptions): void {
  if (options.signal?.aborted) {
    throw deploymentAbortError(options);
  }
}

async function sleepForDeployment(options: DeployOptions, delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    throwIfDeploymentAborted(options);
    return;
  }
  const signal = options.signal;
  if (!signal) {
    await getSleep(options)(delayMs);
    return;
  }
  throwIfDeploymentAborted(options);
  let abortHandler: (() => void) | undefined;
  try {
    await Promise.race([
      getSleep(options)(delayMs),
      new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(deploymentAbortError(options));
        signal.addEventListener('abort', abortHandler, { once: true });
      }),
    ]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}

function getErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as ExecaError & {
      stdout?: unknown;
      stderr?: unknown;
      shortMessage?: unknown;
    };
    const parts = [candidate.shortMessage, candidate.message, candidate.stderr, candidate.stdout]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .filter((part, index, values) => values.indexOf(part) === index);
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function isLocalDiskExhaustionError(error: unknown): boolean {
  return /\bENOSPC\b|no space left on device|insufficient[ _]local[ _]disk[ _]space/i.test(
    getErrorText(error)
  );
}

function classifyRetry(error: unknown): RetryKind {
  if (
    error instanceof NonRetryableDeploymentError ||
    error instanceof DeployConfigLockProofLostAfterMutationError
  ) {
    return 'fatal';
  }
  const message = getErrorText(error);
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(message)) {
    return 'rate-limit';
  }
  // Wrangler OAuth can briefly return Cloudflare code 10000 even though the same session is
  // accepted moments later. Direct deploys still reconcile remote traffic before replaying, so
  // classifying this exact authentication response as transient does not permit a blind retry.
  if (/authentication error\s*\[code:\s*10000\]/i.test(message)) {
    return 'transient';
  }
  if (/worker_version_(?:d1_)?binding_readback_(?:empty|invalid|invalid_json)/u.test(message)) {
    return 'transient';
  }
  if (
    /\b5\d{2}\b|\b7010\b|\b100146\b|requested Worker version could not be found|service unavailable|internal server error|fetch failed|network error|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|connection reset|timed out|und_err/i.test(
      message
    )
  ) {
    return 'transient';
  }
  return 'fatal';
}

function isProvenPreMutationDeploymentFailure(error: unknown): boolean {
  return /authentication error\s*\[code:\s*10000\]/i.test(getErrorText(error));
}

function getRetryAfterMs(error: unknown): number | undefined {
  const message = getErrorText(error);
  const secondsMatch = message.match(
    /retry-after["']?\s*[:=]\s*["']?(\d+)|retry after\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i
  );
  const seconds = Number(secondsMatch?.[1] ?? secondsMatch?.[2]);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return undefined;
}

async function waitForThrottle(
  throttle: DeploymentThrottle,
  options: DeployOptions
): Promise<void> {
  while (true) {
    const deadline = throttle.blockedUntil;
    const delayMs = Math.max(0, deadline - Date.now());
    if (delayMs === 0) {
      return;
    }
    options.onProgress?.(`  ⏳ Cloudflare rate-limit cooldown: ${(delayMs / 1000).toFixed(1)}s`);
    await sleepForDeployment(options, delayMs);
    // A different in-flight command may have observed a newer 429 and extended
    // the shared deadline while this task slept. Never clear that newer block.
    if (throttle.blockedUntil === deadline) {
      throttle.blockedUntil = 0;
      return;
    }
  }
}

async function runWithAdaptiveRetry<T>(
  label: string,
  options: DeployOptions,
  throttle: DeploymentThrottle,
  operation: () => Promise<T>
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxRetries ?? 3);
  const baseDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxRetryDelayMs ?? 300_000);
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfDeploymentAborted(options);
    await waitForThrottle(throttle, options);
    options.onProgress?.(`[${attempt}/${maxAttempts}] ${label}...`);

    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const kind = classifyRetry(error);
      const safeMessage = sanitizeDeploymentErrorMessage(getErrorText(error));
      options.onProgress?.(`  ✗ Attempt ${attempt} failed: ${safeMessage}`);

      if (kind === 'fatal' || attempt === maxAttempts) {
        throw error;
      }

      let delayMs: number;
      if (kind === 'rate-limit') {
        delayMs = Math.min(maxDelayMs, getRetryAfterMs(error) ?? maxDelayMs);
        throttle.currentConcurrency = 1;
        throttle.blockedUntil = Math.max(throttle.blockedUntil, Date.now() + delayMs);
      } else {
        throttle.transientFailures++;
        if (throttle.transientFailures >= 2) {
          throttle.currentConcurrency = 1;
        }
        const exponentialCap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        delayMs = exponentialCap === 0 ? 0 : Math.max(1, Math.floor(random() * exponentialCap));
        throttle.blockedUntil = Math.max(throttle.blockedUntil, Date.now() + delayMs);
      }

      options.onProgress?.(`  ⏳ Retrying in ${(delayMs / 1000).toFixed(1)}s...`);
    }
  }

  throw lastError;
}

function getConfigArgs(options: DeployOptions): string[] {
  // Wrangler prefers wrangler.jsonc when both formats exist. Setup owns the generated
  // wrangler.toml projection, so always select it explicitly.
  return ['--config', options.configFile ?? 'wrangler.toml'];
}

function getVarArgs(component: WorkerComponent, options: DeployOptions): string[] {
  const vars = options.varsByComponent?.[component];
  if (!vars) {
    return [];
  }
  return Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]);
}

function getSecretsForWorker(
  component: WorkerComponent,
  secrets: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (!secrets) {
    return {};
  }
  return Object.fromEntries(
    getSecretNamesForWorker(component)
      .filter((name) => secrets[name] !== undefined)
      .map((name) => [name, secrets[name]])
  );
}

async function createTemporarySecretFile(
  secrets: Readonly<Record<string, string>>
): Promise<TemporarySecretFile | undefined> {
  if (Object.keys(secrets).length === 0) {
    return undefined;
  }
  const directory = await mkdtemp(join(tmpdir(), 'authrim-wrangler-secrets-'));
  const path = join(directory, 'secrets.json');
  try {
    await writeFile(path, JSON.stringify(secrets), { encoding: 'utf-8', mode: 0o600 });
    await chmod(path, 0o600);
    return {
      path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function runManagedWranglerBuild<T>(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  wranglerCommand: 'deploy' | 'versions upload',
  operation: (managedEnv: Readonly<Record<string, string>>) => Promise<T>
): Promise<T> {
  await assertDeployConfigLockProof(options);
  const managedEnvironmentExists = existsSync(
    join(options.rootDir, '.authrim', options.env, 'config.json')
  );
  if (options.requireManagedArtifactVerification || managedEnvironmentExists) {
    const [status] = await checkWranglerStatus({
      baseDir: options.rootDir,
      env: options.env,
      packagesDir: join(options.rootDir, 'packages'),
      components: [context.component],
    });
    if (!status?.masterExists || !status.deployExists || !status.inSync) {
      throw new Error(`managed_worker_deploy_config_mismatch:${context.component}`);
    }
  }
  const ticket = await createManagedWorkerDeployTicket({
    wranglerCommand,
    component: context.component,
    environment: options.env,
    workerName: context.workerName,
    packageDir: context.packageDir,
    configFile: options.configFile,
  });
  if (!ticket) {
    await assertDeployConfigLockProof(options);
    const result = await operation({});
    await assertDeployConfigLockProofAfterMutation(options);
    return result;
  }

  try {
    await assertDeployConfigLockProof(options);
    const result = await operation(ticket.env);
    await assertDeployConfigLockProofAfterMutation(options);
    await ticket.assertConsumed();
    return result;
  } finally {
    await ticket.cleanup();
  }
}

interface WranglerVersionBinding {
  name?: unknown;
  type?: unknown;
  id?: unknown;
}

function parseWranglerVersionD1Bindings(output: unknown): Record<string, string> {
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error('worker_version_binding_readback_empty');
  }
  let parsed: { resources?: { bindings?: WranglerVersionBinding[] } };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    throw new Error('worker_version_binding_readback_invalid_json');
  }
  if (!Array.isArray(parsed.resources?.bindings)) {
    throw new Error('worker_version_binding_readback_invalid');
  }

  const bindings: Record<string, string> = {};
  for (const binding of parsed.resources.bindings) {
    if (binding.type !== 'd1') continue;
    if (typeof binding.name !== 'string' || typeof binding.id !== 'string') {
      throw new Error('worker_version_d1_binding_readback_invalid');
    }
    if (bindings[binding.name] !== undefined) {
      throw new Error(`worker_version_d1_binding_duplicate:${binding.name}`);
    }
    bindings[binding.name] = binding.id;
  }
  return bindings;
}

function describeD1BindingMismatch(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>
): string | undefined {
  const names = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();
  const mismatches = names.filter((name) => expected[name] !== actual[name]);
  return mismatches.length > 0 ? mismatches.join(',') : undefined;
}

async function verifyUploadedWorkerD1Bindings(
  context: WorkerDeploymentContext,
  cloudflareVersionId: string,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<void> {
  if (!(await hasManagedWorkerDeployGuard(context.packageDir, options.configFile))) {
    return;
  }

  const configContent = await readFile(
    resolve(context.packageDir, options.configFile ?? 'wrangler.toml'),
    'utf8'
  );
  const expected = parseWranglerToml(configContent, options.env).d1;
  const actual = await runWithAdaptiveRetry(
    `Verifying D1 bindings for ${context.workerName} version`,
    options,
    throttle,
    async () => {
      const commandResult = await execa(
        'pnpm',
        [
          'exec',
          'wrangler',
          'versions',
          'view',
          cloudflareVersionId,
          '--json',
          ...getConfigArgs(options),
          '--env',
          options.env,
        ],
        {
          cwd: context.packageDir,
          reject: true,
          cancelSignal: options.signal,
          // Wrangler emits `versions view --json` through its `logRaw` channel. `warn`
          // suppresses that channel and makes a successful readback look like empty stdout.
          env: { WRANGLER_LOG: 'log' },
        }
      );
      // A successful Wrangler process can still yield a temporarily empty or incomplete JSON
      // readback. Parse inside the bounded retry so only transport/readback failures retry;
      // the actual binding contract mismatch below remains immediately fatal.
      return parseWranglerVersionD1Bindings(commandResult.stdout);
    }
  );
  const mismatch = describeD1BindingMismatch(expected, actual);
  if (mismatch) {
    throw new Error(`worker_version_d1_binding_mismatch:${mismatch}`);
  }
  options.onProgress?.(
    `  ✓ ${context.workerName} version D1 bindings verified (${Object.keys(expected).length})`
  );
}

async function getWorkerDeploymentContext(
  component: WorkerComponent,
  options: DeployOptions
): Promise<WorkerDeploymentContext | DeployResult> {
  const startedAt = Date.now();
  if (!isValidComponent(component)) {
    return {
      component,
      workerName: '',
      success: false,
      error: 'Invalid component name',
      duration: Date.now() - startedAt,
    };
  }
  if (!isValidEnv(options.env)) {
    return {
      component,
      workerName: '',
      success: false,
      error: 'Invalid environment name',
      duration: Date.now() - startedAt,
    };
  }

  const workerName = getWorkerName(options.env, component);
  const packageDir = join(options.rootDir, 'packages', component);
  if (!existsSync(packageDir)) {
    return {
      component,
      workerName,
      success: false,
      error: 'Package directory not found',
      duration: Date.now() - startedAt,
    };
  }
  const wranglerConfigPath = join(packageDir, 'wrangler.toml');
  if (!existsSync(wranglerConfigPath)) {
    return {
      component,
      workerName,
      success: false,
      error: 'Wrangler config not found',
      duration: Date.now() - startedAt,
    };
  }

  return {
    component,
    workerName,
    packageDir,
    packageVersion: (await getPackageVersion(packageDir)) ?? undefined,
    // Durable Object migrations cannot participate safely in a gradual/versioned
    // deployment. Wrangler deploy applies them as one direct mutation.
    requiresDirectDeployment: (await readFile(wranglerConfigPath, 'utf-8')).includes(
      '[[migrations]]'
    ),
    startedAt,
  };
}

function isDeployResult(context: WorkerDeploymentContext | DeployResult): context is DeployResult {
  return 'success' in context;
}

function deploymentFailure(context: WorkerDeploymentContext, error: unknown): DeployResult {
  return {
    component: context.component,
    workerName: context.workerName,
    success: false,
    error: sanitizeDeploymentErrorMessage(getErrorText(error) || 'Unknown error'),
    version: context.packageVersion,
    duration: Date.now() - context.startedAt,
  };
}

async function deployWorkerDirect(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<DeployResult> {
  let secretFile: TemporarySecretFile | undefined;
  let outputDirectory: string | undefined;
  let deployedVersionId: string | undefined;
  let cloudflareScriptTag: string | undefined;
  let deploymentMayBeLive = false;
  try {
    await options.workerScriptOwnership?.assertBeforeMutation(context.workerName);
    secretFile = await createTemporarySecretFile(
      getSecretsForWorker(context.component, options.secrets)
    );
    outputDirectory = await mkdtemp(join(tmpdir(), 'authrim-wrangler-output-'));
    const commandResult = await runWithAdaptiveRetry(
      `Deploying ${context.workerName}`,
      options,
      throttle,
      async () => {
        let commandError: unknown;
        try {
          const result = await runAuthorizedWorkerMutation(context, options, throttle, () =>
            runManagedWranglerBuild(context, options, 'deploy', async (managedEnv) => {
              try {
                const deployed = await execa(
                  'pnpm',
                  [
                    'exec',
                    'wrangler',
                    'deploy',
                    ...WORKER_BUNDLE_UPLOAD_ARGS,
                    ...getConfigArgs(options),
                    '--env',
                    options.env,
                    ...getVarArgs(context.component, options),
                    ...(secretFile ? ['--secrets-file', secretFile.path] : []),
                  ],
                  {
                    cwd: context.packageDir,
                    reject: true,
                    cancelSignal: options.signal,
                    env: {
                      ...managedEnv,
                      WRANGLER_OUTPUT_FILE_DIRECTORY: outputDirectory,
                    },
                  }
                );
                // Wrangler deploy is atomic: once the command returns, its version may already
                // be serving traffic even if capability-consumption verification fails next.
                deploymentMayBeLive = true;
                return deployed;
              } catch (error) {
                commandError = error;
                throw error;
              }
            })
          );
          return {
            stdout: String(result.stdout),
            adoptedVersionId: undefined as string | undefined,
          };
        } catch (error) {
          // An authorization/fencing/ticket error is not evidence that the provider mutation was
          // rejected. Never let the generic transient classifier replay a direct deployment here.
          if (commandError !== error) {
            if (commandError === undefined && !deploymentMayBeLive) {
              // Configuration, authorization, or build preparation failed before Wrangler began
              // the provider mutation. Preserve its exact error and normal retry classification.
              throw error;
            }
            throw new NonRetryableDeploymentError(
              `Direct deployment state became unverifiable for ${context.workerName}`
            );
          }

          const structuredVersionId = await readVersionIdFromStructuredOutput(outputDirectory!, '');
          if (structuredVersionId) {
            deploymentMayBeLive = true;
            options.onProgress?.(
              `  ✓ Adopted committed ${context.workerName} deployment ${structuredVersionId} after response loss`
            );
            return { stdout: '', adoptedVersionId: structuredVersionId };
          }

          // An explicit authentication rejection is evidence that Cloudflare did not begin the
          // Worker mutation. It is safe to replay after the bounded OAuth backoff above. A 5xx,
          // timeout, or connection loss is not: deployment visibility can lag, so an immediate
          // unchanged readback cannot prove that a deploy (especially a DO migration) did not
          // commit. Those ambiguous outcomes fail closed and resume only after operator readback.
          if (isProvenPreMutationDeploymentFailure(error)) {
            throw error;
          }
          if (classifyRetry(error) === 'fatal') {
            throw error;
          }
          throw new NonRetryableDeploymentError(
            `Direct deployment outcome is ambiguous for ${context.workerName}`
          );
        }
      }
    );
    deployedVersionId =
      commandResult.adoptedVersionId ??
      (await readVersionIdFromStructuredOutput(outputDirectory, commandResult.stdout));
    if (!deployedVersionId) {
      throw new Error('Wrangler did not report the deployed Cloudflare Version ID');
    }
    await options.workerScriptOwnership?.checkpointCommittedVersion(
      context.workerName,
      deployedVersionId
    );
    cloudflareScriptTag = await options.workerScriptOwnership?.captureAfterMutation(
      context.workerName
    );
    if (await hasManagedWorkerDeployGuard(context.packageDir, options.configFile)) {
      await verifyUploadedWorkerD1Bindings(context, deployedVersionId, options, throttle);
    }
    options.onProgress?.(`  ✓ ${context.workerName} deployed successfully`);
    return {
      component: context.component,
      workerName: context.workerName,
      success: true,
      deployedAt: new Date().toISOString(),
      version: context.packageVersion,
      cloudflareVersionId: deployedVersionId,
      cloudflareScriptTag,
      duration: Date.now() - context.startedAt,
    };
  } catch (error) {
    return {
      ...deploymentFailure(context, error),
      ...(deploymentMayBeLive
        ? {
            trafficCommitted: true,
            cloudflareVersionId: deployedVersionId,
            cloudflareScriptTag,
          }
        : {}),
    };
  } finally {
    await Promise.allSettled([
      secretFile?.cleanup(),
      outputDirectory ? rm(outputDirectory, { recursive: true, force: true }) : undefined,
    ]);
  }
}

async function readVersionIdFromStructuredOutput(
  outputDirectory: string,
  stdout: unknown
): Promise<string | undefined> {
  const payloads: string[] = [];
  try {
    for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        payloads.push(await readFile(join(outputDirectory, entry.name), 'utf-8'));
      }
    }
  } catch {
    // The stdout fallback below keeps diagnostics useful if Wrangler could not write output.
  }
  if (typeof stdout === 'string') {
    payloads.push(stdout);
  }

  for (const payload of payloads) {
    for (const line of payload.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as { type?: string; version_id?: unknown };
        if (
          (event.type === 'version-upload' || event.type === 'deploy') &&
          typeof event.version_id === 'string'
        ) {
          return event.version_id;
        }
      } catch {
        // Structured files are NDJSON; human-readable stdout is expected to fail JSON parsing.
      }
    }
  }
  return undefined;
}

async function uploadWorkerVersion(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<DeployResult> {
  let secretFile: TemporarySecretFile | undefined;
  let outputDirectory: string | undefined;
  try {
    await options.workerScriptOwnership?.assertBeforeMutation(context.workerName);
    secretFile = await createTemporarySecretFile(
      getSecretsForWorker(context.component, options.secrets)
    );
    outputDirectory = await mkdtemp(join(tmpdir(), 'authrim-wrangler-output-'));
    const commandResult = await runWithAdaptiveRetry(
      `Uploading version for ${context.workerName}`,
      options,
      throttle,
      () =>
        runAuthorizedWorkerMutation(context, options, throttle, () =>
          runManagedWranglerBuild(context, options, 'versions upload', (managedEnv) =>
            execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'versions',
                'upload',
                ...WORKER_BUNDLE_UPLOAD_ARGS,
                ...getConfigArgs(options),
                '--env',
                options.env,
                ...getVarArgs(context.component, options),
                ...(secretFile ? ['--secrets-file', secretFile.path] : []),
              ],
              {
                cwd: context.packageDir,
                reject: true,
                cancelSignal: options.signal,
                env: {
                  ...managedEnv,
                  WRANGLER_OUTPUT_FILE_DIRECTORY: outputDirectory,
                },
              }
            )
          )
        )
    );
    const versionId = await readVersionIdFromStructuredOutput(
      outputDirectory,
      commandResult.stdout
    );
    if (!versionId) {
      throw new Error('Wrangler did not report the uploaded Cloudflare Version ID');
    }
    await options.workerScriptOwnership?.checkpointCommittedVersion(context.workerName, versionId);
    const cloudflareScriptTag = await options.workerScriptOwnership?.captureAfterMutation(
      context.workerName
    );
    await verifyUploadedWorkerD1Bindings(context, versionId, options, throttle);
    options.onProgress?.(`  ✓ ${context.workerName} version uploaded`);
    return {
      component: context.component,
      workerName: context.workerName,
      success: true,
      version: context.packageVersion,
      cloudflareVersionId: versionId,
      cloudflareScriptTag,
      duration: Date.now() - context.startedAt,
    };
  } catch (error) {
    return deploymentFailure(context, error);
  } finally {
    await Promise.allSettled([
      secretFile?.cleanup(),
      outputDirectory ? rm(outputDirectory, { recursive: true, force: true }) : undefined,
    ]);
  }
}

async function validateWorkerTriggers(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<void> {
  await runWithAdaptiveRetry(
    `Validating triggers for ${context.workerName}`,
    options,
    throttle,
    async () => {
      await execa(
        'pnpm',
        [
          'exec',
          'wrangler',
          'triggers',
          'deploy',
          '--dry-run',
          ...getConfigArgs(options),
          '--env',
          options.env,
        ],
        { cwd: context.packageDir, reject: true, cancelSignal: options.signal }
      );
    }
  );
}

async function applyWorkerTriggers(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<void> {
  await runWithAdaptiveRetry(`Applying triggers for ${context.workerName}`, options, throttle, () =>
    runAuthorizedWorkerMutation(context, options, throttle, () =>
      execa(
        'pnpm',
        ['exec', 'wrangler', 'triggers', 'deploy', ...getConfigArgs(options), '--env', options.env],
        { cwd: context.packageDir, reject: true, cancelSignal: options.signal }
      )
    )
  );
}

function normalizeCronTriggerSet(crons: readonly string[], errorCode: string): string[] {
  const normalized = [...crons].sort();
  if (
    normalized.some(
      (cron) => typeof cron !== 'string' || cron.length === 0 || cron.trim() !== cron
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error(errorCode);
  }
  return normalized;
}

function cronTriggerSetsMatch(expected: readonly string[], actual: readonly string[]): boolean {
  return (
    expected.length === actual.length && expected.every((cron, index) => cron === actual[index])
  );
}

/**
 * Verify provider-side Cron Triggers for already deployed Workers and repair an exact mismatch from
 * the managed Wrangler config. This is deliberately separate from Worker traffic deployment so an
 * interrupted initial handoff can resume without uploading or promoting code again.
 */
export async function reconcileWorkerCronTriggers(
  options: DeployOptions,
  components: readonly WorkerComponent[]
): Promise<void> {
  if (options.dryRun) {
    options.onProgress?.('  [DRY RUN] Would verify and reconcile Worker Cron Triggers');
    return;
  }

  const throttle = makeThrottle({ ...options, concurrency: 1 });
  const readProviderCrons =
    options.readWorkerCronTriggers ??
    ((workerName: string, accountId?: string) =>
      listWorkerCronTriggers({ workerName, ...(accountId ? { accountId } : {}) }));

  for (const component of components) {
    const context = await getWorkerDeploymentContext(component, options);
    if (isDeployResult(context)) {
      throw new Error(
        `worker_cron_reconciliation_context_unavailable:${component}:${context.error ?? 'unknown'}`
      );
    }
    const configPath = resolve(context.packageDir, options.configFile ?? 'wrangler.toml');
    const expected = normalizeCronTriggerSet(
      parseWranglerToml(await readFile(configPath, 'utf8'), options.env).crons,
      `worker_cron_config_invalid:${component}`
    );
    // An omitted `triggers.crons` property intentionally leaves existing provider state untouched.
    if (expected.length === 0) continue;

    const actual = normalizeCronTriggerSet(
      await readProviderCrons(context.workerName, options.cloudflareAccountId),
      `worker_cron_provider_response_invalid:${component}`
    );
    if (cronTriggerSetsMatch(expected, actual)) {
      options.onProgress?.(`  ✓ ${context.workerName} Cron Triggers verified`);
      continue;
    }

    options.onProgress?.(
      `  ⏳ ${context.workerName} Cron Triggers are missing or stale; reapplying managed triggers...`
    );
    await applyWorkerTriggers(context, options, throttle);

    let verified = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const readback = normalizeCronTriggerSet(
        await readProviderCrons(context.workerName, options.cloudflareAccountId),
        `worker_cron_provider_response_invalid:${component}`
      );
      if (cronTriggerSetsMatch(expected, readback)) {
        verified = true;
        break;
      }
      if (attempt < 4 && process.env.NODE_ENV !== 'test') {
        await sleepForDeployment(options, Math.min(500 * 2 ** (attempt - 1), 2_000));
      }
    }
    if (!verified) throw new Error(`worker_cron_reconciliation_failed:${component}`);
    options.onProgress?.(`  ✓ ${context.workerName} Cron Triggers reapplied and verified`);
  }
}

async function deployWorkerTraffic(
  context: WorkerDeploymentContext,
  trafficSpecs: readonly string[],
  options: DeployOptions,
  throttle: DeploymentThrottle,
  label = `Promoting ${context.workerName} version`
): Promise<DeployResult> {
  let trafficCommitted = false;
  const promotedVersionId = trafficSpecs.length === 1 ? trafficSpecs[0].split('@')[0] : undefined;
  try {
    await runWithAdaptiveRetry(label, options, throttle, () =>
      runAuthorizedWorkerMutation(context, options, throttle, () =>
        execa(
          'pnpm',
          [
            'exec',
            'wrangler',
            'versions',
            'deploy',
            ...trafficSpecs,
            '--yes',
            ...getConfigArgs(options),
            '--env',
            options.env,
          ],
          { cwd: context.packageDir, reject: true, cancelSignal: options.signal }
        )
      )
    );
    trafficCommitted = true;
    if (promotedVersionId) {
      await options.workerScriptOwnership?.checkpointCommittedVersion(
        context.workerName,
        promotedVersionId
      );
    }
    const cloudflareScriptTag = await options.workerScriptOwnership?.captureAfterMutation(
      context.workerName
    );
    options.onProgress?.(`  ✓ ${context.workerName} traffic updated successfully`);
    return {
      component: context.component,
      workerName: context.workerName,
      success: true,
      deployedAt: new Date().toISOString(),
      version: context.packageVersion,
      cloudflareVersionId: promotedVersionId,
      cloudflareScriptTag,
      duration: Date.now() - context.startedAt,
    };
  } catch (error) {
    return {
      ...deploymentFailure(context, error),
      ...(trafficCommitted || error instanceof DeployConfigLockProofLostAfterMutationError
        ? {
            trafficCommitted: true,
            deployedAt: new Date().toISOString(),
            cloudflareVersionId: promotedVersionId,
          }
        : {}),
    };
  }
}

async function promoteWorkerVersion(
  context: WorkerDeploymentContext,
  cloudflareVersionId: string,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<DeployResult> {
  try {
    await validateWorkerTriggers(context, options, throttle);
  } catch (error) {
    return deploymentFailure(context, error);
  }

  const trafficResult = await deployWorkerTraffic(
    context,
    [`${cloudflareVersionId}@100%`],
    options,
    throttle
  );
  if (!trafficResult.success) {
    return trafficResult;
  }

  try {
    await applyWorkerTriggers(context, options, throttle);
    options.onProgress?.(`  ✓ ${context.workerName} promoted successfully`);
    return trafficResult;
  } catch (error) {
    return {
      ...deploymentFailure(context, error),
      deployedAt: trafficResult.deployedAt,
      cloudflareVersionId,
      trafficCommitted: true,
      error: `Traffic committed, but trigger synchronization failed: ${sanitizeDeploymentErrorMessage(
        getErrorText(error)
      )}`,
    };
  }
}

function resolvePlannedComponents(
  enabledComponents: WorkerComponent[] | undefined,
  existingComponents: readonly WorkerComponent[] | undefined
): WorkerComponent[] {
  const requested = new Set(enabledComponents ?? CORE_WORKER_COMPONENTS);
  if (!existingComponents) {
    return DEPLOYMENT_PRIORITY.filter((component) => requested.has(component));
  }

  const existing = new Set(existingComponents);
  const visited = new Set<WorkerComponent>();
  const visitMissingDependencies = (component: WorkerComponent): void => {
    if (visited.has(component)) {
      return;
    }
    visited.add(component);
    for (const dependency of WORKER_DEPLOYMENT_DEPENDENCIES[component]) {
      if (!existing.has(dependency) && !requested.has(dependency)) {
        requested.add(dependency);
      }
      // A stale/partial lock can contain a Worker while omitting one of its
      // transitive binding targets, so inspect every dependency either way.
      visitMissingDependencies(dependency);
    }
  };
  for (const component of [...requested]) {
    visitMissingDependencies(component);
  }
  return DEPLOYMENT_PRIORITY.filter((component) => requested.has(component));
}

function resolveDeploymentStrategy(
  options: DeployOptions,
  components: readonly WorkerComponent[]
): 'direct' | 'staged' {
  const requested = options.deploymentStrategy ?? 'auto';
  if (requested === 'direct') {
    return 'direct';
  }
  const existing = new Set(options.existingComponents ?? []);
  const canStage =
    components.length > 0 && components.every((component) => existing.has(component));
  if (requested === 'staged' && !canStage) {
    options.onProgress?.(
      'Some selected Workers are not in the deployment lock; using direct deployment for first-deploy safety.'
    );
  }
  return canStage ? 'staged' : 'direct';
}

function makeSkippedResult(
  component: WorkerComponent,
  options: DeployOptions,
  message: string,
  context?: WorkerDeploymentContext
): DeployResult {
  return {
    component,
    workerName: context?.workerName ?? getWorkerName(options.env, component),
    success: false,
    error: message,
    version: context?.packageVersion,
    duration: context ? Date.now() - context.startedAt : 0,
  };
}

async function runBoundedPool<T>(
  components: readonly WorkerComponent[],
  throttle: DeploymentThrottle,
  task: (component: WorkerComponent) => Promise<T>
): Promise<Map<WorkerComponent, T>> {
  const pending = [...components];
  const active = new Map<
    WorkerComponent,
    Promise<
      | { component: WorkerComponent; status: 'fulfilled'; value: T }
      | { component: WorkerComponent; status: 'rejected'; reason: unknown }
    >
  >();
  const results = new Map<WorkerComponent, T>();
  let firstError: unknown;

  while (pending.length > 0 || active.size > 0) {
    while (
      firstError === undefined &&
      pending.length > 0 &&
      active.size < throttle.currentConcurrency
    ) {
      const component = pending.shift()!;
      active.set(
        component,
        task(component).then(
          (value) => ({ component, status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ component, status: 'rejected' as const, reason })
        )
      );
    }
    if (active.size === 0) {
      break;
    }
    const settled = await Promise.race(active.values());
    active.delete(settled.component);
    if (settled.status === 'fulfilled') {
      results.set(settled.component, settled.value);
    } else if (firstError === undefined) {
      firstError = settled.reason;
      pending.length = 0;
    }
  }
  if (firstError !== undefined) {
    throw firstError instanceof Error ? firstError : new Error(getErrorText(firstError));
  }
  return results;
}

async function runDependencyScheduler(
  components: readonly WorkerComponent[],
  options: DeployOptions,
  throttle: DeploymentThrottle,
  task: (component: WorkerComponent) => Promise<DeployResult>,
  schedulerOptions: { stopOnFailure?: boolean } = {}
): Promise<Map<WorkerComponent, DeployResult>> {
  const selected = new Set(components);
  const pending = new Set(components);
  const active = new Map<
    WorkerComponent,
    Promise<{ component: WorkerComponent; result: DeployResult }>
  >();
  const results = new Map<WorkerComponent, DeployResult>();
  let halted = false;
  let haltReason = 'Skipped because another staged promotion failed';

  while (pending.size > 0 || active.size > 0) {
    if (halted) {
      for (const component of pending) {
        const result = makeSkippedResult(component, options, haltReason);
        results.set(component, result);
        options.onError?.(component, new Error(result.error));
      }
      pending.clear();
    }

    for (const component of [...pending]) {
      const failedDependency = WORKER_DEPLOYMENT_DEPENDENCIES[component]
        .filter((dependency) => selected.has(dependency))
        .find((dependency) => results.get(dependency)?.success === false);
      if (failedDependency) {
        const result = makeSkippedResult(
          component,
          options,
          `Skipped because dependency ${failedDependency} failed`
        );
        pending.delete(component);
        results.set(component, result);
        options.onError?.(component, new Error(result.error));
      }
    }

    while (active.size < throttle.currentConcurrency) {
      const ready = [...pending].find((component) =>
        WORKER_DEPLOYMENT_DEPENDENCIES[component]
          .filter((dependency) => selected.has(dependency))
          .every((dependency) => results.get(dependency)?.success === true)
      );
      if (!ready) {
        break;
      }
      pending.delete(ready);
      active.set(
        ready,
        task(ready).then(
          (result) => ({ component: ready, result }),
          (error: unknown) => ({
            component: ready,
            result: makeSkippedResult(
              ready,
              options,
              `Unexpected deployment error: ${sanitizeDeploymentErrorMessage(getErrorText(error))}`
            ),
          })
        )
      );
    }

    if (active.size === 0) {
      for (const component of pending) {
        const result = makeSkippedResult(
          component,
          options,
          'Skipped because the deployment dependency graph could not make progress'
        );
        results.set(component, result);
        options.onError?.(component, new Error(result.error));
      }
      pending.clear();
      break;
    }

    const settled = await Promise.race(active.values());
    active.delete(settled.component);
    results.set(settled.component, settled.result);
    if (!settled.result.success) {
      options.onError?.(settled.component, new Error(settled.result.error));
      if (isLocalDiskExhaustionError(settled.result.error)) {
        halted = true;
        haltReason =
          'Skipped because Worker deployment stopped after local disk space was exhausted';
      } else if (schedulerOptions.stopOnFailure) {
        halted = true;
      }
    }
  }
  return results;
}

async function runSingleWorkerWithDeploymentLease<T>(
  component: WorkerComponent,
  options: DeployOptions,
  operation: () => Promise<T>,
  succeeded: (result: T) => boolean
): Promise<T> {
  const existingSession = options.deploymentLeaseSession;
  if (options.dryRun) return operation();
  if (!existingSession) {
    options.onProgress?.('Checking local disk space before Worker deployment...');
    await assertLocalDeploymentCapacity({
      rootDir: options.rootDir,
      phase: 'Worker deployment',
      minimumFreeBytes: MINIMUM_WORKER_DEPLOY_FREE_BYTES,
      readAvailableBytes: options.readAvailableDiskBytes,
    });
  }
  await assertDeployConfigLockProof(options);
  if (existingSession) {
    if (!options.workerScriptOwnership) {
      throw new Error(`worker_script_ownership_guard_missing:${component}`);
    }
    return operation();
  }
  await options.beforeWorkerMutations?.();
  await assertDeployConfigLockProof(options);
  await ensureWorkerScriptOwnershipGuard(options, [
    { component, workerName: getWorkerName(options.env, component) },
  ]);
  if (!options.deploymentLease) {
    return operation();
  }
  const context = await getWorkerDeploymentContext(component, options);
  if (isDeployResult(context)) return operation();
  const throttle = makeThrottle({ ...options, concurrency: 1 });
  const session = await createWorkerDeploymentLeaseSession(
    options,
    [component],
    new Map([[component, context]]),
    throttle
  );
  if (!session) return operation();
  options.deploymentLeaseSession = session;
  let success = false;
  try {
    const result = await operation();
    success = succeeded(result);
    return result;
  } finally {
    options.deploymentLeaseSession = undefined;
    await closeWorkerDeploymentLeaseSession(session, success);
  }
}

/** Deploy a single worker with adaptive retry and optional staged promotion. */
async function deployWorkerWithoutLease(
  component: WorkerComponent,
  options: DeployOptions
): Promise<DeployResult> {
  const context = await getWorkerDeploymentContext(component, options);
  if (isDeployResult(context)) {
    return context;
  }
  const strategy = resolveDeploymentStrategy(options, [component]);
  if (options.dryRun) {
    const effectiveStrategy = context.requiresDirectDeployment ? 'direct' : strategy;
    options.onProgress?.(
      `[1/${Math.max(1, options.maxRetries ?? 3)}] Deploying ${context.workerName}...`
    );
    options.onProgress?.(
      `  [DRY RUN] Would ${effectiveStrategy === 'staged' ? 'upload and promote' : 'deploy'} ${component} with --env ${options.env}`
    );
    return {
      component,
      workerName: context.workerName,
      success: true,
      deployedAt: new Date().toISOString(),
      version: context.packageVersion,
      duration: Date.now() - context.startedAt,
    };
  }

  const throttle = makeThrottle(options);
  if (strategy === 'direct' || context.requiresDirectDeployment) {
    if (strategy === 'staged' && context.requiresDirectDeployment) {
      options.onProgress?.(
        `${context.workerName} contains Durable Object migrations; using direct deploy.`
      );
    }
    return deployWorkerDirect(context, options, throttle);
  }
  const prepared = await uploadWorkerVersion(context, options, throttle);
  if (!prepared.success || !prepared.cloudflareVersionId) {
    return prepared;
  }
  return promoteWorkerVersion(context, prepared.cloudflareVersionId, options, throttle);
}

export async function deployWorker(
  component: WorkerComponent,
  options: DeployOptions
): Promise<DeployResult> {
  // Input validation is read-only and should remain observable even when no ownership lock exists.
  if (!isValidEnv(options.env)) {
    return deployWorkerWithoutLease(component, options);
  }
  return runSingleWorkerWithDeploymentLease(
    component,
    options,
    () => deployWorkerWithoutLease(component, options),
    (result) => result.success
  );
}

export interface GradualDeployOptions {
  /** Strictly increasing percentages; the final stage must be 100. */
  stages: readonly number[];
  stabilizationDelayMs?: number;
  stageWaitMs?: number;
  healthCheck?: (stage: number) => Promise<{ success: boolean; error?: string }>;
}

interface WranglerDeploymentListItem {
  id?: string;
  created_on?: string;
  versions?: Array<{ version_id?: string; percentage?: number }>;
}

interface WorkerTrafficSnapshot {
  deploymentId?: string;
  specs: string[];
}

interface HeldWorkerDeploymentLease {
  context: WorkerDeploymentContext;
  baseline: WorkerTrafficSnapshot;
  sourceAbsent: boolean;
  lease: SetupWorkerDeploymentLease;
}

interface WorkerDeploymentLeaseSession {
  coordinator: WorkerDeploymentLeaseCoordinator;
  leases: Map<WorkerComponent, HeldWorkerDeploymentLease>;
}

export interface WorkerDeploymentLeaseCoordinator {
  acquire(input: {
    workerScriptName: string;
    expectedSourceVersionId: string;
  }): Promise<SetupWorkerDeploymentLease>;
  renew(lease: SetupWorkerDeploymentLease): Promise<SetupWorkerDeploymentLease>;
  assertCurrent(lease: SetupWorkerDeploymentLease): Promise<void>;
  markMutationStarted(
    lease: SetupWorkerDeploymentLease,
    previousDeploymentId?: string
  ): Promise<SetupWorkerDeploymentLease>;
  release(lease: SetupWorkerDeploymentLease): Promise<void>;
  complete(success: boolean, errorCode?: string): Promise<void>;
}

function normalizeTrafficSpecs(specs: readonly string[]): string[] {
  return specs
    .map((spec) => {
      const match = spec.match(/^(.+)@(\d+(?:\.\d+)?)%$/);
      return match ? `${match[1]}@${Number(match[2])}%` : spec;
    })
    .sort();
}

function trafficSpecsEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    JSON.stringify(normalizeTrafficSpecs(left)) === JSON.stringify(normalizeTrafficSpecs(right))
  );
}

function getTrafficVersionIds(specs: readonly string[]): Set<string> {
  return new Set(specs.map((spec) => spec.split('@')[0]));
}

async function assertWorkerTrafficUnchanged(
  context: WorkerDeploymentContext,
  expected: WorkerTrafficSnapshot,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<void> {
  const current = await readWorkerTrafficSnapshot(context, options, throttle);
  if (!trafficSpecsEqual(current.specs, expected.specs)) {
    throw new Error(
      `Concurrent deployment detected for ${context.workerName}; expected ${expected.specs.join(', ')}, found ${current.specs.join(', ')}`
    );
  }
}

async function assertWorkerTrafficOwnedForRollback(
  context: WorkerDeploymentContext,
  baseline: WorkerTrafficSnapshot,
  newVersionId: string,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<void> {
  const current = await readWorkerTrafficSnapshot(context, options, throttle);
  const allowed = getTrafficVersionIds([...baseline.specs, `${newVersionId}@100%`]);
  const unexpected = [...getTrafficVersionIds(current.specs)].filter(
    (versionId) => !allowed.has(versionId)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Concurrent deployment detected for ${context.workerName}; rollback skipped to avoid overwriting version(s) ${unexpected.join(', ')}`
    );
  }
}

async function readWorkerTrafficSnapshot(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<WorkerTrafficSnapshot> {
  const deploymentsResult = await runWithAdaptiveRetry(
    `Reading current deployment for ${context.workerName}`,
    options,
    throttle,
    () =>
      execa(
        'pnpm',
        [
          'exec',
          'wrangler',
          'deployments',
          'list',
          '--json',
          ...getConfigArgs(options),
          '--env',
          options.env,
        ],
        { cwd: context.packageDir, reject: true, cancelSignal: options.signal }
      )
  );
  const deployments = JSON.parse(String(deploymentsResult.stdout)) as WranglerDeploymentListItem[];
  const activeDeployment = deployments.at(-1);
  const activeVersions = (activeDeployment?.versions ?? []).filter(
    (version) =>
      typeof version.version_id === 'string' &&
      typeof version.percentage === 'number' &&
      version.percentage > 0
  );
  if (activeVersions.length === 0) {
    throw new Error(`No active baseline deployment found for ${context.workerName}`);
  }
  const totalPercentage = activeVersions.reduce(
    (total, version) => total + (version.percentage ?? 0),
    0
  );
  if (Math.abs(totalPercentage - 100) > 0.001) {
    throw new Error(
      `Active deployment traffic for ${context.workerName} totals ${totalPercentage}%, not 100%`
    );
  }
  return {
    deploymentId: activeDeployment?.id,
    specs: activeVersions.map((version) => `${version.version_id}@${version.percentage}%`),
  };
}

function sourceVersionFromSnapshot(workerName: string, snapshot: WorkerTrafficSnapshot): string {
  if (snapshot.specs.length !== 1 || !snapshot.specs[0].endsWith('@100%')) {
    throw new Error(
      `Deployment lease for ${workerName} requires one active source version at 100%; found ${snapshot.specs.join(', ')}`
    );
  }
  const versionId = snapshot.specs[0].split('@')[0];
  if (!versionId) throw new Error(`No active source version found for ${workerName}`);
  return versionId;
}

async function createWorkerDeploymentLeaseSession(
  options: DeployOptions,
  components: readonly WorkerComponent[],
  contexts: ReadonlyMap<WorkerComponent, WorkerDeploymentContext>,
  throttle: DeploymentThrottle
): Promise<WorkerDeploymentLeaseSession | undefined> {
  if (options.dryRun) return undefined;
  const config = options.deploymentLease;
  const existing = new Set(options.existingComponents ?? []);
  const leasedComponents = components
    .filter(
      (component) =>
        contexts.has(component) && (existing.has(component) || config?.required === true)
    )
    .sort((left, right) =>
      contexts.get(left)!.workerName.localeCompare(contexts.get(right)!.workerName)
    );
  if (leasedComponents.length === 0) return undefined;
  if (!config) {
    return undefined;
  }

  const coordinator =
    config.coordinator ??
    new SetupWorkerDeploymentLeaseCoordinator({
      databaseId: config.controlDatabaseId,
      environmentId: config.environmentId,
      actorId: config.actorId,
      accountId: config.accountId,
      ttlSeconds: 900,
    });
  const session: WorkerDeploymentLeaseSession = { coordinator, leases: new Map() };
  try {
    for (const component of leasedComponents) {
      const context = contexts.get(component)!;
      const sourceAbsent = !existing.has(component);
      const baseline = sourceAbsent
        ? { specs: ['__absent__@100%'] }
        : await readWorkerTrafficSnapshot(context, options, throttle);
      const lease = await coordinator.acquire({
        workerScriptName: context.workerName,
        expectedSourceVersionId: sourceAbsent
          ? '__absent__'
          : sourceVersionFromSnapshot(context.workerName, baseline),
      });
      session.leases.set(component, { context, baseline, sourceAbsent, lease });
      options.onProgress?.(`  ✓ Deployment lease acquired for ${context.workerName}`);
    }
    return session;
  } catch (error) {
    for (const held of [...session.leases.values()].reverse()) {
      await coordinator.release(held.lease).catch(() => undefined);
    }
    await coordinator.complete(false, 'deployment_lease_acquire_failed').catch(() => undefined);
    throw error;
  }
}

async function closeWorkerDeploymentLeaseSession(
  session: WorkerDeploymentLeaseSession | undefined,
  success: boolean
): Promise<void> {
  if (!session) return;
  let releaseFailed = false;
  for (const held of [...session.leases.values()].reverse()) {
    try {
      await session.coordinator.release(held.lease);
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed) {
    await session.coordinator
      .complete(false, 'deployment_lease_release_failed')
      .catch(() => undefined);
    throw new Error('worker_deployment_lease_release_failed');
  }
  await session.coordinator.complete(success, success ? undefined : 'worker_deployment_failed');
}

async function authorizeWorkerMutation(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<void> {
  const session = options.deploymentLeaseSession;
  const held = session?.leases.get(context.component);
  if (!session || !held) {
    if (
      options.deploymentLease?.required &&
      new Set(options.existingComponents ?? []).has(context.component)
    ) {
      throw new Error(`worker_deployment_lease_missing:${context.workerName}`);
    }
    return;
  }

  held.lease = await session.coordinator.renew(held.lease);
  if (!held.lease.mutationStarted) {
    if (held.sourceAbsent) {
      if (
        await cloudflareWorkerHasActiveDeployment(
          context.workerName,
          context.packageDir,
          options,
          throttle
        )
      ) {
        throw new Error(`Concurrent deployment created ${context.workerName} before mutation`);
      }
    } else {
      const current = await readWorkerTrafficSnapshot(context, options, throttle);
      if (
        current.deploymentId !== held.baseline.deploymentId ||
        !trafficSpecsEqual(current.specs, held.baseline.specs)
      ) {
        throw new Error(`Concurrent deployment detected for ${context.workerName} before mutation`);
      }
    }
    held.lease = await session.coordinator.markMutationStarted(
      held.lease,
      held.baseline.deploymentId
    );
  } else {
    await session.coordinator.assertCurrent(held.lease);
  }
}

async function runAuthorizedWorkerMutation<T>(
  context: WorkerDeploymentContext,
  options: DeployOptions,
  throttle: DeploymentThrottle,
  mutation: () => Promise<T>
): Promise<T> {
  await authorizeWorkerMutation(context, options, throttle);
  const session = options.deploymentLeaseSession;
  const held = session?.leases.get(context.component);
  const coordinator = held ? session!.coordinator : undefined;
  let renewal: Promise<void> = Promise.resolve();
  let renewalError: unknown;
  const timer = held
    ? setInterval(() => {
        renewal = renewal.then(async () => {
          if (renewalError) return;
          try {
            held.lease = await coordinator!.renew(held.lease);
          } catch (error) {
            renewalError = error;
          }
        });
      }, 240_000)
    : undefined;
  timer?.unref();
  let result: T | undefined;
  let mutationError: unknown;
  try {
    // Revalidate the exact lock inode/token immediately before every provider mutation. The
    // capability is not caller-constructible and fails after release or cross-env reuse.
    await assertDeployConfigLockProof(options);
    // A Worker name is mutable account namespace, not ownership proof. Re-read the immutable
    // Cloudflare script tag at the last possible point before every provider mutation.
    await options.workerScriptOwnership?.assertBeforeMutation(context.workerName);
    result = await mutation();
    await assertDeployConfigLockProofAfterMutation(options);
  } catch (error) {
    mutationError = error;
  }
  if (timer) clearInterval(timer);
  await renewal;
  let currentLeaseError: unknown;
  if (held) {
    try {
      await coordinator!.assertCurrent(held.lease);
    } catch (error) {
      currentLeaseError = error;
    }
  }
  // Preserve a post-mutation capability failure even when lease readback also fails. Otherwise a
  // transient lease error could mask committed traffic and let the adaptive retry replay it.
  if (mutationError) {
    throw mutationError instanceof Error ? mutationError : new Error(getErrorText(mutationError));
  }
  if (renewalError) {
    throw renewalError instanceof Error ? renewalError : new Error(getErrorText(renewalError));
  }
  if (currentLeaseError) {
    throw currentLeaseError instanceof Error
      ? currentLeaseError
      : new Error(getErrorText(currentLeaseError));
  }
  return result as T;
}

function validateGradualStages(stages: readonly number[]): void {
  if (
    stages.length === 0 ||
    stages.at(-1) !== 100 ||
    stages.some(
      (stage, index) =>
        !Number.isInteger(stage) ||
        stage < 1 ||
        stage > 100 ||
        (index > 0 && stage <= stages[index - 1])
    )
  ) {
    throw new Error(
      'Gradual stages must be strictly increasing integers from 1 to 100 ending at 100'
    );
  }
}

/**
 * Roll out one existing Worker by exact Cloudflare Version IDs.
 * First deployments fall back to a direct deployment because there is no old
 * version with which to split traffic.
 */
async function deployWorkerGraduallyWithoutLease(
  component: WorkerComponent,
  options: DeployOptions,
  gradual: GradualDeployOptions
): Promise<DeployResult> {
  const context = await getWorkerDeploymentContext(component, options);
  if (isDeployResult(context)) {
    return context;
  }
  try {
    validateGradualStages(gradual.stages);
  } catch (error) {
    return deploymentFailure(context, error);
  }

  const throttle = makeThrottle({ ...options, concurrency: 1 });
  if (options.dryRun) {
    options.onProgress?.(
      `  [DRY RUN] Would roll out ${component} at ${gradual.stages.join('%, ')}%`
    );
    return {
      component,
      workerName: context.workerName,
      success: true,
      deployedAt: new Date().toISOString(),
      version: context.packageVersion,
      duration: Date.now() - context.startedAt,
    };
  }

  let remoteExists: boolean;
  try {
    remoteExists = await cloudflareWorkerHasActiveDeployment(
      context.workerName,
      context.packageDir,
      options,
      throttle
    );
  } catch (error) {
    return deploymentFailure(context, error);
  }
  if (!remoteExists || context.requiresDirectDeployment) {
    options.onProgress?.(
      context.requiresDirectDeployment
        ? `${context.workerName} contains Durable Object migrations; using direct deploy.`
        : `${context.workerName} has no recorded deployment; gradual traffic splitting is unavailable, using direct deploy.`
    );
    return deployWorkerDirect(context, options, throttle);
  }

  let baseline: WorkerTrafficSnapshot;
  try {
    baseline = await readWorkerTrafficSnapshot(context, options, throttle);
    if (baseline.specs.length !== 1 || !baseline.specs[0].endsWith('@100%')) {
      throw new Error(
        `Gradual rollout requires exactly one active baseline version at 100%; found ${baseline.specs.join(', ')}`
      );
    }
  } catch (error) {
    return deploymentFailure(context, error);
  }

  const prepared = await uploadWorkerVersion(context, options, throttle);
  if (!prepared.success || !prepared.cloudflareVersionId) {
    return prepared;
  }
  const newVersionId = prepared.cloudflareVersionId;
  const oldVersionId = baseline.specs[0].split('@')[0];

  try {
    await validateWorkerTriggers(context, options, throttle);
    await assertWorkerTrafficUnchanged(context, baseline, options, throttle);
  } catch (error) {
    return deploymentFailure(context, error);
  }

  let trafficCommitted = false;
  try {
    for (const [index, stage] of gradual.stages.entries()) {
      const specs =
        stage === 100
          ? [`${newVersionId}@100%`]
          : [`${oldVersionId}@${100 - stage}%`, `${newVersionId}@${stage}%`];
      const trafficResult = await deployWorkerTraffic(
        context,
        specs,
        options,
        throttle,
        `Rolling out ${context.workerName} at ${stage}%`
      );
      if (!trafficResult.success) {
        if (trafficResult.trafficCommitted) {
          return {
            ...trafficResult,
            cloudflareVersionId: newVersionId,
            trafficCommitted: true,
            error: `${trafficResult.error || `Traffic update failed at ${stage}%`}; rollback skipped because the deploy-config lock was lost after the provider mutation`,
          };
        }
        throw new Error(trafficResult.error || `Traffic update failed at ${stage}%`);
      }
      options.onProgress?.(`  ✓ ${context.workerName}: ${stage}% traffic on new version`);

      const stabilizationDelayMs = Math.max(0, gradual.stabilizationDelayMs ?? 30_000);
      if (stabilizationDelayMs > 0) {
        await sleepForDeployment(options, stabilizationDelayMs);
      }
      if (gradual.healthCheck) {
        const health = await gradual.healthCheck(stage);
        if (!health.success) {
          throw new Error(
            `Health check failed at ${stage}%: ${health.error || 'unknown health error'}`
          );
        }
      }
      if (index < gradual.stages.length - 1) {
        const stageWaitMs = Math.max(0, gradual.stageWaitMs ?? 0);
        if (stageWaitMs > 0) {
          options.onProgress?.(
            `  ⏳ Waiting ${(stageWaitMs / 60_000).toFixed(1)} minute(s) before next stage...`
          );
          await sleepForDeployment(options, stageWaitMs);
        }
      }
    }

    // Code traffic is now healthy and committed. Trigger sync is deliberately
    // last because routes and cron triggers cannot be restored by a traffic rollback.
    trafficCommitted = true;
    await applyWorkerTriggers(context, options, throttle);
  } catch (error) {
    if (trafficCommitted) {
      return {
        ...deploymentFailure(context, error),
        deployedAt: new Date().toISOString(),
        cloudflareVersionId: newVersionId,
        trafficCommitted: true,
        error: `Traffic committed, but trigger synchronization failed: ${sanitizeDeploymentErrorMessage(
          getErrorText(error)
        )}`,
      };
    }

    options.onProgress?.(`  ⚠️ Rolling ${context.workerName} back to ${baseline.specs.join(', ')}`);
    const recoveryOptions: DeployOptions = { ...options, signal: undefined, concurrency: 1 };
    const recoveryThrottle = makeThrottle(recoveryOptions);
    try {
      await assertWorkerTrafficOwnedForRollback(
        context,
        baseline,
        newVersionId,
        recoveryOptions,
        recoveryThrottle
      );
      const rollback = await deployWorkerTraffic(
        context,
        baseline.specs,
        recoveryOptions,
        recoveryThrottle,
        `Rolling back ${context.workerName}`
      );
      if (!rollback.success) {
        throw new Error(rollback.error || 'unknown rollback error');
      }
    } catch (rollbackError) {
      return deploymentFailure(
        context,
        new Error(`${getErrorText(error)}; rollback also failed: ${getErrorText(rollbackError)}`)
      );
    }
    return deploymentFailure(context, error);
  }

  return {
    component,
    workerName: context.workerName,
    success: true,
    deployedAt: new Date().toISOString(),
    version: context.packageVersion,
    cloudflareVersionId: newVersionId,
    duration: Date.now() - context.startedAt,
  };
}

export async function deployWorkerGradually(
  component: WorkerComponent,
  options: DeployOptions,
  gradual: GradualDeployOptions
): Promise<DeployResult> {
  return runSingleWorkerWithDeploymentLease(
    component,
    options,
    () => deployWorkerGraduallyWithoutLease(component, options, gradual),
    (result) => result.success
  );
}

/** Deploy multiple workers through the same dependency-aware bounded scheduler. */
export async function deployParallel(
  components: WorkerComponent[],
  options: DeployOptions
): Promise<DeployResult[]> {
  return (await deployAll(options, components)).results;
}

/** Deploy all selected workers with a bounded dependency DAG. */
export async function deployAll(
  options: DeployOptions,
  enabledComponents?: WorkerComponent[]
): Promise<DeploymentSummary> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const components = resolvePlannedComponents(enabledComponents, options.existingComponents);
  const existingComponents = new Set(options.existingComponents ?? []);
  if (!options.dryRun && components.length > 0) {
    options.onProgress?.('Checking local disk space before Worker deployment...');
    await assertLocalDeploymentCapacity({
      rootDir: options.rootDir,
      phase: 'Worker deployment',
      minimumFreeBytes: MINIMUM_WORKER_DEPLOY_FREE_BYTES,
      readAvailableBytes: options.readAvailableDiskBytes,
    });
  }
  if (
    !options.dryRun &&
    components.includes('ar-control') &&
    !existingComponents.has('ar-control')
  ) {
    const missingControlSecrets = getMissingRequiredDeploySecrets(
      options.secrets ?? {},
      ['ar-control'],
      { automaticProvisioning: options.automaticProvisioning ?? true }
    );
    if (missingControlSecrets.length > 0) {
      throw new Error(`control_plane_baseline_secrets_missing:${missingControlSecrets.join(',')}`);
    }
  }
  const strategy = resolveDeploymentStrategy(options, components);
  const controlBootstrapConfig = initialControlBootstrapConfig(options, components, strategy);
  const authBootstrapConfig = initialAuthBootstrapConfig(options, components, strategy);
  const bridgeBootstrapConfig = initialBridgeBootstrapConfig(options, components, strategy);
  const throttle = makeThrottle(options);

  options.onProgress?.('Starting Authrim deployment...\n');
  options.onProgress?.(`Environment: ${options.env}`);
  options.onProgress?.(`Workers: ${components.join(', ') || '(none)'}`);
  options.onProgress?.(
    `Strategy: ${strategy}; maximum concurrency: ${throttle.configuredConcurrency}\n`
  );

  if (!options.dryRun) {
    await assertDeployConfigLockProof(options);
    await options.beforeWorkerMutations?.();
    await assertDeployConfigLockProof(options);
    await ensureWorkerScriptOwnershipGuard(
      options,
      components.map((component) => ({
        component,
        workerName: getWorkerName(options.env, component),
      }))
    );
  }

  const contexts = new Map<WorkerComponent, WorkerDeploymentContext>();
  const validationFailures = new Map<WorkerComponent, DeployResult>();
  for (const component of components) {
    const context = await getWorkerDeploymentContext(component, options);
    if (isDeployResult(context)) {
      validationFailures.set(component, context);
    } else {
      contexts.set(component, context);
    }
  }

  const existingLeaseSession = options.deploymentLeaseSession;
  const leaseSession =
    existingLeaseSession ??
    (await createWorkerDeploymentLeaseSession(options, components, contexts, throttle));
  const ownsLeaseSession = leaseSession !== undefined && existingLeaseSession === undefined;
  if (leaseSession) options.deploymentLeaseSession = leaseSession;
  let deploymentSucceeded = false;

  try {
    let resultMap: Map<WorkerComponent, DeployResult>;
    if (options.dryRun) {
      resultMap = await runDependencyScheduler(components, options, throttle, async (component) => {
        const failure = validationFailures.get(component);
        if (failure) {
          return failure;
        }
        const context = contexts.get(component)!;
        const effectiveStrategy = context.requiresDirectDeployment ? 'direct' : strategy;
        options.onProgress?.(
          `  [DRY RUN] Would ${effectiveStrategy === 'staged' ? 'upload and promote' : 'deploy'} ${component}`
        );
        if (component === 'ar-management' && authBootstrapConfig) {
          options.onProgress?.(
            '  [DRY RUN] Would redeploy ar-auth with ACCOUNT_PROVISIONER after ar-management'
          );
        }
        if (component === 'ar-management' && bridgeBootstrapConfig) {
          options.onProgress?.(
            '  [DRY RUN] Would redeploy ar-bridge with EXTERNAL_IDP_ACCOUNT_PROVISIONER after ar-management'
          );
        }
        return {
          component,
          workerName: context.workerName,
          success: true,
          deployedAt: new Date().toISOString(),
          version: context.packageVersion,
          duration: Date.now() - context.startedAt,
        };
      });
    } else if (strategy === 'staged') {
      const versionedComponents = components.filter(
        (component) =>
          !validationFailures.has(component) &&
          contexts.get(component)?.requiresDirectDeployment === false
      );
      const prepared = await runBoundedPool(versionedComponents, throttle, (component) =>
        uploadWorkerVersion(contexts.get(component)!, options, throttle)
      );
      const uploadFailed =
        validationFailures.size > 0 ||
        versionedComponents.some((component) => prepared.get(component)?.success !== true);
      if (uploadFailed) {
        resultMap = new Map(
          components.map((component) => {
            const validationFailure = validationFailures.get(component);
            if (validationFailure) {
              options.onError?.(component, new Error(validationFailure.error));
              return [component, validationFailure];
            }
            const result = prepared.get(component);
            if (!result || result.success) {
              const aborted = makeSkippedResult(
                component,
                options,
                result
                  ? 'Version was uploaded but not promoted because another upload failed'
                  : 'Direct deployment was not started because another version upload failed',
                contexts.get(component)
              );
              options.onError?.(component, new Error(aborted.error));
              return [component, aborted];
            }
            options.onError?.(component, new Error(result.error));
            return [component, result];
          })
        );
      } else {
        // Validate every non-versioned trigger and snapshot exact baseline traffic
        // before the first remote mutation. This gives the traffic phase a safe
        // rollback barrier while keeping trigger changes outside that transaction.
        const commitPreflight = await runBoundedPool(
          versionedComponents,
          throttle,
          async (component) => {
            const context = contexts.get(component)!;
            try {
              await validateWorkerTriggers(context, options, throttle);
              return {
                component,
                snapshot: await readWorkerTrafficSnapshot(context, options, throttle),
              };
            } catch (error) {
              return { component, failure: deploymentFailure(context, error) };
            }
          }
        );
        const preflightFailed = versionedComponents.some(
          (component) => commitPreflight.get(component)?.failure !== undefined
        );

        if (preflightFailed) {
          resultMap = new Map(
            components.map((component) => {
              const failure = commitPreflight.get(component)?.failure;
              if (failure) {
                options.onError?.(component, new Error(failure.error));
                return [component, failure];
              }
              const aborted = makeSkippedResult(
                component,
                options,
                'Deployment was not started because staged trigger validation or baseline capture failed',
                contexts.get(component)
              );
              options.onError?.(component, new Error(aborted.error));
              return [component, aborted];
            })
          );
        } else {
          const attemptedVersionPromotions: WorkerComponent[] = [];
          resultMap = await runDependencyScheduler(
            components,
            options,
            throttle,
            async (component) => {
              const context = contexts.get(component)!;
              if (context.requiresDirectDeployment) {
                options.onProgress?.(
                  `${context.workerName} contains Durable Object migrations; using direct deploy.`
                );
                return deployWorkerDirect(context, options, throttle);
              }
              attemptedVersionPromotions.push(component);
              try {
                await assertWorkerTrafficUnchanged(
                  context,
                  commitPreflight.get(component)!.snapshot!,
                  options,
                  throttle
                );
              } catch (error) {
                return deploymentFailure(context, error);
              }
              return deployWorkerTraffic(
                context,
                [`${prepared.get(component)!.cloudflareVersionId!}@100%`],
                options,
                throttle
              );
            },
            { stopOnFailure: true }
          );

          const trafficFailure = components.find(
            (component) => resultMap.get(component)?.success === false
          );
          if (trafficFailure) {
            const failedTrafficResult = resultMap.get(trafficFailure)!;
            if (failedTrafficResult.trafficCommitted) {
              // The exact workspace capability was lost after Cloudflare accepted a promotion.
              // Its outcome is committed/ambiguous and the same invalid capability must never be
              // used to issue rollback mutations. Preserve evidence for every promotion that may
              // already be serving so resume can reconcile from provider state.
              for (const component of attemptedVersionPromotions) {
                const previous = resultMap.get(component)!;
                resultMap.set(component, {
                  ...previous,
                  success: false,
                  trafficCommitted: previous.success || previous.trafficCommitted === true,
                  error: `${previous.error ? `${previous.error}; ` : ''}rollback skipped because the deploy-config lock was lost after a provider mutation in ${trafficFailure}`,
                });
              }
            } else {
              const recoveryOptions: DeployOptions = {
                ...options,
                signal: undefined,
                concurrency: 1,
              };
              const recoveryThrottle = makeThrottle(recoveryOptions);
              const rollbackFailures = new Map<WorkerComponent, string>();
              for (const component of [...attemptedVersionPromotions].reverse()) {
                const snapshot = commitPreflight.get(component)?.snapshot;
                if (!snapshot) {
                  continue;
                }
                const newVersionId = prepared.get(component)!.cloudflareVersionId!;
                try {
                  await assertWorkerTrafficOwnedForRollback(
                    contexts.get(component)!,
                    snapshot,
                    newVersionId,
                    recoveryOptions,
                    recoveryThrottle
                  );
                } catch (error) {
                  rollbackFailures.set(component, getErrorText(error));
                  continue;
                }
                const rollback = await deployWorkerTraffic(
                  contexts.get(component)!,
                  snapshot.specs,
                  recoveryOptions,
                  recoveryThrottle,
                  `Rolling back ${getWorkerName(options.env, component)}`
                );
                if (!rollback.success) {
                  rollbackFailures.set(component, rollback.error || 'unknown rollback error');
                }
              }

              for (const component of attemptedVersionPromotions) {
                const previous = resultMap.get(component)!;
                const rollbackError = rollbackFailures.get(component);
                resultMap.set(component, {
                  ...previous,
                  success: false,
                  deployedAt: rollbackError ? previous.deployedAt : undefined,
                  trafficCommitted: rollbackError ? true : false,
                  error: rollbackError
                    ? `${previous.error || `Staged deployment failed in ${trafficFailure}`}; rollback failed: ${rollbackError}`
                    : `${previous.error ? `${previous.error}; ` : ''}Rolled back because staged deployment failed in ${trafficFailure}`,
                });
              }
            }
          } else {
            // All version traffic is now committed. Synchronize non-versioned
            // routes/domains/crons serially so a failure is explicit and resumable.
            let triggerFailure: WorkerComponent | undefined;
            for (const component of versionedComponents) {
              const trafficResult = resultMap.get(component)!;
              if (triggerFailure) {
                resultMap.set(component, {
                  ...trafficResult,
                  success: false,
                  trafficCommitted: true,
                  error: `Traffic committed, but trigger synchronization was skipped after ${triggerFailure} failed`,
                });
                continue;
              }
              try {
                await applyWorkerTriggers(contexts.get(component)!, options, throttle);
                options.onProgress?.(
                  `  ✓ ${getWorkerName(options.env, component)} promoted successfully`
                );
              } catch (error) {
                triggerFailure = component;
                resultMap.set(component, {
                  ...trafficResult,
                  success: false,
                  trafficCommitted: true,
                  error: `Traffic committed, but trigger synchronization failed: ${sanitizeDeploymentErrorMessage(
                    getErrorText(error)
                  )}`,
                });
              }
            }
          }
        }
      }
    } else {
      let bootstrapControlResult: DeployResult | undefined;
      let bootstrapAuthResult: DeployResult | undefined;
      let fullAuthResult: DeployResult | undefined;
      let bootstrapBridgeResult: DeployResult | undefined;
      let fullBridgeResult: DeployResult | undefined;
      resultMap = await runDependencyScheduler(components, options, throttle, async (component) => {
        const failure = validationFailures.get(component);
        if (failure) {
          return failure;
        }
        if (component === 'ar-control' && controlBootstrapConfig) {
          options.onProgress?.(
            'Deploying initial ar-control bootstrap without runtime smoke bindings...'
          );
          bootstrapControlResult = await deployWorkerDirect(
            contexts.get(component)!,
            { ...options, configFile: controlBootstrapConfig },
            throttle
          );
          return bootstrapControlResult;
        }
        if (component === 'ar-auth' && authBootstrapConfig) {
          options.onProgress?.(
            'Deploying initial ar-auth bootstrap without ACCOUNT_PROVISIONER...'
          );
          bootstrapAuthResult = await deployWorkerDirect(
            contexts.get(component)!,
            { ...options, configFile: authBootstrapConfig },
            throttle
          );
          return bootstrapAuthResult;
        }
        if (component === 'ar-bridge' && bridgeBootstrapConfig) {
          options.onProgress?.(
            'Deploying initial ar-bridge bootstrap without EXTERNAL_IDP_ACCOUNT_PROVISIONER...'
          );
          bootstrapBridgeResult = await deployWorkerDirect(
            contexts.get(component)!,
            { ...options, configFile: bridgeBootstrapConfig },
            throttle
          );
          return bootstrapBridgeResult;
        }
        const result = await deployWorkerDirect(contexts.get(component)!, options, throttle);
        if (
          component !== 'ar-management' ||
          (!authBootstrapConfig && !bridgeBootstrapConfig) ||
          !result.success
        ) {
          return result;
        }

        if (bridgeBootstrapConfig) {
          options.onProgress?.(
            'Redeploying ar-bridge with the authenticated EXTERNAL_IDP_ACCOUNT_PROVISIONER binding...'
          );
          const promotedBridge = await deployWorkerDirect(
            contexts.get('ar-bridge')!,
            options,
            throttle
          );
          if (promotedBridge.success) {
            fullBridgeResult = promotedBridge;
          } else {
            fullBridgeResult = {
              ...promotedBridge,
              success: false,
              trafficCommitted: true,
              deployedAt: bootstrapBridgeResult?.deployedAt,
              error: `Initial Bridge bootstrap is still active; full Bridge redeploy failed: ${promotedBridge.error || 'unknown error'}`,
            };
            return {
              ...result,
              success: false,
              trafficCommitted: true,
              error: `Management deployed, but full Bridge redeploy failed: ${promotedBridge.error || 'unknown error'}`,
            };
          }
        }
        if (authBootstrapConfig) {
          options.onProgress?.(
            'Redeploying ar-auth with the authenticated ACCOUNT_PROVISIONER binding...'
          );
          const promoted = await deployWorkerDirect(contexts.get('ar-auth')!, options, throttle);
          if (promoted.success) {
            fullAuthResult = promoted;
          } else {
            fullAuthResult = {
              ...promoted,
              success: false,
              trafficCommitted: true,
              deployedAt: bootstrapAuthResult?.deployedAt,
              error: `Initial Auth bootstrap is still active; full Auth redeploy failed: ${promoted.error || 'unknown error'}`,
            };
            return {
              ...result,
              success: false,
              trafficCommitted: true,
              error: `Management deployed, but full Auth redeploy failed: ${promoted.error || 'unknown error'}`,
            };
          }
        }
        return result;
      });
      if (controlBootstrapConfig) {
        const existing = new Set(options.existingComponents ?? []);
        const unavailableTarget = CONTROL_SMOKE_TARGET_COMPONENTS.find((component) =>
          components.includes(component)
            ? resultMap.get(component)?.success !== true
            : !existing.has(component)
        );
        if (bootstrapControlResult?.success && !unavailableTarget) {
          options.onProgress?.(
            'Redeploying ar-control with authenticated runtime smoke bindings...'
          );
          const fullControlResult = await deployWorkerDirect(
            contexts.get('ar-control')!,
            options,
            throttle
          );
          resultMap.set(
            'ar-control',
            fullControlResult.success
              ? fullControlResult
              : {
                  ...fullControlResult,
                  success: false,
                  trafficCommitted: true,
                  deployedAt: bootstrapControlResult.deployedAt,
                  error: `Initial Control bootstrap is still active; full Control redeploy failed: ${fullControlResult.error || 'unknown error'}`,
                }
          );
        } else {
          resultMap.set('ar-control', {
            ...(bootstrapControlResult ??
              makeSkippedResult(
                'ar-control',
                options,
                'Initial Control bootstrap did not complete',
                contexts.get('ar-control')
              )),
            success: false,
            trafficCommitted: bootstrapControlResult?.success === true,
            error:
              bootstrapControlResult?.success === true
                ? `Initial Control bootstrap is active, but smoke target ${unavailableTarget || 'unknown'} is unavailable`
                : bootstrapControlResult?.error || 'Initial Control bootstrap did not complete',
          });
        }
      }
      if (authBootstrapConfig) {
        resultMap.set(
          'ar-auth',
          fullAuthResult ?? {
            ...(bootstrapAuthResult ??
              makeSkippedResult(
                'ar-auth',
                options,
                'Initial Auth bootstrap did not complete',
                contexts.get('ar-auth')
              )),
            success: false,
            trafficCommitted: bootstrapAuthResult?.success === true,
            error:
              bootstrapAuthResult?.success === true
                ? 'Initial Auth bootstrap is active, but Management did not complete the full Auth redeploy'
                : bootstrapAuthResult?.error || 'Initial Auth bootstrap did not complete',
          }
        );
      }
      if (bridgeBootstrapConfig) {
        resultMap.set(
          'ar-bridge',
          fullBridgeResult ?? {
            ...(bootstrapBridgeResult ??
              makeSkippedResult(
                'ar-bridge',
                options,
                'Initial Bridge bootstrap did not complete',
                contexts.get('ar-bridge')
              )),
            success: false,
            trafficCommitted: bootstrapBridgeResult?.trafficCommitted,
            error:
              bootstrapBridgeResult?.error ||
              'Initial Bridge bootstrap remains active because Management or full Bridge deployment did not complete',
          }
        );
      }
    }

    const allResults = components.map(
      (component) =>
        resultMap.get(component) ??
        makeSkippedResult(
          component,
          options,
          'Deployment did not produce a result',
          contexts.get(component)
        )
    );
    if (!options.dryRun && options.cleanupLegacyStaticSecrets) {
      const cleanupResult = await cleanupLegacyStaticSecrets(
        options,
        allResults.filter((result) => result.success).map((result) => result.component)
      );
      for (const result of allResults) {
        const activeVersionId = cleanupResult.activeVersionIds[result.component];
        if (activeVersionId) {
          result.cloudflareVersionId = activeVersionId;
          result.deployedAt = new Date().toISOString();
        }
      }
      for (const failure of cleanupResult.failures) {
        const result = allResults.find((candidate) => candidate.component === failure.component);
        if (result) {
          result.success = false;
          result.trafficCommitted = true;
          result.error = `Worker deployed, but legacy static secret cleanup failed: ${failure.error}`;
        }
      }
    }
    const completedAt = new Date().toISOString();
    const successCount = allResults.filter((result) => result.success).length;
    const failedCount = allResults.length - successCount;
    const summary: DeploymentSummary = {
      totalComponents: allResults.length,
      successCount,
      failedCount,
      results: allResults,
      startedAt,
      completedAt,
      duration: Date.now() - startTime,
    };

    options.onProgress?.('\n━━━ Deployment Summary ━━━');
    options.onProgress?.(`Total: ${summary.totalComponents}`);
    options.onProgress?.(`Success: ${successCount}`);
    options.onProgress?.(`Failed: ${failedCount}`);
    options.onProgress?.(`Duration: ${(summary.duration / 1000).toFixed(1)}s`);
    for (const result of allResults.filter((candidate) => !candidate.success)) {
      options.onProgress?.(`  • ${result.component}: ${result.error}`);
    }
    deploymentSucceeded = failedCount === 0;
    return summary;
  } finally {
    if (ownsLeaseSession) {
      options.deploymentLeaseSession = undefined;
      await closeWorkerDeploymentLeaseSession(leaseSession, deploymentSucceeded);
    }
  }
}

// =============================================================================
// Lock File Update
// =============================================================================

/**
 * Update lock file with deployment results
 */
export function updateLockWithDeployments(lock: AuthrimLock, results: DeployResult[]): AuthrimLock {
  const workers: Record<string, WorkerEntry> = { ...lock.workers };
  const workerScriptOwnership = { ...lock.workerScriptOwnership };

  for (const result of results) {
    // A post-traffic trigger/cleanup failure remains an incomplete deployment. Do not advance its
    // recorded product version, otherwise a resume can skip the reconciliation that failed.
    if (!result.success) continue;
    if (!result.deployedAt || !result.cloudflareVersionId || !result.cloudflareScriptTag) {
      throw new Error(`worker_deployment_exact_version_unavailable:${result.component}`);
    }
    workers[result.component] = {
      name: result.workerName,
      deployedAt: result.deployedAt,
      version: result.version,
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

// =============================================================================
// Secrets Upload
// =============================================================================

/** Load only the local secret files needed by the selected Workers. */
export async function loadDeploySecretsFromKeys(
  keysDir: string | undefined,
  workers?: WorkerComponent[]
): Promise<Record<string, string>> {
  const targetSet = new Set(workers ?? CORE_WORKER_COMPONENTS);
  const visitDependencies = (component: WorkerComponent): void => {
    for (const dependency of WORKER_DEPLOYMENT_DEPENDENCIES[component]) {
      if (!targetSet.has(dependency)) {
        targetSet.add(dependency);
        visitDependencies(dependency);
      }
    }
  };
  for (const component of [...targetSet]) {
    visitDependencies(component);
  }
  const targetWorkers = [...targetSet];
  const secretNames = new Set(targetWorkers.flatMap((worker) => getSecretNamesForWorker(worker)));
  const secrets: Record<string, string> = {};

  for (const secretName of secretNames) {
    if (EPHEMERAL_ENV_SECRET_NAMES.includes(secretName)) {
      const value = process.env[secretName]?.trim();
      if (value) {
        secrets[secretName] = value;
      }
      continue;
    }
    const fileName = SECRET_KEY_FILES[secretName];
    if (!fileName) {
      continue;
    }
    const filePath = keysDir ? join(keysDir, fileName) : undefined;
    if (filePath && existsSync(filePath)) {
      secrets[secretName] = await readFile(filePath, 'utf-8');
    }
  }
  return secrets;
}

/**
 * Upload secrets to all workers that need them
 *
 * Uses --env flag to target the correct environment section in wrangler.toml
 */
async function uploadSecretsWithoutLease(
  secrets: Record<string, string>,
  options: DeployOptions,
  workers?: WorkerComponent[]
): Promise<{ success: boolean; errors: string[] }> {
  const { env, rootDir, onProgress, dryRun } = options;
  const errors: string[] = [];
  const targetWorkers = getSecretTargetWorkers(workers);
  const throttle = makeThrottle(options);

  await runBoundedPool(targetWorkers, throttle, async (component) => {
    const workerName = getWorkerName(env, component);
    const packageDir = join(rootDir, 'packages', component);
    const workerSecrets = getSecretsForWorker(component, secrets);
    if (!existsSync(packageDir) || Object.keys(workerSecrets).length === 0) {
      return;
    }
    if (dryRun) {
      onProgress?.(
        `  [DRY RUN] Would upload ${Object.keys(workerSecrets).length} secret(s) to ${workerName}`
      );
      return;
    }

    let secretFile: TemporarySecretFile | undefined;
    try {
      const context = await getWorkerDeploymentContext(component, options);
      if (isDeployResult(context)) {
        throw new Error(context.error || 'Failed to resolve Worker deployment context');
      }
      secretFile = await createTemporarySecretFile(workerSecrets);
      await runWithAdaptiveRetry(
        `Uploading ${Object.keys(workerSecrets).length} secret(s) to ${workerName}`,
        options,
        throttle,
        () =>
          runAuthorizedWorkerMutation(context, options, throttle, () =>
            execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'secret',
                'bulk',
                secretFile!.path,
                ...getConfigArgs(options),
                '--env',
                env,
              ],
              { cwd: packageDir, reject: true, cancelSignal: options.signal }
            )
          )
      );
      onProgress?.(`  ✓ ${workerName} secrets uploaded in one batch`);
    } catch (error) {
      const errorMsg = `Failed to upload secrets to ${workerName}: ${sanitizeDeploymentErrorMessage(
        getErrorText(error)
      )}`;
      errors.push(errorMsg);
      onProgress?.(`  ✗ ${errorMsg}`);
    } finally {
      await secretFile?.cleanup().catch(() => undefined);
    }
  });

  return {
    success: errors.length === 0,
    errors,
  };
}

export async function uploadSecrets(
  secrets: Record<string, string>,
  options: DeployOptions,
  workers?: WorkerComponent[]
): Promise<{ success: boolean; errors: string[] }> {
  await assertDeployConfigLockProof(options);
  const components = getSecretTargetWorkers(workers);
  if (options.deploymentLeaseSession || options.dryRun || !options.deploymentLease) {
    return uploadSecretsWithoutLease(secrets, options, workers);
  }
  const contexts = new Map<WorkerComponent, WorkerDeploymentContext>();
  for (const component of components) {
    const context = await getWorkerDeploymentContext(component, options);
    if (!isDeployResult(context)) contexts.set(component, context);
  }
  const throttle = makeThrottle(options);
  const session = await createWorkerDeploymentLeaseSession(options, components, contexts, throttle);
  if (!session) return uploadSecretsWithoutLease(secrets, options, workers);
  options.deploymentLeaseSession = session;
  let success = false;
  try {
    const result = await uploadSecretsWithoutLease(secrets, options, workers);
    success = result.success;
    return result;
  } finally {
    options.deploymentLeaseSession = undefined;
    await closeWorkerDeploymentLeaseSession(session, success);
  }
}

// =============================================================================
// UI Workers Deployment
// =============================================================================

/** UI component type (separate from core Authrim Worker components) */
export type UiWorkerComponent = 'ar-admin-ui' | 'ar-login-ui';

/** All UI components deployed as Workers static assets */
export const UI_WORKER_COMPONENTS: UiWorkerComponent[] = ['ar-admin-ui', 'ar-login-ui'];

export interface UiWorkerBindingTargets {
  loginUi: boolean;
  adminUi: boolean;
}

async function cloudflareWorkerHasActiveDeployment(
  workerName: string,
  cwd: string,
  options: DeployOptions,
  throttle: DeploymentThrottle
): Promise<boolean> {
  return runWithAdaptiveRetry(
    `Checking Worker deployment ${workerName}`,
    options,
    throttle,
    async () => {
      const result = await execa(
        'pnpm',
        ['exec', 'wrangler', 'deployments', 'list', '--name', workerName, '--json'],
        {
          cwd,
          reject: false,
          cancelSignal: options.signal,
        }
      );
      if (result.exitCode === 0) {
        try {
          const deployments = JSON.parse(String(result.stdout || '[]')) as unknown;
          return Array.isArray(deployments) && deployments.length > 0;
        } catch {
          throw new Error(`Wrangler returned invalid deployment JSON for ${workerName}`);
        }
      }

      const errorText = getErrorText({
        message: String(result.stderr || result.stdout || 'Unknown Wrangler error'),
        stderr: result.stderr,
        stdout: result.stdout,
      });
      if (/does not exist|not found|\b10007\b|\b404\b/i.test(errorText)) {
        return false;
      }
      const commandError = new Error(errorText) as Error & { stderr?: unknown; stdout?: unknown };
      commandError.stderr = result.stderr;
      commandError.stdout = result.stdout;
      throw commandError;
    }
  );
}

/**
 * Resolve first-deploy UI binding targets from Cloudflare, not only from the
 * local lock. An unknown remote state fails closed so an API-only deploy can
 * never overwrite an existing production UI with placeholder settings.
 */
export async function resolveMissingUiWorkerBindingTargets(
  options: DeployOptions,
  enabled: UiWorkerBindingTargets
): Promise<UiWorkerBindingTargets> {
  const throttle = makeThrottle({ ...options, concurrency: 2 });
  const [loginExists, adminExists] = await Promise.all([
    enabled.loginUi
      ? cloudflareWorkerHasActiveDeployment(
          `${options.env}-ar-login-ui`,
          options.rootDir,
          options,
          throttle
        )
      : Promise.resolve(true),
    enabled.adminUi
      ? cloudflareWorkerHasActiveDeployment(
          `${options.env}-ar-admin-ui`,
          options.rootDir,
          options,
          throttle
        )
      : Promise.resolve(true),
  ]);
  return {
    loginUi: enabled.loginUi && !loginExists,
    adminUi: enabled.adminUi && !adminExists,
  };
}

/** Resolve remote existence for lock-less CLI deployments without mutating traffic. */
export async function resolveExistingWorkerComponents(
  options: DeployOptions,
  components: readonly WorkerComponent[]
): Promise<WorkerComponent[]> {
  const throttle = makeThrottle(options);
  const results = await runBoundedPool(components, throttle, async (component) => ({
    component,
    exists: await cloudflareWorkerHasActiveDeployment(
      getWorkerName(options.env, component),
      join(options.rootDir, 'packages', component),
      options,
      throttle
    ),
  }));
  return components.filter((component) => results.get(component)?.exists === true);
}

/** Result for UI Workers deployment */
export interface UiWorkerDeployResult {
  component: UiWorkerComponent;
  projectName: string;
  success: boolean;
  error?: string;
  deployedAt?: string;
  cloudflareVersionId?: string;
  cloudflareScriptTag?: string;
  trafficCommitted?: boolean;
  duration?: number;
}

/** Options for deploying a single UI Worker component */
export interface UiWorkerDeployOptions extends DeployOptions {
  /** Reuse an existing UI build output. Wrangler config is still regenerated. */
  skipBuild?: boolean;
  /** UI Worker name (defaults to {env}-{component}) */
  projectName?: string;
  /** API base URL for the UI to connect to (e.g., https://prod-ar-router.workers.dev) */
  apiBaseUrl?: string;
  /** Path to ui.env file (.authrim/{env}/ui.env) - preferred over apiBaseUrl */
  uiEnvPath?: string;
  /** Component-specific UI env generated at deploy time */
  uiEnvConfig?: UiEnvConfig;
  /** Runtime backend URL for the UI Worker proxy (or a disable marker) */
  runtimeApiBackendUrl?: string;
  /** Service Binding name for UI Worker -> router communication (e.g., 'AR_ROUTER') */
  serviceBindingName?: string;
  /** Whether to expose the UI Worker on workers.dev */
  workersDev?: boolean;
  /** Custom-domain routes for the UI Worker */
  routes?: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }>;
  /** Optional Admin UI BFF machine credentials uploaded as UI Worker secrets */
  adminUiBffSecrets?: AdminUiBffWorkerSecrets;
}

function assertNoPublicUiSourceMaps(uiDir: string): void {
  const publicAssetsDir = join(uiDir, '.svelte-kit', 'cloudflare');
  if (!existsSync(publicAssetsDir)) {
    return;
  }

  const pending = [publicAssetsDir];
  let sourceMapCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.map')) {
        sourceMapCount += 1;
      }
    }
  }

  if (sourceMapCount > 0) {
    throw new Error(`ui_public_source_maps_forbidden:${sourceMapCount}`);
  }
}

export function assertLoginUiBuildClientId(uiDir: string, expectedClientId: string): void {
  const publicAssetsDir = join(uiDir, '.svelte-kit', 'cloudflare');
  if (!existsSync(publicAssetsDir)) {
    throw new Error('login_ui_build_output_missing');
  }

  const pending = [publicAssetsDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith('.js') || entry.name.endsWith('.html')) &&
        readFileSync(entryPath, 'utf8').includes(expectedClientId)
      ) {
        return;
      }
    }
  }

  throw new Error('login_ui_build_client_id_mismatch');
}

/**
 * Deploy a single UI package to Cloudflare Workers static assets.
 *
 * Deploys AdminUI/LoginUI as Workers static assets.
 */
export async function deployUiWorkerComponent(
  component: UiWorkerComponent,
  options: UiWorkerDeployOptions
): Promise<UiWorkerDeployResult> {
  const {
    env,
    rootDir,
    projectName,
    onProgress,
    dryRun,
    apiBaseUrl,
    uiEnvPath,
    uiEnvConfig,
    runtimeApiBackendUrl,
    serviceBindingName,
    workersDev,
    routes,
    adminUiBffSecrets,
    skipBuild,
    maxRetries = 3,
    retryDelayMs = 5000,
  } = options;

  // Security: Validate environment name
  if (!isValidEnv(env)) {
    return {
      component,
      projectName: projectName || `${env}-${component}`,
      success: false,
      error: 'Invalid environment name',
      duration: 0,
    };
  }

  const uiDir = join(rootDir, 'packages', component);
  const startTime = Date.now();

  if (!existsSync(uiDir)) {
    return {
      component,
      projectName: projectName || `${env}-${component}`,
      success: false,
      error: `${component} package not found`,
      duration: Date.now() - startTime,
    };
  }

  // Track if we copied ui.env so we know to clean up
  let copiedUiEnv = false;
  let wrotePackageEnv = false;
  let uiTrafficCommitted = false;
  let uiCommittedVersionId: string | undefined;

  try {
    await assertDeployConfigLockProof(options);
    if (!dryRun) {
      onProgress?.('Checking local disk space before UI Worker deployment...');
      await assertLocalDeploymentCapacity({
        rootDir,
        phase: skipBuild ? 'Worker deployment' : 'package build',
        minimumFreeBytes: skipBuild ? MINIMUM_WORKER_DEPLOY_FREE_BYTES : MINIMUM_BUILD_FREE_BYTES,
        readAvailableBytes: options.readAvailableDiskBytes,
      });
    }
    // Build the UI first
    onProgress?.(`Building ${component}...`);

    if (!dryRun) {
      // A killed earlier build can leave another environment's package-level .env behind.
      // Remove it before preparing this build; every supported source is republished below.
      await assertDeployConfigLockProof(options);
      await cleanupPackageEnv(uiDir);
      const generatedUiEnv = uiEnvConfig;
      const runtimeSecretValue = serviceBindingName
        ? DISABLED_API_BACKEND_URL
        : (runtimeApiBackendUrl ?? DISABLED_API_BACKEND_URL);

      // Generate wrangler.toml for this environment before building.
      // This ensures the correct Worker name, runtime vars, and Service Binding
      // are applied when wrangler reads the file during `wrangler deploy`.
      const wranglerContent = generateUiWorkersWranglerConfig({
        component,
        env,
        needsProxy: !!serviceBindingName,
        workersDev,
        routes,
        vars: {
          ...generatedUiEnv,
          API_BACKEND_URL: runtimeSecretValue,
        },
      });
      await assertDeployConfigLockProof(options);
      await writePrivateFileAtomically(join(uiDir, 'wrangler.toml'), wranglerContent, 0o644);
      if (serviceBindingName) {
        onProgress?.(`  Generated wrangler.toml with Service Binding: ${serviceBindingName}`);
      } else {
        onProgress?.(`  Generated wrangler.toml for ${env}-${component}`);
      }

      // Prefer a component-specific env generated from config at deploy time.
      if (uiEnvConfig) {
        await assertDeployConfigLockProof(options);
        await saveUiEnv(join(uiDir, '.env'), uiEnvConfig);
        wrotePackageEnv = true;
        onProgress?.(`  Using generated env for ${component}`);
      }

      // Copy ui.env to package's .env for Vite to read during build
      // Priority: generated config > uiEnvPath (file) > apiBaseUrl (legacy env var approach)
      if (!wrotePackageEnv && uiEnvPath && (await uiEnvExists(uiEnvPath))) {
        await assertDeployConfigLockProof(options);
        await copyUiEnvToPackage(uiEnvPath, uiDir);
        copiedUiEnv = true;
        onProgress?.(`  Using env from: ${uiEnvPath}`);
      } else if (uiEnvPath) {
        // ui.env path specified but file doesn't exist
        onProgress?.(`  ⚠️  ui.env not found at: ${uiEnvPath}`);
        onProgress?.(`  Tip: Run 'authrim-setup deploy' to regenerate ui.env from config`);
        if (apiBaseUrl) {
          onProgress?.(`  Falling back to environment variable: ${apiBaseUrl}`);
        }
      } else if (apiBaseUrl) {
        // Legacy structure: pass via environment variable (may not work with Vite)
        onProgress?.(`  API URL (env): ${apiBaseUrl}`);
      } else {
        onProgress?.(`  ⚠️  No API URL configured - UI may not connect to backend`);
      }

      try {
        const buildEnv = buildUiWorkerBuildEnv(process.env, {
          apiBaseUrl,
          preferPackageEnv: wrotePackageEnv || copiedUiEnv,
        });

        if (skipBuild) {
          onProgress?.(`  Skipping ${component} build; using existing output`);
        } else {
          await assertDeployConfigLockProof(options);
          await execa('pnpm', ['run', 'build'], {
            cwd: uiDir,
            // Strip conflicting PUBLIC_* vars when a generated/copied .env exists.
            // Otherwise, inject PUBLIC_API_BASE_URL as the legacy fallback.
            env: buildEnv,
          });
        }
      } finally {
        // Always clean up .env after build (success or failure)
        if (copiedUiEnv || wrotePackageEnv) {
          await assertDeployConfigLockProof(options);
          await cleanupPackageEnv(uiDir);
        }
      }

      await assertDeployConfigLockProof(options);
      // Browser source maps are intentionally disabled. Fail closed if stale or
      // misconfigured build output would publish source through Static Assets.
      assertNoPublicUiSourceMaps(uiDir);
      const expectedLoginUiClientId = uiEnvConfig?.PUBLIC_LOGIN_UI_CLIENT_ID?.trim();
      if (component === 'ar-login-ui' && expectedLoginUiClientId) {
        assertLoginUiBuildClientId(uiDir, expectedLoginUiClientId);
      }
    }

    onProgress?.('Deploying UI Worker...');

    if (dryRun) {
      onProgress?.(`[DRY RUN] Would deploy ${component} with wrangler deploy`);
      return {
        component,
        projectName: projectName || `${env}-${component}`,
        success: true,
        deployedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    }

    const uiWorkerName = projectName || `${env}-${component}`;
    await ensureWorkerScriptOwnershipGuard(options, [{ component, workerName: uiWorkerName }]);

    let uiSecretFile: TemporarySecretFile | undefined;
    let outputDirectory: string | undefined;
    let deployedVersionId: string | undefined;
    const uiDeployOptions: DeployOptions = {
      ...options,
      maxRetries,
      retryDelayMs,
    };
    const throttle = makeThrottle(uiDeployOptions);

    try {
      await uiDeployOptions.workerScriptOwnership?.assertBeforeMutation(uiWorkerName);
      uiSecretFile =
        component === 'ar-admin-ui' && adminUiBffSecrets
          ? await createTemporarySecretFile({ ...adminUiBffSecrets })
          : undefined;
      const knownExisting =
        uiDeployOptions.deploymentStrategy !== 'direct' &&
        (await cloudflareWorkerHasActiveDeployment(uiWorkerName, uiDir, uiDeployOptions, throttle));

      if (!knownExisting) {
        outputDirectory = await mkdtemp(join(tmpdir(), 'authrim-ui-wrangler-output-'));
        const directResult = await runWithAdaptiveRetry(
          `Deploying UI Worker ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          async () => {
            await assertDeployConfigLockProof(uiDeployOptions);
            await uiDeployOptions.workerScriptOwnership?.assertBeforeMutation(uiWorkerName);
            let result: Awaited<ReturnType<typeof execa>>;
            try {
              result = await execa(
                'pnpm',
                [
                  'exec',
                  'wrangler',
                  'deploy',
                  ...WORKER_BUNDLE_UPLOAD_ARGS,
                  '--config',
                  'wrangler.toml',
                  ...(uiSecretFile ? ['--secrets-file', uiSecretFile.path] : []),
                ],
                {
                  cwd: uiDir,
                  reject: false,
                  cancelSignal: options.signal,
                  env: { WRANGLER_OUTPUT_FILE_DIRECTORY: outputDirectory },
                }
              );
            } catch (error) {
              const structuredVersionId = await readVersionIdFromStructuredOutput(
                outputDirectory!,
                ''
              );
              if (structuredVersionId) {
                uiTrafficCommitted = true;
                uiCommittedVersionId = structuredVersionId;
                await uiDeployOptions.workerScriptOwnership?.checkpointCommittedVersion(
                  uiWorkerName,
                  structuredVersionId
                );
                onProgress?.(
                  `  ✓ Adopted committed ${uiWorkerName} deployment ${structuredVersionId} after response loss`
                );
                return { stdout: '', adoptedVersionId: structuredVersionId };
              }
              if (isProvenPreMutationDeploymentFailure(error) || classifyRetry(error) === 'fatal') {
                throw error;
              }
              throw new NonRetryableDeploymentError(
                `Direct UI deployment outcome is ambiguous for ${uiWorkerName}`
              );
            }
            if (result.exitCode !== 0) {
              const commandError = new Error(
                String(result.stderr || result.stdout || 'Unknown error')
              ) as Error & { stderr?: unknown; stdout?: unknown };
              commandError.stderr = result.stderr;
              commandError.stdout = result.stdout;
              const structuredVersionId = await readVersionIdFromStructuredOutput(
                outputDirectory!,
                result.stdout
              );
              if (structuredVersionId) {
                uiTrafficCommitted = true;
                uiCommittedVersionId = structuredVersionId;
                await uiDeployOptions.workerScriptOwnership?.checkpointCommittedVersion(
                  uiWorkerName,
                  structuredVersionId
                );
                onProgress?.(
                  `  ✓ Adopted committed ${uiWorkerName} deployment ${structuredVersionId} after response loss`
                );
                return { stdout: '', adoptedVersionId: structuredVersionId };
              }
              if (
                isProvenPreMutationDeploymentFailure(commandError) ||
                classifyRetry(commandError) === 'fatal'
              ) {
                throw commandError;
              }
              throw new NonRetryableDeploymentError(
                `Direct UI deployment outcome is ambiguous for ${uiWorkerName}`
              );
            }
            uiTrafficCommitted = true;
            await assertDeployConfigLockProofAfterMutation(uiDeployOptions);
            return { stdout: String(result.stdout), adoptedVersionId: undefined };
          }
        );
        deployedVersionId =
          directResult.adoptedVersionId ??
          (await readVersionIdFromStructuredOutput(outputDirectory, directResult.stdout));
        if (!deployedVersionId) {
          throw new Error('Wrangler did not report the deployed UI Cloudflare Version ID');
        }
        if (uiCommittedVersionId !== deployedVersionId) {
          uiCommittedVersionId = deployedVersionId;
          await uiDeployOptions.workerScriptOwnership?.checkpointCommittedVersion(
            uiWorkerName,
            deployedVersionId
          );
        }
      } else {
        outputDirectory = await mkdtemp(join(tmpdir(), 'authrim-ui-wrangler-output-'));
        const uploadResult = await runWithAdaptiveRetry(
          `Uploading UI Worker version ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          async () => {
            await assertDeployConfigLockProof(uiDeployOptions);
            await uiDeployOptions.workerScriptOwnership?.assertBeforeMutation(uiWorkerName);
            const result = await execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'versions',
                'upload',
                ...WORKER_BUNDLE_UPLOAD_ARGS,
                '--config',
                'wrangler.toml',
                ...(uiSecretFile ? ['--secrets-file', uiSecretFile.path] : []),
              ],
              {
                cwd: uiDir,
                reject: true,
                cancelSignal: options.signal,
                env: { WRANGLER_OUTPUT_FILE_DIRECTORY: outputDirectory },
              }
            );
            await assertDeployConfigLockProofAfterMutation(uiDeployOptions);
            return result;
          }
        );
        const versionId = await readVersionIdFromStructuredOutput(
          outputDirectory,
          uploadResult.stdout
        );
        if (!versionId) {
          throw new Error('Wrangler did not report the uploaded UI Cloudflare Version ID');
        }
        deployedVersionId = versionId;
        await uiDeployOptions.workerScriptOwnership?.checkpointCommittedVersion(
          uiWorkerName,
          versionId
        );

        await runWithAdaptiveRetry(
          `Validating UI Worker triggers ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          async () => {
            await assertDeployConfigLockProof(uiDeployOptions);
            return execa(
              'pnpm',
              ['exec', 'wrangler', 'triggers', 'deploy', '--dry-run', '--config', 'wrangler.toml'],
              { cwd: uiDir, reject: true, cancelSignal: options.signal }
            );
          }
        );
        await runWithAdaptiveRetry(
          `Promoting UI Worker version ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          async () => {
            await assertDeployConfigLockProof(uiDeployOptions);
            await uiDeployOptions.workerScriptOwnership?.assertBeforeMutation(uiWorkerName);
            const result = await execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'versions',
                'deploy',
                `${versionId}@100%`,
                '--yes',
                '--config',
                'wrangler.toml',
              ],
              { cwd: uiDir, reject: true, cancelSignal: options.signal }
            );
            uiTrafficCommitted = true;
            uiCommittedVersionId = versionId;
            await assertDeployConfigLockProofAfterMutation(uiDeployOptions);
            return result;
          }
        );
        try {
          await runWithAdaptiveRetry(
            `Applying UI Worker triggers ${uiWorkerName}`,
            uiDeployOptions,
            throttle,
            async () => {
              await assertDeployConfigLockProof(uiDeployOptions);
              await uiDeployOptions.workerScriptOwnership?.assertBeforeMutation(uiWorkerName);
              const result = await execa(
                'pnpm',
                ['exec', 'wrangler', 'triggers', 'deploy', '--config', 'wrangler.toml'],
                { cwd: uiDir, reject: true, cancelSignal: options.signal }
              );
              await assertDeployConfigLockProofAfterMutation(uiDeployOptions);
              return result;
            }
          );
        } catch (error) {
          const errorOutput = sanitizeDeploymentErrorMessage(getErrorText(error));
          return {
            component,
            projectName: uiWorkerName,
            success: false,
            trafficCommitted: true,
            cloudflareVersionId: versionId,
            deployedAt: new Date().toISOString(),
            error: `Traffic committed, but UI trigger synchronization failed: ${errorOutput}`,
            duration: Date.now() - startTime,
          };
        }
      }
    } catch (error) {
      const errorOutput = sanitizeDeploymentErrorMessage(getErrorText(error));
      const hint = errorOutput.includes('assets-upload-session')
        ? '\nCloudflare rejected the Workers Static Assets upload session. This is usually an account/API entitlement issue or a transient Cloudflare API failure, not a Svelte build error. Try updating Wrangler and retrying; if it persists, check Workers Static Assets availability for the Cloudflare account.'
        : '';
      onProgress?.(`UI Worker deploy error: ${errorOutput}${hint}`);
      return {
        component,
        projectName: uiWorkerName,
        success: false,
        ...(uiTrafficCommitted
          ? {
              trafficCommitted: true,
              deployedAt: new Date().toISOString(),
              cloudflareVersionId: uiCommittedVersionId,
            }
          : {}),
        error: `${errorOutput}${hint}`,
        duration: Date.now() - startTime,
      };
    } finally {
      await Promise.allSettled([
        uiSecretFile?.cleanup(),
        outputDirectory ? rm(outputDirectory, { recursive: true, force: true }) : undefined,
      ]);
    }

    const cloudflareScriptTag =
      await uiDeployOptions.workerScriptOwnership?.captureAfterMutation(uiWorkerName);
    onProgress?.(`✓ ${component} deployed as UI Worker: ${uiWorkerName}`);

    return {
      component,
      projectName: uiWorkerName,
      success: true,
      deployedAt: new Date().toISOString(),
      cloudflareVersionId: deployedVersionId,
      cloudflareScriptTag,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    // Sanitize error message to prevent path exposure
    const errorMsg = error instanceof Error ? error.message : String(error);
    const sanitizedError = errorMsg.replace(/\/[^\s:]+/g, '[path]').replace(/\\[^\s:]+/g, '[path]');
    return {
      component,
      projectName: projectName || `${env}-${component}`,
      success: false,
      ...(uiTrafficCommitted
        ? {
            trafficCommitted: true,
            deployedAt: new Date().toISOString(),
            cloudflareVersionId: uiCommittedVersionId,
          }
        : {}),
      error: sanitizedError,
      duration: Date.now() - startTime,
    };
  }
}

/** Summary for all UI Worker deployments */
export interface UiWorkersDeploymentSummary {
  results: UiWorkerDeployResult[];
  successCount: number;
  failedCount: number;
}

/**
 * Deploy all enabled UI packages to Cloudflare Workers static assets.
 */
export async function deployAllUiWorkers(
  options: DeployOptions & {
    apiBaseUrl?: string;
    uiEnvPath?: string;
    perComponent?: Partial<
      Record<
        UiWorkerComponent,
        Pick<
          UiWorkerDeployOptions,
          | 'apiBaseUrl'
          | 'projectName'
          | 'runtimeApiBackendUrl'
          | 'uiEnvConfig'
          | 'uiEnvPath'
          | 'serviceBindingName'
          | 'workersDev'
          | 'routes'
          | 'adminUiBffSecrets'
        >
      >
    >;
  },
  enabledComponents: { loginUi: boolean; adminUi: boolean }
): Promise<UiWorkersDeploymentSummary> {
  await assertDeployConfigLockProof(options);
  const results: UiWorkerDeployResult[] = [];

  if (enabledComponents.loginUi) {
    const loginResult = await deployUiWorkerComponent('ar-login-ui', {
      ...options,
      ...(options.perComponent?.['ar-login-ui'] || {}),
    });
    results.push(loginResult);
    if (!loginResult.success && isLocalDiskExhaustionError(loginResult.error)) {
      if (enabledComponents.adminUi) {
        results.push({
          component: 'ar-admin-ui',
          projectName:
            options.perComponent?.['ar-admin-ui']?.projectName ?? `${options.env}-ar-admin-ui`,
          success: false,
          error: 'Skipped because UI deployment stopped after local disk space was exhausted',
          duration: 0,
        });
      }
      return {
        results,
        successCount: 0,
        failedCount: results.length,
      };
    }
  }

  if (enabledComponents.adminUi) {
    const adminResult = await deployUiWorkerComponent('ar-admin-ui', {
      ...options,
      ...(options.perComponent?.['ar-admin-ui'] || {}),
    });
    results.push(adminResult);
  }

  return {
    results,
    successCount: results.filter((r) => r.success).length,
    failedCount: results.filter((r) => !r.success).length,
  };
}

/**
 * Create UI Worker scripts before ar-router is deployed.
 *
 * Cloudflare validates Service Binding targets at deploy time. In multi-tenant
 * mode ar-router binds LOGIN_UI_WORKER/ADMIN_UI_WORKER, while some final UI
 * deployments may also bind back to ar-router. This lightweight first pass
 * breaks that first-deploy cycle; the full UI deployment later overwrites these
 * scripts with the final env, routes, and secrets.
 */
export async function deployUiWorkerBindingTargets(
  options: DeployOptions & {
    apiBaseUrl?: string;
  },
  enabledComponents: { loginUi: boolean; adminUi: boolean }
): Promise<UiWorkersDeploymentSummary> {
  const apiBaseUrl = options.apiBaseUrl || `https://${options.env}-ar-router.workers.dev`;
  const placeholderUiEnv: UiEnvConfig = {
    PUBLIC_API_BASE_URL: apiBaseUrl,
    PUBLIC_AUTHRIM_ISSUER: apiBaseUrl,
    API_BACKEND_URL: DISABLED_API_BACKEND_URL,
  };

  options.onProgress?.('Preparing UI Worker binding targets before router deploy...');

  return deployAllUiWorkers(
    {
      ...options,
      perComponent: {
        'ar-login-ui': {
          apiBaseUrl,
          runtimeApiBackendUrl: DISABLED_API_BACKEND_URL,
          uiEnvConfig: placeholderUiEnv,
          serviceBindingName: undefined,
          workersDev: true,
          routes: [],
        },
        'ar-admin-ui': {
          apiBaseUrl,
          runtimeApiBackendUrl: DISABLED_API_BACKEND_URL,
          uiEnvConfig: placeholderUiEnv,
          serviceBindingName: undefined,
          workersDev: true,
          routes: [],
        },
      },
    },
    enabledComponents
  );
}

export async function deployUiWorker(
  options: DeployOptions & { projectName?: string }
): Promise<UiWorkerDeployResult> {
  return deployUiWorkerComponent('ar-login-ui', options);
}
