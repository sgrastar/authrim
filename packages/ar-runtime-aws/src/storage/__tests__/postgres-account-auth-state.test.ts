import { describe, expect, it } from 'vitest';
import { PostgresAccountAuthStateStore } from '../postgres-account-auth-state';
import type { PostgresQueryClient } from '../postgres-transient-state';

type State = {
  lifecycle: string;
  lifecycle_version_ms: string;
  lifecycle_operation_id: string | null;
  revoked_after_ms: string | null;
  last_login_at_ms: string | null;
};

class FakePostgres implements PostgresQueryClient {
  readonly accountStates = new Map<string, State>();
  readonly counters = new Map<string, number>();
  readonly statements: string[] = [];

  async query<Row extends Record<string, unknown>>(
    sql: string,
    values: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.statements.push(sql);
    const action = sql.match(/\/\* aws-account-auth:([\w-]+) \*\//)?.[1];
    const key = `${String(values[0])}\u0000${String(values[1])}`;
    const existing = this.accountStates.get(key);
    let rows: Record<string, unknown>[] = [];
    if (action === 'get-state') {
      if (existing) rows = [existing];
    } else if (action === 'initialize-state') {
      const state = existing ?? {
        lifecycle: values[3] as string,
        lifecycle_version_ms: String(values[4]),
        lifecycle_operation_id: null,
        revoked_after_ms: null,
        last_login_at_ms: null,
      };
      this.accountStates.set(key, state);
      rows = [state];
    } else if (action === 'advance-passkey-counter') {
      const counterKey = `${key}\u0000${String(values[3])}`;
      const sourceCounter = values[4] as number;
      const newCounter = values[5] as number;
      const stored = this.counters.get(counterKey);
      let counter: string | null = null;
      if (existing?.lifecycle === 'active') {
        const current = Math.max(stored ?? sourceCounter, sourceCounter);
        if ((current === 0 && newCounter === 0) || newCounter > current) {
          this.counters.set(counterKey, newCounter);
          counter = String(newCounter);
        }
      }
      rows = [{ lifecycle: existing?.lifecycle ?? null, counter }];
    } else {
      throw new Error(`Unexpected SQL action: ${action}`);
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

describe('PostgresAccountAuthStateStore', () => {
  const tenantId = 'tenant-a';
  const userId = 'user-a';
  const accountId = 'account:user-a';

  it('does not infer active from an absent restored account', async () => {
    const db = new FakePostgres();
    const store = new PostgresAccountAuthStateStore(db);
    expect(await store.getAccountStateRpc(tenantId, userId, accountId)).toEqual({
      revokedAfterMs: null,
      lastLoginAtMs: null,
      lifecycle: null,
      lifecycleVersionMs: null,
      lifecycleOperationId: null,
    });
    await expect(
      store.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 1, 1000)
    ).rejects.toThrow('account_auth_state_uninitialized');
    expect(db.counters.size).toBe(0);
  });

  it('rejects mismatched tenant/user/account and inactive lifecycle', async () => {
    const db = new FakePostgres();
    const store = new PostgresAccountAuthStateStore(db);
    await expect(store.getAccountStateRpc(tenantId, userId, 'account:other')).rejects.toThrow(
      'session_revocation_identity_invalid'
    );
    await store.initializeAccountStateRpc(tenantId, userId, accountId, 'suspended', 1000);
    expect((await store.getAccountStateRpc('tenant-b', userId, accountId)).lifecycle).toBeNull();
    await expect(
      store.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 1, 1001)
    ).rejects.toThrow('account_authentication_not_allowed');
    expect(db.counters.size).toBe(0);
    // The first trusted lifecycle cannot be overwritten by a later casual initializer.
    expect(
      (await store.initializeAccountStateRpc(tenantId, userId, accountId, 'active', 2000)).lifecycle
    ).toBe('suspended');
  });

  it('advances monotonically and accepts WebAuthn zero-counter semantics', async () => {
    const db = new FakePostgres();
    const store = new PostgresAccountAuthStateStore(db);
    await store.initializeAccountStateRpc(tenantId, userId, accountId, 'active', 1000);
    expect(
      await store.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 0, 1001)
    ).toEqual({ counter: 0, advanced: false });
    expect(
      await store.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 5, 1002)
    ).toEqual({ counter: 5, advanced: true });
    await expect(
      store.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 5, 1003)
    ).rejects.toThrow('passkey_counter_replay');
    await expect(
      store.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 10, 8, 1004)
    ).rejects.toThrow('passkey_counter_replay');
    expect(db.counters.get(`${tenantId}\u0000${userId}\u0000passkey-1`)).toBe(5);
  });

  it('allows only one concurrent advance for a repeated counter', async () => {
    const db = new FakePostgres();
    const first = new PostgresAccountAuthStateStore(db);
    const second = new PostgresAccountAuthStateStore(db);
    await first.initializeAccountStateRpc(tenantId, userId, accountId, 'active', 1000);
    const results = await Promise.allSettled([
      first.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 9, 1001),
      second.advancePasskeyCounterRpc(tenantId, userId, accountId, 'passkey-1', 0, 9, 1001),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const sql = db.statements.find((statement) => statement.includes(':advance-passkey-counter'));
    expect(sql).toMatch(/SELECT lifecycle[\s\S]*FOR UPDATE/);
    expect(sql).toMatch(/ON CONFLICT[\s\S]*EXCLUDED.counter > GREATEST/);
  });
});
