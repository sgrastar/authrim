/**
 * Source Download Module
 *
 * Downloads Authrim source code from GitHub for deployment.
 * Supports both degit (shallow clone) and tar.gz (release artifact) methods.
 */

import { execa } from 'execa';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, rm, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar';

// =============================================================================
// Types
// =============================================================================

export interface SourceInfo {
  /** GitHub repository (e.g., "sgrastar/authrim") */
  repository: string;
  /** Git reference (tag or branch) */
  gitRef: string;
  /** Full commit hash */
  commitHash?: string;
  /** SHA256 hash of the source artifact */
  artifactHash?: string;
  /** Download method used */
  method: 'degit' | 'tarball';
}

export interface DownloadOptions {
  /** Target directory to extract source */
  targetDir: string;
  /** GitHub repository (default: sgrastar/authrim) */
  repository?: string;
  /** Git tag or branch (default: latest release or main) */
  gitRef?: string;
  /** Force overwrite if directory exists */
  force?: boolean;
  /** Progress callback */
  onProgress?: (message: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_REPOSITORY = 'sgrastar/authrim';
const DEFAULT_BRANCH = 'main';
const GITHUB_API_BASE = 'https://api.github.com';

// =============================================================================
// GitHub API Helpers
// =============================================================================

/**
 * Get the latest release tag from GitHub
 */
export async function getLatestRelease(
  repository: string = DEFAULT_REPOSITORY
): Promise<string | null> {
  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${repository}/releases/latest`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { tag_name?: string };
    return data.tag_name || null;
  } catch {
    return null;
  }
}

/**
 * Get commit hash for a given ref
 */
export async function getCommitHash(
  repository: string = DEFAULT_REPOSITORY,
  gitRef: string = DEFAULT_BRANCH
): Promise<string | null> {
  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${repository}/commits/${gitRef}`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { sha?: string };
    return data.sha || null;
  } catch {
    return null;
  }
}

/**
 * Get available tags from GitHub
 */
export async function getAvailableTags(repository: string = DEFAULT_REPOSITORY): Promise<string[]> {
  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${repository}/tags`);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as Array<{ name: string }>;
    return data.map((tag) => tag.name);
  } catch {
    return [];
  }
}

// =============================================================================
// Download Methods
// =============================================================================

/**
 * Check if degit is available
 */
export async function isDegitAvailable(): Promise<boolean> {
  try {
    await execa('npx', ['degit', '--help']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download source using degit (shallow clone)
 */
export async function downloadWithDegit(options: DownloadOptions): Promise<SourceInfo> {
  const {
    targetDir,
    repository = DEFAULT_REPOSITORY,
    gitRef = DEFAULT_BRANCH,
    force = false,
    onProgress,
  } = options;

  // Validate inputs to prevent command injection
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(repository)) {
    throw new Error('Invalid repository format. Expected: owner/repo');
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(gitRef)) {
    throw new Error('Invalid git ref format');
  }

  // Check if target directory exists
  if (existsSync(targetDir)) {
    if (!force) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }
    onProgress?.('Removing existing directory...');
    await rm(targetDir, { recursive: true });
  }

  // Ensure parent directory exists
  const parentDir = dirname(targetDir);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  onProgress?.(`Downloading ${repository}#${gitRef} using degit...`);

  try {
    // Use degit to clone the repository
    const source = gitRef ? `${repository}#${gitRef}` : repository;
    await execa('npx', ['degit', source, targetDir], {
      timeout: 120000, // 2 minute timeout
    });

    // Get commit hash
    const commitHash = await getCommitHash(repository, gitRef);

    onProgress?.('Download completed successfully');

    return {
      repository,
      gitRef,
      commitHash: commitHash || undefined,
      method: 'degit',
    };
  } catch (error) {
    throw new Error(`Failed to download source with degit: ${error}`);
  }
}

/**
 * Download source as tarball from GitHub
 */
export async function downloadTarball(options: DownloadOptions): Promise<SourceInfo> {
  const {
    targetDir,
    repository = DEFAULT_REPOSITORY,
    gitRef = DEFAULT_BRANCH,
    force = false,
    onProgress,
  } = options;

  // Validate inputs
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(repository)) {
    throw new Error('Invalid repository format. Expected: owner/repo');
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(gitRef)) {
    throw new Error('Invalid git ref format');
  }

