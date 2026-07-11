/**
 * Wrangler Configuration Sync Utility
 *
 * Manages synchronization between master wrangler.toml files in .authrim/{env}/wrangler/
 * and the deployment copies in packages/ar-star/wrangler.toml (with [env.xxx] sections).
 *
 * Features:
 * - Detects manual modifications to deployment configs
 * - Protects user edits from being overwritten
 * - Maintains portable master copies in environment directory
 * - Generates [env.xxx] format for Cloudflare's official environment support
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getEnvironmentPaths } from './paths.js';
import { generateWranglerConfig, toToml, type ResourceIds } from './wrangler.js';
import type { AuthrimConfig } from './config.js';
import { getEnabledComponents, WORKER_COMPONENTS, type WorkerComponent } from './naming.js';
import { getWorkersSubdomain } from './cloudflare.js';

// =============================================================================
// Types
// =============================================================================

export interface WranglerSyncOptions {
  /** Base directory */
  baseDir: string;
  /** Environment name */
  env: string;
  /** Packages directory (where ar-* components are) */
  packagesDir: string;
  /** Force overwrite without prompting */
  force?: boolean;
  /** Dry run - don't actually write files */
  dryRun?: boolean;
  /** Progress callback */
  onProgress?: (msg: string) => void;
  /** Optional component subset to sync */
  components?: WorkerComponent[];
}

export interface WranglerSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Components that were synced */
  synced: string[];
  /** Components where manual edits were detected */
  manualEdits: string[];
  /** Components that were skipped */
  skipped: string[];
  /** Errors encountered */
  errors: string[];
}

export type SyncAction = 'keep' | 'overwrite' | 'backup';

export interface ManualEditCallback {
  (component: string, masterPath: string, deployPath: string): Promise<SyncAction>;
}

export interface WranglerFileStatus {
  component: string;
  masterExists: boolean;
  deployExists: boolean;
  inSync: boolean;
  masterPath: string;
  deployPath: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Normalize TOML content for comparison (remove comments, whitespace variations)
 */
function normalizeToml(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .join('\n');
}

function isTargetEnvLine(line: string, env: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === `# Environment: ${env}` ||
    trimmed === `[env.${env}]` ||
    trimmed.startsWith(`[env.${env}.`) ||
    trimmed.startsWith(`[[env.${env}.`)
  );
}

function isOtherEnvBoundary(line: string, env: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('# Environment: ')) {
    return trimmed !== `# Environment: ${env}`;
  }

  const envHeader = trimmed.match(/^\[\[?env\.([a-z0-9-]+)/);
  return !!envHeader && envHeader[1] !== env;
}

export function removeEnvironmentSectionFromToml(
  content: string,
  env: string
): { content: string; removed: boolean } {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skipping = false;
  let removed = false;

  for (const line of lines) {
    if (!skipping && isTargetEnvLine(line, env)) {
      skipping = true;
      removed = true;
      continue;
    }

    if (skipping) {
      if (isOtherEnvBoundary(line, env)) {
        skipping = false;
        kept.push(line);
      }
      continue;
    }

    kept.push(line);
  }

  const normalized = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return {
    content: normalized.length > 0 ? normalized + '\n' : '',
    removed,
  };
}

export function extractEnvironmentSectionFromToml(content: string, env: string): string {
  const lines = content.split('\n');
  const section: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (!collecting && isTargetEnvLine(line, env)) {
      collecting = true;
    }

    if (collecting) {
      if (section.length > 0 && isOtherEnvBoundary(line, env)) {
        break;
      }
      section.push(line);
    }
  }

  return section.join('\n').trimEnd();
}

function findFirstEnvironmentBoundary(lines: string[]): number {
  return lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('# Environment: ') || /^\[\[?env\.[a-z0-9-]+/.test(trimmed);
  });
}

function extractTopLevelPreamble(content: string): string {
  const lines = content.split('\n');
  const boundary = findFirstEnvironmentBoundary(lines);
  return (boundary === -1 ? lines : lines.slice(0, boundary)).join('\n').trimEnd();
}

function extractEnvironmentSections(content: string): string {
  const lines = content.split('\n');
  const boundary = findFirstEnvironmentBoundary(lines);
  return boundary === -1 ? '' : lines.slice(boundary).join('\n').trim();
}

export function mergeEnvironmentSectionIntoToml(
  deployContent: string,
  masterContent: string,
  env: string
): string {
  // Generated top-level settings (especially the complete Durable Object
  // migration history) must advance together with the target environment.
  // Other environment sections remain byte-for-byte from the deploy copy.
  const masterPreamble = extractTopLevelPreamble(masterContent);
  const withoutTargetEnv = removeEnvironmentSectionFromToml(deployContent, env).content;
  const otherEnvironmentSections = extractEnvironmentSections(withoutTargetEnv);
  const targetSection = extractEnvironmentSectionFromToml(masterContent, env).trim();
  return (
    [masterPreamble, otherEnvironmentSections, targetSection].filter(Boolean).join('\n\n') + '\n'
  );
}

