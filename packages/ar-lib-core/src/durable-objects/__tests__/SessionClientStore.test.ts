import { beforeEach, describe, expect, it } from 'vitest';
import { SessionClientStore } from '../SessionClientStore';
import type { Env } from '../../types/env';

class MockDurableObjectState implements Partial<DurableObjectState> {
  private readonly store = new Map<string, unknown>();
  storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(this.store.get(key) as T | undefined),
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
        if (typeof keyOrEntries === 'string') {
          this.store.set(keyOrEntries, value);
        } else {
          for (const [key, entryValue] of Object.entries(keyOrEntries)) {
            this.store.set(key, entryValue);
          }
        }
        return Promise.resolve();
      },
      delete: (keyOrKeys: string | string[]): Promise<boolean | number> => {
        if (typeof keyOrKeys === 'string') {
          const existed = this.store.delete(keyOrKeys);
          return Promise.resolve(existed);
        }
        let count = 0;
        for (const key of keyOrKeys) {
          if (this.store.delete(key)) {
            count += 1;
          }
        }
        return Promise.resolve(count);
      },
      deleteAll: (): Promise<void> => {
        this.store.clear();
        return Promise.resolve();
      },
      list: <T>(options?: DurableObjectListOptions): Promise<Map<string, T>> => {
        const prefix = options?.prefix ?? '';
        const entries = new Map<string, T>();
        for (const [key, value] of this.store) {
          if (key.startsWith(prefix)) {
            entries.set(key, value as T);
          }
        }
        return Promise.resolve(entries);
      },
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
        closure(this.storage),
      getAlarm: (): Promise<number | null> => Promise.resolve(null),
      setAlarm: (): Promise<void> => Promise.resolve(),
      deleteAlarm: (): Promise<void> => Promise.resolve(),
      sync: (): Promise<void> => Promise.resolve(),
      transactionSync: <T>(closure: () => T): T => closure(),
      sql: {} as SqlStorage,
      kv: {} as KVNamespace,
      getCurrentBookmark: (): string => '',
      getBookmarkForTime: (): string => '',
      onNextSessionRestoreBookmark: (): void => {},
    } as unknown as DurableObjectStorage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

describe('SessionClientStore', () => {
  let state: MockDurableObjectState;
  let store: SessionClientStore;

  beforeEach(() => {
    state = new MockDurableObjectState();
    store = new SessionClientStore(state as unknown as DurableObjectState, {} as Env);
  });

  it('registers and updates session clients by client id', async () => {
    const first = await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-a',
      now: 100,
    });
    const second = await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-a',
      now: 200,
    });

    expect(second).toEqual({
      ...first,
      last_token_at: 200,
    });
    await expect(
      store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
    ).resolves.toEqual([second]);
  });

  it('rejects cross-session reuse of the same durable object instance', async () => {
    await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-a',
      now: 100,
    });

    await expect(
      store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-b',
        clientId: 'client-b',
        now: 100,
      })
    ).rejects.toThrow('session_client_store_session_mismatch');
  });

  it('deletes all clients for the pinned session', async () => {
    await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-a',
      now: 100,
    });
    await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-b',
      now: 101,
    });

    await expect(
      store.deleteSessionRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
    ).resolves.toBe(2);
    await expect(
      store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
    ).resolves.toEqual([]);
  });
});
