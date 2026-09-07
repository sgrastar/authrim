import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import { SessionRevocationStore } from '../SessionRevocationStore';

class MockDurableObjectState implements Partial<DurableObjectState> {
  private readonly data: Map<string, unknown>;
  storage: DurableObjectStorage;

  constructor(data = new Map<string, unknown>()) {
    this.data = data;
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(this.data.get(key) as T | undefined),
      put: (key: string, value: unknown): Promise<void> => {
        this.data.set(key, structuredClone(value));
        return Promise.resolve();
      },
      delete: (key: string | string[]): Promise<boolean | number> => {
        if (Array.isArray(key)) {
          let deleted = 0;
          for (const item of key) deleted += this.data.delete(item) ? 1 : 0;
          return Promise.resolve(deleted);
        }
        return Promise.resolve(this.data.delete(key));
      },
      list: <T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> =>
        Promise.resolve(
          new Map(
            [...this.data.entries()]
              .filter(([key]) => (options?.prefix ? key.startsWith(options.prefix) : true))
              .sort(([left], [right]) => left.localeCompare(right))
              .slice(0, options?.limit) as [string, T][]
          )
        ),
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
        closure(this.storage),
    } as unknown as DurableObjectStorage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

describe('SessionRevocationStore', () => {
  let store: SessionRevocationStore;

  beforeEach(() => {
    const state = new MockDurableObjectState();
    store = new SessionRevocationStore(state as unknown as DurableObjectState, {} as Env);
  });

  it('registers a session after the current epoch and records last login', async () => {
    await expect(store.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 1_000)).resolves.toBe(
      1_000
    );

    await expect(
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 900, 'session-1', 2_000)
    ).resolves.toEqual({
      revokedAfterMs: 1_000,
      revocationBoundAtMs: 1_001,
    });
    await expect(store.getLastLoginAtRpc('tenant-a', 'user-a', 'account:user-a')).resolves.toBe(
      1_001
    );
  });

