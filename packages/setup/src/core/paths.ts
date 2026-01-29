/**
 * Path Management Module
 *
 * Centralized path resolution for Authrim configuration files.
 * Supports legacy, internal, and external key storage structures.
 *
 * External Keys Structure (new default):
 *   CWD/
 *   ├── .authrim-keys/{env}/     <-- Keys stored outside source
 *   └── authrim/                  (source code)
 *       └── .authrim/{env}/
 *           ├── config.json
 *           ├── lock.json
 *           └── version.txt
 *
 * Internal Structure:
 *   project/
 *   └── .authrim/{env}/
 *       ├── config.json
 *       ├── lock.json
 *       ├── version.txt
 *       └── keys/
 *
 * Legacy Structure:
 *   project/
 *   ├── authrim-config.json
 *   ├── authrim-lock.json
 *   └── .keys/{env}/
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
  /** External keys base directory (usually process.cwd()) - keys stored at {keysBaseDir}/.authrim-keys/{env}/ */
  keysBaseDir?: string;
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
  /** UI environment variables file: .authrim/{env}/ui.env */
  uiEnv: string;
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

/** External keys directory name (at CWD level) */
export const AUTHRIM_KEYS_DIR = '.authrim-keys';

/** Wrangler configs subdirectory name */
export const WRANGLER_DIR = 'wrangler';

/** UI environment file name */
export const UI_ENV_FILE = 'ui.env';

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
 *
 * If keysBaseDir is provided, keys paths resolve to {keysBaseDir}/.authrim-keys/{env}/
 * instead of {baseDir}/.authrim/{env}/keys/
 */
export function getEnvironmentPaths(config: PathConfig): EnvironmentPaths {
  const { baseDir, env, keysBaseDir } = config;
  const root = join(baseDir, AUTHRIM_DIR, env);
  const keysDir = keysBaseDir ? join(keysBaseDir, AUTHRIM_KEYS_DIR, env) : join(root, KEYS_DIR);
  const wranglerDir = join(root, WRANGLER_DIR);

  return {
    root,
    config: join(root, CONFIG_FILE),
    lock: join(root, LOCK_FILE),
    version: join(root, VERSION_FILE),
    keys: keysDir,
    wrangler: wranglerDir,
    uiEnv: join(root, UI_ENV_FILE),
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
 * Common subdirectory names where authrim project might be located
 */
const COMMON_SUBDIRS = ['authrim', 'authrim-source', 'src'];

/**
 * Find the actual base directory containing .authrim/
 * Searches current directory and common subdirectories
 *
 * @param startDir - Starting directory to search from
 * @returns The directory containing .authrim/, or startDir if not found
 */
export function findAuthrimBaseDir(startDir: string): string {
  // First, check if .authrim/ exists in startDir
  if (existsSync(join(startDir, AUTHRIM_DIR))) {
    return startDir;
  }

  // Check common subdirectories
  for (const subdir of COMMON_SUBDIRS) {
    const subdirPath = join(startDir, subdir);
    if (existsSync(join(subdirPath, AUTHRIM_DIR))) {
      return subdirPath;
    }
  }

  // Check for legacy structure in startDir
  if (
    existsSync(join(startDir, LEGACY_CONFIG_FILE)) ||
    existsSync(join(startDir, LEGACY_LOCK_FILE))
  ) {
    return startDir;
  }

  // Check legacy structure in subdirectories
  for (const subdir of COMMON_SUBDIRS) {
    const subdirPath = join(startDir, subdir);
    if (
      existsSync(join(subdirPath, LEGACY_CONFIG_FILE)) ||
      existsSync(join(subdirPath, LEGACY_LOCK_FILE))
    ) {
      return subdirPath;
    }
  }

  // Return original if nothing found
  return startDir;
}

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
 * For external keys: returns environments from .authrim-keys/
 * For mixed: returns all found environments
 *
 * @param baseDir - Source directory containing .authrim/
 * @param keysBaseDir - Optional base directory for external keys (checks .authrim-keys/)
 */
export function listEnvironments(baseDir: string, keysBaseDir?: string): string[] {
  const envs = new Set<string>();

  // Check external keys structure: {keysBaseDir}/.authrim-keys/
  if (keysBaseDir) {
    const externalKeysDir = join(keysBaseDir, AUTHRIM_KEYS_DIR);
    if (existsSync(externalKeysDir)) {
      try {
        const entries = readdirSync(externalKeysDir, { withFileTypes: true });
        entries.filter((d) => d.isDirectory()).forEach((d) => envs.add(d.name));
      } catch {
        // Ignore errors
      }
    }
  }

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
      entries.filter((d) => d.isDirectory()).forEach((d) => envs.add(d.name));
    } catch {
      // Ignore errors
    }
  }

  return Array.from(envs).sort();
}