/**
 * Get the master wrangler.toml path for a component
 */
export function getMasterWranglerPath(
  envPaths: ReturnType<typeof getEnvironmentPaths>,
  component: string
): string {
  return join(envPaths.wrangler, `${component}.toml`);
}

/**
 * Get the deploy wrangler.toml path for a component
 *
 * Returns the unified wrangler.toml path (not environment-specific).
 * Environment-specific settings are defined within [env.xxx] sections.
 */
export function getDeployWranglerPath(packagesDir: string, component: string): string {
  return join(packagesDir, component, 'wrangler.toml');
}

function getWranglerComponentsForConfig(config: AuthrimConfig): WorkerComponent[] {
  return Array.from(getEnabledComponents(config.components));
}

// =============================================================================
// Status Check
// =============================================================================

/**
 * Check the sync status of all wrangler configs
 *
 * Note: With the new [env.xxx] format, comparison checks if the environment section
 * in the deploy file matches the master config content.
 */
export async function checkWranglerStatus(
  options: Pick<WranglerSyncOptions, 'baseDir' | 'env' | 'packagesDir'>
): Promise<WranglerFileStatus[]> {
  const { baseDir, env, packagesDir } = options;
  const envPaths = getEnvironmentPaths({ baseDir, env });
  const results: WranglerFileStatus[] = [];

  for (const component of WORKER_COMPONENTS) {
    const masterPath = getMasterWranglerPath(envPaths, component);
    const deployPath = getDeployWranglerPath(packagesDir, component);

    const masterExists = existsSync(masterPath);
    const deployExists = existsSync(deployPath);

    let inSync = true;
    if (masterExists && deployExists) {
      const masterContent = await readFile(masterPath, 'utf-8');
      const deployContent = await readFile(deployPath, 'utf-8');
      // Compare only the relevant [env.xxx] section content.
      inSync =
        normalizeToml(extractEnvironmentSectionFromToml(masterContent, env)) ===
        normalizeToml(extractEnvironmentSectionFromToml(deployContent, env));
    } else if (masterExists !== deployExists) {
      inSync = false;
    }

    results.push({
      component,
      masterExists,
      deployExists,
      inSync,
      masterPath,
      deployPath,
    });
  }

  return results;
}

// =============================================================================
// Generate and Save Master Configs
// =============================================================================

/**
 * Generate and save master wrangler.toml files to .authrim/{env}/wrangler/
 */
