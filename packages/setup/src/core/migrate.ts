/**
 * Migration Module
 *
 * Handles migration from legacy flat file structure to new unified
 * .authrim/{env}/ directory structure.
 *
 * Legacy structure:
 *   project/
 *   ├── authrim-config.json
 *   ├── authrim-lock.json
 *   └── .keys/{env}/
 *
 * New structure:
 *   project/
 *   └── .authrim/
 *       └── {env}/
 *           ├── config.json
 *           ├── lock.json
 *           ├── version.txt
 *           └── keys/
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  LEGACY_CONFIG_FILE,
  LEGACY_LOCK_FILE,
  LEGACY_KEYS_DIR,
  getEnvironmentPaths,
  getExternalKeysDir,
  findKeysDirectory,
  getLegacyConfigFileName,
  getLegacyLockFileName,
  detectStructure,
  listEnvironments,
  validateEnvName,
} from './paths.js';

import { AuthrimConfigSchema, type AuthrimConfig } from './config.js';
import {
  AuthrimLockSchema,
  acquireEnvironmentOperationForEnvironment,
  acquireEnvironmentOperationLock,
  type AuthrimLock,
} from './lock.js';
import { saveMasterWranglerConfigs } from './wrangler-sync.js';
import type { ResourceIds } from './wrangler.js';
import {
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
} from './environment-operation-policy.js';

// File permission constants
const SENSITIVE_FILE_MODE = 0o600; // Owner read/write only
const DIRECTORY_MODE = 0o700; // Owner read/write/execute only

// Get package version
const require = createRequire(import.meta.url);
function getVersion(): string {
  try {
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

// =============================================================================
// Types
// =============================================================================

export interface MigrationOptions {
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /** Specific environment to migrate (if not specified, migrates all detected) */
  env?: string;
  /** Dry run - don't actually modify files */
  dryRun?: boolean;
  /** Skip backup creation */
  noBackup?: boolean;
  /** Delete legacy files after successful migration */
  deleteLegacy?: boolean;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

export interface MigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** Environments that were migrated */
  migratedEnvs: string[];
  /** Errors encountered */
  errors: string[];
  /** Path to backup directory (if created) */
  backupPath?: string;
  /** Files that were migrated */
  migratedFiles: string[];
  /** Files that would be migrated (dry run) */
  plannedFiles?: string[];
}

export interface BackupResult {
  /** Whether backup succeeded */
  success: boolean;
  /** Path to backup directory */
  backupPath: string;
  /** Error message if failed */
  error?: string;
  /** Files that were backed up */
  files: string[];
}

export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Issues found */
  issues: string[];
}

export async function migrateToNewStructureLocked(
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  if (options.dryRun) return migrateToNewStructure(options);

  const baseDir = resolve(options.baseDir ?? process.cwd());
  const environments = (options.env ? [options.env] : getEnvironmentsToMigrate(baseDir)).sort();
  const operationLocks: Array<{ release: () => Promise<void> }> = [];
  try {
    for (const env of environments) {
      const operation = await acquireEnvironmentOperationForEnvironment({
        baseDir,
        env,
        operation: 'structure-migrate',
      });
      operationLocks.push(operation);
      const destinationLockPath = getEnvironmentPaths({ baseDir, env }).lock;
      if (operation.lockFilePath !== destinationLockPath) {
        operationLocks.push(
          await acquireEnvironmentOperationLock(
            destinationLockPath,
            'structure-migrate-destination'
          )
        );
      }
      const decision = evaluateEnvironmentOperation({
        operation: 'structure_migration',
        lock: operation.lock,
      });
      if (!decision.allowed) {
        throw new Error(environmentOperationBlockMessage(decision));
      }
    }
    return await migrateToNewStructure({ ...options, baseDir });
  } finally {
    for (const operationLock of operationLocks.reverse()) {
      await operationLock.release();
    }
  }
}

// =============================================================================
// Migration Detection
// =============================================================================

/**
 * Check if migration from legacy structure is needed
 */
export function needsMigration(baseDir: string = process.cwd()): boolean {
  return getEnvironmentsToMigrate(baseDir).length > 0;
}

const LEGACY_METADATA_PATTERN = /^authrim(?:-([a-z][a-z0-9-]*))?-(config|lock)\.json$/u;

