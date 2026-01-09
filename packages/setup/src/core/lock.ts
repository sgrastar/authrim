/**
 * Authrim Lock File Module
 *
 * Manages lock files which record created resource IDs.
 * This file allows re-deployment and resource management.
 *
 * Supports both legacy (authrim-lock.json) and new (.authrim/{env}/lock.json) structures.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ProvisionedResources } from './cloudflare.js';
import {
  getEnvironmentPaths,
  getLegacyPaths,
  resolvePaths,
  type EnvironmentPaths,
  type LegacyPaths,
} from './paths.js';

// =============================================================================
// Schema
// =============================================================================

const ResourceEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
});

const KVResourceEntrySchema = ResourceEntrySchema.extend({
  previewId: z.string().optional(),
});

const WorkerEntrySchema = z.object({
  name: z.string(),
  deployedAt: z.string().datetime().optional(),
  version: z.string().optional(),
});

export const AuthrimLockSchema = z.object({
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  env: z.string(),

  d1: z.record(ResourceEntrySchema).default({}),
  kv: z.record(KVResourceEntrySchema).default({}),
  queues: z.record(ResourceEntrySchema).optional(),
  r2: z.record(z.object({ name: z.string() })).optional(),
  workers: z.record(WorkerEntrySchema).optional(),
});

export type AuthrimLock = z.infer<typeof AuthrimLockSchema>;
export type ResourceEntry = z.infer<typeof ResourceEntrySchema>;
export type KVResourceEntry = z.infer<typeof KVResourceEntrySchema>;
export type WorkerEntry = z.infer<typeof WorkerEntrySchema>;

// =============================================================================
// Lock File Operations
// =============================================================================

/**
 * Create a new lock file from provisioned resources
 */
export function createLockFile(env: string, resources: ProvisionedResources): AuthrimLock {
  const now = new Date().toISOString();

  const lock: AuthrimLock = {
    version: '1.0.0',
    createdAt: now,
    updatedAt: now,
    env,
    d1: {},
    kv: {},
  };

  // Add D1 databases
  for (const db of resources.d1) {
    lock.d1[db.binding] = {
      name: db.name,
      id: db.id,
    };
  }

  // Add KV namespaces
  for (const kv of resources.kv) {
    lock.kv[kv.binding] = {
      name: kv.name,
      id: kv.id,
      previewId: kv.previewId,
    };
  }

  // Add Queues
  if (resources.queues.length > 0) {
    lock.queues = {};
    for (const q of resources.queues) {
      lock.queues[q.binding] = {
        name: q.name,
        id: q.id,
      };
    }
  }

  // Add R2 buckets
  if (resources.r2.length > 0) {
    lock.r2 = {};
    for (const r of resources.r2) {
      lock.r2[r.binding] = {
        name: r.name,
      };
    }
  }

  return lock;
}

// =============================================================================
// Path Resolution for Lock Files
// =============================================================================

export interface LockFileOptions {
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /** Environment name */
  env?: string;
  /** Use legacy structure (authrim-lock.json) */
  legacy?: boolean;
  /** Direct path to lock file (overrides baseDir/env/legacy) */
  path?: string;
}

/**
 * Resolve lock file path based on options
 *
 * Priority:
 * 1. Explicit path
 * 2. Legacy structure if legacy=true
 * 3. Auto-detect existing structure
 * 4. Default to new structure
 */
export function resolveLockFilePath(options: LockFileOptions | string = {}): string {
  // Support legacy call with just a path string
  if (typeof options === 'string') {
    return options;
  }

  const { baseDir = process.cwd(), env, legacy, path: explicitPath } = options;

  // Explicit path takes priority
  if (explicitPath) {
    return explicitPath;
  }

  // Environment is required when not using explicit path
  if (!env) {
    // For backward compatibility, default to legacy path
    return getLegacyPaths(baseDir, 'default').lock;
  }

  // Force legacy structure
  if (legacy) {
    return getLegacyPaths(baseDir, env).lock;
  }

  // Auto-detect structure
  const resolved = resolvePaths({ baseDir, env });
  if (resolved.type === 'legacy') {
    return (resolved.paths as LegacyPaths).lock;
  }

  return (resolved.paths as EnvironmentPaths).lock;
}

/**
 * Get lock file path for new structure
 */
export function getNewLockFilePath(baseDir: string, env: string): string {
  return getEnvironmentPaths({ baseDir, env }).lock;
}

/**
 * Get lock file path for legacy structure
 */
export function getLegacyLockFilePath(baseDir: string): string {
  return getLegacyPaths(baseDir, 'default').lock;
}

/**
 * Check if lock file exists for an environment
 * Checks both new and legacy structures
 */
export function lockFileExists(baseDir: string, env: string): boolean {
  // Check new structure
  const newPath = getEnvironmentPaths({ baseDir, env }).lock;
  if (existsSync(newPath)) {
    return true;
  }

  // Check legacy structure
  const legacyPath = getLegacyPaths(baseDir, env).lock;
  return existsSync(legacyPath);
}

// =============================================================================
// Lock File Operations
// =============================================================================

/**
 * Save lock file to disk
 *
 * Supports both:
 * - New structure: .authrim/{env}/lock.json
 * - Legacy structure: authrim-lock.json
 *
 * @param lock - Lock data to save
 * @param options - Options for path resolution, or direct path string (legacy)
 */
export async function saveLockFile(
  lock: AuthrimLock,
  options: LockFileOptions | string = {}
): Promise<void> {
  const path = resolveLockFilePath(options);

  // Ensure parent directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  lock.updatedAt = new Date().toISOString();
  await writeFile(path, JSON.stringify(lock, null, 2), 'utf-8');
}