/**
 * Check if an environment exists (in any structure)
 *
 * @param baseDir - Source directory
 * @param env - Environment name
 * @param keysBaseDir - Optional base directory for external keys
 */
export function environmentExists(baseDir: string, env: string, keysBaseDir?: string): boolean {
  // Check external keys structure
  if (keysBaseDir) {
    const externalDir = getExternalKeysDir(env, keysBaseDir);
    if (existsSync(externalDir)) {
      return true;
    }
  }

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
// External Keys Directory Functions
// =============================================================================

/**
 * Get the external keys directory path for an environment
 *
 * @param env - Environment name (must be a valid env name)
 * @param keysBaseDir - Base directory for external keys (usually process.cwd())
 * @returns Path to the external keys directory: {keysBaseDir}/.authrim-keys/{env}/
 * @throws Error if env contains path traversal or invalid characters
 */
export function getExternalKeysDir(env: string, keysBaseDir: string): string {
  validateEnvForPath(env);
  return join(keysBaseDir, AUTHRIM_KEYS_DIR, env);
}

/**
 * Get the absolute path for secretsPath in config.json when using external keys
 *
 * @param env - Environment name (must be a valid env name)
 * @param keysBaseDir - Base directory for external keys (usually process.cwd())
 * @returns Absolute path to the external keys directory
 * @throws Error if env contains path traversal or invalid characters
 */
export function getExternalKeysPathForConfig(env: string, keysBaseDir: string): string {
  validateEnvForPath(env);
  return resolve(keysBaseDir, AUTHRIM_KEYS_DIR, env) + '/';
}

export type KeysLocation = 'external' | 'internal' | 'legacy';

export interface FindKeysResult {
  /** Resolved path to the keys directory */
  path: string;
  /** Where the keys were found */
  location: KeysLocation;
}

export interface FindKeysOptions {
  /** Environment name */
  env: string;
  /** Source directory containing .authrim/ (usually the authrim project root) */
  sourceDir: string;
  /** Base directory for external keys (usually process.cwd()) */
  keysBaseDir?: string;
}

/**
 * Find keys directory with 3-tier fallback:
 * 1. External: {keysBaseDir}/.authrim-keys/{env}/
 * 2. Internal: {sourceDir}/.authrim/{env}/keys/
 * 3. Legacy: {sourceDir}/.keys/{env}/
 *
 * @returns Found keys directory info, or null if not found anywhere
 */
export function findKeysDirectory(options: FindKeysOptions): FindKeysResult | null {
  const { env, sourceDir, keysBaseDir } = options;

  // Security: Validate env to prevent path traversal
  validateEnvForPath(env);

  // 1. External: {keysBaseDir}/.authrim-keys/{env}/
  if (keysBaseDir) {
    const externalDir = getExternalKeysDir(env, keysBaseDir);
    if (existsSync(externalDir)) {
      return { path: externalDir, location: 'external' };
    }
  }

  // 2. Internal: {sourceDir}/.authrim/{env}/keys/
  const internalDir = join(sourceDir, AUTHRIM_DIR, env, KEYS_DIR);
  if (existsSync(internalDir)) {
    return { path: internalDir, location: 'internal' };
  }

  // 3. Legacy: {sourceDir}/.keys/{env}/
  const legacyDir = join(sourceDir, LEGACY_KEYS_DIR, env);
  if (existsSync(legacyDir)) {
    return { path: legacyDir, location: 'legacy' };
  }

  return null;
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
 * Security: Validate env string before using it in path construction.
 * Rejects path traversal, null bytes, and invalid characters.
 *
 * @throws Error if env is not safe for use in file paths
 */
function validateEnvForPath(env: string): void {
  if (!env || typeof env !== 'string') {
    throw new Error('Invalid environment name: must be a non-empty string');
  }
  if (env.includes('..') || env.includes('/') || env.includes('\\') || env.includes('\0')) {
    throw new Error('Invalid environment name: path traversal characters not allowed');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    throw new Error(
      'Invalid environment name: must be lowercase alphanumeric with hyphens, starting with a letter'
    );
  }
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
