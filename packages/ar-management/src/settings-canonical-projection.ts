import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import {
  DatabaseSettingsCanonicalStore,
  type PendingSettingsProjection,
} from '@authrim/ar-lib-core/services/settings-canonical-store';
import {
  generateVersion,
  projectLatestSettingsDocument,
} from '@authrim/ar-lib-core/utils/settings-manager';

/** Recently changed documents are compared with KV first, so a lost write is repaired fast. */
const RECONCILE_WINDOW_MS = 10 * 60 * 1000;

/** Retry the bounded Workers KV projection from the strongly consistent settings source. */
export async function processPendingSettingsProjections(
  env: Env,
  limit = 25,
  now: () => number = Date.now
): Promise<{ projected: number; failures: number; repaired: number }> {
  if (!env.SETTINGS) return { projected: 0, failures: 0, repaired: 0 };
  const kv = env.SETTINGS;
  const store = new DatabaseSettingsCanonicalStore(
    requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical'),
    now
  );
  const pending = await store.pending(limit);
  let projected = 0;
  let failures = 0;
  for (const item of pending) {
    // Project the latest canonical document, not the one listed as pending: a save may have
    // landed since, and writing the listed (older) document would leave KV behind it.
    try {
      const result = await projectLatestSettingsDocument(
        store,
        env.SETTINGS,
        item.category,
        item.scope,
        item.storageKey
      );
      if (result === 'applied') projected += 1;
      else failures += 1;
    } catch {
      failures += 1;
    }
  }

  // KV has no conditional write: a slow projection of an older version can land after a newer
  // one was projected and marked, leaving nothing pending, and a briefly cached KV read can
  // hide it. Two passes compare documents with KV and project the latest again where they
  // differ: recently changed documents first (fast repair), then the documents compared least
  // recently, so each one gets its turn however long ago it changed, however many changed at
  // once, and after any outage. Pending documents there are projected again directly.
  let repaired = 0;
  const reconcile = async (
    item: PendingSettingsProjection,
    state: 'pending' | 'applied' = 'applied'
  ): Promise<boolean> => {
    try {
      if (state === 'applied') {
        const raw = await kv.get(item.storageKey);
        if (raw !== null && projectedVersion(raw) === item.version) return true;
      }
      const result = await projectLatestSettingsDocument(
        store,
        kv,
        item.category,
        item.scope,
        item.storageKey
      );
      if (result === 'applied') {
        repaired += 1;
        return true;
      }
    } catch {
      // Handled below.
    }
    failures += 1;
    // Record the document as pending so it is not lost; the sweep reaches every document,
    // pending ones included, so it is retried in turn even while others keep failing. Only when
    // even that cannot be recorded does the sweep have to stop here and come back to it.
    try {
      await store.markPending(item.category, item.scope, item.version);
      return true;
    } catch {
      return false;
    }
  };

  const recent = await store.recentlyProjected(Math.max(0, now() - RECONCILE_WINDOW_MS), limit);
  for (const item of recent) await reconcile(item);

  // Then the documents compared least recently, whatever their state. Each one tried is moved
  // to the back of the queue whether or not it worked, so documents that keep failing cannot
  // hold the front and every document gets its turn; a failed one comes round again after the
  // rest. (While the database refuses every write nothing can be recorded, projections
  // included; the queue moves on again once writes succeed.)
  const due = await store.leastRecentlyReconciled(limit);
  for (const item of due) {
    await reconcile(item, item.projectionState);
    try {
      await store.markReconciled(item.category, item.scope);
    } catch {
      failures += 1;
    }
  }

  return { projected, failures, repaired };
}

function projectedVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? generateVersion(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