/** Error class for lock file operations */
export class LockFileError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LockFileError';
  }
}

/**
 * Load lock file from disk
 *
 * Supports both:
 * - New structure: .authrim/{env}/lock.json
 * - Legacy structure: authrim-lock.json
 *
 * @param options - Options for path resolution, or direct path string (legacy)
 * @throws LockFileError if file exists but cannot be parsed
 */
export async function loadLockFile(
  options: LockFileOptions | string = {}
): Promise<AuthrimLock | null> {
  const path = resolveLockFilePath(options);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, 'utf-8');
    const data = JSON.parse(content);
    return AuthrimLockSchema.parse(data);
  } catch (error) {
    // Re-throw with context for better debugging
    if (error instanceof SyntaxError) {
      throw new LockFileError('Invalid JSON in lock file', error);
    }
    if (error instanceof z.ZodError) {
      throw new LockFileError(
        `Invalid lock file schema: ${error.issues.map((i) => i.message).join(', ')}`,
        error
      );
    }
    throw new LockFileError('Failed to read lock file', error instanceof Error ? error : undefined);
  }
}

/**
 * Load lock file with automatic structure detection
 * Tries new structure first, then legacy
 */
export async function loadLockFileAuto(
  baseDir: string,
  env: string
): Promise<{ lock: AuthrimLock | null; path: string; type: 'new' | 'legacy' }> {
  // Try new structure first
  const newPath = getEnvironmentPaths({ baseDir, env }).lock;
  if (existsSync(newPath)) {
    const lock = await loadLockFile({ path: newPath });
    return { lock, path: newPath, type: 'new' };
  }

  // Try legacy structure
  const legacyPath = getLegacyPaths(baseDir, env).lock;
  const lock = await loadLockFile({ path: legacyPath });
  return { lock, path: legacyPath, type: 'legacy' };
}

/**
 * Update worker deployment info in lock file
 */
export function updateWorkerDeployment(
  lock: AuthrimLock,
  workerName: string,
  deploymentName: string,
  version?: string
): AuthrimLock {
  if (!lock.workers) {
    lock.workers = {};
  }

  lock.workers[workerName] = {
    name: deploymentName,
    deployedAt: new Date().toISOString(),
    version,
  };

  return lock;
}

/**
 * Convert lock file to ResourceIds format for wrangler.ts
 */
export function lockToResourceIds(lock: AuthrimLock): {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<string, { name: string }>;
} {
  return {
    d1: lock.d1,
    kv: Object.fromEntries(
      Object.entries(lock.kv).map(([key, value]) => [key, { id: value.id, name: value.name }])
    ),
    queues: lock.queues,
    r2: lock.r2,
  };
}

/**
 * Merge two lock files (for updating existing)
 */
export function mergeLockFiles(existing: AuthrimLock, newData: Partial<AuthrimLock>): AuthrimLock {
  return {
    ...existing,
    ...newData,
    d1: { ...existing.d1, ...newData.d1 },
    kv: { ...existing.kv, ...newData.kv },
    queues: { ...existing.queues, ...newData.queues },
    r2: { ...existing.r2, ...newData.r2 },
    workers: { ...existing.workers, ...newData.workers },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate that all required resources exist in lock file
 */
export function validateLockFile(lock: AuthrimLock): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  // Check required D1 databases
  const requiredD1 = ['DB', 'PII_DB'];
  for (const binding of requiredD1) {
    if (!lock.d1[binding]) {
      missing.push(`D1: ${binding}`);
    }
  }

  // Check required KV namespaces
  const requiredKV = ['CLIENTS_CACHE', 'SETTINGS', 'AUTHRIM_CONFIG', 'USER_CACHE'];
  for (const binding of requiredKV) {
    if (!lock.kv[binding]) {
      missing.push(`KV: ${binding}`);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Generate summary of resources in lock file
 */
export function getLockFileSummary(lock: AuthrimLock): string {
  const lines: string[] = [
    `Environment: ${lock.env}`,
    `Created: ${lock.createdAt}`,
    `Updated: ${lock.updatedAt || 'N/A'}`,
    '',
    'D1 Databases:',
  ];

  for (const [binding, db] of Object.entries(lock.d1)) {
    lines.push(`  • ${binding}: ${db.name} (${db.id.slice(0, 8)}...)`);
  }

  lines.push('', 'KV Namespaces:');
  for (const [binding, kv] of Object.entries(lock.kv)) {
    lines.push(`  • ${binding}: ${kv.name} (${kv.id.slice(0, 8)}...)`);
  }

  if (lock.queues && Object.keys(lock.queues).length > 0) {
    lines.push('', 'Queues:');
    for (const [binding, q] of Object.entries(lock.queues)) {
      lines.push(`  • ${binding}: ${q.name}`);
    }
  }

  if (lock.r2 && Object.keys(lock.r2).length > 0) {
    lines.push('', 'R2 Buckets:');
    for (const [binding, r] of Object.entries(lock.r2)) {
      lines.push(`  • ${binding}: ${r.name}`);
    }
  }

  if (lock.workers && Object.keys(lock.workers).length > 0) {
    lines.push('', 'Workers:');
    for (const [name, w] of Object.entries(lock.workers)) {
      lines.push(`  • ${name}: ${w.name} (deployed: ${w.deployedAt || 'N/A'})`);
    }
  }

  return lines.join('\n');
}
