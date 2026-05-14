/**
 * Authrim Deployment Module
 *
 * Handles the deployment order, parallel execution, and retry logic
 * for Authrim Workers.
 */

import { execa, type ExecaError } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  getWorkerName,
  getDeploymentOrder,
  CORE_WORKER_COMPONENTS,
  WORKER_COMPONENTS,
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
import { getSecretNamesForWorker, getSecretTargetWorkers } from './secrets.js';
import type { AdminUiBffWorkerSecrets } from './admin-machine-access.js';

export {
  DEFAULT_SECRET_TARGET_WORKERS,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
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
  interDeploymentDelayMs?: number;
  onProgress?: (message: string) => void;
  onError?: (component: string, error: Error) => void;
}

export interface DeployResult {
  component: WorkerComponent;
  workerName: string;
  success: boolean;
  error?: string;
  deployedAt?: string;
  version?: string;
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

export interface BuildOptions {
  rootDir: string;
  onProgress?: (message: string) => void;
}

export interface BuildResult {
  success: boolean;
  error?: string;
}

export const DEFAULT_INTER_DEPLOY_DELAY_MS = 10_000;

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
  const { rootDir, onProgress } = options;

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

    // Use pnpm exec turbo instead of relying on global turbo
    // This works because turbo is in devDependencies
    onProgress?.('Building packages...');
    await execa(
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--filter=!@authrim/ui-*', '--filter=!@authrim/setup'],
      {
        cwd: rootDir,
        stdio: 'pipe',
      }
    );

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
// Single Worker Deployment
// =============================================================================

/**
 * Deploy a single worker with retry logic
 */
export async function deployWorker(
  component: WorkerComponent,
  options: DeployOptions
): Promise<DeployResult> {
  const { env, rootDir, maxRetries = 3, retryDelayMs = 5000, onProgress } = options;
  const startTime = Date.now();

  // Security: Validate component to prevent path traversal
  if (!isValidComponent(component)) {
    return {
      component,
      workerName: '',
      success: false,
      error: 'Invalid component name',
      duration: Date.now() - startTime,
    };
  }

  // Security: Validate environment name
  if (!isValidEnv(env)) {
    return {
      component,
      workerName: '',
      success: false,
      error: 'Invalid environment name',
      duration: Date.now() - startTime,
    };
  }

  const workerName = getWorkerName(env, component);
  const packageDir = join(rootDir, 'packages', component);
  const wranglerConfigPath = join(packageDir, 'wrangler.toml');

  // Check if package directory exists
  if (!existsSync(packageDir)) {
    return {
      component,
      workerName,
      success: false,
      error: 'Package directory not found', // Don't expose full path
      duration: Date.now() - startTime,
    };
  }

  // Check if wrangler config exists
  if (!existsSync(wranglerConfigPath)) {
    return {
      component,
      workerName,
      success: false,
      error: 'Wrangler config not found', // Don't expose full path
      duration: Date.now() - startTime,
    };
  }

  // Read package version from package.json (for version tracking)
  const packageVersion = await getPackageVersion(packageDir);

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      onProgress?.(`[${attempt}/${maxRetries}] Deploying ${workerName}...`);

      if (options.dryRun) {
        onProgress?.(`  [DRY RUN] Would deploy ${component} with --env ${env}`);
        return {
          component,
          workerName,
          success: true,
          deployedAt: new Date().toISOString(),
          version: packageVersion || undefined,
          duration: Date.now() - startTime,
        };
      }

      // Use wrangler deploy with --env to target [env.{env}] section in wrangler.toml
      // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
      await execa('pnpm', ['exec', 'wrangler', 'deploy', '--env', env], {
        cwd: packageDir,
        reject: true,
      });

      onProgress?.(`  ✓ ${workerName} deployed successfully`);

      return {
        component,
        workerName,
        success: true,
        deployedAt: new Date().toISOString(),
        version: packageVersion || undefined,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error as Error;
      const execaError = error as ExecaError;

      onProgress?.(`  ✗ Attempt ${attempt} failed: ${execaError.message || String(error)}`);

      if (attempt < maxRetries) {
        const delay = retryDelayMs * attempt; // Exponential backoff
        onProgress?.(`  ⏳ Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    component,
    workerName,
    success: false,
    error: lastError?.message || 'Unknown error',
    duration: Date.now() - startTime,
  };
}

// =============================================================================
// Parallel Deployment
// =============================================================================

/**
 * Deploy multiple workers in parallel
 */
export async function deployParallel(
  components: WorkerComponent[],
  options: DeployOptions
): Promise<DeployResult[]> {
  const { onProgress } = options;

  if (components.length === 0) {
    return [];
  }

  onProgress?.(`Deploying ${components.length} component(s) in parallel: ${components.join(', ')}`);

  const results = await Promise.all(
    components.map((component) => deployWorker(component, options))
  );

  return results;
}

// =============================================================================
// Full Deployment
// =============================================================================

/**
 * Deploy all workers in the correct order
 */
export async function deployAll(
  options: DeployOptions,
  enabledComponents?: WorkerComponent[]
): Promise<DeploymentSummary> {
  const { onProgress, onError, interDeploymentDelayMs = 0 } = options;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const levels = getDeploymentLevels(enabledComponents);
  const allResults: DeployResult[] = [];
  const totalPlannedComponents = levels.reduce((count, level) => count + level.length, 0);
  let processedComponents = 0;

  onProgress?.('Starting Authrim deployment...\n');
  onProgress?.(`Environment: ${options.env}`);
  onProgress?.(`Root directory: ${options.rootDir}`);
  onProgress?.(`Deployment levels: ${levels.length}\n`);

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
    const level = levels[levelIndex];
    onProgress?.(`\n━━━ Level ${levelIndex} ━━━`);

    // Always deploy sequentially to avoid race conditions and dependency issues
    for (const component of level) {
      const result = await deployWorker(component, options);
      allResults.push(result);
      processedComponents++;

      if (!result.success) {
        onError?.(component, new Error(result.error));

        // Stop deployment if critical component fails
        if (['ar-lib-core', 'ar-discovery'].includes(component)) {
          onProgress?.(`\n⚠️  Critical component ${component} failed. Stopping deployment.`);
          break;
        }
      }

      if (
        result.success &&
        !options.dryRun &&
        interDeploymentDelayMs > 0 &&
        processedComponents < totalPlannedComponents
      ) {
        const waitSeconds =
          interDeploymentDelayMs % 1000 === 0
            ? String(interDeploymentDelayMs / 1000)
            : (interDeploymentDelayMs / 1000).toFixed(1);
        onProgress?.(`  ⏳ Waiting ${waitSeconds}s before deploying the next worker...`);
        await new Promise((resolve) => setTimeout(resolve, interDeploymentDelayMs));
      }
    }
  }

  const completedAt = new Date().toISOString();
  const successCount = allResults.filter((r) => r.success).length;
  const failedCount = allResults.filter((r) => !r.success).length;

  const summary: DeploymentSummary = {
    totalComponents: allResults.length,
    successCount,
    failedCount,
    results: allResults,
    startedAt,
    completedAt,
    duration: Date.now() - startTime,
  };

  // Print summary
  onProgress?.('\n━━━ Deployment Summary ━━━');
  onProgress?.(`Total: ${summary.totalComponents}`);
  onProgress?.(`Success: ${successCount}`);
  onProgress?.(`Failed: ${failedCount}`);
  onProgress?.(`Duration: ${(summary.duration / 1000).toFixed(1)}s`);

  if (failedCount > 0) {
    onProgress?.('\nFailed components:');
    for (const result of allResults.filter((r) => !r.success)) {
      onProgress?.(`  • ${result.component}: ${result.error}`);
    }
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
    if (result.success && result.deployedAt) {
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

  // Workers that need secrets
  const targetWorkers = getSecretTargetWorkers(workers);

  for (const component of targetWorkers) {
    const workerName = getWorkerName(env, component);
    const packageDir = join(rootDir, 'packages', component);

    if (!existsSync(packageDir)) {
      continue;
    }

    const componentSecretNames = getSecretNamesForWorker(component);

    for (const secretName of componentSecretNames) {
      const secretValue = secrets[secretName];
      if (secretValue === undefined) {
        continue;
      }

      try {
        onProgress?.(`Uploading ${secretName} to ${workerName}...`);

        if (dryRun) {
          onProgress?.(`  [DRY RUN] Would upload ${secretName}`);
          continue;
        }

        // Use --env to target the environment section in wrangler.toml
        // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
        await execa('pnpm', ['exec', 'wrangler', 'secret', 'put', secretName, '--env', env], {
          cwd: packageDir,
          input: secretValue,
        });

        onProgress?.(`  ✓ ${secretName} uploaded`);
      } catch (error) {
        const errorMsg = `Failed to upload ${secretName} to ${workerName}: ${error}`;
        errors.push(errorMsg);
        onProgress?.(`  ✗ ${errorMsg}`);
      }
    }
  }

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

/** Result for UI Workers deployment */
export interface UiWorkerDeployResult {
  component: UiWorkerComponent;
  projectName: string;
  success: boolean;
  error?: string;
  deployedAt?: string;
  duration?: number;
}

/** Options for deploying a single UI Worker component */
export interface UiWorkerDeployOptions extends DeployOptions {
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
    adminUiBffSecrets,
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

        await execa('pnpm', ['run', 'build'], {
          cwd: uiDir,
          // Strip conflicting PUBLIC_* vars when a generated/copied .env exists.
          // Otherwise, inject PUBLIC_API_BASE_URL as the legacy fallback.
          env: buildEnv,
        });
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

    const result = await execa('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.toml'], {
      cwd: uiDir,
      reject: false, // Don't throw on non-zero exit
    });

    if (result.exitCode !== 0) {
      // Get meaningful error from stderr or stdout
      const errorOutput = result.stderr || result.stdout || 'Unknown error';
      onProgress?.(`UI Worker deploy error: ${errorOutput}`);
      return {
        component,
        projectName: uiWorkerName,
        success: false,
        error: errorOutput,
        duration: Date.now() - startTime,
      };
    }

    onProgress?.(`✓ ${component} deployed as UI Worker: ${uiWorkerName}`);

    if (component === 'ar-admin-ui' && adminUiBffSecrets) {
      for (const [secretName, secretValue] of Object.entries(adminUiBffSecrets)) {
        onProgress?.(`Uploading ${secretName} to ${uiWorkerName}...`);
        await execa('pnpm', ['exec', 'wrangler', 'secret', 'put', secretName, '--env', env], {
          cwd: uiDir,
          input: secretValue,
        });
        onProgress?.(`  ✓ ${secretName} uploaded`);
      }
    }

    return {
      component,
      projectName: uiWorkerName,
      success: true,
      deployedAt: new Date().toISOString(),
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

export async function deployUiWorker(
  options: DeployOptions & { projectName?: string }
): Promise<UiWorkerDeployResult> {
  return deployUiWorkerComponent('ar-login-ui', options);
}
