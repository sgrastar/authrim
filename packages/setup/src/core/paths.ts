/**
 * Path Management Module
 *
 * Centralized path resolution for Authrim configuration files.
 * Supports both legacy (flat files) and new (.authrim/{env}/) structures.
 *
 * Legacy Structure:
 *   project/
 *   ├── authrim-config.json
 *   ├── authrim-lock.json
 *   └── .keys/{env}/
 *
 * New Structure:
 *   project/
 *   └── .authrim/
 *       └── {env}/
 *           ├── config.json
 *           ├── lock.json
 *           ├── version.txt
 *           └── keys/
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// =============================================================================
// Types
// =============================================================================

export interface PathConfig {
  /** Base directory (usually cwd) */
  baseDir: string;
  /** Environment name */
  env: string;
}

export interface EnvironmentPaths {
  /** Root directory for this environment: .authrim/{env}/ */
  root: string;
  /** Configuration file: .authrim/{env}/config.json */
  config: string;
  /** Lock file with resource IDs: .authrim/{env}/lock.json */
  lock: string;
  /** Version tracking file: .authrim/{env}/version.txt */
  version: string;
  /** Keys directory: .authrim/{env}/keys/ */
  keys: string;
  /** Wrangler configs directory: .authrim/{env}/wrangler/ */
  wrangler: string;
  /** Specific key file paths */
  keyFiles: KeyFilePaths;
}

export interface KeyFilePaths {
  privateKey: string;
  publicKey: string;
  rpTokenEncryptionKey: string;
  adminApiSecret: string;
  keyManagerSecret: string;
  setupToken: string;
  metadata: string;
  emailFrom: string;
  resendApiKey: string;
}

export interface LegacyPaths {
  /** Configuration file: authrim-config.json */
  config: string;
  /** Lock file: authrim-lock.json */
  lock: string;
  /** Keys directory: .keys/{env}/ */
  keys: string;
  /** Specific key file paths */
  keyFiles: KeyFilePaths;
}

export type StructureType = 'new' | 'legacy' | 'none';

