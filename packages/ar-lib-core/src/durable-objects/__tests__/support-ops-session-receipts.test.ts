/**
 * Actual SessionRevocationStore RPCs with a real SQLite-backed Durable Storage KV transaction.
 * Only the cloudflare:workers base class is shimmed by the package's normal Vitest setup.
 * This does not emulate Workers input gates or test Admin's caller-side transfer persistence.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import { SessionRevocationStore, type UserSessionIndexEntry } from '../SessionRevocationStore';
import type { SupportOpsSessionReceiptLease } from '../support-ops-session-receipt';

const IDENTITY = ['tenant-a', 'user-a', 'account:user-a'] as const;
const RECEIPT = 'support-ops-session-receipt';
const ITEMS = 'support-ops-session-receipt-item:';
type SqlValue = string | number | bigint | Uint8Array | null;
interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number | bigint };
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
  };
}
// The runtime is Node22+, while Core's supported Node ambient types predate node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};
const opened: SqliteDatabase[] = [];

class SqliteReceiptStorage {
  readonly raw = new DatabaseSync(':memory:');
  readonly limits: Array<{ prefix: string; limit: number }> = [];
  afterList: (() => Promise<void>) | undefined;

  constructor() {
    opened.push(this.raw);
    this.raw.exec('CREATE TABLE kv(k TEXT PRIMARY KEY NOT NULL,v TEXT NOT NULL)');
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = this.raw.prepare('SELECT v FROM kv WHERE k=?').get(key) as
      | { v: string }
      | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('fixture_storage_value_invalid');
    this.raw
      .prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(key, serialized);
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(key: string | string[]): Promise<boolean | number> {
    const many = Array.isArray(key);
    const keys = many ? key : [key];
    if (keys.length > 128) throw new Error('fixture_delete_key_limit');
    let deleted = 0;
    for (const item of keys) {
      deleted += Number(this.raw.prepare('DELETE FROM kv WHERE k=?').run(item).changes);
    }
    return many ? deleted : deleted > 0;
  }

  async list<T>(options: {
    prefix: string;
    limit: number;
    startAfter?: string;
  }): Promise<Map<string, T>> {
    const { prefix, limit, startAfter = '' } = options;
    this.limits.push({ prefix, limit });
    const rows = this.raw
      .prepare('SELECT k,v FROM kv WHERE substr(k,1,?)=? AND k>? ORDER BY k LIMIT ?')
      .all(prefix.length, prefix, startAfter, limit) as Array<{ k: string; v: string }>;
    const result = new Map(rows.map(({ k, v }) => [k, JSON.parse(v) as T]));
    // One controlled interleave after the read, before the caller rereads the expired key.
    const callback = this.afterList;
    this.afterList = undefined;
    if (callback) await callback();
    return result;
  }

  async transaction<T>(work: (storage: SqliteReceiptStorage) => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN');
    try {
      const result = await work(this);
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture() {
  const storage = new SqliteReceiptStorage();
  const store = new SessionRevocationStore({ storage } as unknown as DurableObjectState, {} as Env);
  const register = (id: string, requested = 1_000, expires = 100_000) =>
    store.registerSessionRpc(...IDENTITY, requested, id, expires);
  const begin = (operation = 'op-1', version = 10_000, owner = 'owner-1', now = 10_000) =>
    store.beginSupportOpsSuspensionRpc(...IDENTITY, version, operation, owner, now);
  const read = (
    lease: SupportOpsSessionReceiptLease,
    operation = 'op-1',
    owner = 'owner-1',
    now = 10_001
  ) => store.readSupportOpsSuspensionReceiptRpc(...IDENTITY, operation, owner, lease.fence, now);
  const ack = (
    lease: SupportOpsSessionReceiptLease,
    sequence: number,
    operation = 'op-1',
    owner = 'owner-1',
    now = 10_001
  ) =>
    store.acknowledgeSupportOpsSuspensionReceiptRpc(
      ...IDENTITY,
      operation,
      owner,
      lease.fence,
      sequence,
      now
    );
  async function drain(
    lease: SupportOpsSessionReceiptLease,
    operation = 'op-1',
    owner = 'owner-1',
    now = 10_001
  ) {
    const ids: string[] = [];
    for (let calls = 0; calls < 2_000; calls++) {
      const page = await read(lease, operation, owner, now);
      expect(page.sessionIds.length).toBeLessThanOrEqual(10);
      if (page.stage === 'drained' || page.stage === 'complete') return { ids, page };
      if (page.sessionIds.length) {
        ids.push(...page.sessionIds);
        await ack(lease, page.sequence, operation, owner, now);
      }
    }
    throw new Error('fixture_unbounded_drain');
  }
  return { storage, store, register, begin, read, ack, drain };
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe('Support Ops bounded durable session receipts (real SQLite KV)', () => {
  it('transfers all 2,051 sessions with scans of 100 and pages of 10, retaining completion', async () => {
    const f = fixture();
    for (let i = 0; i < 2_051; i++) await f.register(`session-${String(i).padStart(4, '0')}`);
    const lease = await f.begin();
    expect(lease).not.toHaveProperty('sessionIds');
    expect(lease.currentState).toMatchObject({ lifecycle: 'suspended', revokedAfterMs: 10_000 });
    f.storage.limits.length = 0;

    const { ids, page } = await f.drain(lease);

    expect(ids).toHaveLength(2_051);
    expect(new Set(ids).size).toBe(2_051);
    const scans = f.storage.limits.filter((entry) => entry.prefix === 'session-index:');
    expect(scans).toHaveLength(21);
    expect(scans.every((entry) => entry.limit === 100)).toBe(true);
    const transfers = f.storage.limits.filter((entry) => entry.prefix === ITEMS);
    expect(transfers.length).toBeGreaterThan(0);
    expect(transfers.every((entry) => entry.limit <= 10)).toBe(true);
    expect(await f.storage.get(RECEIPT)).toMatchObject({ complete: false, operationId: 'op-1' });
    await f.store.completeSupportOpsSuspensionReceiptRpc(
      ...IDENTITY,
      10_000,
      'op-1',
      'owner-1',
      lease.fence,
      page.sequence,
      10_002
    );
    expect(await f.storage.get(RECEIPT)).toMatchObject({ complete: true, operationId: 'op-1' });
    expect(await f.storage.list({ prefix: ITEMS, limit: 1 })).toEqual(new Map());
  });

  it('replays a lost read and lost ACK response without skipping a page or allowing an unfinished replacement', async () => {
    const f = fixture();
    for (let i = 0; i < 12; i++) await f.register(`session-${i}`);
    const lease = await f.begin();
    // The first call scans; the next returns a stable page that its caller loses.
    expect((await f.read(lease)).sessionIds).toEqual([]);
    const page = await f.read(lease);
    expect(page.sessionIds).toHaveLength(10);
    expect(await f.read(lease)).toEqual(page);
    await expect(f.begin('op-2', 20_000)).rejects.toThrow('support_ops_receipt_busy');
    // Admin would persist these deterministic jobs before the ACK; lose the ACK response only.
    await f.ack(lease, page.sequence);
    const afterAck = await f.storage.get(RECEIPT);
    await f.ack(lease, page.sequence);
    expect(await f.storage.get(RECEIPT)).toEqual(afterAck);
    const rest = await f.drain(lease);
    expect(rest.ids).toHaveLength(2);
    expect(new Set([...page.sessionIds, ...rest.ids]).size).toBe(12);
    await expect(f.begin('op-2', 20_000)).rejects.toThrow('support_ops_receipt_busy');
    expect(await f.store.getAccountStateRpc(...IDENTITY)).toMatchObject({
      lifecycleVersionMs: 10_000,
    });
  });

  it('captures the original IDs across normal reactivation, unregister and same-ID registration', async () => {
    const f = fixture();
    await f.register('same-id');
    await f.register('removed-id');
    const lease = await f.begin();
    await f.store.setAccountLifecycleRpc(...IDENTITY, 'active', 20_000, 'normal-reactivate', false);
    await f.register('same-id', 21_000, 200_000);
    await f.store.unregisterSessionRpc(...IDENTITY, 'removed-id');
    expect(await f.begin()).toMatchObject({
      currentState: { lifecycle: 'active', lifecycleOperationId: 'normal-reactivate' },
    });

    const { ids } = await f.drain(lease);

    expect(ids.sort()).toEqual(['removed-id', 'same-id']);
    expect(await f.storage.get('session-index:same-id')).toMatchObject({
      revocationBoundAtMs: 21_000,
      expiresAtMs: 200_000,
    });
    expect(await f.storage.get('session-index:removed-id')).toBeUndefined();
    expect(await f.store.getAccountStateRpc(...IDENTITY)).toMatchObject({
      lifecycle: 'active',
      lifecycleVersionMs: 20_000,
    });
  });

  it('rereads an expired entry transactionally after renewal and preserves its receipt ID', async () => {
    const f = fixture();
    await f.register('expiring', 1_000, 15_000);
    const lease = await f.begin();
    f.storage.afterList = async () => {
      const entry = await f.storage.get<UserSessionIndexEntry>('session-index:expiring');
      if (!entry) throw new Error('fixture_session_missing');
      await f.storage.put('session-index:expiring', { ...entry, expiresAtMs: 50_000 });
    };

    await f.store.listActiveSessionsRpc(...IDENTITY, 20_000);

    expect(await f.storage.get('session-index:expiring')).toMatchObject({ expiresAtMs: 50_000 });
    expect((await f.drain(lease)).ids).toEqual(['expiring']);
  });

  it('rejects stale owners, expired fences, unread ACKs and foreign tenants without losing IDs', async () => {
    const f = fixture();
    await f.register('session');
    const first = await f.begin();
    await expect(f.begin('op-1', 10_000, 'owner-2', 10_001)).rejects.toThrow(
      'support_ops_receipt_lease_lost'
    );
    await expect(f.ack(first, first.sequence)).rejects.toThrow('support_ops_receipt_page_not_read');
    await expect(f.read(first, 'op-1', 'owner-1', 71_000)).rejects.toThrow(
      'support_ops_receipt_lease_lost'
    );
    const next = await f.begin('op-1', 10_000, 'owner-2', 71_000);
    expect(next.fence).toBeGreaterThan(first.fence);
    const before = await f.storage.get(RECEIPT);
    await expect(f.read(first, 'op-1', 'owner-1', 71_001)).rejects.toThrow(
      'support_ops_receipt_lease_lost'
    );
    await expect(
      f.store.readSupportOpsSuspensionReceiptRpc(
        'other-tenant',
        'user-a',
        'account:user-a',
        'op-1',
        'owner-2',
        next.fence,
        71_001
      )
    ).rejects.toThrow('session_revocation_identity_mismatch');
    expect(await f.storage.get(RECEIPT)).toEqual(before);
    expect((await f.drain(next, 'op-1', 'owner-2', 71_001)).ids).toEqual(['session']);
  });

  it('replays an old completion from durable Admin transfer evidence without touching a newer operation', async () => {
    const f = fixture();
    await f.register('old-session');
    const lease = await f.begin();
    const transferred = await f.drain(lease);
    expect(transferred.ids).toEqual(['old-session']);
    // Stand-in for the caller's separate Admin persistence: written before complete ACK, and
    // loaded again after that ACK is lost. This test does not exercise the Management writer.
    const admin = new DatabaseSync(':memory:');
    opened.push(admin);
    admin.exec(
      'CREATE TABLE transferred(operation TEXT PRIMARY KEY,sequence INTEGER,account_result INTEGER)'
    );
    admin.prepare('INSERT INTO transferred VALUES(?,?,1)').run('op-1', transferred.page.sequence);
    await f.store.completeSupportOpsSuspensionReceiptRpc(
      ...IDENTITY,
      10_000,
      'op-1',
      'owner-1',
      lease.fence,
      transferred.page.sequence,
      10_002
    );
    // The caller received no completion response. A normal action and a newer job happen.
    await f.store.setAccountLifecycleRpc(...IDENTITY, 'active', 20_000, 'normal-reactivate', false);
    await f.register('new-session', 21_000, 200_000);
    const newer = await f.begin('op-2', 30_000, 'owner-2', 30_000);
    const progress = admin
      .prepare('SELECT sequence,account_result FROM transferred WHERE operation=?')
      .get('op-1') as { sequence: number; account_result: number };
    expect(progress.account_result).toBe(1);
    const newerBefore = await f.storage.get(RECEIPT);
    const stateBefore = await f.store.getAccountStateRpc(...IDENTITY);

    await f.store.completeSupportOpsSuspensionReceiptRpc(
      ...IDENTITY,
      10_000,
      'op-1',
      'owner-1',
      0,
      progress.sequence,
      30_001
    );

    expect(await f.storage.get(RECEIPT)).toEqual(newerBefore);
    expect(await f.store.getAccountStateRpc(...IDENTITY)).toEqual(stateBefore);
    expect((await f.drain(newer, 'op-2', 'owner-2', 30_001)).ids).toEqual(['new-session']);
  });

  it('preserves the legacy lifecycle retry response without implicitly opting into receipts', async () => {
    const f = fixture();
    await f.register('session');
    const apply = () =>
      f.store.setAccountLifecycleEndingSessionsRpc(
        ...IDENTITY,
        'suspended',
        10_000,
        'legacy-op',
        true,
        10_000
      );
    expect((await apply()).endedSessions).toHaveLength(1);
    expect((await apply()).endedSessions).toEqual([]);
    expect(await f.storage.get(RECEIPT)).toBeUndefined();
  });

  it('rolls back the lifecycle and epoch when creating the durable receipt fails', async () => {
    const f = fixture();
    await f.register('session');
    const before = await f.store.getAccountStateRpc(...IDENTITY);
    f.storage.raw.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON kv
      WHEN NEW.k='support-ops-session-receipt' BEGIN SELECT RAISE(ABORT,'receipt_write_failure'); END`);

    await expect(f.begin()).rejects.toThrow('receipt_write_failure');

    expect(await f.store.getAccountStateRpc(...IDENTITY)).toEqual(before);
    expect(await f.storage.get(RECEIPT)).toBeUndefined();
    expect(await f.storage.get('session-index:session')).toMatchObject({
      revocationBoundAtMs: 1_000,
    });
  });
});
