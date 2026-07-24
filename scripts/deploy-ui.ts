#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AuthrimConfigSchema, type AuthrimConfig } from '../packages/setup/src/core/config.js';
import {
  findKeysDirectory,
  resolvePaths,
  type EnvironmentPaths,
  type LegacyPaths,
} from '../packages/setup/src/core/paths.js';
import {
  cleanupSetupMachineAccessInD1,
  ensureSetupMachineAccessInD1,
  getWorkersSubdomain,
} from '../packages/setup/src/core/cloudflare.js';
import {
  acquireEnvironmentOperationForEnvironment,
  loadLockFileAuto,
  saveLockFile,
} from '../packages/setup/src/core/lock.js';
import {
  UI_WORKER_COMPONENTS,
  deployUiWorkerBindingTargets,
  deployUiWorkerComponent,
  resolveMissingUiWorkerBindingTargets,
  type UiWorkerComponent,
} from '../packages/setup/src/core/deploy.js';
import { ensureSupplementalKeyFiles } from '../packages/setup/src/core/keys.js';
import { prepareAdminUiBffDeployment } from '../packages/setup/src/core/admin-ui-bff-deployment.js';
import { getPackageVersion, getRootProductVersion } from '../packages/setup/src/core/version.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../packages/setup/src/core/release-deployment-guard.js';
import { ensureLoginUiClient } from '../packages/setup/src/core/login-ui-client.js';
import { resolveUiDeploymentSettings } from '../packages/setup/src/core/ui-deployment.js';
import { mergeAndSaveUiEnv } from '../packages/setup/src/core/ui-env.js';
import {
  resolveAdminUiEntryUrl,
  resolveApiBaseUrlCandidates,
  resolveIssuerUrl,
  resolveLoginUiEntryUrl,
} from '../packages/setup/src/core/url-config.js';
import {
  waitForWorkerDeploymentsReady,
  waitForWorkerHttpReady,
} from '../packages/setup/src/core/worker-readiness.js';

interface CliOptions {
  env: string;
  package?: UiWorkerComponent;
  phase: 'final' | 'binding-targets-if-missing';
  keysDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let env = '';
  let pkg: UiWorkerComponent | undefined;
  let phase: CliOptions['phase'] = 'final';
  let keysDir: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--env=')) {
      env = arg.slice('--env='.length);
      continue;
    }

    if (arg.startsWith('--package=')) {
      const value = arg.slice('--package='.length) as UiWorkerComponent;
      if (!UI_WORKER_COMPONENTS.includes(value)) {
        throw new Error(`Invalid package name: ${value}`);
      }
      pkg = value;
      continue;
    }

    if (arg.startsWith('--phase=')) {
      const value = arg.slice('--phase='.length);
      if (value !== 'final' && value !== 'binding-targets-if-missing') {
        throw new Error(`Invalid UI deployment phase: ${value}`);
      }
      phase = value;
      continue;
    }

    if (arg.startsWith('--keys-dir=')) {
      keysDir = arg.slice('--keys-dir='.length);
      continue;
    }

    if (arg === '--keys-dir' && argv[index + 1]) {
      keysDir = argv[++index];
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: ./scripts/deploy-ui.sh --env=<environment> [--package=ar-login-ui|ar-admin-ui] [--phase=final|binding-targets-if-missing] [--keys-dir=<path>]'
      );
      process.exit(0);
    }

    throw new Error(`Unknown parameter: ${arg}`);
  }

  if (!env) {
    throw new Error('--env parameter is required');
  }

  return { env, package: pkg, phase, keysDir };
}

