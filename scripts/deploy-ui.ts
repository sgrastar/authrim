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
} from '../packages/setup/src/core/cloudflare.js';
import { loadLockFileAuto, saveLockFile } from '../packages/setup/src/core/lock.js';
import {
  UI_WORKER_COMPONENTS,
  deployUiWorkerComponent,
  type UiWorkerComponent,
} from '../packages/setup/src/core/deploy.js';
import { getPackageVersion } from '../packages/setup/src/core/version.js';
import { ensureLoginUiClient } from '../packages/setup/src/core/login-ui-client.js';
import { resolveUiDeploymentSettings } from '../packages/setup/src/core/ui-deployment.js';
import { mergeAndSaveUiEnv } from '../packages/setup/src/core/ui-env.js';
import {
  resolveApiBaseUrlCandidates,
  resolveIssuerUrl,
} from '../packages/setup/src/core/url-config.js';

interface CliOptions {
  env: string;
  package?: UiWorkerComponent;
}

function parseArgs(argv: string[]): CliOptions {
  let env = '';
  let pkg: UiWorkerComponent | undefined;

  for (const arg of argv) {
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

    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: ./scripts/deploy-ui.sh --env=<environment> [--package=ar-login-ui|ar-admin-ui]'
      );
      process.exit(0);
    }

    throw new Error(`Unknown parameter: ${arg}`);
  }

  if (!env) {
    throw new Error('--env parameter is required');
  }

  return { env, package: pkg };
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
  resolved: ReturnType<typeof resolvePaths>
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
    `https://${env}-ar-login-ui.pages.dev`;
  const apiBaseUrl = getApiBaseUrl(config);
  const foundKeys = findKeysDirectory({
    env,
    sourceDir: rootDir,
    keysBaseDir: process.cwd(),
  });
  const adminApiSecretPath = foundKeys
    ? join(foundKeys.path, 'admin_api_secret.txt')
    : (resolved.paths as EnvironmentPaths).keyFiles.adminApiSecret;
  const keysDir = foundKeys ? foundKeys.path : (resolved.paths as EnvironmentPaths).keys;

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
      adminApiSecretPath,
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
  component: UiWorkerComponent
): Promise<void> {
  const loginUiClientId =
    component === 'ar-login-ui'
      ? await resolveLoginUiClientId(rootDir, env, config, resolved)
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

  const result = await deployUiWorkerComponent(component, {
    env,
    rootDir,
    apiBaseUrl: uiSettings.apiBaseUrl,
    runtimeApiBackendUrl: uiSettings.runtimeApiBackendUrl,
    uiEnvConfig: uiSettings.uiEnv,
    serviceBindingName: uiSettings.serviceBindingName,
    workersDev: uiSettings.workersDev,
    routes: uiSettings.routes,
    onProgress: (message) => console.log(message),
  });

  if (!result.success) {
    throw new Error(`${component}: ${result.error || 'Pages deployment failed'}`);
  }

  if (resolved.type === 'new' && result.deployedAt) {
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

  console.log(`Deployed ${component} to ${result.projectName}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { config, resolved } = await loadConfig(rootDir, options.env);

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

  for (const component of components) {
    await deployComponent(rootDir, options.env, config, resolved, component);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
