/**
 * In-isolate cache of anonymized user IDs (user_anonymization_map) for the event_log mirror.
 *
 * The mapping lives in the user's PII store and the mirror runs on every audited request, so a
 * request only ever uses an entry already here; a miss is read or created after the response.
 *
 * Deleting a mapping elsewhere does not reach this cache. An entry is therefore kept only for
 * ANONYMIZED_USER_ID_CACHE_TTL_MS: within that time a new event can still carry the old
 * anonymized ID, which is no more linkable than the user's earlier events once the mapping is
 * gone. The cache never writes an ID back to the store, so it cannot recreate a deleted mapping.
 */

/** Most entries kept per isolate; the oldest is dropped first. */
export const ANONYMIZED_USER_ID_CACHE_MAX_ENTRIES = 1000;
/** How long an entry is used after it was read from the PII store. */
export const ANONYMIZED_USER_ID_CACHE_TTL_MS = 60_000;

const cache = new Map<string, { anonymizedUserId: string; expiresAt: number }>();

function cacheKey(tenantId: string, userId: string): string {
  return `${tenantId}\u0000${userId}`;
}

export function getCachedAnonymizedUserId(
  tenantId: string,
  userId: string,
  now = Date.now()
): string | undefined {
  const key = cacheKey(tenantId, userId);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.anonymizedUserId;
}

export function cacheAnonymizedUserId(
  tenantId: string,
  userId: string,
  anonymizedUserId: string,
  now = Date.now()
): void {
  const key = cacheKey(tenantId, userId);
  // Re-inserting moves the key to the end, so the first key is always the oldest entry.
  cache.delete(key);
  while (cache.size >= ANONYMIZED_USER_ID_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { anonymizedUserId, expiresAt: now + ANONYMIZED_USER_ID_CACHE_TTL_MS });
}

/** Drop a user's entry, when this isolate deletes the user's mapping. */
export function forgetCachedAnonymizedUserId(tenantId: string, userId: string): void {
  cache.delete(cacheKey(tenantId, userId));
}

/** Test support: empty the cache. */
export function clearAnonymizedUserIdCache(): void {
  cache.clear();
}

/** Test support: the number of entries held. */
export function anonymizedUserIdCacheSize(): number {
  return cache.size;
}
