/**
 * Authrim Deployment Module
 *
 * Handles the deployment order, parallel execution, and retry logic
 * for Authrim Workers.
 */

import { execa, type ExecaError } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
import type { AuthrimLock, WorkerEntry } from './lock.js';
import {
  saveUiEnv,
  copyUiEnvToPackage,
  cleanupPackageEnv,
  uiEnvExists,
  type UiEnvConfig,
} from './ui-env.js';
import { DISABLED_API_BACKEND_URL } from './ui-deployment.js';
import { generateUiWorkersWranglerConfig } from './wrangler.js';
import { getPackageVersion } from './version.js';
import { getSecretNamesForWorker, getSecretTargetWorkers, SECRET_KEY_FILES } from './secrets.js';
import type { AdminUiBffWorkerSecrets } from './admin-machine-access.js';

export {
  DEFAULT_SECRET_TARGET_WORKERS,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  SECRET_KEY_FILES,
  SECRET_UPLOAD_PLAN,
  type SecretName,
} from './secrets.js';

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
  /** Optional non-secret CLI vars, scoped per Worker. */
  varsByComponent?: Partial<Record<WorkerComponent, Readonly<Record<string, string>>>>;
  onProgress?: (message: string) => void;
  onError?: (component: string, error: Error) => void;
  /** Test hook for deterministic retry behavior. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Test hook for deterministic full-jitter retry behavior. */
  random?: () => number;
  /** Optional cancellation signal. Gradual rollouts use it to roll traffic back on interruption. */
  signal?: AbortSignal;
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

export interface DeploymentCompletionState {
  workerFailedCount: number;
  migrationsSuccess: boolean;
  initialTenantSuccess: boolean;
  initialAdminRolesSuccess: boolean;
  setupMachineAccessSuccess: boolean;
  adminUiBffMachineAccessSuccess: boolean;
  defaultCanonicalCatalogSeedSuccess: boolean;
  runtimeProfileSeedSuccess: boolean;
  uiWorkersSuccess: boolean;
}

export interface BuildOptions {
  rootDir: string;
  components?: WorkerComponent[];
  onProgress?: (message: string) => void;
}

export interface BuildResult {
  success: boolean;
  error?: string;
}

export const DEFAULT_INTER_DEPLOY_DELAY_MS = 0;
export const DEFAULT_DEPLOY_CONCURRENCY = 2;

