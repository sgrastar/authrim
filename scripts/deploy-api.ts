#!/usr/bin/env tsx

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  cleanupLegacyStaticSecrets,
  deployAll,
  deployWorkerGradually,
  loadDeploySecretsFromKeys,
  resolveExistingWorkerComponents,
  updateLockWithDeployments,
  type DeployOptions,
  type DeploymentSummary,
} from '../packages/setup/src/core/deploy.js';
import {
  acquireEnvironmentOperationForEnvironment,
  loadLockFileAuto,
  saveLockFile,
} from '../packages/setup/src/core/lock.js';
import {
  CORE_WORKER_COMPONENTS,
  WORKER_DEPLOYMENT_DEPENDENCIES,
  type WorkerComponent,
} from '../packages/setup/src/core/naming.js';
import { findKeysDirectory } from '../packages/setup/src/core/paths.js';
import { ensureSupplementalKeyFiles } from '../packages/setup/src/core/keys.js';
import { getMissingRequiredDeploySecrets } from '../packages/setup/src/core/secrets.js';
import { getRootProductVersion } from '../packages/setup/src/core/version.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../packages/setup/src/core/release-deployment-guard.js';

interface CliOptions {
  env: string;
  component?: WorkerComponent;
  strategy: 'auto' | 'direct' | 'staged';
  concurrency: number;
  dryRun: boolean;
  gradualStages?: number[];
  gradualWaitMs: number;
  healthUrl?: string;
  keysDir?: string;
  preflight: boolean;
  finalizeLegacyStaticSecretCleanup: boolean;
}

function readValue(argument: string, name: string): string | undefined {
  const prefix = `--${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined;
}

function parseOptions(argv: string[]): CliOptions {
  let env = '';
  let component: WorkerComponent | undefined;
  let strategy: CliOptions['strategy'] = 'auto';
  let concurrency = 2;
  let dryRun = false;
  let gradualStages: number[] | undefined;
  let gradualWaitMs = 0;
  let healthUrl: string | undefined;
  let keysDir: string | undefined;
  let preflight = false;
  let finalizeLegacyStaticSecretCleanup = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = argv[index + 1];
    const envValue = readValue(argument, 'env');
    const componentValue = readValue(argument, 'component');
    const strategyValue = readValue(argument, 'mode');
    const concurrencyValue = readValue(argument, 'concurrency');
    const gradualStagesValue = readValue(argument, 'gradual-stages');
    const gradualWaitValue = readValue(argument, 'gradual-wait-seconds');
    const healthUrlValue = readValue(argument, 'health-url');
    const keysDirValue = readValue(argument, 'keys-dir');

    if (envValue !== undefined) {
      env = envValue;
    } else if (argument === '--env' && next) {
      env = next;
      index++;
    } else if (componentValue !== undefined) {
      component = componentValue as WorkerComponent;
    } else if (argument === '--component' && next) {
      component = next as WorkerComponent;
      index++;
    } else if (strategyValue !== undefined) {
      strategy = strategyValue as CliOptions['strategy'];
    } else if (argument === '--mode' && next) {
      strategy = next as CliOptions['strategy'];
      index++;
    } else if (concurrencyValue !== undefined) {
      concurrency = Number(concurrencyValue);
    } else if (argument === '--concurrency' && next) {
      concurrency = Number(next);
      index++;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--preflight') {
      preflight = true;
    } else if (argument === '--finalize-legacy-static-secret-cleanup') {
      finalizeLegacyStaticSecretCleanup = true;
    } else if (gradualStagesValue !== undefined) {
      gradualStages = gradualStagesValue.split(',').map(Number);
    } else if (argument === '--gradual-stages' && next) {
      gradualStages = next.split(',').map(Number);
      index++;
    } else if (gradualWaitValue !== undefined) {
      gradualWaitMs = Number(gradualWaitValue) * 1000;
    } else if (healthUrlValue !== undefined) {
      healthUrl = healthUrlValue.replace(/\/+$/, '');
    } else if (keysDirValue !== undefined) {
      keysDir = keysDirValue;
    } else if (argument === '--keys-dir' && next) {
      keysDir = next;
      index++;
    } else {
      throw new Error(`Unknown deploy-api option: ${argument}`);
    }
  }

  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    throw new Error('--env is required and must contain lowercase letters, digits, or hyphens');
  }
  if (component && !CORE_WORKER_COMPONENTS.includes(component)) {
    throw new Error(`Unknown Worker component: ${component}`);
  }
  if (!['auto', 'direct', 'staged'].includes(strategy)) {
    throw new Error(`Unknown deployment mode: ${strategy}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('--concurrency must be an integer from 1 to 4');
  }
  if (gradualStages && !component) {
    throw new Error('--component is required with --gradual-stages');
  }
  if (
    gradualStages &&
    (gradualStages.length === 0 ||
      gradualStages.at(-1) !== 100 ||
      gradualStages.some(
        (stage, index) =>
          !Number.isInteger(stage) ||
          stage < 1 ||
          stage > 100 ||
          (index > 0 && stage <= gradualStages[index - 1])
      ))
  ) {
    throw new Error(
      '--gradual-stages must be strictly increasing integers from 1 to 100 ending at 100'
    );
  }
  if (!Number.isFinite(gradualWaitMs) || gradualWaitMs < 0) {
    throw new Error('--gradual-wait-seconds must be a non-negative number');
  }
  if (healthUrl && !/^https:\/\//.test(healthUrl)) {
    throw new Error('--health-url must be an https URL');
  }
  if (finalizeLegacyStaticSecretCleanup && (component || gradualStages || preflight || dryRun)) {
    throw new Error(
      '--finalize-legacy-static-secret-cleanup cannot be combined with deployment options'
    );
  }
  return {
    env,
    component,
    strategy,
    concurrency,
    dryRun,
    gradualStages,
    gradualWaitMs,
    healthUrl,
    keysDir,
    preflight,
    finalizeLegacyStaticSecretCleanup,
  };
}

