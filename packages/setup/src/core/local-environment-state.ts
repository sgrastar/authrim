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
  const candidates = [
    current.config,
    current.lock,
    current.provisioningIntent,
    current.pendingEmailSecrets,
    current.pendingControlBootstrap,
    current.controlTokenCleanup,
    legacy.config,
    legacy.lock,
  ];
  const paths = [...new Set(candidates.filter((path) => existsSync(path)))];
  // An otherwise unknown or future checkpoint inside the setup-owned environment directory must
  // not be silently inherited by a new environment with the same name.
  if (paths.length === 0 && existsSync(current.root)) paths.push(current.root);
  return { exists: paths.length > 0, paths };
}
