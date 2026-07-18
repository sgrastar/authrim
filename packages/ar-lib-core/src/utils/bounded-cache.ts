/**
 * Insert or refresh an entry while keeping a module-level Map within a fixed bound.
 *
 * JavaScript Maps preserve insertion order, so deleting an existing key before
 * re-inserting it also makes the entry the most recently used one. This is intended
 * for small Worker-isolate caches where a full cache implementation would be wasteful.
 */
export function setBoundedMapEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive safe integer');
  }

  cache.delete(key);
  while (cache.size >= maxEntries) {
    const oldestEntry = cache.keys().next();
    if (oldestEntry.done) {
      break;
    }
    cache.delete(oldestEntry.value);
  }
  cache.set(key, value);
}
