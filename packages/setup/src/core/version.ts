/**
 * Version Management Module
 *
 * Handles reading and comparing package versions for update functionality.
 * Used by both CLI `update` command and Web API for version comparison.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_COMPONENTS, type WorkerComponent } from './naming.js';

// =============================================================================
// Types
// =============================================================================

export interface PackageJson {
  name: string;
  version: string;
}

export interface VersionComparison {
  component: WorkerComponent;
  deployedVersion: string | null;
  localVersion: string | null;
  needsUpdate: boolean;
  lastDeployedAt: string | null;
}

export interface WorkerDeploymentInfo {
  version?: string;
  deployedAt?: string;
}

// =============================================================================
// Package Version Functions
// =============================================================================

/**
 * Read version from a package's package.json
 */
export async function getPackageVersion(packageDir: string): Promise<string | null> {
  const packageJsonPath = join(packageDir, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const content = await readFile(packageJsonPath, 'utf-8');
    const pkg: PackageJson = JSON.parse(content);
    return pkg.version || null;
  } catch {
    return null;
  }
}

/** Read the Authrim product version from the repository root package.json. */
export async function getRootProductVersion(rootDir: string): Promise<string> {
  const version = await getPackageVersion(rootDir);
  if (!version) throw new Error(`Could not read Authrim product version from ${rootDir}`);
  return version;
}

/**
 * Get versions for all worker packages
 *
 * @param rootDir - Root directory of the Authrim project
 * @returns Record of component name to version string
 */
export async function getLocalPackageVersions(
  rootDir: string
): Promise<Partial<Record<WorkerComponent, string>>> {
  const versions: Partial<Record<WorkerComponent, string>> = {};

  for (const component of WORKER_COMPONENTS) {
    const packageDir = join(rootDir, 'packages', component);
    const version = await getPackageVersion(packageDir);

    if (version) {
      versions[component] = version;
    }
  }

  return versions;
}

// =============================================================================
// Version Comparison Functions
// =============================================================================

/**
 * Compare deployed versions with local versions
 *
 * @param localVersions - Local package versions from package.json
 * @param deployedVersions - Deployed versions from lock.json
 * @returns Array of version comparisons with update status
 */
export function compareVersions(
  localVersions: Partial<Record<WorkerComponent, string>>,
  deployedVersions: Record<string, WorkerDeploymentInfo>
): VersionComparison[] {
  const comparisons: VersionComparison[] = [];

  // Include all components that exist locally
  for (const component of WORKER_COMPONENTS) {
    const localVersion = localVersions[component] || null;

    // Skip if local package doesn't exist
    if (!localVersion) {
      continue;
    }

    const deployed = deployedVersions[component];
    const deployedVersion = deployed?.version || null;

    comparisons.push({
      component,
      deployedVersion,
      localVersion,
      needsUpdate: localVersion !== deployedVersion,
      lastDeployedAt: deployed?.deployedAt || null,
    });
  }

  return comparisons;
}

/**
 * Get components that need to be updated
 *
 * @param comparisons - Version comparison results
 * @param updateAll - If true, return all components regardless of version
 * @returns Array of components that need updating
 */
export function getComponentsToUpdate(
  comparisons: VersionComparison[],
  updateAll: boolean = false
): WorkerComponent[] {
  if (updateAll) {
    return comparisons.map((c) => c.component);
  }

  return comparisons.filter((c) => c.needsUpdate).map((c) => c.component);
}