function getDeploymentScope(selected: readonly WorkerComponent[]): WorkerComponent[] {
  const scope = new Set<WorkerComponent>(selected);
  const visit = (component: WorkerComponent): void => {
    for (const dependency of WORKER_DEPLOYMENT_DEPENDENCIES[component]) {
      if (!scope.has(dependency)) {
        scope.add(dependency);
        visit(dependency);
      }
    }
  };
  for (const component of selected) {
    visit(component);
  }
  return CORE_WORKER_COMPONENTS.filter((component) => scope.has(component));
}

async function checkOidcHealth(baseUrl: string): Promise<{ success: boolean; error?: string }> {
  let lastError = 'unknown health error';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body = (await response.json()) as { issuer?: unknown };
        if (typeof body.issuer === 'string' && body.issuer.length > 0) {
          return { success: true };
        }
        lastError = 'discovery response has no issuer';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
  }
  return { success: false, error: lastError };
}

function buildVersionVars(): DeployOptions['varsByComponent'] {
  const codeVersion = process.env.AUTHRIM_DEPLOY_UUID;
  const deployTime = process.env.AUTHRIM_DEPLOY_TIME;
  if (!codeVersion && !deployTime) {
    return undefined;
  }
  return Object.fromEntries(
    CORE_WORKER_COMPONENTS.filter(
      (component) => component !== 'ar-lib-core' && component !== 'ar-router'
    ).map((component) => [
      component,
      {
        ...(codeVersion ? { CODE_VERSION_UUID: codeVersion } : {}),
        ...(deployTime ? { DEPLOY_TIME_UTC: deployTime } : {}),
      },
    ])
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rootDir = resolve(process.cwd());
  const { lock, path: lockPath } = await loadLockFileAuto(rootDir, options.env);
  if (!lock) {
    throw new Error(
      `Environment ${options.env} has no lock file; run authrim-setup init before deploying.`
    );
  }
  if (!lock.productVersion && Object.keys(lock.workers ?? {}).length === 0) {
    throw new Error(
      'Initial deployment must use authrim-setup deploy so the exact release schema is applied first.'
    );
  }
  const targetProductVersion = await getRootProductVersion(rootDir);
  const deploymentGuard = evaluateReleaseDeploymentGuard(
    lock,
    targetProductVersion,
    'worker_redeploy'
  );
  if (!deploymentGuard.allowed) {
    throw new Error(releaseDeploymentGuardMessage(deploymentGuard, targetProductVersion));
  }
  if (options.finalizeLegacyStaticSecretCleanup) {
    const cleanupOperationLock = await acquireEnvironmentOperationForEnvironment({
      baseDir: rootDir,
      env: options.env,
      operation: 'deploy-api:legacy-secret-cleanup',
      requireExisting: true,
    });
    if (JSON.stringify(cleanupOperationLock.lock) !== JSON.stringify(lock)) {
      await cleanupOperationLock.release();
      throw new Error('environment_changed_while_waiting_for_deploy_api_cleanup_lock');
    }
    try {
      const cleanupResult = await cleanupLegacyStaticSecrets(
        {
          env: options.env,
          rootDir,
          concurrency: options.concurrency,
          maxRetries: 4,
          retryDelayMs: 1000,
          onProgress: console.log,
        },
        ['ar-lib-core', 'ar-auth', 'ar-token', 'ar-management']
      );
      if (cleanupResult.failures.length > 0) {
        for (const failure of cleanupResult.failures) {
          console.error(`${failure.component}: ${failure.error}`);
        }
        process.exitCode = 1;
        return;
      }
      if (options.healthUrl) {
        const health = await checkOidcHealth(options.healthUrl);
        if (!health.success) {
          console.error(`Post-cleanup health check failed: ${health.error || 'unknown error'}`);
          process.exitCode = 1;
          return;
        }
      }
      for (const [component, versionId] of Object.entries(cleanupResult.activeVersionIds)) {
        console.log(`  ✓ ${component}: cleanup version ${versionId}`);
      }
      console.log('Legacy static secret cleanup finalized.');
    } finally {
      await cleanupOperationLock.release();
    }
    return;
  }
  const selected = options.component ? [options.component] : [...CORE_WORKER_COMPONENTS];
  const deploymentScope = getDeploymentScope(selected);
  const lockComponents = CORE_WORKER_COMPONENTS.filter(
    (component) => lock?.workers?.[component] !== undefined
  );
  let keysPath: string | undefined;
  if (options.keysDir) {
    keysPath = resolve(rootDir, options.keysDir);
    const keysStats = await stat(keysPath).catch(() => undefined);
    if (!keysStats?.isDirectory()) {
      throw new Error(`Keys directory not found: ${keysPath}`);
    }
  } else {
    keysPath = findKeysDirectory({
      env: options.env,
      sourceDir: rootDir,
      keysBaseDir: process.cwd(),
    })?.path;
  }
  const controller = new AbortController();
  let interruptCount = 0;
  const handleInterrupt = (): void => {
    interruptCount++;
    if (interruptCount === 1) {
      console.warn('Deployment cancellation requested; finishing recovery...');
      controller.abort(new Error('Deployment cancelled by user'));
      return;
    }
    process.exit(130);
  };
  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleInterrupt);
  let operationLock:
    | Awaited<ReturnType<typeof acquireEnvironmentOperationForEnvironment>>
    | undefined;

  try {
    operationLock =
      options.dryRun || options.preflight
        ? undefined
        : await acquireEnvironmentOperationForEnvironment({
            baseDir: rootDir,
            env: options.env,
            operation: 'deploy-api',
            requireExisting: true,
          });
    if (operationLock && JSON.stringify(operationLock.lock) !== JSON.stringify(lock)) {
      throw new Error('environment_changed_while_waiting_for_deploy_api_lock');
    }
    if (keysPath && !options.dryRun && !options.preflight) {
      await ensureSupplementalKeyFiles(keysPath);
    }
    const secrets = keysPath ? await loadDeploySecretsFromKeys(keysPath, deploymentScope) : {};

    if (!process.env.CLOUDFLARE_API_TOKEN && options.concurrency > 1) {
      console.warn(
        'Tip: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are recommended for parallel CI deploys.'
      );
    }

    const commonOptions: DeployOptions = {
      env: options.env,
      rootDir,
      dryRun: options.dryRun,
      concurrency: options.concurrency,
      deploymentStrategy: options.strategy,
      existingComponents: lockComponents,
      secrets,
      cleanupLegacyStaticSecrets: true,
      varsByComponent: buildVersionVars(),
      maxRetries: 4,
      retryDelayMs: 1000,
      signal: controller.signal,
      onProgress: console.log,
      onError: (component, error) => {
        console.error(`${component}: ${error.message}`);
      },
    };
    const existingComponents = options.dryRun
      ? lockComponents
      : await resolveExistingWorkerComponents(commonOptions, deploymentScope);
    const freshComponents = deploymentScope.filter(
      (component) => !existingComponents.includes(component)
    );
    const missingSecrets = getMissingRequiredDeploySecrets(secrets, freshComponents);
    if (missingSecrets.length > 0) {
      throw new Error(
        `First deployment requires local secret files for: ${missingSecrets.join(', ')}. ` +
          'Pass --keys-dir=<path> or restore the environment key archive.'
      );
    }
    const deployOptions: DeployOptions = {
      ...commonOptions,
      existingComponents,
    };

    if (options.preflight) {
      console.log(
        `Preflight passed: ${existingComponents.length}/${deploymentScope.length} Worker(s) already exist.`
      );
      return;
    }

    let summary: DeploymentSummary;
    if (options.gradualStages && options.component) {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const result = await deployWorkerGradually(options.component, deployOptions, {
        stages: options.gradualStages,
        stabilizationDelayMs: 30_000,
        stageWaitMs: options.gradualWaitMs,
        healthCheck: options.healthUrl ? () => checkOidcHealth(options.healthUrl!) : undefined,
      });
      if (!options.dryRun && result.success && deployOptions.cleanupLegacyStaticSecrets) {
        const cleanupResult = await cleanupLegacyStaticSecrets(deployOptions, [options.component]);
        const activeVersionId = cleanupResult.activeVersionIds[options.component];
        if (activeVersionId) {
          result.cloudflareVersionId = activeVersionId;
          result.deployedAt = new Date().toISOString();
        }
        const cleanupFailure = cleanupResult.failures.find(
          (failure) => failure.component === options.component
        );
        if (cleanupFailure) {
          result.success = false;
          result.trafficCommitted = true;
          result.error = `Worker deployed, but legacy static secret cleanup failed: ${cleanupFailure.error}`;
        }
      }
      summary = {
        totalComponents: 1,
        successCount: result.success ? 1 : 0,
        failedCount: result.success ? 0 : 1,
        results: [result],
        startedAt,
        completedAt: new Date().toISOString(),
        duration: Date.now() - started,
      };
    } else {
      summary = await deployAll(deployOptions, selected);
    }

    if (
      !options.dryRun &&
      lock &&
      lockPath &&
      summary.results.some((result) => result.success || result.trafficCommitted)
    ) {
      await saveLockFile(updateLockWithDeployments(lock, summary.results), lockPath);
      console.log(`Lock file updated: ${lockPath}`);
    }
    if (controller.signal.aborted) {
      process.exitCode = 130;
    } else if (summary.failedCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await operationLock?.release();
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleInterrupt);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
