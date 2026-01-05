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
  getEnabledComponents,
  CORE_WORKER_COMPONENTS,
  WORKER_COMPONENTS,
  type WorkerComponent,
} from './naming.js';
import type { AuthrimLock, WorkerEntry } from './lock.js';

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
  const wranglerConfig = options.configFile || `wrangler.${env}.toml`;
  const wranglerConfigPath = join(packageDir, wranglerConfig);

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

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      onProgress?.(`[${attempt}/${maxRetries}] Deploying ${workerName}...`);

      if (options.dryRun) {
        onProgress?.(`  [DRY RUN] Would deploy ${component} with config ${wranglerConfig}`);
        return {
          component,
          workerName,
          success: true,
          deployedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
        };
      }

      // Use deploy script if available for version management
      const deployScript = join(rootDir, 'scripts', 'deploy-with-retry.sh');
      let result: { stdout: string; stderr: string };

      if (existsSync(deployScript)) {
        // Use deploy script (handles version management)
        result = await execa(deployScript, [component, env], {
          cwd: rootDir,
          reject: true,
        });
      } else {
        // Fall back to direct wrangler deploy
        result = await execa('wrangler', ['deploy', '--config', wranglerConfig], {
          cwd: packageDir,
          reject: true,
        });
      }

      // Extract version from output if available
      const versionMatch = result.stdout.match(/Deployed.*version[:\s]+([a-f0-9-]+)/i);

      onProgress?.(`  ✓ ${workerName} deployed successfully`);

      return {
        component,
        workerName,
        success: true,
        deployedAt: new Date().toISOString(),
        version: versionMatch?.[1],
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

    // Level 0 and 4 are sequential (single component)
    // Levels 1-3 can be parallel
    const isParallel = level.length > 1;

    if (isParallel) {
      const results = await deployParallel(level, options);
      allResults.push(...results);

      // Check for failures
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        for (const failure of failures) {
          onError?.(failure.component, new Error(failure.error));
        }
      }
    } else {
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

  const wranglerConfig = options.configFile || `wrangler.${env}.toml`;

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

        await execa('wrangler', ['secret', 'put', secretName, '--config', wranglerConfig], {
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
export type PagesComponent = 'ar-ui';

/** Result for Pages deployment */
export interface PagesDeployResult {
  component: PagesComponent;
  projectName: string;
  success: boolean;
  error?: string;
  deployedAt?: string;
  duration?: number;
}

/**
 * Deploy UI to Cloudflare Pages
 */
export async function deployPages(
  options: DeployOptions & { projectName?: string }
): Promise<PagesDeployResult> {
  const { env, rootDir, projectName, onProgress, dryRun } = options;

  // Security: Validate environment name
  if (!isValidEnv(env)) {
    return {
      component: 'ar-ui',
      projectName: projectName || `${env}-ar-ui`,
      success: false,
      error: 'Invalid environment name',
      duration: 0,
    };
  }

  const uiDir = join(rootDir, 'packages', 'ar-ui');
  const distDir = join(uiDir, 'dist');
  const startTime = Date.now();

  if (!existsSync(uiDir)) {
    return {
      component: 'ar-ui',
      projectName: projectName || `${env}-ar-ui`,
      success: false,
      error: 'ar-ui package not found',
      duration: Date.now() - startTime,
    };
  }

  try {
    // Build the UI first
    onProgress?.('Building ar-ui...');

    if (!dryRun) {
      await execa('pnpm', ['run', 'build'], {
        cwd: uiDir,
      });
    }

    onProgress?.('Deploying to Cloudflare Pages...');

    if (dryRun) {
      onProgress?.('[DRY RUN] Would deploy ar-ui to Pages');
      return {
        component: 'ar-ui',
        projectName: projectName || `${env}-ar-ui`,
        success: true,
        deployedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    }

    const pagesProjectName = projectName || `${env}-ar-ui`;

    await execa('wrangler', ['pages', 'deploy', distDir, '--project-name', pagesProjectName], {
      cwd: uiDir,
    });

    onProgress?.(`✓ ar-ui deployed to Pages: ${pagesProjectName}`);

    return {
      component: 'ar-ui',
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
      component: 'ar-ui',
      projectName: projectName || `${env}-ar-ui`,
      success: false,
      error: sanitizedError,
      duration: Date.now() - startTime,
    };
  }
}
