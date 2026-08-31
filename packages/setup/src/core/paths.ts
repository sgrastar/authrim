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
import { basename, dirname, join, resolve } from 'node:path';

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
  /** Fresh-provisioning journal: .authrim/{env}/provisioning-intent.json */
  provisioningIntent: string;
  /** Email secrets staged until the atomic key bundle is published. */
  pendingEmailSecrets: string;
  /** One-use Control bootstrap credential retained only until cutover reaches ready. */
  pendingControlBootstrap: string;
  /** Durable exact-ID checkpoint used while revoking setup-managed Control tokens on delete. */
  controlTokenCleanup: string;
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
  piiEncryptionKey: string;
  objectEncryptionRootKey: string;
  otpHmacSecret: string;
  loggingCursorHmacSecret: string;
  lookupHmacKeySlotA: string;
  pluginEncryptionKey: string;
  pluginMutationHmacKey: string;
  agentElevationEncryptionKey: string;
  tenantRuntimeRegistrySigningPrivateJwk: string;
  tenantRuntimeRegistryVerifyingPublicJwks: string;
  tenantRuntimeRegistrySigningKeyId: string;
  smokeRpcSigningJwkSlotA: string;
  smokeRpcSigningJwkSlotB: string;
  controlSmokeVerifyingPublicJwks: string;
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

const LEGACY_CONFIG_PATTERN = /^authrim(?:-([a-z][a-z0-9-]*))?-config\.json$/;
const LEGACY_LOCK_PATTERN = /^authrim(?:-([a-z][a-z0-9-]*))?-lock\.json$/;

/** Legacy keys directory */
export const LEGACY_KEYS_DIR = '.keys';

/** New structure config file name */
export const CONFIG_FILE = 'config.json';

/** New structure lock file name */
export const LOCK_FILE = 'lock.json';

/** Durable journal for an interrupted fresh-environment provisioning attempt. */
export const PROVISIONING_INTENT_FILE = 'provisioning-intent.json';

/** Durable email-secret staging artifact used only during fresh provisioning. */
export const PENDING_EMAIL_SECRETS_FILE = 'pending-email-secrets.json';

/** Durable private recovery artifact for an interrupted Control token cutover. */
export const PENDING_CONTROL_BOOTSTRAP_FILE = 'pending-control-bootstrap.json';

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

export function getLegacyConfigFileName(env?: string): string {
  return env ? `authrim-${env}-config.json` : LEGACY_CONFIG_FILE;
}

export function getLegacyLockFileName(env?: string): string {
  return env ? `authrim-${env}-lock.json` : LEGACY_LOCK_FILE;
}

function getExistingLegacyFilePath(baseDir: string, candidates: string[]): string | undefined {
  const existingCandidate = candidates.find((candidate) => existsSync(join(baseDir, candidate)));
  return existingCandidate ? join(baseDir, existingCandidate) : undefined;
}

export function getLegacyConfigCandidates(baseDir: string, env?: string): string[] {
  const candidates = env
    ? [getLegacyConfigFileName(env), LEGACY_CONFIG_FILE]
    : [LEGACY_CONFIG_FILE];
  return candidates.map((candidate) => join(baseDir, candidate));
}

export function getLegacyLockCandidates(baseDir: string, env?: string): string[] {
  const candidates = env ? [getLegacyLockFileName(env), LEGACY_LOCK_FILE] : [LEGACY_LOCK_FILE];
  return candidates.map((candidate) => join(baseDir, candidate));
}

export function findLegacyConfigPath(baseDir: string, env?: string): string {
  const candidates = env
    ? [getLegacyConfigFileName(env), LEGACY_CONFIG_FILE]
    : [LEGACY_CONFIG_FILE];
  return getExistingLegacyFilePath(baseDir, candidates) || join(baseDir, candidates[0]);
}

export function findLegacyLockPath(baseDir: string, env?: string): string {
  const candidates = env ? [getLegacyLockFileName(env), LEGACY_LOCK_FILE] : [LEGACY_LOCK_FILE];
  return getExistingLegacyFilePath(baseDir, candidates) || join(baseDir, candidates[0]);
}

function listLegacyConfigPaths(baseDir: string): string[] {
  try {
    return readdirSync(baseDir)
      .filter((entry) => LEGACY_CONFIG_PATTERN.test(entry))
      .map((entry) => join(baseDir, entry))
      .sort();
  } catch {
    return [];
  }
}