export function hasBlockingDeploymentFailures(state: DeploymentCompletionState): boolean {
  return (
    state.workerFailedCount > 0 ||
    !state.migrationsSuccess ||
    !state.initialTenantSuccess ||
    !state.initialAdminRolesSuccess ||
    !state.setupMachineAccessSuccess ||
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
    // Check if node_modules exists
    const nodeModulesPath = join(rootDir, 'node_modules');
    if (!existsSync(nodeModulesPath)) {
      onProgress?.('Installing dependencies (node_modules not found)...');
      await execa('pnpm', ['install'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      onProgress?.('Dependencies installed');
    }

    // Clear turbo cache to ensure fresh builds
    onProgress?.('Clearing build cache...');
    await execa('rm', ['-rf', '.turbo', 'node_modules/.cache'], {
      cwd: rootDir,
      reject: false, // Don't fail if directories don't exist
    });

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

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMsg };
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

const DEPLOYMENT_PRIORITY: readonly WorkerComponent[] = [
  'ar-lib-core',
  'ar-bridge',
  'ar-auth',
  'ar-management',
  'ar-discovery',
  'ar-token',
  'ar-userinfo',
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-vc',
  'ar-router',
];

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

function classifyRetry(error: unknown): RetryKind {
  const message = getErrorText(error);
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(message)) {
    return 'rate-limit';
  }
  if (
    /\b5\d{2}\b|\b7010\b|service unavailable|internal server error|fetch failed|network error|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|connection reset|timed out|und_err/i.test(
      message
    )
  ) {
    return 'transient';
  }
  return 'fatal';
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
  return options.configFile ? ['--config', options.configFile] : [];
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
  try {
    secretFile = await createTemporarySecretFile(
      getSecretsForWorker(context.component, options.secrets)
    );
    await runWithAdaptiveRetry(`Deploying ${context.workerName}`, options, throttle, async () => {
      await execa(
        'pnpm',
        [
          'exec',
          'wrangler',
          'deploy',
          ...getConfigArgs(options),
          '--env',
          options.env,
          ...getVarArgs(context.component, options),
          ...(secretFile ? ['--secrets-file', secretFile.path] : []),
        ],
        { cwd: context.packageDir, reject: true, cancelSignal: options.signal }
      );
    });
    options.onProgress?.(`  ✓ ${context.workerName} deployed successfully`);
    return {
      component: context.component,
      workerName: context.workerName,
      success: true,
      deployedAt: new Date().toISOString(),
      version: context.packageVersion,
      duration: Date.now() - context.startedAt,
    };
  } catch (error) {
    return deploymentFailure(context, error);
  } finally {
    await secretFile?.cleanup().catch(() => undefined);
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
        if (event.type === 'version-upload' && typeof event.version_id === 'string') {
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
    secretFile = await createTemporarySecretFile(
      getSecretsForWorker(context.component, options.secrets)
    );
    outputDirectory = await mkdtemp(join(tmpdir(), 'authrim-wrangler-output-'));
    const commandResult = await runWithAdaptiveRetry(
      `Uploading version for ${context.workerName}`,
      options,
      throttle,
      () =>
        execa(
          'pnpm',
          [
            'exec',
            'wrangler',
            'versions',
            'upload',
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
              WRANGLER_OUTPUT_FILE_DIRECTORY: outputDirectory,
            },
          }
        )
    );
    const versionId = await readVersionIdFromStructuredOutput(
      outputDirectory,
      commandResult.stdout
    );
    if (!versionId) {
      throw new Error('Wrangler did not report the uploaded Cloudflare Version ID');
    }
    options.onProgress?.(`  ✓ ${context.workerName} version uploaded`);
    return {
      component: context.component,
      workerName: context.workerName,
      success: true,
      version: context.packageVersion,
      cloudflareVersionId: versionId,
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
  await runWithAdaptiveRetry(
    `Applying triggers for ${context.workerName}`,
    options,
    throttle,
    async () => {
      await execa(
        'pnpm',
        ['exec', 'wrangler', 'triggers', 'deploy', ...getConfigArgs(options), '--env', options.env],
        { cwd: context.packageDir, reject: true, cancelSignal: options.signal }
      );
    }
  );
}

async function deployWorkerTraffic(
  context: WorkerDeploymentContext,
  trafficSpecs: readonly string[],
  options: DeployOptions,
  throttle: DeploymentThrottle,
  label = `Promoting ${context.workerName} version`
): Promise<DeployResult> {
  try {
    await runWithAdaptiveRetry(label, options, throttle, async () => {
      await execa(
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
      );
    });
    options.onProgress?.(`  ✓ ${context.workerName} traffic updated successfully`);
    return {
      component: context.component,
      workerName: context.workerName,
      success: true,
      deployedAt: new Date().toISOString(),
      version: context.packageVersion,
      cloudflareVersionId: trafficSpecs.length === 1 ? trafficSpecs[0].split('@')[0] : undefined,
      duration: Date.now() - context.startedAt,
    };
  } catch (error) {
    return deploymentFailure(context, error);
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

  while (pending.size > 0 || active.size > 0) {
    if (halted) {
      for (const component of pending) {
        const result = makeSkippedResult(
          component,
          options,
          'Skipped because another staged promotion failed'
        );
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
      if (schedulerOptions.stopOnFailure) {
        halted = true;
      }
    }
  }
  return results;
}

/** Deploy a single worker with adaptive retry and optional staged promotion. */
export async function deployWorker(
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
export async function deployWorkerGradually(
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
  const strategy = resolveDeploymentStrategy(options, components);
  const throttle = makeThrottle(options);

  options.onProgress?.('Starting Authrim deployment...\n');
  options.onProgress?.(`Environment: ${options.env}`);
  options.onProgress?.(`Workers: ${components.join(', ') || '(none)'}`);
  options.onProgress?.(
    `Strategy: ${strategy}; maximum concurrency: ${throttle.configuredConcurrency}\n`
  );

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
          const recoveryOptions: DeployOptions = { ...options, signal: undefined, concurrency: 1 };
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
              deployedAt: undefined,
              trafficCommitted: false,
              error: rollbackError
                ? `${previous.error || `Staged deployment failed in ${trafficFailure}`}; rollback failed: ${rollbackError}`
                : `${previous.error ? `${previous.error}; ` : ''}Rolled back because staged deployment failed in ${trafficFailure}`,
            });
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
    resultMap = await runDependencyScheduler(components, options, throttle, async (component) => {
      const failure = validationFailures.get(component);
      if (failure) {
        return failure;
      }
      return deployWorkerDirect(contexts.get(component)!, options, throttle);
    });
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
  return summary;
}

// =============================================================================
// Lock File Update
// =============================================================================

/**
 * Update lock file with deployment results
 */
export function updateLockWithDeployments(lock: AuthrimLock, results: DeployResult[]): AuthrimLock {
  const workers: Record<string, WorkerEntry> = { ...lock.workers };

  for (const result of results) {
    if ((result.success || result.trafficCommitted) && result.deployedAt) {
      workers[result.component] = {
        name: result.workerName,
        deployedAt: result.deployedAt,
        version: result.version,
      };
    }
  }

  return {
    ...lock,
    workers,
    updatedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Secrets Upload
// =============================================================================

/** Load only the local secret files needed by the selected Workers. */
export async function loadDeploySecretsFromKeys(
  keysDir: string,
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
    const fileName = SECRET_KEY_FILES[secretName];
    if (!fileName) {
      continue;
    }
    const filePath = join(keysDir, fileName);
    if (existsSync(filePath)) {
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
export async function uploadSecrets(
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
      secretFile = await createTemporarySecretFile(workerSecrets);
      await runWithAdaptiveRetry(
        `Uploading ${Object.keys(workerSecrets).length} secret(s) to ${workerName}`,
        options,
        throttle,
        async () => {
          await execa(
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
          );
        }
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

  try {
    // Build the UI first
    onProgress?.(`Building ${component}...`);

    if (!dryRun) {
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
      await writeFile(join(uiDir, 'wrangler.toml'), wranglerContent, 'utf-8');
      if (serviceBindingName) {
        onProgress?.(`  Generated wrangler.toml with Service Binding: ${serviceBindingName}`);
      } else {
        onProgress?.(`  Generated wrangler.toml for ${env}-${component}`);
      }

      // Prefer a component-specific env generated from config at deploy time.
      if (uiEnvConfig) {
        try {
          await saveUiEnv(join(uiDir, '.env'), uiEnvConfig);
          wrotePackageEnv = true;
          onProgress?.(`  Using generated env for ${component}`);
        } catch (writeError) {
          onProgress?.(`  ⚠️  Warning: Could not write generated env: ${writeError}`);
          onProgress?.(`  Falling back to file/environment variable approach`);
        }
      }

      // Copy ui.env to package's .env for Vite to read during build
      // Priority: generated config > uiEnvPath (file) > apiBaseUrl (legacy env var approach)
      if (!wrotePackageEnv && uiEnvPath && (await uiEnvExists(uiEnvPath))) {
        try {
          await copyUiEnvToPackage(uiEnvPath, uiDir);
          copiedUiEnv = true;
          onProgress?.(`  Using env from: ${uiEnvPath}`);
        } catch (copyError) {
          onProgress?.(`  ⚠️  Warning: Could not copy ui.env: ${copyError}`);
          onProgress?.(`  Falling back to environment variable approach`);
        }
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
          await cleanupPackageEnv(uiDir);
        }
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
      uiSecretFile =
        component === 'ar-admin-ui' && adminUiBffSecrets
          ? await createTemporarySecretFile({ ...adminUiBffSecrets })
          : undefined;
      const knownExisting =
        uiDeployOptions.deploymentStrategy !== 'direct' &&
        (await cloudflareWorkerHasActiveDeployment(uiWorkerName, uiDir, uiDeployOptions, throttle));

      if (!knownExisting) {
        await runWithAdaptiveRetry(
          `Deploying UI Worker ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          async () => {
            const result = await execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'deploy',
                '--config',
                'wrangler.toml',
                ...(uiSecretFile ? ['--secrets-file', uiSecretFile.path] : []),
              ],
              {
                cwd: uiDir,
                reject: false,
                cancelSignal: options.signal,
              }
            );
            if (result.exitCode !== 0) {
              const commandError = new Error(
                String(result.stderr || result.stdout || 'Unknown error')
              ) as Error & { stderr?: unknown; stdout?: unknown };
              commandError.stderr = result.stderr;
              commandError.stdout = result.stdout;
              throw commandError;
            }
          }
        );
      } else {
        outputDirectory = await mkdtemp(join(tmpdir(), 'authrim-ui-wrangler-output-'));
        const uploadResult = await runWithAdaptiveRetry(
          `Uploading UI Worker version ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          () =>
            execa(
              'pnpm',
              [
                'exec',
                'wrangler',
                'versions',
                'upload',
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
            )
        );
        const versionId = await readVersionIdFromStructuredOutput(
          outputDirectory,
          uploadResult.stdout
        );
        if (!versionId) {
          throw new Error('Wrangler did not report the uploaded UI Cloudflare Version ID');
        }
        deployedVersionId = versionId;

        await runWithAdaptiveRetry(
          `Validating UI Worker triggers ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          () =>
            execa(
              'pnpm',
              ['exec', 'wrangler', 'triggers', 'deploy', '--dry-run', '--config', 'wrangler.toml'],
              { cwd: uiDir, reject: true, cancelSignal: options.signal }
            )
        );
        await runWithAdaptiveRetry(
          `Promoting UI Worker version ${uiWorkerName}`,
          uiDeployOptions,
          throttle,
          () =>
            execa(
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
            )
        );
        try {
          await runWithAdaptiveRetry(
            `Applying UI Worker triggers ${uiWorkerName}`,
            uiDeployOptions,
            throttle,
            () =>
              execa(
                'pnpm',
                ['exec', 'wrangler', 'triggers', 'deploy', '--config', 'wrangler.toml'],
                { cwd: uiDir, reject: true, cancelSignal: options.signal }
              )
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
        error: `${errorOutput}${hint}`,
        duration: Date.now() - startTime,
      };
    } finally {
      await Promise.allSettled([
        uiSecretFile?.cleanup(),
        outputDirectory ? rm(outputDirectory, { recursive: true, force: true }) : undefined,
      ]);
    }

    onProgress?.(`✓ ${component} deployed as UI Worker: ${uiWorkerName}`);

    return {
      component,
      projectName: uiWorkerName,
      success: true,
      deployedAt: new Date().toISOString(),
      cloudflareVersionId: deployedVersionId,
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
  const results: UiWorkerDeployResult[] = [];

  if (enabledComponents.loginUi) {
    const loginResult = await deployUiWorkerComponent('ar-login-ui', {
      ...options,
      ...(options.perComponent?.['ar-login-ui'] || {}),
    });
    results.push(loginResult);
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
