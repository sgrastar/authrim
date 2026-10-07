/**
 * `authrim-setup local init` / `local reset`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AuthrimConfigSchema, type AuthrimConfig } from '../config.js';
import { writePrivateFileAtomically } from '../atomic-file.js';
import { generateAllSecrets, saveKeysToDirectory } from '../keys.js';
import type { WorkerComponent } from '../naming.js';
import {
  buildLocalConfig,
  buildLocalLock,
  selectLocalComponents,
  type LocalComponentSelection,
  type LocalEnvironmentOptions,
} from './environment.js';
import {
  getLocalEnvironmentPaths,
  getLocalWorkerConfigPath,
  getLocalWorkerDevVarsPath,
  type LocalEnvironmentPaths,
} from './paths.js';
import { buildLocalSeedConfigToml, buildLocalWorkerFiles } from './wrangler-files.js';
import { applyLocalMigrations, loadLocalRelease, seedLocalEnvironment } from './data.js';
import { buildInitialControlPlaneResourcePlans } from '../control-plane-bootstrap.js';
import { withLocalEnvironmentLock } from './lock.js';
import { assertSupportedLocalPlatform } from './platform.js';
import { LOCAL_SELECTABLE_COMPONENTS } from './environment.js';

export function assertLocalSourceRoot(rootDir: string): void {
  if (!existsSync(`${rootDir}/packages/ar-router`) || !existsSync(`${rootDir}/migrations`)) {
    throw new Error(
      `Local mode must run from an Authrim source checkout (packages/ and migrations/ not found in ${rootDir}).`
    );
  }
}

export function isLocalEnvironmentInitialized(paths: LocalEnvironmentPaths): boolean {
  return existsSync(paths.config);
}

export async function loadLocalConfig(paths: LocalEnvironmentPaths): Promise<AuthrimConfig> {
  if (!isLocalEnvironmentInitialized(paths)) {
    throw new Error(
      `Local environment is not initialized (${paths.config} not found). Run \`pnpm setup:local init\` first.`
    );
  }
  return AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf-8')));
}

/** (Re)write seed config, per-package Wrangler configs and `.dev.vars.<env>` files. */
export async function writeLocalWranglerFiles(input: {
  paths: LocalEnvironmentPaths;
  config: AuthrimConfig;
  selection: LocalComponentSelection;
}): Promise<WorkerComponent[]> {
  const env = input.config.environment.prefix;
  const lock = buildLocalLock(env);
  await writePrivateFileAtomically(input.paths.seedConfig, buildLocalSeedConfigToml(env));
  const files = await buildLocalWorkerFiles({
    config: input.config,
    lock,
    keysDir: input.paths.keys,
    running: input.selection.running,
    excluded: input.selection.excluded,
  });
  // Components left out of this session must not leave a stale config that looks usable.
  for (const component of LOCAL_SELECTABLE_COMPONENTS) {
    if (input.selection.running.includes(component)) continue;
    await rm(getLocalWorkerConfigPath(input.paths.rootDir, component, env), { force: true });
    await rm(getLocalWorkerDevVarsPath(input.paths.rootDir, component, env), { force: true });
  }
  for (const file of files) {
    await writePrivateFileAtomically(
      getLocalWorkerConfigPath(input.paths.rootDir, file.component, env),
      file.toml,
      0o644
    );
    await writePrivateFileAtomically(
      getLocalWorkerDevVarsPath(input.paths.rootDir, file.component, env),
      file.devVars
    );
  }
  return files.map((file) => file.component);
}

export interface LocalInitOptions extends LocalEnvironmentOptions {
  rootDir: string;
  onProgress?: (message: string) => void;
}