export interface StructureInfo {
  type: StructureType;
  /** Available environments (for 'new' type) */
  envs: string[];
  /** Detected environment name (for 'legacy' type, if determinable) */
  legacyEnv?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Root directory name for new structure */
export const AUTHRIM_DIR = '.authrim';

/** Legacy config file name */
export const LEGACY_CONFIG_FILE = 'authrim-config.json';

/** Legacy lock file name */
export const LEGACY_LOCK_FILE = 'authrim-lock.json';

/** Legacy keys directory */
export const LEGACY_KEYS_DIR = '.keys';

/** New structure config file name */
export const CONFIG_FILE = 'config.json';

/** New structure lock file name */
export const LOCK_FILE = 'lock.json';

/** Version tracking file name */
export const VERSION_FILE = 'version.txt';

/** Keys subdirectory name */
export const KEYS_DIR = 'keys';

/** Wrangler configs subdirectory name */
export const WRANGLER_DIR = 'wrangler';

// =============================================================================
// Path Resolution Functions
// =============================================================================

/**
 * Get key file paths for a given keys directory
 */
function getKeyFilePaths(keysDir: string): KeyFilePaths {
  return {
    privateKey: join(keysDir, 'private.pem'),
    publicKey: join(keysDir, 'public.jwk.json'),
    rpTokenEncryptionKey: join(keysDir, 'rp_token_encryption_key.txt'),
    adminApiSecret: join(keysDir, 'admin_api_secret.txt'),
    keyManagerSecret: join(keysDir, 'key_manager_secret.txt'),
    setupToken: join(keysDir, 'setup_token.txt'),
    metadata: join(keysDir, 'metadata.json'),
    emailFrom: join(keysDir, 'email_from.txt'),
    resendApiKey: join(keysDir, 'resend_api_key.txt'),
  };
}

/**
 * Get paths for new directory structure (.authrim/{env}/)
 */
export function getEnvironmentPaths(config: PathConfig): EnvironmentPaths {
  const { baseDir, env } = config;
  const root = join(baseDir, AUTHRIM_DIR, env);
  const keysDir = join(root, KEYS_DIR);
  const wranglerDir = join(root, WRANGLER_DIR);

  return {
    root,
    config: join(root, CONFIG_FILE),
    lock: join(root, LOCK_FILE),
    version: join(root, VERSION_FILE),
    keys: keysDir,
    wrangler: wranglerDir,
    keyFiles: getKeyFilePaths(keysDir),
  };
}

/**
 * Get paths for legacy structure (flat files)
 */
export function getLegacyPaths(baseDir: string, env: string): LegacyPaths {
  const keysDir = join(baseDir, LEGACY_KEYS_DIR, env);

  return {
    config: join(baseDir, LEGACY_CONFIG_FILE),
    lock: join(baseDir, LEGACY_LOCK_FILE),
    keys: keysDir,
    keyFiles: getKeyFilePaths(keysDir),
  };
}

/**
 * Get the .authrim root directory path
 */
export function getAuthrimRoot(baseDir: string): string {
  return join(baseDir, AUTHRIM_DIR);
}

// =============================================================================
// Structure Detection
// =============================================================================

/**
 * Detect which structure is in use
 *
 * Returns:
 * - { type: 'new', envs: [...] } if .authrim/ structure exists with environments
 * - { type: 'legacy', envs: [], legacyEnv: 'name' } if legacy files exist
 * - { type: 'none', envs: [] } if no configuration exists
 */
export function detectStructure(baseDir: string): StructureInfo {
  const authrimDir = join(baseDir, AUTHRIM_DIR);
  const legacyConfig = join(baseDir, LEGACY_CONFIG_FILE);
  const legacyLock = join(baseDir, LEGACY_LOCK_FILE);
  const legacyKeys = join(baseDir, LEGACY_KEYS_DIR);

  // Check for new structure first
  if (existsSync(authrimDir)) {
    try {
      const entries = readdirSync(authrimDir, { withFileTypes: true });
      const envs = entries
        .filter((d) => d.isDirectory())
        .filter((d) => {
          // Verify it's a valid environment directory (has config.json or keys/)
          const envPath = join(authrimDir, d.name);
          return existsSync(join(envPath, CONFIG_FILE)) || existsSync(join(envPath, KEYS_DIR));
        })
        .map((d) => d.name);

      if (envs.length > 0) {
        return { type: 'new', envs };
      }
    } catch {
      // Ignore errors reading directory
    }
  }

  // Check for legacy structure
  if (existsSync(legacyConfig) || existsSync(legacyLock)) {
    let legacyEnv: string | undefined;

    // Try to determine env from config file
    if (existsSync(legacyConfig)) {
      try {
        const config = JSON.parse(readFileSync(legacyConfig, 'utf-8'));
        legacyEnv = config.environment?.prefix;
      } catch {
        // Ignore parse errors
      }
    }

    // Try to determine env from lock file if not found in config
    if (!legacyEnv && existsSync(legacyLock)) {
      try {
        const lock = JSON.parse(readFileSync(legacyLock, 'utf-8'));
        legacyEnv = lock.env;
      } catch {
        // Ignore parse errors
      }
    }

    // Try to find env from .keys directory
    if (!legacyEnv && existsSync(legacyKeys)) {
      try {
        const entries = readdirSync(legacyKeys, { withFileTypes: true });
        const envDirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
        if (envDirs.length === 1) {
          legacyEnv = envDirs[0];
        }
      } catch {
        // Ignore errors
      }
    }

    return { type: 'legacy', envs: [], legacyEnv };
  }

  // Check if only .keys exists (partial legacy setup)
  if (existsSync(legacyKeys)) {
    try {
      const entries = readdirSync(legacyKeys, { withFileTypes: true });
      const envDirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
      if (envDirs.length > 0) {
        return { type: 'legacy', envs: [], legacyEnv: envDirs[0] };
      }
    } catch {
      // Ignore errors
    }
  }

  return { type: 'none', envs: [] };
}

/**
 * Check if migration from legacy to new structure is needed
 */
export function needsMigration(baseDir: string): boolean {
  const structure = detectStructure(baseDir);
  return structure.type === 'legacy';
}

/**
 * List all available environments
 *
 * For new structure: returns environments from .authrim/
 * For legacy structure: returns environment from .keys/
 * For mixed: returns all found environments
 */
export function listEnvironments(baseDir: string): string[] {
  const envs = new Set<string>();

  // Check new structure
  const authrimDir = join(baseDir, AUTHRIM_DIR);
  if (existsSync(authrimDir)) {
    try {
      const entries = readdirSync(authrimDir, { withFileTypes: true });
      entries
        .filter((d) => d.isDirectory())
        .filter((d) => {
          const envPath = join(authrimDir, d.name);
          return existsSync(join(envPath, CONFIG_FILE)) || existsSync(join(envPath, KEYS_DIR));
        })
        .forEach((d) => envs.add(d.name));
    } catch {
      // Ignore errors
    }
  }

  // Check legacy .keys structure
  const legacyKeys = join(baseDir, LEGACY_KEYS_DIR);
  if (existsSync(legacyKeys)) {
    try {
      const entries = readdirSync(legacyKeys, { withFileTypes: true });
      entries
        .filter((d) => d.isDirectory())
        .forEach((d) => envs.add(d.name));
    } catch {
      // Ignore errors
    }
  }

  return Array.from(envs).sort();
}

/**
 * Check if an environment exists (in either structure)
 */
export function environmentExists(baseDir: string, env: string): boolean {
  // Check new structure
  const newPaths = getEnvironmentPaths({ baseDir, env });
  if (existsSync(newPaths.root) && (existsSync(newPaths.config) || existsSync(newPaths.keys))) {
    return true;
  }

  // Check legacy structure
  const legacyPaths = getLegacyPaths(baseDir, env);
  if (existsSync(legacyPaths.keys)) {
    return true;
  }

  return false;
}

// =============================================================================
// Path Resolution with Structure Detection
// =============================================================================

export interface ResolvePathsOptions {
  baseDir: string;
  env: string;
  /** Force legacy structure */
  forceLegacy?: boolean;
  /** Force new structure */
  forceNew?: boolean;
}

export type ResolvedPaths =
  | { type: 'new'; paths: EnvironmentPaths }
  | { type: 'legacy'; paths: LegacyPaths };

/**
 * Resolve paths based on detected structure or explicit options
 *
 * Priority:
 * 1. If forceNew is true, use new structure
 * 2. If forceLegacy is true, use legacy structure
 * 3. If new structure exists for this env, use it
 * 4. If legacy structure exists, use it
 * 5. Default to new structure for new environments
 */
export function resolvePaths(options: ResolvePathsOptions): ResolvedPaths {
  const { baseDir, env, forceLegacy, forceNew } = options;

  // Explicit overrides
  if (forceNew) {
    return { type: 'new', paths: getEnvironmentPaths({ baseDir, env }) };
  }
  if (forceLegacy) {
    return { type: 'legacy', paths: getLegacyPaths(baseDir, env) };
  }

  // Check if new structure exists for this environment
  const newPaths = getEnvironmentPaths({ baseDir, env });
  if (existsSync(newPaths.root)) {
    return { type: 'new', paths: newPaths };
  }

  // Check if legacy structure exists
  const legacyPaths = getLegacyPaths(baseDir, env);
  if (
    existsSync(legacyPaths.config) ||
    existsSync(legacyPaths.lock) ||
    existsSync(legacyPaths.keys)
  ) {
    return { type: 'legacy', paths: legacyPaths };
  }

  // Default to new structure for new environments
  return { type: 'new', paths: newPaths };
}

/**
 * Get the relative path from environment root to keys directory
 * Used for secretsPath in config
 */
export function getRelativeKeysPath(): string {
  return './keys/';
}

/**
 * Get the relative path for legacy secretsPath
 */
export function getLegacyRelativeKeysPath(env: string): string {
  return `./.keys/${env}/`;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Validate environment name
 */
export function validateEnvName(env: string): boolean {
  // Must start with lowercase letter, contain only lowercase letters, numbers, and hyphens
  return /^[a-z][a-z0-9-]*$/.test(env);
}

/**
 * Get absolute path, resolving relative paths against baseDir
 */
export function toAbsolutePath(baseDir: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return relativePath;
  }
  return resolve(baseDir, relativePath);
}
