import type { CallLedger } from './call-ledger';

interface KVCacheEntry {
  value: string;
  expiration?: number;
}

/**
 * In-memory KV namespace fake. Records reads/writes/deletes in the call ledger and honors
 * expirationTtl against the real wall clock (which security matrix tests pin deterministically).
 * Structurally compatible with `KVNamespace` (cast at the Env boundary).
 */
export class MemoryKVNamespace {
  private store = new Map<string, KVCacheEntry>();
  private metadata = new Map<string, unknown>();
  private failingKeys = new Set<string>();

  constructor(
    private readonly ledger?: CallLedger,
    private readonly label = 'kv'
  ) {}

  /**
   * Make `get` on the given key throw. Used to exercise production degradation paths
   * (settings/KV read failures) deterministically. The attempted read is recorded in the
   * ledger with a failure detail so tests can distinguish a failed read from a cache miss.
   */
  setGetFailure(key: string): void {
    this.failingKeys.add(key);
  }

  resetGetFailures(): void {
    this.failingKeys.clear();
  }

  async get<T = string>(
    key: string,
    options?: { type?: string; cacheTtl?: number }
  ): Promise<T | null> {
    this.ledger?.record('kv.get', `${this.label}:${key}`);
    if (this.failingKeys.has(key)) {
      this.ledger?.record('kv.get', `${this.label}:${key}:failed`, { failed: true });
      throw new Error(`KV read failed for ${this.label}:${key}`);
    }
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration !== undefined && Date.now() > entry.expiration) {
      this.store.delete(key);
      return null;
    }
    if (options?.type === 'json') {
      return JSON.parse(entry.value) as T;
    }
    if (options?.type === 'arrayBuffer') {
      return new TextEncoder().encode(entry.value).buffer as unknown as T;
    }
    return entry.value as T;
  }

  async getWithMetadata<T = string>(
    key: string,
    options?: { type?: string; cacheTtl?: number }
  ): Promise<{ value: T | null; metadata: unknown | null }> {
    const value = await this.get<T>(key, options);
    return { value, metadata: this.metadata.get(key) ?? null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
  ): Promise<void> {
    this.ledger?.record('kv.put', `${this.label}:${key}`);
    const stringValue =
      typeof value === 'string'
        ? value
        : new TextDecoder().decode(
            value instanceof ArrayBuffer ? value : (value as ArrayBufferView)
          );
    const entry: KVCacheEntry = { value: stringValue };
    if (options?.expirationTtl !== undefined) {
      entry.expiration = Date.now() + options.expirationTtl * 1000;
    } else if (options?.expiration !== undefined) {
      entry.expiration = options.expiration;
    }
    this.store.set(key, entry);
    if (options?.metadata !== undefined) {
      this.metadata.set(key, options.metadata);
    }
  }

  async delete(key: string): Promise<void> {
    this.ledger?.record('kv.delete', `${this.label}:${key}`);
    this.store.delete(key);
    this.metadata.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const keys = Array.from(this.store.keys())
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .sort()
      .map((name) => {
        const entry = this.store.get(name);
        return {
          name,
          ...(entry?.expiration !== undefined ? { expiration: entry.expiration } : {}),
          ...(this.metadata.has(name) ? { metadata: this.metadata.get(name) } : {}),
        };
      });
    const limit = options?.limit ?? keys.length;
    return { keys: keys.slice(0, limit), list_complete: keys.length <= limit };
  }

  seed(key: string, value: string): void {
    this.store.set(key, { value });
  }

  snapshot(): Map<string, string> {
    return new Map(Array.from(this.store.entries()).map(([key, entry]) => [key, entry.value]));
  }
}
