import { vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * In-memory Durable Storage for tests that drive a store through its HTTP routes: ordered keys,
 * `prefix`, `startAfter` and `limit` on list, and multi-key get, put and delete.
 */
export class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly alarms: number[] = [];
  /**
   * While set, a write is applied at once but its promise waits for this one, as Durable Storage
   * applies writes in the order they are issued whatever the caller does with the promise.
   */
  holdPuts: Promise<void> | null = null;

  async list<T>(options?: {
    prefix?: string;
    limit?: number;
    startAfter?: string;
  }): Promise<Map<string, T>> {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options?.prefix ?? ''))
      .filter((key) => options?.startAfter === undefined || key > options.startAfter)
      .sort();
    const limited = options?.limit === undefined ? keys : keys.slice(0, options.limit);
    return new Map(limited.map((key) => [key, structuredClone(this.values.get(key))])) as Map<
      string,
      T
    >;
  }

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      return new Map(
        key
          .filter((entry) => this.values.has(entry))
          .map((entry) => [entry, structuredClone(this.values.get(entry))])
      ) as Map<string, T>;
    }
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === 'string') {
      this.values.set(key, structuredClone(value));
    } else {
      for (const [entryKey, entryValue] of Object.entries(key)) {
        this.values.set(entryKey, structuredClone(entryValue));
      }
    }
    if (this.holdPuts) await this.holdPuts;
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    if (!Array.isArray(keys)) return this.values.delete(keys);
    return keys.filter((key) => this.values.delete(key)).length;
  }

  /** Durable Storage's explicit transaction: a throw in the callback undoes every write in it. */
  async transaction<T>(
    callback: (txn: Pick<MemoryStorage, 'get' | 'put' | 'delete' | 'list'>) => Promise<T>
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback({
        get: this.get.bind(this),
        put: this.put.bind(this),
        delete: this.delete.bind(this),
        list: this.list.bind(this),
      });
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarms.push(timestamp);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarms.at(-1) ?? null;
  }
}

export function durableState(storage = new MemoryStorage()): {
  state: DurableObjectState;
  storage: MemoryStorage;
  initialized: () => Promise<void>;
} {
  let initialized = Promise.resolve();
  const state = {
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => {
      initialized = callback();
      return initialized;
    }),
  } as unknown as DurableObjectState;
  return { state, storage, initialized: () => initialized };
}

export function storeRequest(path: string, body: unknown, tenant = 'tenant-a'): Request {
  return new Request(`https://store.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenant },
    body: JSON.stringify(body),
  });
}
