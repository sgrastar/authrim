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

import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  LEGACY_CONFIG_FILE,
  LEGACY_LOCK_FILE,
  LEGACY_KEYS_DIR,
  getEnvironmentPaths,
  getLegacyPaths,
  detectStructure,
  listEnvironments,
  validateEnvName,
} from './paths.js';

import { AuthrimConfigSchema, type AuthrimConfig } from './config.js';
import { AuthrimLockSchema, type AuthrimLock } from './lock.js';
import { saveMasterWranglerConfigs } from './wrangler-sync.js';
import type { ResourceIds } from './wrangler.js';

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

// =============================================================================
// Migration Detection
// =============================================================================

/**
 * Check if migration from legacy structure is needed
 */
export function needsMigration(baseDir: string = process.cwd()): boolean {
  const structure = detectStructure(baseDir);
  return structure.type === 'legacy';
}

/**
 * Get list of environments that need migration
 */
export function getEnvironmentsToMigrate(baseDir: string = process.cwd()): string[] {
  const legacyConfigPath = join(baseDir, LEGACY_CONFIG_FILE);
  const legacyKeysDir = join(baseDir, LEGACY_KEYS_DIR);

  const environments: string[] = [];

  // Check if legacy config exists and extract environment from it
  if (existsSync(legacyConfigPath)) {
    try {
      const content = require('fs').readFileSync(legacyConfigPath, 'utf-8');
      const config = JSON.parse(content);
      if (config.environment?.prefix) {
        environments.push(config.environment.prefix);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Also check for environments in .keys directory
  if (existsSync(legacyKeysDir)) {
    try {
      const entries = require('fs').readdirSync(legacyKeysDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !environments.includes(entry.name)) {
          environments.push(entry.name);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return environments;
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

    // Backup legacy config
    const legacyConfigPath = join(baseDir, LEGACY_CONFIG_FILE);
    if (existsSync(legacyConfigPath)) {
      const destPath = join(backupDir, LEGACY_CONFIG_FILE);
      await copyFile(legacyConfigPath, destPath);
      files.push(LEGACY_CONFIG_FILE);
      onProgress?.(`  Backed up ${LEGACY_CONFIG_FILE}`);
    }

    // Backup legacy lock file
    const legacyLockPath = join(baseDir, LEGACY_LOCK_FILE);
    if (existsSync(legacyLockPath)) {
      const destPath = join(backupDir, LEGACY_LOCK_FILE);
      await copyFile(legacyLockPath, destPath);
      files.push(LEGACY_LOCK_FILE);
      onProgress?.(`  Backed up ${LEGACY_LOCK_FILE}`);
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

  // Check if migration is needed
  const structure = detectStructure(baseDir);
  if (structure.type !== 'legacy') {
    if (structure.type === 'new') {
      onProgress?.('Already using new directory structure');
      result.success = true;
      return result;
    } else {
      result.errors.push('No configuration files found to migrate');
      return result;
    }
  }

  // Determine environments to migrate
  const environments = env ? [env] : getEnvironmentsToMigrate(baseDir);

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
    await deleteLegacyFiles(baseDir, onProgress);
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
  const legacyPaths = getLegacyPaths(baseDir, env);

  // Create new directory structure with secure permissions
  if (!dryRun) {
    await mkdir(newPaths.root, { recursive: true, mode: DIRECTORY_MODE });
    await mkdir(newPaths.keys, { recursive: true, mode: DIRECTORY_MODE });
    onProgress?.(`  Created ${newPaths.root}`);
  } else {
    onProgress?.(`  Would create ${newPaths.root}`);
  }

  // Migrate config.json
  if (existsSync(legacyPaths.config)) {
    try {
      const content = await readFile(legacyPaths.config, 'utf-8');
      const config = JSON.parse(content) as AuthrimConfig;

      // Update secretsPath to relative path within new structure
      if (config.keys) {
        config.keys.secretsPath = './keys/';
      }

      if (!dryRun) {
        await writeFile(newPaths.config, JSON.stringify(config, null, 2));
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
  if (existsSync(legacyPaths.lock)) {
    try {
      const content = await readFile(legacyPaths.lock, 'utf-8');
      const lock = JSON.parse(content) as AuthrimLock;

      if (!dryRun) {
        await writeFile(newPaths.lock, JSON.stringify(lock, null, 2));
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
      // Non-fatal: wrangler generation failure doesn't fail the migration
      onProgress?.(
        `  Warning: Could not generate wrangler configs: ${error instanceof Error ? error.message : String(error)}`
      );
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
  onProgress?: (msg: string) => void
): Promise<void> {
  // Delete legacy config
  const legacyConfigPath = join(baseDir, LEGACY_CONFIG_FILE);
  if (existsSync(legacyConfigPath)) {
    await rm(legacyConfigPath);
    onProgress?.(`  Deleted ${LEGACY_CONFIG_FILE}`);
  }

  // Delete legacy lock
  const legacyLockPath = join(baseDir, LEGACY_LOCK_FILE);
  if (existsSync(legacyLockPath)) {
    await rm(legacyLockPath);
    onProgress?.(`  Deleted ${LEGACY_LOCK_FILE}`);
  }

  // Delete legacy keys directory
  const legacyKeysDir = join(baseDir, LEGACY_KEYS_DIR);
  if (existsSync(legacyKeysDir)) {
    await rm(legacyKeysDir, { recursive: true });
    onProgress?.(`  Deleted ${LEGACY_KEYS_DIR}/`);
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

  const legacyFiles: string[] = [];
  if (existsSync(join(baseDir, LEGACY_CONFIG_FILE))) {
    legacyFiles.push(LEGACY_CONFIG_FILE);
  }
  if (existsSync(join(baseDir, LEGACY_LOCK_FILE))) {
    legacyFiles.push(LEGACY_LOCK_FILE);
  }
  if (existsSync(join(baseDir, LEGACY_KEYS_DIR))) {
    legacyFiles.push(LEGACY_KEYS_DIR + '/');
  }

  const environments =
    structure.type === 'new' ? listEnvironments(baseDir) : getEnvironmentsToMigrate(baseDir);

  return {
    needsMigration: structure.type === 'legacy',
    currentStructure: structure.type,
    environments,
    legacyFiles,
  };
}
