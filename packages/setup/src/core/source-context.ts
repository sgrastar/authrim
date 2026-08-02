/**
 * Source Context Detection Module
 *
 * Detects whether the setup tool is running from within the Authrim source
 * repository (e.g., via `pnpm run setup`) versus being invoked externally
 * (e.g., via `npx @authrim/setup`).
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Required paths that identify an Authrim monorepo source directory.
 * Includes `packages/setup` to distinguish from downloaded source (which
 * may not include the setup package).
 */
const REQUIRED_SOURCE_PATHS = [
  'packages/ar-auth',
  'packages/ar-token',
  'packages/ar-lib-core',
  'packages/setup',
  'package.json',
];

/**
 * Check if the given directory is the root of the Authrim source repository.
 *
 * This differs from `isAuthrimSourceDir()` in init.ts: it additionally checks
 * for `packages/setup` to confirm the user is running from the full source repo
 * (not just a downloaded source bundle without the setup package).
 */
export function isRunningFromSource(dir?: string): boolean {
  const checkDir = dir ? resolve(dir) : process.cwd();

  for (const path of REQUIRED_SOURCE_PATHS) {
    if (!existsSync(join(checkDir, path))) {
      return false;
    }
  }
  return true;
}

/**
 * Get the appropriate command prefix for user-facing messages.
 *
 * Returns `'pnpm run setup'` when running from source, `'npx @authrim/setup'` otherwise.
 */
export function getCommandPrefix(): string {
  return isRunningFromSource() ? 'pnpm run setup' : 'npx @authrim/setup';
}