  it('keeps revocation monotonic across retries', async () => {
    await store.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 2_000);
    await expect(store.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 1_500)).resolves.toBe(
      2_000
    );
    await expect(store.getRevokedAfterRpc('tenant-a', 'user-a', 'account:user-a')).resolves.toBe(
      2_000
    );
  });

  it.each(['_base64url-user', '-base64url-user'])(
    'accepts a valid runtime user ID beginning with %s',
    async (userId) => {
      await expect(
        store.registerSessionRpc('tenant-a', userId, `account:${userId}`, 1_000, 'session-1', 2_000)
      ).resolves.toEqual({
        revokedAfterMs: null,
        revocationBoundAtMs: 1_000,
      });
    }
  );

  it('rejects malformed or conflicting identities', async () => {
    await expect(
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-b', 1_000, 'session-1', 2_000)
    ).rejects.toThrow('session_revocation_identity_invalid');

    await store.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      1_000,
      'session-1',
      2_000
    );
    await expect(store.getRevokedAfterRpc('tenant-a', 'user-b', 'account:user-b')).rejects.toThrow(
      'session_revocation_identity_mismatch'
    );
  });

  it('initializes lifecycle once and rejects inactive session registration', async () => {
    await expect(
      store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000)
    ).resolves.toMatchObject({ lifecycle: 'active', lifecycleVersionMs: 1_000 });
    await expect(
      store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'suspended', 2_000)
    ).resolves.toMatchObject({ lifecycle: 'active', lifecycleVersionMs: 1_000 });

    await store.setAccountLifecycleRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      'suspended',
      2_000,
      'operation-1',
      true
    );
    await expect(
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 2_001, 'session-1', 3_000)
    ).rejects.toThrow('account_authentication_not_allowed');
  });

  it('preserves account lifecycle when registering a session', async () => {
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);

    await store.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      1_001,
      'session-1',
      2_000
    );

    await expect(
      store.getAccountStateRpc('tenant-a', 'user-a', 'account:user-a')
    ).resolves.toMatchObject({ lifecycle: 'active', lifecycleVersionMs: 1_000 });
  });

  it('indexes active sessions, removes explicit logout, and hides revoke-all entries', async () => {
    await store.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      1_000,
      'session-1',
      3_000,
      { ipAddress: '203.0.113.1', userAgent: 'Browser' }
    );
    await expect(
      store.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 1_500)
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        ipAddress: '203.0.113.1',
        userAgent: 'Browser',
      }),
    ]);

    await expect(
      store.unregisterSessionRpc('tenant-a', 'user-a', 'account:user-a', 'session-1')
    ).resolves.toBe(true);
    await expect(
      store.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 1_500)
    ).resolves.toEqual([]);

    await store.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      2_000,
      'session-2',
      4_000
    );
    await store.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 2_000);
    await expect(
      store.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 2_100)
    ).resolves.toEqual([]);
  });

  it('updates only the matching session expiration and rejects mismatched identities', async () => {
    await store.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      1_000,
      'session-1',
      2_000
    );
    await expect(
      store.updateSessionExpirationRpc('tenant-a', 'user-a', 'account:user-a', 'session-1', 4_000)
    ).resolves.toBe(true);
    await expect(
      store.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 3_000)
    ).resolves.toEqual([expect.objectContaining({ sessionId: 'session-1', expiresAtMs: 4_000 })]);
    await expect(
      store.updateSessionExpirationRpc('tenant-b', 'user-a', 'account:user-a', 'session-1', 5_000)
    ).rejects.toThrow('session_revocation_identity_mismatch');
  });

  it('restores the authoritative epoch and index from Durable Object storage after restart', async () => {
    const data = new Map<string, unknown>();
    const first = new SessionRevocationStore(
      new MockDurableObjectState(data) as unknown as DurableObjectState,
      {} as Env
    );
    await first.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      1_000,
      'session-1',
      3_000
    );

    const restarted = new SessionRevocationStore(
      new MockDurableObjectState(data) as unknown as DurableObjectState,
      {} as Env
    );
    await expect(
      restarted.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 1_500)
    ).resolves.toHaveLength(1);
    await restarted.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 1_500);
    await expect(
      restarted.getRevokedAfterRpc('tenant-a', 'user-a', 'account:user-a')
    ).resolves.toBe(1_500);
  });

  it('keeps concurrent session registrations request-local and retains both index entries', async () => {
    await Promise.all([
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 1_000, 'session-1', 3_000),
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 1_001, 'session-2', 3_000),
    ]);

    await expect(
      store.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 1_500)
    ).resolves.toHaveLength(2);
  });

  it('fails closed when a user session index exceeds its bounded scan limit', async () => {
    for (let index = 0; index <= 1_000; index += 1) {
      await store.registerSessionRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        1_000 + index,
        `session-${index}`,
        10_000
      );
    }

    await expect(
      store.listActiveSessionsRpc('tenant-a', 'user-a', 'account:user-a', 5_000)
    ).rejects.toThrow('session_index_limit_exceeded');
  });

  it('indexes external-provider sessions by a digest-only identity and rejects cross-tenant reuse', async () => {
    const claimDigest = 'a'.repeat(64);
    await store.registerExternalProviderSessionRpc(
      'tenant-a',
      'provider-a',
      'sid',
      claimDigest,
      'session-1',
      'user-a',
      3_000
    );

    await expect(
      store.listExternalProviderSessionsRpc('tenant-a', 'provider-a', 'sid', claimDigest, 1_500)
    ).resolves.toEqual([{ sessionId: 'session-1', userId: 'user-a', expiresAtMs: 3_000 }]);
    await expect(
      store.listExternalProviderSessionsRpc('tenant-b', 'provider-a', 'sid', claimDigest, 1_500)
    ).rejects.toThrow('external_provider_session_identity_mismatch');
  });

  it('expires and unregisters external-provider session index entries', async () => {
    const claimDigest = 'b'.repeat(64);
    await store.registerExternalProviderSessionRpc(
      'tenant-a',
      'provider-a',
      'sub',
      claimDigest,
      'session-expired',
      'user-a',
      1_000
    );
    await expect(
      store.listExternalProviderSessionsRpc('tenant-a', 'provider-a', 'sub', claimDigest, 1_000)
    ).resolves.toEqual([]);

    await store.registerExternalProviderSessionRpc(
      'tenant-a',
      'provider-a',
      'sub',
      claimDigest,
      'session-active',
      'user-a',
      3_000
    );
    await expect(
      store.unregisterExternalProviderSessionRpc(
        'tenant-a',
        'provider-a',
        'sub',
        claimDigest,
        'session-active'
      )
    ).resolves.toBe(true);
  });

  it('fails closed when an external-provider session index exceeds its bounded scan limit', async () => {
    const claimDigest = 'c'.repeat(64);
    for (let index = 0; index <= 1_000; index += 1) {
      await store.registerExternalProviderSessionRpc(
        'tenant-a',
        'provider-a',
        'sid',
        claimDigest,
        `session-${index}`,
        `user-${index}`,
        10_000
      );
    }

    await expect(
      store.listExternalProviderSessionsRpc('tenant-a', 'provider-a', 'sid', claimDigest, 5_000)
    ).rejects.toThrow('external_provider_session_limit_exceeded');
  });

  it('keeps lifecycle transitions monotonic and idempotent', async () => {
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);
    const restricted = await store.setAccountLifecycleRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      'locked',
      2_000,
      'operation-1',
      true
    );
    expect(restricted).toMatchObject({ lifecycle: 'locked', revokedAfterMs: 2_000 });
    await expect(
      store.setAccountLifecycleRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'locked',
        2_000,
        'operation-1',
        true
      )
    ).resolves.toEqual(restricted);
    await expect(
      store.setAccountLifecycleRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'active',
        2_000,
        'operation-2',
        false
      )
    ).rejects.toThrow('account_authentication_lifecycle_conflict');
    await expect(
      store.setAccountLifecycleRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'active',
        1_500,
        'operation-3',
        false
      )
    ).rejects.toThrow('account_authentication_lifecycle_stale');
  });

  it('atomically advances Passkey counters with WebAuthn zero semantics', async () => {
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);
    await expect(
      store.advancePasskeyCounterRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'passkey-1',
        0,
        0,
        1_001
      )
    ).resolves.toEqual({ counter: 0, advanced: false });
    await expect(
      store.advancePasskeyCounterRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'passkey-1',
        0,
        5,
        1_002
      )
    ).resolves.toEqual({ counter: 5, advanced: true });
    await expect(
      store.advancePasskeyCounterRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'passkey-1',
        0,
        5,
        1_003
      )
    ).rejects.toThrow('passkey_counter_replay');
  });

  it('rejects a reused TOTP time-step and separates credentials', async () => {
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);
    await expect(
      store.consumeTotpTimeStepRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'totp-1',
        null,
        100,
        1_001
      )
    ).resolves.toEqual({ lastAcceptedTimeStep: 100 });
    await expect(
      store.consumeTotpTimeStepRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'totp-1',
        null,
        100,
        1_002
      )
    ).rejects.toThrow('totp_time_step_replay');
    await expect(
      store.consumeTotpTimeStepRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'totp-2',
        null,
        100,
        1_003
      )
    ).resolves.toEqual({ lastAcceptedTimeStep: 100 });
  });
});
