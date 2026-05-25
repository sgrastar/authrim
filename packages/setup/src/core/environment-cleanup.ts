import { existsSync } from 'node:fs';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKER_COMPONENTS } from './naming.js';
import { AUTHRIM_KEYS_DIR, getEnvironmentPaths, getLegacyPaths } from './paths.js';
import { getDeployWranglerPath, removeEnvironmentSectionFromToml } from './wrangler-sync.js';

export interface LocalEnvironmentCleanupOptions {
  baseDir: string;
  env: string;
  packagesDir?: string;
  keysBaseDir?: string;
  onProgress?: (message: string) => void;
}

export interface LocalEnvironmentCleanupResult {
  removed: string[];
  errors: string[];
}

export async function cleanupLocalEnvironmentArtifacts(
  options: LocalEnvironmentCleanupOptions
): Promise<LocalEnvironmentCleanupResult> {
  const { baseDir, env, packagesDir, keysBaseDir = baseDir, onProgress } = options;
  const removed: string[] = [];
  const errors: string[] = [];

  const envPaths = getEnvironmentPaths({ baseDir, env });
  const externalKeysDir = join(keysBaseDir, AUTHRIM_KEYS_DIR, env);
  const legacyKeysDir = getLegacyPaths(baseDir, env).keys;

  const removeDirIfExists = async (path: string, label: string) => {
    if (!existsSync(path)) {
      return;
    }

    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
      onProgress?.(`  🧹 Removed ${label}: ${path}`);
    } catch (error) {
      const message = `Failed to remove ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      onProgress?.(`  ⚠️ ${message}`);
    }
  };

  await removeDirIfExists(envPaths.root, 'environment directory');
  await removeDirIfExists(externalKeysDir, 'external keys directory');
  await removeDirIfExists(legacyKeysDir, 'legacy keys directory');

  if (packagesDir && existsSync(packagesDir)) {
    for (const component of WORKER_COMPONENTS) {
      const deployPath = getDeployWranglerPath(packagesDir, component);
      if (!existsSync(deployPath)) {
        continue;
      }

      try {
        const currentContent = await readFile(deployPath, 'utf-8');
        const { content, removed: envRemoved } = removeEnvironmentSectionFromToml(
          currentContent,
          env
        );

        if (!envRemoved) {
          continue;
        }

        await writeFile(deployPath, content, 'utf-8');
        removed.push(deployPath);
        onProgress?.(`  🧹 Removed [env.${env}] from ${component}/wrangler.toml`);
      } catch (error) {
        const message = `Failed to clean wrangler.toml for ${component}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        onProgress?.(`  ⚠️ ${message}`);
      }
    }
  }

  return { removed, errors };
}