async function initLocalEnvironmentUnlocked(options: LocalInitOptions): Promise<{
  paths: LocalEnvironmentPaths;
  config: AuthrimConfig;
}> {
  const { rootDir, onProgress } = options;
  assertLocalSourceRoot(rootDir);
  const paths = getLocalEnvironmentPaths(rootDir, options.env);
  if (existsSync(paths.root)) {
    throw new Error(
      `Local environment "${options.env}" already exists at ${paths.root}. ` +
        'Run `pnpm setup:local reset` to rebuild it.'
    );
  }
  const config = buildLocalConfig(options);
  const lock = buildLocalLock(options.env);
  // Every Worker is configured at init; `local up --only` narrows what runs.
  const selection = selectLocalComponents();

  try {
    onProgress?.('Generating local keys...');
    const secrets = generateAllSecrets(`${options.env}-key`);
    config.keys.keyId = secrets.keyPair.keyId;
    await mkdir(dirname(paths.keys), { recursive: true, mode: 0o700 });
    await saveKeysToDirectory(secrets, { targetDir: paths.keys });
    await writePrivateFileAtomically(paths.config, `${JSON.stringify(config, null, 2)}\n`);

    onProgress?.('Writing Wrangler configs and .dev.vars...');
    await writeLocalWranglerFiles({ paths, config, selection });

    const release = await loadLocalRelease(rootDir);
    const plans = buildInitialControlPlaneResourcePlans({
      env: options.env,
      lock,
      release: release.manifest,
      releaseDraft: release.draft,
    });
    onProgress?.('Applying migrations...');
    await applyLocalMigrations({ paths, lock, release, plans, onProgress });
    onProgress?.('Seeding initial data...');
    await seedLocalEnvironment({ env: options.env, config, lock, paths, release, onProgress });
  } catch (error) {
    // A half-seeded environment is worse than none: leave nothing behind to resume from.
    await resetLocalEnvironmentUnlocked({ rootDir, env: options.env }).catch(() => undefined);
    throw error;
  }
  return { paths, config };
}

async function resetLocalEnvironmentUnlocked(input: {
  rootDir: string;
  env: string;
}): Promise<void> {
  const paths = getLocalEnvironmentPaths(input.rootDir, input.env);
  for (const component of LOCAL_SELECTABLE_COMPONENTS) {
    await rm(getLocalWorkerConfigPath(paths.rootDir, component, input.env), { force: true });
    await rm(getLocalWorkerDevVarsPath(paths.rootDir, component, input.env), { force: true });
  }
  await rm(paths.root, { recursive: true, force: true });
}

/** Create the environment. Fails while another `up`/`init`/`reset` holds it. */
export async function initLocalEnvironment(options: LocalInitOptions): Promise<{
  paths: LocalEnvironmentPaths;
  config: AuthrimConfig;
}> {
  assertSupportedLocalPlatform();
  const paths = getLocalEnvironmentPaths(options.rootDir, options.env);
  return withLocalEnvironmentLock(paths, options.env, 'init', () =>
    initLocalEnvironmentUnlocked(options)
  );
}

/** Remove all state of one local environment and its own generated per-package files. */
export async function resetLocalEnvironment(input: {
  rootDir: string;
  env: string;
}): Promise<void> {
  assertSupportedLocalPlatform();
  const paths = getLocalEnvironmentPaths(input.rootDir, input.env);
  await withLocalEnvironmentLock(paths, input.env, 'reset', () =>
    resetLocalEnvironmentUnlocked(input)
  );
}

/** Delete the environment and create it again with the settings it had. One lock for both. */
export async function rebuildLocalEnvironment(input: {
  rootDir: string;
  env: string;
  onProgress?: (message: string) => void;
}): Promise<{ paths: LocalEnvironmentPaths; config: AuthrimConfig }> {
  assertSupportedLocalPlatform();
  const paths = getLocalEnvironmentPaths(input.rootDir, input.env);
  return withLocalEnvironmentLock(paths, input.env, 'reset', async () => {
    const previous = isLocalEnvironmentInitialized(paths)
      ? await loadLocalConfig(paths)
      : undefined;
    await resetLocalEnvironmentUnlocked(input);
    const apiOrigin = previous?.urls?.api?.auto;
    return initLocalEnvironmentUnlocked({
      rootDir: input.rootDir,
      env: input.env,
      routerPort: apiOrigin ? Number.parseInt(new URL(apiOrigin).port, 10) || undefined : undefined,
      loginUiPort: portOf(previous?.urls?.loginUi?.auto),
      adminUiPort: portOf(previous?.urls?.adminUi?.auto),
      adminUiVariant: previous?.components.adminUiVariant,
      tenantName: previous?.tenant.name,
      onProgress: input.onProgress,
    });
  });
}

function portOf(origin: string | undefined): number | undefined {
  return origin ? Number.parseInt(new URL(origin).port, 10) || undefined : undefined;
}