export async function saveMasterWranglerConfigs(
  config: AuthrimConfig,
  resourceIds: ResourceIds,
  options: Pick<WranglerSyncOptions, 'baseDir' | 'env' | 'dryRun' | 'onProgress'> & {
    includeDurableObjectMigrations?: boolean;
    components?: WorkerComponent[];
  }
): Promise<{ success: boolean; files: string[]; errors: string[] }> {
  const { baseDir, env, dryRun, onProgress, includeDurableObjectMigrations } = options;
  const envPaths = getEnvironmentPaths({ baseDir, env });
  const files: string[] = [];
  const errors: string[] = [];

  // Create wrangler directory
  if (!dryRun) {
    await mkdir(envPaths.wrangler, { recursive: true });
  }

  // Get workers.dev subdomain for CORS configuration
  // Workers.dev URLs must be in format: {name}.{subdomain}.workers.dev
  const workersSubdomain = await getWorkersSubdomain();

  const configuredComponents = getWranglerComponentsForConfig(config);
  const components = options.components
    ? options.components.filter((component) => configuredComponents.includes(component))
    : configuredComponents;

  for (const component of components) {
    try {
      const wranglerConfig = generateWranglerConfig(
        component,
        config,
        resourceIds,
        workersSubdomain ?? undefined,
        { includeDurableObjectMigrations }
      );
      // Generate TOML with [env.{env}] section format
      const tomlContent = toToml(wranglerConfig, env);
      const masterPath = getMasterWranglerPath(envPaths, component);

      if (!dryRun) {
        await writeFile(masterPath, tomlContent, 'utf-8');
        onProgress?.(`  Saved ${component}.toml`);
      } else {
        onProgress?.(`  Would save ${component}.toml`);
      }
      files.push(masterPath);
    } catch (error) {
      errors.push(`${component}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { success: errors.length === 0, files, errors };
}

// =============================================================================
// Sync to Deploy Location
// =============================================================================

/**
 * Sync master wrangler configs to deployment locations
 *
 * This copies from .authrim/{env}/wrangler/ to packages/ar-star/wrangler.toml
 * while detecting and protecting manual edits.
 *
 * With the new [env.xxx] format, each deploy file contains environment-specific
 * sections, allowing multiple environments to coexist in a single wrangler.toml.
 */
export async function syncWranglerConfigs(
  options: WranglerSyncOptions,
  onManualEdit?: ManualEditCallback
): Promise<WranglerSyncResult> {
  const { baseDir, env, packagesDir, force, dryRun, onProgress } = options;
  const envPaths = getEnvironmentPaths({ baseDir, env });

  const result: WranglerSyncResult = {
    success: true,
    synced: [],
    manualEdits: [],
    skipped: [],
    errors: [],
  };

  // Check if master wrangler directory exists
  if (!existsSync(envPaths.wrangler)) {
    result.errors.push('Master wrangler directory not found. Run init first.');
    result.success = false;
    return result;
  }

  const components = options.components ?? WORKER_COMPONENTS;
  for (const component of components) {
    const masterPath = getMasterWranglerPath(envPaths, component);
    const deployPath = getDeployWranglerPath(packagesDir, component);
    const componentDir = join(packagesDir, component);

    // Skip if component directory doesn't exist
    if (!existsSync(componentDir)) {
      result.skipped.push(component);
      continue;
    }

    // Skip if master doesn't exist
    if (!existsSync(masterPath)) {
      result.skipped.push(component);
      continue;
    }

    try {
      const masterContent = await readFile(masterPath, 'utf-8');

      // Check if deploy file exists and is different
      let nextDeployContent = masterContent;
      if (existsSync(deployPath)) {
        const deployContent = await readFile(deployPath, 'utf-8');
        const masterNormalized = normalizeToml(masterContent);
        const deployNormalized = normalizeToml(
          extractEnvironmentSectionFromToml(deployContent, env)
        );
        nextDeployContent = mergeEnvironmentSectionIntoToml(deployContent, masterContent, env);

        if (masterNormalized === deployNormalized) {
          // Already in sync
          result.synced.push(component);
          continue;
        }

        // Manual edit detected
        result.manualEdits.push(component);

        if (!force && onManualEdit) {
          const action = await onManualEdit(component, masterPath, deployPath);

          switch (action) {
            case 'keep':
              onProgress?.(`  ${component}: Keeping manual changes`);
              continue;

            case 'backup':
              if (!dryRun) {
                const backupPath = deployPath + '.backup';
                await writeFile(backupPath, deployContent, 'utf-8');
                onProgress?.(`  ${component}: Backed up to ${basename(backupPath)}`);
              }
              // Fall through to overwrite
              break;

            case 'overwrite':
              // Continue to overwrite
              break;
          }
        }
      }

      // Write master content to deploy location
      if (!dryRun) {
        await writeFile(deployPath, nextDeployContent, 'utf-8');
        onProgress?.(`  ${component}: Synced to wrangler.toml`);
      } else {
        onProgress?.(`  ${component}: Would sync to wrangler.toml`);
      }
      result.synced.push(component);
    } catch (error) {
      result.errors.push(`${component}: ${error instanceof Error ? error.message : String(error)}`);
      result.success = false;
    }
  }

  return result;
}

// =============================================================================
// Backup and Restore
// =============================================================================

/**
 * Backup deploy wrangler configs before sync
 */
export async function backupDeployConfigs(
  options: Pick<WranglerSyncOptions, 'env' | 'packagesDir' | 'onProgress'>
): Promise<string[]> {
  const { packagesDir, onProgress } = options;
  const backedUp: string[] = [];

  for (const component of WORKER_COMPONENTS) {
    const deployPath = getDeployWranglerPath(packagesDir, component);

    if (existsSync(deployPath)) {
      const content = await readFile(deployPath, 'utf-8');
      const backupPath = deployPath + '.backup';
      await writeFile(backupPath, content, 'utf-8');
      backedUp.push(component);
      onProgress?.(`  Backed up ${component}/wrangler.toml`);
    }
  }

  return backedUp;
}

/**
 * Restore deploy wrangler configs from backup
 */
export async function restoreDeployConfigs(
  options: Pick<WranglerSyncOptions, 'env' | 'packagesDir' | 'onProgress'>
): Promise<string[]> {
  const { packagesDir, onProgress } = options;
  const restored: string[] = [];

  for (const component of WORKER_COMPONENTS) {
    const deployPath = getDeployWranglerPath(packagesDir, component);
    const backupPath = deployPath + '.backup';

    if (existsSync(backupPath)) {
      const content = await readFile(backupPath, 'utf-8');
      await writeFile(deployPath, content, 'utf-8');
      restored.push(component);
      onProgress?.(`  Restored ${component}/wrangler.toml`);
    }
  }

  return restored;
}