function listLegacyLockPaths(baseDir: string): string[] {
  try {
    return readdirSync(baseDir)
      .filter((entry) => LEGACY_LOCK_PATTERN.test(entry))
      .map((entry) => join(baseDir, entry))
      .sort();
  } catch {
    return [];
  }
}

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
    piiEncryptionKey: join(keysDir, 'pii_encryption_key.txt'),
    objectEncryptionRootKey: join(keysDir, 'object_encryption_root_key.txt'),
    otpHmacSecret: join(keysDir, 'otp_hmac_secret.txt'),
    loggingCursorHmacSecret: join(keysDir, 'logging_cursor_hmac_secret.txt'),
    lookupHmacKeySlotA: join(keysDir, 'lookup_hmac_key_slot_a.txt'),
    pluginEncryptionKey: join(keysDir, 'plugin_encryption_key.txt'),
    pluginMutationHmacKey: join(keysDir, 'plugin_mutation_hmac_key.txt'),
    agentElevationEncryptionKey: join(keysDir, 'agent_elevation_encryption_key.txt'),
    tenantRuntimeRegistrySigningPrivateJwk: join(
      keysDir,
      'tenant_runtime_registry_signing_private.jwk.json'
    ),
    tenantRuntimeRegistryVerifyingPublicJwks: join(
      keysDir,
      'tenant_runtime_registry_verify.jwks.json'
    ),
    tenantRuntimeRegistrySigningKeyId: join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
    smokeRpcSigningJwkSlotA: join(keysDir, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
    smokeRpcSigningJwkSlotB: join(keysDir, 'smoke_rpc_signing_jwk_slot_b.private.jwk.json'),
    controlSmokeVerifyingPublicJwks: join(keysDir, 'control_smoke_verify.jwks.json'),
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
    provisioningIntent: join(root, PROVISIONING_INTENT_FILE),
    pendingEmailSecrets: join(root, PENDING_EMAIL_SECRETS_FILE),
    pendingControlBootstrap: join(root, PENDING_CONTROL_BOOTSTRAP_FILE),
    controlTokenCleanup: join(root, 'control-token-cleanup.json'),
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
    config: findLegacyConfigPath(baseDir, env),
    lock: findLegacyLockPath(baseDir, env),
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
  if (listLegacyConfigPaths(startDir).length > 0 || listLegacyLockPaths(startDir).length > 0) {
    return startDir;
  }

  // Check legacy structure in subdirectories
  for (const subdir of COMMON_SUBDIRS) {
    const subdirPath = join(startDir, subdir);
    if (
      listLegacyConfigPaths(subdirPath).length > 0 ||
      listLegacyLockPaths(subdirPath).length > 0
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
  const legacyConfigs = listLegacyConfigPaths(baseDir);
  const legacyLocks = listLegacyLockPaths(baseDir);
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
  if (legacyConfigs.length > 0 || legacyLocks.length > 0) {
    let legacyEnv: string | undefined;

    // Try to determine env from config file
    if (legacyConfigs.length > 0) {
      try {
        const config = JSON.parse(readFileSync(legacyConfigs[0], 'utf-8'));
        legacyEnv = config.environment?.prefix;
      } catch {
        // Ignore parse errors
      }
    }

    if (!legacyEnv && legacyConfigs.length > 0) {
      const match = legacyConfigs[0].match(LEGACY_CONFIG_PATTERN);
      legacyEnv = match?.[1];
    }

    // Try to determine env from lock file if not found in config
    if (!legacyEnv && legacyLocks.length > 0) {
      try {
        const lock = JSON.parse(readFileSync(legacyLocks[0], 'utf-8'));
        legacyEnv = lock.env;
      } catch {
        // Ignore parse errors
      }
    }

    if (!legacyEnv && legacyLocks.length > 0) {
      const match = legacyLocks[0].match(LEGACY_LOCK_PATTERN);
      legacyEnv = match?.[1];
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

function hasMatchingEnvironmentConfig(envPath: string, env: string): boolean {
  const configPath = join(envPath, CONFIG_FILE);
  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.environment?.prefix === env;
  } catch {
    return false;
  }
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
          return (
            hasMatchingEnvironmentConfig(envPath, d.name) ||
            existsSync(join(envPath, LOCK_FILE)) ||
            existsSync(join(envPath, KEYS_DIR))
          );
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

  for (const configPath of listLegacyConfigPaths(baseDir)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const env = config.environment?.prefix;
      if (env) {
        envs.add(env);
        continue;
      }
    } catch {
      // Ignore parse errors and fall back to filename parsing below.
    }

    const fileName = basename(configPath);
    const match = fileName.match(LEGACY_CONFIG_PATTERN);
    if (match?.[1]) {
      envs.add(match[1]);
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
 * Resolve paths for the fresh-install environment structure.
 * Legacy flat-file layouts are deliberately not auto-detected or reinterpreted.
 */
export function resolvePaths(options: ResolvePathsOptions): ResolvedPaths {
  if (options.forceLegacy) throw new Error('legacy_environment_structure_not_supported');
  return {
    type: 'new',
    paths: getEnvironmentPaths({ baseDir: options.baseDir, env: options.env }),
  };
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

export function deriveExternalKeysBaseDirFromConfigPath(env: string, secretsPath: string): string {
  validateEnvForPath(env);
  if (!secretsPath.trim()) throw new Error('external_keys_config_path_required');
  const normalizedPath = resolve(secretsPath);
  const candidateBaseDir = dirname(dirname(normalizedPath));
  if (getExternalKeysDir(env, candidateBaseDir) !== normalizedPath) {
    throw new Error('external_keys_config_path_mismatch');
  }
  return candidateBaseDir;
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
