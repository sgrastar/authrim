import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { GuestLifecycleRepository } from '../../repositories/guest-lifecycle';
import { GuestUpgradeRepository } from '../../repositories/guest-upgrade';
import { commitGuestUpgrade } from '../guest-upgrade-coordinator';

describe('guest upgrade admission and crash recovery', () => {
  let db: DatabaseSync;
  let lifecycle: GuestLifecycleRepository;
  let operations: GuestUpgradeRepository;
  const commit = vi.fn(async () => {});
  const allowed = vi.fn(async () => true);
  beforeEach(async () => {
    vi.clearAllMocks();
    allowed.mockResolvedValue(true);
    commit.mockResolvedValue(undefined);
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE identity_accounts (tenant_id TEXT, legacy_user_id TEXT, account_type TEXT, deleted_at INTEGER);
      INSERT INTO identity_accounts VALUES ('tenant', 'guest', 'anonymous', NULL);`);
    for (const [family, name] of [
      ['core', 'guest_account_lifecycle'],
      ['pii', 'guest_upgrade_operations'],
    ]) {
      db.exec(
        readFileSync(
          new URL(`../../../../../migrations/${family}/d1/002_${name}.sql`, import.meta.url),
          'utf8'
        )
      );
    }
    const adapter = {
      async execute(sql: string, values: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(values as SQLInputValue[])).changes),
        };
      },
      async queryOne<T>(sql: string, values: unknown[] = []) {
        return (db.prepare(sql).get(...(values as SQLInputValue[])) ?? null) as T | null;
      },
    } as DatabaseAdapter;
    lifecycle = new GuestLifecycleRepository(adapter, 'tenant');
    operations = new GuestUpgradeRepository(adapter, 'tenant');
    await lifecycle.enroll({
      userId: 'guest',
      clientId: 'client',
      createdAt: 1,
      deletionAfterDays: 1,
      policyVersion: 'v1',
    });
    await operations.create({
      operationId: 'operation',
      userId: 'guest',
      clientId: 'client',
      sessionId: 'session',
      requestTokenHash: 'a'.repeat(64),
      method: 'email',
      payloadJson: '{"email":"guest@example.org"}',
      verifier: 'proof',
      now: 90000,
      expiresAt: 90600,
    });
    await operations.verifyEmail({
      operationId: 'operation',
      userId: 'guest',
      sessionId: 'session',
      requestTokenHash: 'a'.repeat(64),
      verifier: 'proof',
      now: 90001,
    });
  });
  afterEach(() => db.close());
  const run = (now = 90002, overrides: Partial<Parameters<typeof commitGuestUpgrade>[0]> = {}) =>
    commitGuestUpgrade({
      lifecycle,
      operations,
      userId: 'guest',
      clientId: 'client',
      operationId: 'operation',
      now,
      leaseOwner: 'worker',
      isAllowed: allowed,
      commit,
      ...overrides,
    });

  it('allows a verified upgrade after retention due, cancels deletion and redacts proof', async () => {
    expect(await run()).toBe('completed');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await lifecycle.get('guest')).toMatchObject({
      phase: 'registered',
      deletion_due_at: null,
    });
    expect(await operations.get('operation')).toMatchObject({
      state: 'completed',
      proof_payload_json: null,
      challenge_verifier: null,
    });
    expect(await lifecycle.beginDeletion('guest', 'delete', 99999)).toBe(false);
    expect(await run()).toBe('completed');
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('fences a stale verified request before proof erasure without blocking a later attempt', async () => {
    expect(await lifecycle.fenceExpiredProof('guest', 'operation', 90600, 90600)).toBe(true);
    // A worker that read proof before cleanup cannot admit with its stale clock.
    expect(await lifecycle.beginUpgrade('guest', 'operation', 90002, 90600)).toBe(false);
    await operations.eraseFencedProof('operation', 90600);
    expect(await operations.get('operation')).toMatchObject({
      state: 'canceled',
      proof_payload_json: null,
      challenge_verifier: null,
    });
    expect(await lifecycle.beginUpgrade('guest', 'new-attempt', 90601, 91201)).toBe(true);
  });
  it('keeps expired proof when admission won so recovery can roll forward', async () => {
    expect(await lifecycle.beginUpgrade('guest', 'operation', 90002, 90600)).toBe(true);
    expect(await lifecycle.fenceExpiredProof('guest', 'operation', 90600, 90600)).toBe(false);
    expect(await run(90601)).toBe('completed');
    expect(commit).toHaveBeenCalledOnce();
  });
  it('never fences unexpired proof or another tenant', async () => {
    expect(await lifecycle.fenceExpiredProof('guest', 'operation', 90600, 90599)).toBe(false);
    expect(await lifecycle.fenceExpiredProof('missing-user', 'operation', 90600, 90600)).toBe(
      false
    );
    expect(await run()).toBe('completed');
  });
  it('pins reservation indexes once across key rotation and erases them on completion', async () => {
    expect(await operations.pinReservation('operation', '{"generation":1}')).toBe(
      '{"generation":1}'
    );
    expect(await operations.pinReservation('operation', '{"generation":2}')).toBe(
      '{"generation":1}'
    );
    expect(await run()).toBe('completed');
    expect((await operations.get('operation'))?.reservation_publication_json).toBeNull();
  });
  it('rejects expired proof before admission', async () => {
    expect(await run(90600)).toBe('expired');
    expect(commit).not.toHaveBeenCalled();
    expect((await lifecycle.get('guest'))?.phase).toBe('active');
  });
  it('rechecks permissions before any commit or lifecycle mutation', async () => {
    allowed.mockResolvedValue(false);
    expect(await run()).toBe('denied');
    expect(commit).not.toHaveBeenCalled();
    expect((await lifecycle.get('guest'))?.phase).toBe('active');
  });
  it('rejects deletion winning during the permission read', async () => {
    allowed.mockImplementationOnce(async () => {
      expect(await lifecycle.beginDeletion('guest', 'delete', 90002)).toBe(true);
      return true;
    });
    expect(await run()).toBe('denied');
    expect(commit).not.toHaveBeenCalled();
  });
  it('rejects a different account or client before side effects', async () => {
    expect(await run(90002, { userId: 'other' })).toBe('denied');
    expect(await run(90002, { clientId: 'other' })).toBe('denied');
    expect(commit).not.toHaveBeenCalled();
  });
  it('recovers a core admission before the PII lease, even after proof expiry', async () => {
    await lifecycle.beginUpgrade('guest', 'operation', 90002, 90602);
    allowed.mockResolvedValue(false);
    expect(await run(91000)).toBe('completed');
    expect(allowed).not.toHaveBeenCalled();
  });
  it('waits for an existing lease then retries durable side effects after failure', async () => {
    commit.mockRejectedValueOnce(new Error('transient_database_failure'));
    await expect(run()).rejects.toThrow('transient_database_failure');
    expect((await lifecycle.get('guest'))?.phase).toBe('upgrading');
    expect(await lifecycle.beginDeletion('guest', 'delete', 90003)).toBe(false);
    expect(await run(90003, { leaseOwner: 'worker-2' })).toBe('pending');
    expect(await run(90062, { leaseOwner: 'worker-2' })).toBe('completed');
    expect(commit).toHaveBeenCalledTimes(2);
  });
  it('only redacts PII when recovering after core completion', async () => {
    await lifecycle.beginUpgrade('guest', 'operation', 90002, 90602);
    await operations.leaseCommit('operation', 'crashed-worker', 90002);
    await lifecycle.completeUpgrade('guest', 'operation', 90002);
    expect(await run(90062)).toBe('completed');
    expect(commit).not.toHaveBeenCalled();
    expect((await operations.get('operation'))?.proof_payload_json).toBeNull();
  });
  it('does not let a second verified operation claim an admitted guest', async () => {
    await lifecycle.beginUpgrade('guest', 'other-operation', 90002, 90602);
    expect(await run()).toBe('denied');
    expect(commit).not.toHaveBeenCalled();
  });
});
