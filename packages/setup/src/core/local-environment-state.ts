import { existsSync } from 'node:fs';
import { getEnvironmentPaths, getLegacyPaths } from './paths.js';

export interface LocalEnvironmentState {
  exists: boolean;
  paths: readonly string[];
}

/**
 * Detects setup-owned state before a new-environment wizard starts.
 *
 * Cloudflare inventory is not sufficient for this check: a partial/resource-type deletion can
 * intentionally preserve the local lock so that a later delete or repair can safely resume.
 */
export function inspectLocalEnvironmentState(input: {
  baseDir: string;
  environment: string;
}): LocalEnvironmentState {
  const current = getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment });
  const legacy = getLegacyPaths(input.baseDir, input.environment);
  const candidates = [current.config, current.lock, legacy.config, legacy.lock];
  const paths = [...new Set(candidates.filter((path) => existsSync(path)))];
  return { exists: paths.length > 0, paths };
}
