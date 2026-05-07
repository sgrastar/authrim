/**
 * Source Download Module
 *
 * Downloads Authrim source code from GitHub for deployment.
 * Supports both degit (shallow clone) and tar.gz (release artifact) methods.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, rm, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar';
import { fetchWithTimeout, readResponseJsonWithLimit } from './http-limits.js';

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
const MAX_SOURCE_TARBALL_BYTES = 250 * 1024 * 1024;

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
    const response = await fetchWithTimeout(`${GITHUB_API_BASE}/repos/${repository}/releases/latest`);
    if (!response.ok) {
      return null;
    }
    const data = await readResponseJsonWithLimit<{ tag_name?: string }>(response);
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
    const response = await fetchWithTimeout(`${GITHUB_API_BASE}/repos/${repository}/commits/${gitRef}`);
    if (!response.ok) {
      return null;
    }
    const data = await readResponseJsonWithLimit<{ sha?: string }>(response);
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
    const response = await fetchWithTimeout(`${GITHUB_API_BASE}/repos/${repository}/tags`);
    if (!response.ok) {
      return [];
    }
    const data = await readResponseJsonWithLimit<Array<{ name: string }>>(response);
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
    const response = await fetchWithTimeout(tarballUrl, {}, 120000);
    if (!response.ok) {
      // Try as a tag instead
      const tagUrl = `https://github.com/${repository}/archive/refs/tags/${gitRef}.tar.gz`;
      const tagResponse = await fetchWithTimeout(tagUrl, {}, 120000);
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

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const parsed = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsed) && parsed > MAX_SOURCE_TARBALL_BYTES) {
        throw new Error(
          `Source tarball exceeds maximum size: ${parsed} > ${MAX_SOURCE_TARBALL_BYTES} bytes`
        );
      }
    }

    // Extract to temp directory
    const body = response.body;
    if (!body) {
      throw new Error('Empty response body');
    }

    // Use tar to extract
    // Convert web ReadableStream to Node.js Readable
    const { Readable, Transform } = await import('node:stream');
    const nodeReadable = Readable.fromWeb(body as import('node:stream/web').ReadableStream);
    let downloadedBytes = 0;
    const limitStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.byteLength;
        if (downloadedBytes > MAX_SOURCE_TARBALL_BYTES) {
          callback(
            new Error(
              `Source tarball exceeds maximum size: ${downloadedBytes} > ${MAX_SOURCE_TARBALL_BYTES} bytes`
            )
          );
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(nodeReadable, limitStream, createGunzip(), extract({ cwd: tempDir }));

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
 * Get local version from package.json
 */
export async function getLocalVersion(sourceDir: string): Promise<string | null> {
  try {
    const packageJsonPath = join(sourceDir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return null;
    }
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Get latest version from GitHub releases or package.json
 */
export async function getRemoteVersion(
  repository: string = DEFAULT_REPOSITORY
): Promise<{ version: string; gitRef: string } | null> {
  try {
    // First try to get latest release
    const latestRelease = await getLatestRelease(repository);
    if (latestRelease) {
      // Extract version number from tag (e.g., "v1.0.0" -> "1.0.0")
      const version = latestRelease.replace(/^v/, '');
      return { version, gitRef: latestRelease };
    }

    // Fall back to main branch package.json
    const response = await fetch(
      `https://raw.githubusercontent.com/${repository}/main/package.json`
    );
    if (!response.ok) {
      return null;
    }
    const pkg = (await response.json()) as { version?: string };
    return pkg.version ? { version: pkg.version, gitRef: 'main' } : null;
  } catch {
    return null;
  }
}

/**
 * Compare two version strings
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const parts2 = v2
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check if an update is available
 */
export async function checkForUpdate(
  sourceDir: string,
  repository: string = DEFAULT_REPOSITORY
): Promise<{
  updateAvailable: boolean;
  localVersion: string | null;
  remoteVersion: string | null;
  gitRef: string | null;
}> {
  const localVersion = await getLocalVersion(sourceDir);
  const remoteInfo = await getRemoteVersion(repository);

  if (!localVersion || !remoteInfo) {
    return {
      updateAvailable: false,
      localVersion,
      remoteVersion: remoteInfo?.version || null,
      gitRef: remoteInfo?.gitRef || null,
    };
  }

  const updateAvailable = compareVersions(localVersion, remoteInfo.version) < 0;

  return {
    updateAvailable,
    localVersion,
    remoteVersion: remoteInfo.version,
    gitRef: remoteInfo.gitRef,
  };
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
