import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import { SessionRevocationStore } from '../SessionRevocationStore';

class MockDurableObjectState implements Partial<DurableObjectState> {
  private readonly data = new Map<string, unknown>();
  storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(this.data.get(key) as T | undefined),
      put: (key: string, value: unknown): Promise<void> => {
        this.data.set(key, structuredClone(value));
        return Promise.resolve();
      },
      delete: (key: string): Promise<boolean> => Promise.resolve(this.data.delete(key)),
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
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 900)
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
        store.registerSessionRpc('tenant-a', userId, `account:${userId}`, 1_000)
      ).resolves.toEqual({
        revokedAfterMs: null,
        revocationBoundAtMs: 1_000,
      });
    }
  );

  it('rejects malformed or conflicting identities', async () => {
    await expect(
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-b', 1_000)
    ).rejects.toThrow('session_revocation_identity_invalid');

    await store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 1_000);
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
      store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 2_001)
    ).rejects.toThrow('account_authentication_not_allowed');
  });

  it('preserves account lifecycle when registering a session', async () => {
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);

    await store.registerSessionRpc('tenant-a', 'user-a', 'account:user-a', 1_001);

    await expect(
      store.getAccountStateRpc('tenant-a', 'user-a', 'account:user-a')
    ).resolves.toMatchObject({ lifecycle: 'active', lifecycleVersionMs: 1_000 });
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