async function resolveKeysDir(
  rootDir: string,
  env: string,
  config: AuthrimConfig,
  resolvedPaths: ReturnType<typeof resolvePaths>,
  override?: string
): Promise<string | undefined> {
  const explicitCandidates = [override, config.keys?.secretsPath]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .map((candidate) => resolve(rootDir, candidate));
  for (const candidate of explicitCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  if (override) {
    throw new Error(`Keys directory not found: ${resolve(rootDir, override)}`);
  }
  const found = findKeysDirectory({
    env,
    sourceDir: rootDir,
    keysBaseDir: process.cwd(),
  });
  if (found) {
    return found.path;
  }
  const configured = (resolvedPaths.paths as EnvironmentPaths | LegacyPaths).keys;
  return existsSync(configured) ? configured : undefined;
}

async function loadConfig(
  rootDir: string,
  env: string
): Promise<{
  config: AuthrimConfig;
  resolved: ReturnType<typeof resolvePaths>;
}> {
  const resolved = resolvePaths({ baseDir: rootDir, env });
  const configPath =
    resolved.type === 'new'
      ? (resolved.paths as EnvironmentPaths).config
      : (resolved.paths as LegacyPaths).config;

  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const content = await readFile(configPath, 'utf-8');
  const config = AuthrimConfigSchema.parse(JSON.parse(content));
  return { config, resolved };
}

function getApiBaseUrl(config: AuthrimConfig): string {
  return resolveIssuerUrl(config, { env: config.environment.prefix });
}

async function resolveLoginUiClientId(
  rootDir: string,
  env: string,
  config: AuthrimConfig,
  resolved: ReturnType<typeof resolvePaths>,
  keysDir: string
): Promise<string | undefined> {
  const overrideClientId =
    process.env.AUTHRIM_LOGIN_UI_CLIENT_ID?.trim() || process.env.PUBLIC_LOGIN_UI_CLIENT_ID?.trim();
  if (overrideClientId) {
    console.log(`Using Login UI client override: ${overrideClientId}`);
    return overrideClientId;
  }

  if (resolved.type !== 'new') {
    return undefined;
  }

  const loginUiUrl =
    config.urls?.loginUi?.custom ||
    config.urls?.loginUi?.auto ||
    `https://${env}-ar-login-ui.workers.dev`;
  const apiBaseUrl = getApiBaseUrl(config);

  const setupMachineResult = await ensureSetupMachineAccessInD1(env, config, keysDir, (message) =>
    console.log(message)
  );
  if (!setupMachineResult.success) {
    throw new Error(
      `Setup machine access bootstrap failed: ${setupMachineResult.error || 'unknown error'}`
    );
  }

  let clientResult: Awaited<ReturnType<typeof ensureLoginUiClient>>;
  try {
    clientResult = await ensureLoginUiClient({
      apiBaseUrl,
      apiBaseUrls: resolveApiBaseUrlCandidates(config, {
        env,
        purpose: 'tenant-scoped-admin',
      }),
      loginUiUrl,
      keysDir,
      tenantId: config.tenant?.name,
      onProgress: (message) => console.log(message),
    });
  } finally {
    await cleanupSetupMachineAccessInD1(env, keysDir, (message) => console.log(message));
  }

  if (!clientResult.success) {
    throw new Error(`Login UI client resolution failed: ${clientResult.error || 'unknown error'}`);
  }

  if (clientResult.alreadyExists) {
    console.log(`Login UI client exists: ${clientResult.clientId}`);
  } else {
    console.log(`Login UI client created: ${clientResult.clientId}`);
  }

  return clientResult.clientId;
}

async function deployComponent(
  rootDir: string,
  env: string,
  config: AuthrimConfig,
  resolved: ReturnType<typeof resolvePaths>,
  component: UiWorkerComponent,
  keysDir: string
): Promise<void> {
  const loginUiClientId =
    component === 'ar-login-ui'
      ? await resolveLoginUiClientId(rootDir, env, config, resolved, keysDir)
      : undefined;
  const uiSettings = resolveUiDeploymentSettings({
    component,
    config,
    apiBaseUrl: getApiBaseUrl(config),
    loginUiClientId,
  });

  if (component === 'ar-login-ui' && resolved.type === 'new' && loginUiClientId) {
    const uiEnvPath = (resolved.paths as EnvironmentPaths).uiEnv;
    await mergeAndSaveUiEnv(uiEnvPath, uiSettings.uiEnv);
    console.log(`Updated Login UI env: ${uiEnvPath}`);
  }

  let adminUiBffSecrets;
  if (component === 'ar-admin-ui') {
    adminUiBffSecrets = await prepareAdminUiBffDeployment({
      env,
      config,
      keysDir,
      onProgress: console.log,
    });
  }

  const result = await deployUiWorkerComponent(component, {
    env,
    rootDir,
    apiBaseUrl: uiSettings.apiBaseUrl,
    runtimeApiBackendUrl: uiSettings.runtimeApiBackendUrl,
    uiEnvConfig: uiSettings.uiEnv,
    serviceBindingName: uiSettings.serviceBindingName,
    workersDev: uiSettings.workersDev,
    routes: uiSettings.routes,
    adminUiBffSecrets,
    onProgress: (message) => console.log(message),
  });

  if (result.deployedAt && (result.success || result.trafficCommitted)) {
    const { lock, path: lockPath } = await loadLockFileAuto(rootDir, env);
    if (lock && lockPath) {
      const version = await getPackageVersion(join(rootDir, 'packages', component));
      await saveLockFile(
        {
          ...lock,
          workers: {
            ...lock.workers,
            [component]: {
              name: result.projectName,
              deployedAt: result.deployedAt,
              version: version ?? undefined,
            },
          },
          updatedAt: new Date().toISOString(),
        },
        lockPath
      );
    }
  }

  if (!result.success) {
    throw new Error(`${component}: ${result.error || 'Worker deployment failed'}`);
  }

  const visibility = await waitForWorkerDeploymentsReady({
    targets: [{ workerName: result.projectName, deployedAt: result.deployedAt }],
    onProgress: console.log,
  });
  if (!visibility.ready) {
    throw new Error(
      `${component}: deployment did not become visible: ${visibility.error ?? 'unknown error'}`
    );
  }
  const workersSubdomain = await getWorkersSubdomain();
  const entryUrl =
    component === 'ar-login-ui'
      ? resolveLoginUiEntryUrl(config, { env, workersSubdomain })
      : resolveAdminUiEntryUrl(config, { env, workersSubdomain });
  const httpReadiness = await waitForWorkerHttpReady({
    targets: [{ workerName: result.projectName, url: entryUrl }],
    onProgress: console.log,
  });
  if (!httpReadiness.ready) {
    throw new Error(
      `${component}: HTTP readiness failed: ${httpReadiness.error ?? 'unknown error'}`
    );
  }

  console.log(`Deployed ${component} to ${result.projectName}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { config, resolved } = await loadConfig(rootDir, options.env);
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

  if (options.phase === 'binding-targets-if-missing') {
    const missing = await resolveMissingUiWorkerBindingTargets(
      {
        env: options.env,
        rootDir,
        onProgress: console.log,
      },
      {
        loginUi:
          (!options.package || options.package === 'ar-login-ui') &&
          config.components?.loginUi !== false,
        adminUi:
          (!options.package || options.package === 'ar-admin-ui') &&
          config.components?.adminUi !== false,
      }
    );
    if (!missing.loginUi && !missing.adminUi) {
      console.log('UI Worker binding targets already exist.');
      return;
    }
    const operationLock = await acquireEnvironmentOperationForEnvironment({
      baseDir: rootDir,
      env: options.env,
      operation: 'deploy-ui:binding-targets',
      requireExisting: true,
    });
    if (JSON.stringify(operationLock.lock) !== JSON.stringify(lock)) {
      await operationLock.release();
      throw new Error('environment_changed_while_waiting_for_deploy_ui_lock');
    }
    const lockedConfig = await loadConfig(rootDir, options.env);
    if (JSON.stringify(lockedConfig.config) !== JSON.stringify(config)) {
      await operationLock.release();
      throw new Error('config_changed_while_waiting_for_deploy_ui_lock');
    }
    try {
      const summary = await deployUiWorkerBindingTargets(
        {
          env: options.env,
          rootDir,
          apiBaseUrl: getApiBaseUrl(config),
          onProgress: console.log,
        },
        missing
      );
      if (summary.failedCount > 0) {
        throw new Error(
          `UI Worker binding-target deployment failed: ${summary.results
            .filter((result) => !result.success)
            .map((result) => `${result.component}: ${result.error}`)
            .join(', ')}`
        );
      }
    } finally {
      await operationLock.release();
    }
    return;
  }

  const components = options.package
    ? [options.package]
    : UI_WORKER_COMPONENTS.filter((component) =>
        component === 'ar-login-ui'
          ? config.components?.loginUi !== false
          : config.components?.adminUi !== false
      );

  if (components.length === 0) {
    console.log('No UI components enabled in config.');
    return;
  }

  const operationLock = await acquireEnvironmentOperationForEnvironment({
    baseDir: rootDir,
    env: options.env,
    operation: 'deploy-ui',
    requireExisting: true,
  });
  if (JSON.stringify(operationLock.lock) !== JSON.stringify(lock)) {
    await operationLock.release();
    throw new Error('environment_changed_while_waiting_for_deploy_ui_lock');
  }
  const lockedConfig = await loadConfig(rootDir, options.env);
  if (JSON.stringify(lockedConfig.config) !== JSON.stringify(config)) {
    await operationLock.release();
    throw new Error('config_changed_while_waiting_for_deploy_ui_lock');
  }
  try {
    const keysDir = await resolveKeysDir(rootDir, options.env, config, resolved, options.keysDir);
    if (!keysDir) {
      throw new Error(
        'UI deployment requires the environment key archive. Pass --keys-dir=<path> or restore it.'
      );
    }
    await ensureSupplementalKeyFiles(keysDir);

    for (const component of components) {
      await deployComponent(rootDir, options.env, config, resolved, component, keysDir);
    }
  } finally {
    await operationLock.release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
