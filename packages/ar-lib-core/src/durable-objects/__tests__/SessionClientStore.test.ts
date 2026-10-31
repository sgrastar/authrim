import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_CLIENT_STORE_RETENTION_MS, SessionClientStore } from '../SessionClientStore';
import type { Env } from '../../types/env';

class MockDurableObjectState implements Partial<DurableObjectState> {
  readonly store = new Map<string, unknown>();
  alarmAt: number | null = null;
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
          if (options?.limit !== undefined && entries.size >= options.limit) {
            break;
          }
          if (key.startsWith(prefix)) {
            entries.set(key, value as T);
          }
        }
        return Promise.resolve(entries);
      },
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
        closure(this.storage),
      getAlarm: (): Promise<number | null> => Promise.resolve(this.alarmAt),
      setAlarm: (scheduledTime: number | Date): Promise<void> => {
        this.alarmAt = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
        return Promise.resolve();
      },
      deleteAlarm: (): Promise<void> => {
        this.alarmAt = null;
        return Promise.resolve();
      },
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

  it("records the client's ID token sub, and keeps it when a registration gives none", async () => {
    const register = (oidcSub: string | undefined, now: number) =>
      store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-a',
        oidcSid: 'sid-a',
        ...(oidcSub !== undefined ? { oidcSub } : {}),
        now,
      });

    await expect(register(' pairwise-sub ', 100)).resolves.toMatchObject({
      oidc_sub: ' pairwise-sub ',
    });
    await expect(register(undefined, 200)).resolves.toMatchObject({ oidc_sub: ' pairwise-sub ' });
    await expect(register('', 300)).resolves.toMatchObject({ oidc_sub: ' pairwise-sub ' });
    await expect(register('newer-sub', 400)).resolves.toMatchObject({ oidc_sub: 'newer-sub' });
    await expect(
      store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
    ).resolves.toEqual([expect.objectContaining({ oidc_sub: 'newer-sub', last_token_at: 400 })]);
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

  it('deletes everything the session instance holds and returns the sids of its aliases', async () => {
    await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-a',
      oidcSid: 'sid-a',
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
    ).resolves.toEqual({ deleted: 2, oidcSids: ['sid-a'] });
    // Client records, pinned context and expiry are all gone, and no alarm is left behind.
    expect(state.store.size).toBe(0);
    expect(state.alarmAt).toBeNull();
    await expect(
      store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
    ).resolves.toEqual([]);
  });

  it('refuses to delete another session through a pinned instance', async () => {
    await store.registerClientRpc({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      clientId: 'client-a',
    });

    await expect(
      store.deleteSessionRpc({ tenantId: 'tenant-a', sessionId: 'session-b' })
    ).rejects.toThrow('session_client_store_context_mismatch');
    expect(state.store.size).toBeGreaterThan(0);
  });

  describe('expiry', () => {
    const START = Date.UTC(2026, 9, 1);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('outlasts the longest session lifetime session.max_ttl allows (30 days) by a day', () => {
      // A logout reads the records after its response: a session ending at its expiry still
      // finds them.
      expect(SESSION_CLIENT_STORE_RETENTION_MS).toBe(31 * 24 * 60 * 60 * 1000);
    });

    it('keeps the alarm when removing the data fails, so the expiry still removes it', async () => {
      await store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-a',
        oidcSid: 'sid-a',
      });
      vi.spyOn(state.storage, 'deleteAll').mockRejectedValueOnce(new Error('storage unavailable'));

      await expect(
        store.deleteSessionRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
      ).rejects.toThrow('storage unavailable');

      expect(state.alarmAt).toBe(START + SESSION_CLIENT_STORE_RETENTION_MS);
      vi.setSystemTime(START + SESSION_CLIENT_STORE_RETENTION_MS);
      await store.alarm();
      expect(state.store.size).toBe(0);
    });

    it('sets an alarm for the retention after each registration and moves it on later ones', async () => {
      await store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-a',
      });
      expect(state.alarmAt).toBe(START + SESSION_CLIENT_STORE_RETENTION_MS);

      vi.setSystemTime(START + 1000);
      await store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-b',
      });
      expect(state.alarmAt).toBe(START + 1000 + SESSION_CLIENT_STORE_RETENTION_MS);
    });

    it('removes all data when the alarm fires after the retention', async () => {
      await store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-a',
        oidcSid: 'sid-a',
      });

      vi.setSystemTime(START + SESSION_CLIENT_STORE_RETENTION_MS);
      await store.alarm();

      expect(state.store.size).toBe(0);
      await expect(
        store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
      ).resolves.toEqual([]);
    });

    it('keeps the data and sets the alarm again when a registration moved the expiry', async () => {
      await store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-a',
      });
      vi.setSystemTime(START + 5000);
      await store.registerClientRpc({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        clientId: 'client-a',
      });

      // The first alarm fires late: the later registration's expiry has not passed yet.
      vi.setSystemTime(START + SESSION_CLIENT_STORE_RETENTION_MS);
      await store.alarm();

      await expect(
        store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' })
      ).resolves.toHaveLength(1);
      expect(state.alarmAt).toBe(START + 5000 + SESSION_CLIENT_STORE_RETENTION_MS);
    });

    it('gives an expiry to data written before the store had one when it is read', async () => {
      state.store.set('session-client-context:tenant-id', 'tenant-a');
      state.store.set('session-client-context:session-id', 'session-a');
      state.store.set('session-client:client-a', {
        id: 'record-a',
        tenant_id: 'tenant-a',
        session_id: 'session-a',
        client_id: 'client-a',
        first_token_at: 1,
        last_token_at: 1,
        last_seen_at: null,
      });

      await store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' });
      expect(state.alarmAt).toBe(START + SESSION_CLIENT_STORE_RETENTION_MS);

      // A later read does not move it.
      vi.setSystemTime(START + 1000);
      await store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' });
      expect(state.alarmAt).toBe(START + SESSION_CLIENT_STORE_RETENTION_MS);
    });

    it('writes nothing when an empty instance is read', async () => {
      await store.listClientsRpc({ tenantId: 'tenant-a', sessionId: 'session-a' });
      await store.resolveOidcSidAliasRpc({ tenantId: 'tenant-a', oidcSid: 'sid-a' });

      expect(state.store.size).toBe(0);
      expect(state.alarmAt).toBeNull();
    });

    it('expires oidc sid alias instances too', async () => {
      await store.registerOidcSidAliasRpc({
        tenantId: 'tenant-a',
        oidcSid: 'sid-a',
        sessionId: 'session-a',
      });
      expect(state.alarmAt).toBe(START + SESSION_CLIENT_STORE_RETENTION_MS);

      vi.setSystemTime(START + SESSION_CLIENT_STORE_RETENTION_MS);
      await store.alarm();

      await expect(
        store.resolveOidcSidAliasRpc({ tenantId: 'tenant-a', oidcSid: 'sid-a' })
      ).resolves.toBeNull();
      expect(state.store.size).toBe(0);
    });
  });

  describe('oidc sid alias removal', () => {
    beforeEach(async () => {
      await store.registerOidcSidAliasRpc({
        tenantId: 'tenant-a',
        oidcSid: 'sid-a',
        sessionId: 'session-a',
      });
    });

    it('removes the alias of the ended session', async () => {
      await expect(
        store.deleteOidcSidAliasRpc({
          tenantId: 'tenant-a',
          oidcSid: 'sid-a',
          sessionId: 'session-a',
        })
      ).resolves.toBe(true);
      expect(state.store.size).toBe(0);
      expect(state.alarmAt).toBeNull();
    });

    it.each([
      ['another session', { tenantId: 'tenant-a', oidcSid: 'sid-a', sessionId: 'session-b' }],
      ['another tenant', { tenantId: 'tenant-b', oidcSid: 'sid-a', sessionId: 'session-a' }],
      ['another sid', { tenantId: 'tenant-a', oidcSid: 'sid-b', sessionId: 'session-a' }],
    ])('leaves the alias alone when asked for %s', async (_label, input) => {
      await expect(store.deleteOidcSidAliasRpc(input)).resolves.toBe(false);
      await expect(
        store.resolveOidcSidAliasRpc({ tenantId: 'tenant-a', oidcSid: 'sid-a' })
      ).resolves.toBe('session-a');
    });
  });
});
