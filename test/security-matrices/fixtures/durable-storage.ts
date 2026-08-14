import type { CallLedger } from './call-ledger';

/**
 * In-memory Durable Object storage for security matrix tests. Structurally matches the
 * `DurableObjectStorage` contract (cast at the boundary) so real state owners can run over it.
 * This provides sequential decision-logic and instance-reconstruction evidence only; it does
 * not simulate Cloudflare input gates, alarms, or crash/restart recovery.
 */
export class MemoryDurableObjectStorage {
  private store = new Map<string, unknown>();
  private alarm: number | null = null;
  private failingKeyPrefixes = new Set<string>();

  constructor(
    private readonly ledger?: CallLedger,
    private readonly label = 'do-storage'
  ) {}

  /**
   * Make `get` on keys with the given prefix throw. Used to exercise production
   * degradation paths (for example a failing session-store read) deterministically.
   * The attempted read is recorded in the ledger with a failure detail so tests can
   * distinguish a failed read from a missing key.
   */
  setGetFailure(keyPrefix: string): void {
    this.failingKeyPrefixes.add(keyPrefix);
  }

  clearGetFailures(): void {
    this.failingKeyPrefixes.clear();
  }

  private throwIfFailing(key: string): void {
    for (const prefix of this.failingKeyPrefixes) {
      if (key.startsWith(prefix)) {
        this.ledger?.record('do.fetch', `${this.label}:get:${key}:failed`, { failed: true });
        throw new Error(`Durable storage read failed for ${this.label}:${key}`);
      }
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined>;
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, T>();
      for (const key of keyOrKeys) {
        this.throwIfFailing(key);
        const value = this.store.get(key);
        if (value !== undefined) result.set(key, value as T);
      }
      this.ledger?.record('do.fetch', `${this.label}:get[]`, keyOrKeys);
      return result;
    }
    this.throwIfFailing(keyOrKeys);
    this.ledger?.record('do.fetch', `${this.label}:get:${keyOrKeys}`);
    return this.store.get(keyOrKeys) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void>;
  async put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.store.set(keyOrEntries, value as T);
      this.ledger?.record('do.fetch', `${this.label}:put:${keyOrEntries}`);
      return;
    }
    for (const [key, entryValue] of Object.entries(keyOrEntries)) {
      this.store.set(key, entryValue);
    }
    this.ledger?.record('do.fetch', `${this.label}:put:${Object.keys(keyOrEntries).join(',')}`);
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let deleted = 0;
      for (const key of keyOrKeys) {
        if (this.store.delete(key)) deleted += 1;
      }
      this.ledger?.record('do.fetch', `${this.label}:delete[]`, keyOrKeys);
      return deleted;
    }
    this.ledger?.record('do.fetch', `${this.label}:delete:${keyOrKeys}`);
    return this.store.delete(keyOrKeys);
  }

  async deleteAll(): Promise<void> {
    this.store.clear();
    this.ledger?.record('do.fetch', `${this.label}:deleteAll`);
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) deleted += 1;
    }
    this.ledger?.record('do.fetch', `${this.label}:deleteMany`, keys);
    return deleted;
  }

  /**
   * Sequential decision-logic transaction view. There is no rollback/atomicity semantics here:
   * the transaction context simply reads/writes the same backing map, which is sufficient for
   * the local Node test contract. It does not simulate Cloudflare transaction isolation.
   */
  async transaction<T>(
    callback: (txn: {
      get<TVal = unknown>(key: string): Promise<TVal | undefined>;
      put<TVal>(key: string, value: TVal): Promise<void>;
      delete(key: string): Promise<boolean>;
    }) => Promise<T>
  ): Promise<T> {
    return callback({
      get: async <TVal = unknown>(key: string) => this.store.get(key) as TVal | undefined,
      put: async <TVal>(key: string, value: TVal) => {
        this.store.set(key, value);
        this.ledger?.record('do.fetch', `${this.label}:put:${key}`);
      },
      delete: async (key: string) => this.store.delete(key),
    });
  }

  async list<T = unknown>(options?: {
    prefix?: string;
    start?: string;
    startAfter?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const entries = Array.from(this.store.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of entries) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue;
      result.set(key, value as T);
    }
    this.ledger?.record('do.fetch', `${this.label}:list:${options?.prefix ?? ''}`);
    return result;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    this.ledger?.record('do.fetch', `${this.label}:setAlarm`);
  }

  async getAlarm(): Promise<number | null> {
    this.ledger?.record('do.fetch', `${this.label}:getAlarm`);
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
    this.ledger?.record('do.fetch', `${this.label}:deleteAlarm`);
  }

  snapshot(): Map<string, unknown> {
    return new Map(this.store);
  }

  restore(snapshot: Map<string, unknown>): void {
    this.store = new Map(snapshot);
  }
}

export interface MemoryDurableObjectStateOptions {
  idName?: string;
  storage?: MemoryDurableObjectStorage;
  ledger?: CallLedger;
  blockConcurrencyWhile?: (callback: () => Promise<unknown>) => Promise<unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Create a fake `DurableObjectState` bound to the provided memory storage. The
 * `blockConcurrencyWhile` default simply executes the callback so sequential decision logic
 * runs; it does not serialize concurrent requests.
 */
export function createMemoryDurableObjectState(
  options: MemoryDurableObjectStateOptions
): DurableObjectState {
  const storage = options.storage ?? new MemoryDurableObjectStorage(options.ledger);
  const idName = options.idName ?? 'memory-do';
  return {
    id: {
      toString: () => idName,
      equals: (other: { toString(): string }) => other.toString() === idName,
      name: idName,
    },
    storage,
    blockConcurrencyWhile: options.blockConcurrencyWhile ?? ((callback) => callback()),
    waitUntil: options.waitUntil ?? (() => undefined),
  } as unknown as DurableObjectState;
}
