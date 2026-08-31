import { existsSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKER_COMPONENTS } from './naming.js';
import {
  AUTHRIM_KEYS_DIR,
  deriveExternalKeysBaseDirFromConfigPath,
  getEnvironmentPaths,
  getExternalKeysDir,
  getLegacyPaths,
} from './paths.js';
import {
  getDeployWranglerPath,
  removeEnvironmentSectionFromToml,
  writeWranglerFileAtomically,
} from './wrangler-sync.js';

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

interface LocalEnvironmentCleanupDependencies {
  writeWranglerFile?: typeof writeWranglerFileAtomically;
}

export async function cleanupLocalEnvironmentArtifacts(
  options: LocalEnvironmentCleanupOptions,
  dependencies: LocalEnvironmentCleanupDependencies = {}
): Promise<LocalEnvironmentCleanupResult> {
  const { baseDir, env, packagesDir, keysBaseDir = baseDir, onProgress } = options;
  const removed: string[] = [];
  const errors: string[] = [];

  const envPaths = getEnvironmentPaths({ baseDir, env });
  // Legacy environments did not record key storage explicitly and used the cwd-relative
  // .authrim-keys directory. Keep that fallback only while there is no explicit storage mode:
  // an internal-key environment must never delete an unrelated external bundle with the same name.
  let externalKeysDir: string | null = join(keysBaseDir, AUTHRIM_KEYS_DIR, env);
  const legacyKeysDir = getLegacyPaths(baseDir, env).keys;

  // The external key location is pinned in config and can differ from the cwd used for delete.
  // Resolve it before removing config.json; otherwise a successful remote deletion can erase the
  // only pointer to a directory that still contains production credentials.
  if (existsSync(envPaths.config)) {
    try {
      const raw = JSON.parse(await readFile(envPaths.config, 'utf-8')) as {
        keys?: { storageType?: unknown; secretsPath?: unknown };
      };
      if (raw.keys?.storageType === 'external') {
        if (typeof raw.keys.secretsPath !== 'string') {
          throw new Error('external_keys_config_path_required');
        }
        const configuredBaseDir = deriveExternalKeysBaseDirFromConfigPath(
          env,
          raw.keys.secretsPath
        );
        externalKeysDir = getExternalKeysDir(env, configuredBaseDir);
      } else if (raw.keys?.storageType === 'internal') {
        externalKeysDir = null;
      }
    } catch (error) {
      const message = `Failed to resolve configured external keys directory: ${
        error instanceof Error ? error.message : String(error)
      }`;
      errors.push(message);
      onProgress?.(`  ⚠️ ${message}`);
      externalKeysDir = null;
    }
  }

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

  // Keep the lock/config inventory until every independent cleanup step has run. If key or
  // wrangler cleanup fails, the operator can retry without losing the environment record.
  if (externalKeysDir) {
    await removeDirIfExists(externalKeysDir, 'external keys directory');
  }
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

        await (dependencies.writeWranglerFile ?? writeWranglerFileAtomically)(deployPath, content);
        const reflected = await readFile(deployPath, 'utf-8');
        if (reflected !== content || removeEnvironmentSectionFromToml(reflected, env).removed) {
          throw new Error('wrangler_environment_cleanup_reflection_failed');
        }
        removed.push(deployPath);
        onProgress?.(`  🧹 Removed [env.${env}] from ${component}/wrangler.toml`);
      } catch (error) {
        const message = `Failed to clean wrangler.toml for ${component}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        onProgress?.(`  ⚠️ ${message}`);
      }
    }
  }

  if (errors.length === 0) {
    await removeDirIfExists(envPaths.root, 'environment directory');
  } else {
    onProgress?.('  ⚠️ Preserved environment directory for local cleanup retry');
  }

  return { removed, errors };
}
