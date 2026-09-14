import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';

/** Retry the bounded Workers KV projection from the strongly consistent settings source. */
export async function processPendingSettingsProjections(
  env: Env,
  limit = 25,
  now: () => number = Date.now
): Promise<{ projected: number; failures: number }> {
  if (!env.SETTINGS) return { projected: 0, failures: 0 };
  const store = new DatabaseSettingsCanonicalStore(
    requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical'),
    now
  );
  const pending = await store.pending(limit);
  let projected = 0;
  let failures = 0;
  for (const item of pending) {
    try {
      await env.SETTINGS.put(item.storageKey, item.documentJson);
      await store.markProjected(item.category, item.scope, item.version);
      projected += 1;
    } catch {
      failures += 1;
    }
  }
  return { projected, failures };
}
