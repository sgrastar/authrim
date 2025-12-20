/**
 * Platform-agnostic Actor Storage abstraction
 *
 * Cloudflare: ctx.storage (DurableObjectStorage)
 * Future: Redis + DynamoDB, etc.
 *
 * NOTE:
 * This interface is intentionally minimal.
 * Do NOT add transaction, alarm, or batch operations here.
 * TTL management is handled at the application layer.
 */
export interface ActorStorage {
  /**
   * Get a value by key
   * @returns The value or null if not found
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Store a value with optional TTL hint
   * Note: TTL is advisory - actual expiration depends on implementation
   */
  put<T>(key: string, value: T, options?: StoragePutOptions): Promise<void>;

  /**
   * Delete a single key
   * @returns true if the key existed
   */
  delete(key: string): Promise<boolean>;

  /**
   * Delete multiple keys
   * @returns The number of keys deleted
   */
  deleteMany(keys: string[]): Promise<number>;

  /**
   * List all keys with optional prefix filter
   * @returns Map of key-value pairs
   */
  list<T>(options?: StorageListOptions): Promise<Map<string, T>>;
}

export interface StoragePutOptions {
  /**
   * TTL hint in seconds (advisory, may not be supported by all implementations)
   */
  expirationTtl?: number;
}

export interface StorageListOptions {
  /**
   * Filter keys by prefix
   */
  prefix?: string;

  /**
   * Maximum number of results
   */
  limit?: number;
}