function readLegacyMetadataEnvironment(path: string, kind: 'config' | 'lock'): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as {
      environment?: { prefix?: unknown };
      env?: unknown;
    };
    const environment = kind === 'config' ? value.environment?.prefix : value.env;
    return typeof environment === 'string' && validateEnvName(environment)
      ? environment
      : undefined;
  } catch {
    return undefined;
  }
}

function listLegacyMetadataFiles(baseDir: string): string[] {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter(
        (entry: { isFile: () => boolean; name: string }) =>
          entry.isFile() && LEGACY_METADATA_PATTERN.test(entry.name)
      )
      .map((entry: { name: string }) => join(baseDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function resolveLegacyMetadataPath(
  baseDir: string,
  env: string,
  kind: 'config' | 'lock'
): string | undefined {
  const named = join(
    baseDir,
    kind === 'config' ? getLegacyConfigFileName(env) : getLegacyLockFileName(env)
  );
  const generic = join(baseDir, kind === 'config' ? LEGACY_CONFIG_FILE : LEGACY_LOCK_FILE);
  for (const candidate of [named, generic]) {
    if (!existsSync(candidate)) continue;
    const embeddedEnvironment = readLegacyMetadataEnvironment(candidate, kind);
    if (embeddedEnvironment === env) return candidate;
    const filenameEnvironment = basename(candidate).match(LEGACY_METADATA_PATTERN)?.[1];
    if (!embeddedEnvironment && filenameEnvironment === env) return candidate;
  }
  return undefined;
}

/**
 * Get list of environments that need migration
 */
export function getEnvironmentsToMigrate(baseDir: string = process.cwd()): string[] {
  const legacyKeysDir = join(baseDir, LEGACY_KEYS_DIR);
  const environments = new Set<string>();

  for (const path of listLegacyMetadataFiles(baseDir)) {
    const match = basename(path).match(LEGACY_METADATA_PATTERN);
    if (!match) continue;
    const kind = match[2] as 'config' | 'lock';
    const embeddedEnvironment = readLegacyMetadataEnvironment(path, kind);
    const environment = embeddedEnvironment ?? match[1];
    if (environment && validateEnvName(environment)) environments.add(environment);
  }

  // Also check for environments in .keys directory
  if (existsSync(legacyKeysDir)) {
    try {
      const entries = readdirSync(legacyKeysDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && validateEnvName(entry.name)) {
          environments.add(entry.name);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return [...environments].sort();
}

// =============================================================================
// Backup
// =============================================================================

/**
 * Create a backup of legacy files before migration
 */
export async function createBackup(
  baseDir: string = process.cwd(),
  onProgress?: (msg: string) => void
): Promise<BackupResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = join(baseDir, `.authrim-backup-${timestamp}`);

  const files: string[] = [];

  try {
    onProgress?.(`Creating backup at ${backupDir}`);

    // Create backup directory
    await mkdir(backupDir, { recursive: true });

    for (const legacyMetadataPath of listLegacyMetadataFiles(baseDir)) {
      const fileName = basename(legacyMetadataPath);
      const destPath = join(backupDir, fileName);
      await copyFile(legacyMetadataPath, destPath);
      files.push(fileName);
      onProgress?.(`  Backed up ${fileName}`);
    }

    // Backup .keys directory
    const legacyKeysDir = join(baseDir, LEGACY_KEYS_DIR);
    if (existsSync(legacyKeysDir)) {
      const backupKeysDir = join(backupDir, LEGACY_KEYS_DIR);
      await copyDirectoryRecursive(legacyKeysDir, backupKeysDir, files, LEGACY_KEYS_DIR);
      onProgress?.(`  Backed up ${LEGACY_KEYS_DIR}/`);
    }

    onProgress?.(`Backup complete: ${files.length} files`);

    return {
      success: true,
      backupPath: backupDir,
      files,
    };
  } catch (error) {
    return {
      success: false,
      backupPath: backupDir,
      error: error instanceof Error ? error.message : String(error),
      files,
    };
  }
}

/**
 * Check if a file is sensitive (keys, secrets)
 */
function isSensitiveFile(filename: string): boolean {
  return (
    filename.endsWith('.pem') ||
    filename.endsWith('.key') ||
    filename.includes('secret') ||
    filename.includes('private') ||
    filename.includes('token')
  );
}

/**
 * Recursively copy a directory with security checks
 */
async function copyDirectoryRecursive(
  src: string,
  dest: string,
  files: string[],
  relativePath: string
): Promise<void> {
  await mkdir(dest, { recursive: true, mode: DIRECTORY_MODE });

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    const relPath = join(relativePath, entry.name);

    // Security: Skip symbolic links to prevent symlink attacks
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath, files, relPath);
    } else {
      await copyFile(srcPath, destPath);
      files.push(relPath);

      // Security: Set restrictive permissions on sensitive files
      if (isSensitiveFile(entry.name)) {
        await chmod(destPath, SENSITIVE_FILE_MODE);
      }
    }
  }
}

// =============================================================================
// Migration
// =============================================================================

/**
 * Migrate from legacy structure to new unified structure
 */
export async function migrateToNewStructure(
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  const {
    baseDir = process.cwd(),
    env,
    dryRun = false,
    noBackup = false,
    deleteLegacy = false,
    onProgress,
  } = options;

  const result: MigrationResult = {
    success: false,
    migratedEnvs: [],
    errors: [],
    migratedFiles: [],
  };

  const legacyEnvironments = getEnvironmentsToMigrate(baseDir);
  if (legacyEnvironments.length === 0) {
    const structure = detectStructure(baseDir);
    if (structure.type === 'new') {
      onProgress?.('Already using new directory structure');
      result.success = true;
      return result;
    }
    result.errors.push('No configuration files found to migrate');
    return result;
  }

  // Determine environments to migrate
  const environments = env ? [env] : legacyEnvironments;

  if (environments.length === 0) {
    result.errors.push('No environments detected for migration');
    return result;
  }

  onProgress?.(`Environments to migrate: ${environments.join(', ')}`);

  // Create backup (unless skipped or dry run)
  if (!noBackup && !dryRun) {
    onProgress?.('\nCreating backup...');
    const backupResult = await createBackup(baseDir, onProgress);

    if (!backupResult.success) {
      result.errors.push(`Backup failed: ${backupResult.error}`);
      return result;
    }

    result.backupPath = backupResult.backupPath;
  }

  // Migrate each environment
  for (const envName of environments) {
    onProgress?.(`\nMigrating environment: ${envName}`);

    try {
      const envResult = await migrateEnvironment(baseDir, envName, dryRun, onProgress);

      if (envResult.success) {
        result.migratedEnvs.push(envName);
        result.migratedFiles.push(...envResult.files);
      } else {
        result.errors.push(...envResult.errors);
      }
    } catch (error) {
      result.errors.push(
        `Failed to migrate ${envName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Delete legacy files if requested and migration succeeded
  if (deleteLegacy && !dryRun && result.migratedEnvs.length > 0 && result.errors.length === 0) {
    onProgress?.('\nCleaning up legacy files...');
    await deleteLegacyFiles(baseDir, result.migratedEnvs, onProgress);
  }

  result.success = result.errors.length === 0 && result.migratedEnvs.length > 0;

  return result;
}

/**
 * Migrate a single environment
 */
async function migrateEnvironment(
  baseDir: string,
  env: string,
  dryRun: boolean,
  onProgress?: (msg: string) => void
): Promise<{ success: boolean; files: string[]; errors: string[] }> {
  const files: string[] = [];
  const errors: string[] = [];

  // Security: Validate environment name to prevent path traversal
  if (!validateEnvName(env)) {
    errors.push(
      `Invalid environment name: ${env}. Must start with lowercase letter and contain only lowercase letters, numbers, and hyphens.`
    );
    return { success: false, files, errors };
  }

  const newPaths = getEnvironmentPaths({ baseDir, env });
  const legacyConfigPath = resolveLegacyMetadataPath(baseDir, env, 'config');
  const legacyLockPath = resolveLegacyMetadataPath(baseDir, env, 'lock');
  if (!legacyConfigPath || !legacyLockPath) {
    errors.push(`Legacy config/lock pair for environment ${env} was not found or did not match.`);
    return { success: false, files, errors };
  }

  // Create new directory structure with secure permissions
  if (!dryRun) {
    await mkdir(newPaths.root, { recursive: true, mode: DIRECTORY_MODE });
    await mkdir(newPaths.keys, { recursive: true, mode: DIRECTORY_MODE });
    onProgress?.(`  Created ${newPaths.root}`);
  } else {
    onProgress?.(`  Would create ${newPaths.root}`);
  }

  // Migrate config.json
  if (existsSync(legacyConfigPath)) {
    try {
      const content = await readFile(legacyConfigPath, 'utf-8');
      const rawConfig = JSON.parse(content) as Record<string, unknown>;
      const config = AuthrimConfigSchema.parse(rawConfig);
      if (config.environment?.prefix !== env) {
        throw new Error(`config environment is ${config.environment?.prefix ?? 'missing'}`);
      }

      // Update secretsPath to relative path within new structure
      const rawKeys =
        rawConfig.keys && typeof rawConfig.keys === 'object' && !Array.isArray(rawConfig.keys)
          ? (rawConfig.keys as Record<string, unknown>)
          : {};
      const migratedConfig = {
        ...rawConfig,
        keys: { ...rawKeys, secretsPath: './keys/' },
      };

      if (!dryRun) {
        await writeFile(newPaths.config, JSON.stringify(migratedConfig, null, 2));
        onProgress?.('  Migrated config.json');
      } else {
        onProgress?.('  Would migrate config.json');
      }
      files.push(newPaths.config);
    } catch (error) {
      errors.push(
        `Failed to migrate config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Migrate lock.json
  if (existsSync(legacyLockPath)) {
    try {
      const content = await readFile(legacyLockPath, 'utf-8');
      const rawLock = JSON.parse(content) as Record<string, unknown>;
      const lock = AuthrimLockSchema.parse(rawLock);
      if (lock.env !== env) throw new Error(`lock environment is ${lock.env ?? 'missing'}`);

      if (!dryRun) {
        await writeFile(newPaths.lock, JSON.stringify(rawLock, null, 2));
        onProgress?.('  Migrated lock.json');
      } else {
        onProgress?.('  Would migrate lock.json');
      }
      files.push(newPaths.lock);
    } catch (error) {
      errors.push(
        `Failed to migrate lock: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Migrate keys directory
  const legacyKeysDir = join(baseDir, LEGACY_KEYS_DIR, env);
  if (existsSync(legacyKeysDir)) {
    try {
      const keyFiles = await readdir(legacyKeysDir, { withFileTypes: true });
      let migratedCount = 0;

      for (const entry of keyFiles) {
        // Security: Skip symbolic links to prevent symlink attacks
        if (entry.isSymbolicLink() || entry.isDirectory()) {
          continue;
        }

        const srcPath = join(legacyKeysDir, entry.name);
        const destPath = join(newPaths.keys, entry.name);

        if (!dryRun) {
          await copyFile(srcPath, destPath);

          // Security: Set restrictive permissions on sensitive files
          if (isSensitiveFile(entry.name)) {
            await chmod(destPath, SENSITIVE_FILE_MODE);
          }
        }
        files.push(destPath);
        migratedCount++;
      }

      if (!dryRun) {
        onProgress?.(`  Migrated ${migratedCount} key files`);
      } else {
        onProgress?.(`  Would migrate ${migratedCount} key files`);
      }
    } catch (error) {
      errors.push(
        `Failed to migrate keys: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Create version.txt
  const version = getVersion();
  if (!dryRun) {
    await writeFile(newPaths.version, version);
    onProgress?.(`  Created version.txt (${version})`);
  } else {
    onProgress?.(`  Would create version.txt (${version})`);
  }
  files.push(newPaths.version);

  // Generate wrangler configs from migrated config and lock
  // This is needed because legacy structure has no wrangler/ directory
  if (existsSync(newPaths.config) && existsSync(newPaths.lock)) {
    try {
      const configContent = await readFile(newPaths.config, 'utf-8');
      const lockContent = await readFile(newPaths.lock, 'utf-8');
      const config = JSON.parse(configContent) as AuthrimConfig;
      const lock = JSON.parse(lockContent) as AuthrimLock;

      // Build ResourceIds from lock file
      // AuthrimLock has d1, kv, queues, r2 at the top level (not nested under resources)
      const resourceIds: ResourceIds = {
        d1: {},
        kv: {},
        queues: {},
        r2: {},
      };

      // Map D1 databases
      if (lock.d1) {
        for (const [binding, info] of Object.entries(lock.d1)) {
          resourceIds.d1[binding] = { id: info.id, name: info.name };
        }
      }

      // Map KV namespaces
      if (lock.kv) {
        for (const [binding, info] of Object.entries(lock.kv)) {
          resourceIds.kv[binding] = { id: info.id, name: info.name };
        }
      }

      // Map Queues (if present)
      if (lock.queues) {
        for (const [binding, info] of Object.entries(lock.queues)) {
          if (resourceIds.queues) {
            resourceIds.queues[binding] = { id: info.id, name: info.name };
          }
        }
      }

      // Map R2 buckets (if present)
      if (lock.r2) {
        for (const [binding, info] of Object.entries(lock.r2)) {
          if (resourceIds.r2) {
            resourceIds.r2[binding] = { name: info.name };
          }
        }
      }

      // Generate and save wrangler configs
      if (!dryRun) {
        onProgress?.('  Generating wrangler configs...');
        const wranglerResult = await saveMasterWranglerConfigs(config, resourceIds, {
          baseDir,
          env,
          dryRun: false,
          onProgress,
          validateCapabilities: false,
        });

        if (wranglerResult.success) {
          files.push(...wranglerResult.files);
          onProgress?.(`  Generated ${wranglerResult.files.length} wrangler configs`);
        } else {
          for (const err of wranglerResult.errors) {
            errors.push(`Wrangler generation: ${err}`);
          }
        }
      } else {
        onProgress?.('  Would generate wrangler configs');
      }
    } catch (error) {
      errors.push(
        `Wrangler generation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!dryRun && errors.length === 0) {
    const validation = await validateMigration(baseDir, env);
    if (!validation.valid) {
      errors.push(...validation.issues.map((issue) => `Post-migration validation: ${issue}`));
    }
  }

  return {
    success: errors.length === 0,
    files,
    errors,
  };
}

/**
 * Delete legacy files after successful migration
 */
async function deleteLegacyFiles(
  baseDir: string,
  environments: string[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const deletedMetadata = new Set<string>();
  for (const env of environments) {
    for (const kind of ['config', 'lock'] as const) {
      const path = resolveLegacyMetadataPath(baseDir, env, kind);
      if (!path || deletedMetadata.has(path)) continue;
      await rm(path);
      deletedMetadata.add(path);
      onProgress?.(`  Deleted ${basename(path)}`);
    }
    const legacyKeysDir = join(baseDir, LEGACY_KEYS_DIR, env);
    if (existsSync(legacyKeysDir)) {
      await rm(legacyKeysDir, { recursive: true });
      onProgress?.(`  Deleted ${LEGACY_KEYS_DIR}/${env}/`);
    }
  }
  const legacyKeysRoot = join(baseDir, LEGACY_KEYS_DIR);
  if (existsSync(legacyKeysRoot) && (await readdir(legacyKeysRoot)).length === 0) {
    await rm(legacyKeysRoot);
  }
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a migrated environment
 */
export async function validateMigration(baseDir: string, env: string): Promise<ValidationResult> {
  const issues: string[] = [];
  const paths = getEnvironmentPaths({ baseDir, env });

  // Check directory exists
  if (!existsSync(paths.root)) {
    issues.push(`Environment directory not found: ${paths.root}`);
    return { valid: false, issues };
  }

  // Check config.json
  if (!existsSync(paths.config)) {
    issues.push('config.json not found');
  } else {
    try {
      const content = await readFile(paths.config, 'utf-8');
      const data = JSON.parse(content);
      const result = AuthrimConfigSchema.safeParse(data);
      if (!result.success) {
        issues.push(`config.json validation failed: ${result.error.message}`);
      }
    } catch (error) {
      issues.push(
        `config.json read error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Check lock.json
  if (!existsSync(paths.lock)) {
    issues.push('lock.json not found');
  } else {
    try {
      const content = await readFile(paths.lock, 'utf-8');
      const data = JSON.parse(content);
      const result = AuthrimLockSchema.safeParse(data);
      if (!result.success) {
        issues.push(`lock.json validation failed: ${result.error.message}`);
      }
    } catch (error) {
      issues.push(
        `lock.json read error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Check version.txt
  if (!existsSync(paths.version)) {
    issues.push('version.txt not found');
  }

  // Check keys directory
  if (!existsSync(paths.keys)) {
    issues.push('keys/ directory not found');
  } else {
    // Check for essential key files
    const essentialKeys = ['private.pem', 'public.jwk.json'];
    for (const keyFile of essentialKeys) {
      if (!existsSync(join(paths.keys, keyFile))) {
        issues.push(`Key file not found: ${keyFile}`);
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Get migration status summary
 */
export function getMigrationStatus(baseDir: string = process.cwd()): {
  needsMigration: boolean;
  currentStructure: 'new' | 'legacy' | 'none';
  environments: string[];
  legacyFiles: string[];
} {
  const structure = detectStructure(baseDir);
  const environmentsToMigrate = getEnvironmentsToMigrate(baseDir);

  const legacyFiles: string[] = [];
  legacyFiles.push(...listLegacyMetadataFiles(baseDir).map((path) => basename(path)));
  if (existsSync(join(baseDir, LEGACY_KEYS_DIR))) {
    legacyFiles.push(LEGACY_KEYS_DIR + '/');
  }

  const environments =
    environmentsToMigrate.length > 0 ? environmentsToMigrate : listEnvironments(baseDir);

  return {
    needsMigration: environmentsToMigrate.length > 0,
    currentStructure: environmentsToMigrate.length > 0 ? 'legacy' : structure.type,
    environments,
    legacyFiles,
  };
}

// =============================================================================
// External Keys Migration
// =============================================================================

export interface MigrateKeysToExternalOptions {
  /** Source directory containing .authrim/ or .keys/ */
  sourceDir: string;
  /** Target base directory for external keys (keys go to {keysBaseDir}/.authrim-keys/{env}/) */
  keysBaseDir: string;
  /** Environment name */
  env: string;
  /** Dry run - don't actually copy files */
  dryRun?: boolean;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

export interface MigrateKeysToExternalResult {
  success: boolean;
  /** Source location where keys were found */
  sourceLocation?: 'internal' | 'legacy';
  /** Source path */
  sourcePath?: string;
  /** Destination path */
  destPath?: string;
  /** Files copied */
  files: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Migrate keys from internal/legacy location to external .authrim-keys/{env}/ directory
 *
 * Copies key files from:
 * - {sourceDir}/.authrim/{env}/keys/ (internal), or
 * - {sourceDir}/.keys/{env}/ (legacy)
 *
 * To: {keysBaseDir}/.authrim-keys/{env}/
 *
 * After copy, updates config.json with new secretsPath and storageType.
 */
export async function migrateKeysToExternal(
  options: MigrateKeysToExternalOptions
): Promise<MigrateKeysToExternalResult> {
  const { sourceDir, keysBaseDir, env, dryRun = false, onProgress } = options;

  // Security: Validate environment name
  if (!validateEnvName(env)) {
    return {
      success: false,
      files: [],
      error: `Invalid environment name: ${env}`,
    };
  }

  // Security: Validate keysBaseDir to prevent path traversal
  if (keysBaseDir.includes('\0')) {
    return {
      success: false,
      files: [],
      error: 'Invalid keysBaseDir: null bytes not allowed',
    };
  }

  // Find existing keys
  const found = findKeysDirectory({ env, sourceDir });
  if (!found) {
    return {
      success: false,
      files: [],
      error: `No keys found for environment "${env}" in ${sourceDir}`,
    };
  }

  const destDir = getExternalKeysDir(env, keysBaseDir);
  const files: string[] = [];

  onProgress?.(`Migrating keys from ${found.path} to ${destDir}`);

  if (!dryRun) {
    // Create destination directory with secure permissions
    await mkdir(destDir, { recursive: true, mode: DIRECTORY_MODE });

    // Copy all key files
    const entries = await readdir(found.path, { withFileTypes: true });
    for (const entry of entries) {
      // Skip symbolic links and directories
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        continue;
      }

      const srcPath = join(found.path, entry.name);
      const destPath = join(destDir, entry.name);
      await copyFile(srcPath, destPath);

      // Set restrictive permissions on sensitive files
      if (isSensitiveFile(entry.name)) {
        await chmod(destPath, SENSITIVE_FILE_MODE);
      }

      files.push(entry.name);
    }

    onProgress?.(`  Copied ${files.length} key files`);

    // Update config.json if it exists
    const configPath = getEnvironmentPaths({ baseDir: sourceDir, env }).config;
    if (existsSync(configPath)) {
      try {
        const content = await readFile(configPath, 'utf-8');
        const config = JSON.parse(content) as AuthrimConfig;

        if (config.keys) {
          config.keys.secretsPath = resolve(keysBaseDir, '.authrim-keys', env) + '/';
          config.keys.storageType = 'external';
        }

        await writeFile(configPath, JSON.stringify(config, null, 2));
        onProgress?.('  Updated config.json with external keys path');
      } catch (error) {
        onProgress?.(
          `  Warning: Could not update config.json: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } else {
    onProgress?.(`  Would copy keys from ${found.path} to ${destDir}`);
  }

  return {
    success: true,
    sourceLocation: found.location === 'legacy' ? 'legacy' : 'internal',
    sourcePath: found.path,
    destPath: destDir,
    files,
  };
}