  // Check if target directory exists
  if (existsSync(targetDir)) {
    if (!force) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }
    onProgress?.('Removing existing directory...');
    await rm(targetDir, { recursive: true });
  }

  const parentDir = dirname(targetDir);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  // Download tarball
  const tarballUrl = `https://github.com/${repository}/archive/refs/heads/${gitRef}.tar.gz`;
  onProgress?.(`Downloading tarball from ${tarballUrl}...`);

  try {
    const response = await fetch(tarballUrl);
    if (!response.ok) {
      // Try as a tag instead
      const tagUrl = `https://github.com/${repository}/archive/refs/tags/${gitRef}.tar.gz`;
      const tagResponse = await fetch(tagUrl);
      if (!tagResponse.ok) {
        throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
      }
      // Continue with tag response
      return await extractTarball(tagResponse, targetDir, repository, gitRef, onProgress);
    }

    return await extractTarball(response, targetDir, repository, gitRef, onProgress);
  } catch (error) {
    throw new Error(`Failed to download tarball: ${error}`);
  }
}

/**
 * Extract tarball response to target directory
 */
async function extractTarball(
  response: Response,
  targetDir: string,
  repository: string,
  gitRef: string,
  onProgress?: (message: string) => void
): Promise<SourceInfo> {
  const tempDir = join(dirname(targetDir), `.tmp-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    onProgress?.('Extracting tarball...');

    // Extract to temp directory
    const body = response.body;
    if (!body) {
      throw new Error('Empty response body');
    }

    // Use tar to extract
    // Convert web ReadableStream to Node.js Readable
    const { Readable } = await import('node:stream');
    const nodeReadable = Readable.fromWeb(body as import('node:stream/web').ReadableStream);

    await pipeline(nodeReadable, createGunzip(), extract({ cwd: tempDir }));

    // Find the extracted directory (GitHub archives have a single root directory)
    const entries = await readdir(tempDir);
    if (entries.length !== 1) {
      throw new Error('Unexpected tarball structure');
    }

    const extractedDir = join(tempDir, entries[0]);

    // Move to target directory
    await rename(extractedDir, targetDir);

    // Get commit hash
    const commitHash = await getCommitHash(repository, gitRef);

    onProgress?.('Extraction completed successfully');

    return {
      repository,
      gitRef,
      commitHash: commitHash || undefined,
      method: 'tarball',
    };
  } finally {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true }).catch(() => {});
    }
  }
}

// =============================================================================
// Main Download Function
// =============================================================================

/**
 * Download Authrim source code
 *
 * Attempts to use degit first, falls back to tarball download if degit is unavailable.
 */
export async function downloadSource(options: DownloadOptions): Promise<SourceInfo> {
  const { onProgress } = options;

  // Determine git ref (use latest release if not specified)
  let gitRef: string = options.gitRef || '';
  if (!gitRef) {
    onProgress?.('Checking for latest release...');
    const latestRelease = await getLatestRelease(options.repository);
    if (!latestRelease) {
      gitRef = DEFAULT_BRANCH;
      onProgress?.(`No release found, using ${gitRef}`);
    } else {
      gitRef = latestRelease;
      onProgress?.(`Found latest release: ${gitRef}`);
    }
  }

  const optionsWithRef = { ...options, gitRef };

  // Try degit first (faster, simpler)
  onProgress?.('Checking degit availability...');
  const degitAvailable = await isDegitAvailable();

  if (degitAvailable) {
    try {
      return await downloadWithDegit(optionsWithRef);
    } catch (error) {
      onProgress?.(`degit failed, falling back to tarball: ${error}`);
    }
  } else {
    onProgress?.('degit not available, using tarball download');
  }

  // Fall back to tarball
  return await downloadTarball(optionsWithRef);
}

/**
 * Verify downloaded source contains expected structure
 */
export async function verifySourceStructure(sourceDir: string): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const requiredPaths = [
    'packages/ar-auth',
    'packages/ar-token',
    'packages/ar-lib-core',
    'packages/ar-discovery',
    'package.json',
  ];

  for (const path of requiredPaths) {
    const fullPath = join(sourceDir, path);
    if (!existsSync(fullPath)) {
      errors.push(`Missing required path: ${path}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
