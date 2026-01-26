/**
 * Authrim Deployment Module
 *
 * Handles the deployment order, parallel execution, and retry logic
 * for Authrim Workers.
 */

import { execa, type ExecaError } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  getWorkerName,
  getDeploymentOrder,
  CORE_WORKER_COMPONENTS,
  WORKER_COMPONENTS,
  type WorkerComponent,
} from './naming.js';
import type { AuthrimLock, WorkerEntry } from './lock.js';
import { copyUiEnvToPackage, cleanupPackageEnv, uiEnvExists } from './ui-env.js';
import { getPackageVersion } from './version.js';

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
      await execa('npx', ['wrangler', 'deploy', '--env', env], {
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
  const { onProgress, onError } = options;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const levels = getDeploymentLevels(enabledComponents);
  const allResults: DeployResult[] = [];

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

      if (!result.success) {
        onError?.(component, new Error(result.error));

        // Stop deployment if critical component fails
        if (['ar-lib-core', 'ar-discovery'].includes(component)) {
          onProgress?.(`\n⚠️  Critical component ${component} failed. Stopping deployment.`);
          break;
        }
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
  const targetWorkers = workers || [
    'ar-auth',
    'ar-token',
    'ar-userinfo',
    'ar-management',
    'ar-lib-core',
  ];

  for (const component of targetWorkers) {
    const workerName = getWorkerName(env, component);
    const packageDir = join(rootDir, 'packages', component);

    if (!existsSync(packageDir)) {
      continue;
    }

    for (const [secretName, secretValue] of Object.entries(secrets)) {
      try {
        onProgress?.(`Uploading ${secretName} to ${workerName}...`);

        if (dryRun) {
          onProgress?.(`  [DRY RUN] Would upload ${secretName}`);
          continue;
        }

        // Use --env to target the environment section in wrangler.toml
        // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
        await execa('npx', ['wrangler', 'secret', 'put', secretName, '--env', env], {
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
// Pages Deployment
// =============================================================================

/** Pages component type (separate from Worker components) */
export type PagesComponent = 'ar-admin-ui' | 'ar-login-ui';

/** All Pages components */
export const PAGES_COMPONENTS: PagesComponent[] = ['ar-admin-ui', 'ar-login-ui'];

/** Result for Pages deployment */
export interface PagesDeployResult {
  component: PagesComponent;
  projectName: string;
  success: boolean;
  error?: string;
  deployedAt?: string;
  duration?: number;
}

/** Options for deploying a single Pages component */
export interface PagesDeployOptions extends DeployOptions {
  /** Cloudflare Pages project name (defaults to {env}-{component}) */
  projectName?: string;
  /** API base URL for the UI to connect to (e.g., https://prod-ar-router.workers.dev) */
  apiBaseUrl?: string;
  /** Path to ui.env file (.authrim/{env}/ui.env) - preferred over apiBaseUrl */
  uiEnvPath?: string;
}

/**
 * Deploy a single UI package to Cloudflare Pages
 */
export async function deployPagesComponent(
  component: PagesComponent,
  options: PagesDeployOptions
): Promise<PagesDeployResult> {
  const { env, rootDir, projectName, onProgress, dryRun, apiBaseUrl, uiEnvPath } = options;

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
  // SvelteKit with adapter-cloudflare outputs to .svelte-kit/cloudflare
  const distDir = join(uiDir, '.svelte-kit', 'cloudflare');
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

  try {
    // Build the UI first
    onProgress?.(`Building ${component}...`);

    if (!dryRun) {
      // Copy ui.env to package's .env for Vite to read during build
      // Priority: uiEnvPath (file) > apiBaseUrl (legacy env var approach)
      if (uiEnvPath && (await uiEnvExists(uiEnvPath))) {
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
        await execa('pnpm', ['run', 'build'], {
          cwd: uiDir,
          // Note: We still pass apiBaseUrl as env var for backwards compatibility,
          // but Vite will primarily read from .env file
          env: apiBaseUrl ? { ...process.env, PUBLIC_API_BASE_URL: apiBaseUrl } : process.env,
        });
      } finally {
        // Always clean up .env after build (success or failure)
        if (copiedUiEnv) {
          await cleanupPackageEnv(uiDir);
        }
      }
    }

    onProgress?.('Deploying to Cloudflare Pages...');

    if (dryRun) {
      onProgress?.(`[DRY RUN] Would deploy ${component} to Pages`);
      return {
        component,
        projectName: projectName || `${env}-${component}`,
        success: true,
        deployedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    }

    const pagesProjectName = projectName || `${env}-${component}`;

    // First, try to create the project (will fail silently if already exists)
    // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
    onProgress?.(`Ensuring Pages project exists: ${pagesProjectName}...`);
    await execa(
      'npx',
      ['wrangler', 'pages', 'project', 'create', pagesProjectName, '--production-branch', 'main'],
      {
        cwd: uiDir,
        reject: false, // Ignore error if project already exists
      }
    );

    // Set API_BACKEND_URL secret for Admin UI (Safari ITP cookie proxy)
    // This enables the server-side proxy in hooks.server.ts
    if (component === 'ar-admin-ui' && apiBaseUrl) {
      onProgress?.(`Setting API_BACKEND_URL secret for ${pagesProjectName}...`);
      const secretResult = await execa(
        'npx',
        [
          'wrangler',
          'pages',
          'secret',
          'put',
          'API_BACKEND_URL',
          '--project-name',
          pagesProjectName,
        ],
        {
          cwd: uiDir,
          input: apiBaseUrl,
          reject: false,
        }
      );
      if (secretResult.exitCode === 0) {
        onProgress?.(`✓ API_BACKEND_URL secret set for Safari ITP compatibility`);
      } else {
        onProgress?.(
          `⚠️ Could not set API_BACKEND_URL secret: ${secretResult.stderr || 'Unknown error'}`
        );
      }
    }

    // Deploy to Pages
    const result = await execa(
      'npx',
      ['wrangler', 'pages', 'deploy', distDir, '--project-name', pagesProjectName],
      {
        cwd: uiDir,
        reject: false, // Don't throw on non-zero exit
      }
    );

    if (result.exitCode !== 0) {
      // Get meaningful error from stderr or stdout
      const errorOutput = result.stderr || result.stdout || 'Unknown error';
      onProgress?.(`Pages deploy error: ${errorOutput}`);
      return {
        component,
        projectName: pagesProjectName,
        success: false,
        error: errorOutput,
        duration: Date.now() - startTime,
      };
    }

    onProgress?.(`✓ ${component} deployed to Pages: ${pagesProjectName}`);

    return {
      component,
      projectName: pagesProjectName,
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

/** Summary for all Pages deployments */
export interface PagesDeploymentSummary {
  results: PagesDeployResult[];
  successCount: number;
  failedCount: number;
}

/**
 * Deploy all enabled UI packages to Cloudflare Pages
 */
export async function deployAllPages(
  options: DeployOptions & { apiBaseUrl?: string; uiEnvPath?: string },
  enabledComponents: { loginUi: boolean; adminUi: boolean }
): Promise<PagesDeploymentSummary> {
  const results: PagesDeployResult[] = [];

  if (enabledComponents.loginUi) {
    const loginResult = await deployPagesComponent('ar-login-ui', options);
    results.push(loginResult);
  }

  if (enabledComponents.adminUi) {
    const adminResult = await deployPagesComponent('ar-admin-ui', options);
    results.push(adminResult);
  }

  return {
    results,
    successCount: results.filter((r) => r.success).length,
    failedCount: results.filter((r) => !r.success).length,
  };
}

/**
 * @deprecated Use deployPagesComponent instead for new code
 * Deploy UI to Cloudflare Pages (legacy - deploys ar-login-ui)
 */
export async function deployPages(
  options: DeployOptions & { projectName?: string }
): Promise<PagesDeployResult> {
  return deployPagesComponent('ar-login-ui', options);
}
