import type { AuthrimLock } from './lock.js';
import { reconcileD1ResourcesInLock } from './lock.js';
import { D1_DATABASES } from './naming.js';

/**
 * Fail closed when a fixed setup-managed D1 no longer has the UUID recorded in lock.json.
 *
 * Names are operator-facing labels and can be reused after deletion. Capacity and Control
 * operations must therefore authorize their D1 targets by the immutable Cloudflare UUID captured
 * in the environment lock, after comparing that UUID with a fresh account inventory.
 */
export function assertFixedD1ResourceIdentities(input: {
  environment: string;
  lock: AuthrimLock;
  databases: Array<{ name: string; uuid: string }>;
}): void {
  const fixedBindings = new Set(D1_DATABASES.map((database) => database.binding));
  const reconciliation = reconcileD1ResourcesInLock(input.lock, input.environment, input.databases);
  const mismatches = reconciliation.identityMismatches
    .filter((item) => fixedBindings.has(item.binding as (typeof D1_DATABASES)[number]['binding']))
    .map((item) => `D1:${item.binding}`);
  if (mismatches.length > 0) {
    throw new Error(`cloudflare_resource_identity_mismatch:${mismatches.join(',')}`);
  }
  const missing = reconciliation.missingBindings
    .filter((item) => fixedBindings.has(item.binding as (typeof D1_DATABASES)[number]['binding']))
    .map((item) => `D1:${item.binding}:${item.name}`);
  if (missing.length > 0) {
    throw new Error(`required_cloudflare_resources_missing:${missing.join(',')}`);
  }
}
