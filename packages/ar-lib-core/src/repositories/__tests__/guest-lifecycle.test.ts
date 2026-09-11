import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { GuestLifecycleRepository } from '../guest-lifecycle';

describe.each(['d1', 'postgresql'])('guest lifecycle conditional SQL (%s schema)', (dialect) => {
  let sqlite: DatabaseSync;
  let repository: GuestLifecycleRepository;
  let otherTenant: GuestLifecycleRepository;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE identity_accounts (
      tenant_id TEXT, legacy_user_id TEXT, account_type TEXT, deleted_at INTEGER, registration_state TEXT, updated_at INTEGER);
      INSERT INTO identity_accounts VALUES ('tenant-1', 'guest-1', 'user', NULL, 'guest', 0);
      INSERT INTO identity_accounts VALUES ('tenant-2', 'guest-1', 'user', NULL, 'guest', 0);
      INSERT INTO identity_accounts VALUES ('tenant-1', 'device-1', 'device', NULL, 'registered', 0);`);
    sqlite.exec(
      readFileSync(
        new URL(
          `../../../../../migrations/core/${dialect}/002_guest_account_lifecycle.sql`,
          import.meta.url
        ),
        'utf8'
      )
    );
    const params = (values: unknown[] = []): SQLInputValue[] =>
      values.map((value) => {
        if (value === null || typeof value === 'string' || typeof value === 'number') return value;
        throw new Error('unsupported_test_sql_value');
      });
    const adapter: DatabaseAdapter = {
      async query<T>(sql: string, values?: unknown[]) {
        return sqlite.prepare(sql).all(...params(values)) as T[];
      },
      async queryOne<T>(sql: string, values?: unknown[]) {
        return (sqlite.prepare(sql).get(...params(values)) ?? null) as T | null;
      },
      async execute(sql, values) {
        return {
          success: true,
          rowsAffected: Number(sqlite.prepare(sql).run(...params(values)).changes),
        };
      },
      async transaction() {
        throw new Error('not_used');
      },
      async batch(statements) {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map(({ sql, params: values }) => ({
            success: true,
            rowsAffected: Number(sqlite.prepare(sql).run(...params(values)).changes),
          }));
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
      async isHealthy() {
        return { healthy: true, latencyMs: 0, type: 'sqlite' };
      },
      getType() {
        return 'sqlite';
      },
    };
    repository = new GuestLifecycleRepository(adapter, 'tenant-1');
    otherTenant = new GuestLifecycleRepository(adapter, 'tenant-2');
  });
  afterEach(() => sqlite.close());

  const enrollment = {
    userId: 'guest-1',
    clientId: 'app-1',
    createdAt: 1000,
    deletionAfterDays: 1,
    policyVersion: 'v1',
  };

  it('snapshots the creation deadline and never extends it on re-enrollment', async () => {
    await repository.enroll(enrollment);
    const again = await repository.enroll({
      ...enrollment,
      createdAt: 90000,
      deletionAfterDays: 365,
    });
    expect(again).toMatchObject({ created_at: 1000, deletion_due_at: 87400, policy_version: 'v1' });
    expect(await otherTenant.get('guest-1')).toBeNull();
    await expect(repository.enroll({ ...enrollment, userId: 'device-1' })).rejects.toThrow(
      'guest_account_enrollment_failed'
    );
  });

  it.each([-1, 0, 1])(
    'admits an upgrade only strictly before proof expiry (offset %i)',
    async (offset) => {
      await repository.enroll(enrollment);
      expect(await repository.beginUpgrade('guest-1', 'upgrade-1', 2000 + offset, 2000)).toBe(
        offset < 0
      );
      expect((await repository.get('guest-1'))?.phase).toBe(offset < 0 ? 'upgrading' : 'active');
    }
  );
  it('excludes a cleaned-up proof even when admission carries a stale time snapshot', async () => {
    await repository.enroll(enrollment);
    expect(await repository.fenceExpiredProof('guest-1', 'old', 2000, 1999)).toBe(false);
    expect(await repository.fenceExpiredProof('guest-1', 'old', 2000, 2000)).toBe(true);
    expect(await repository.beginUpgrade('guest-1', 'old', 1999, 2000)).toBe(false);
    expect(await repository.beginUpgrade('guest-1', 'new', 2000, 2001)).toBe(true);
  });
  it('never selects or admits unscheduled guests for deletion', async () => {
    await repository.enroll({ ...enrollment, deletionAfterDays: null });
    expect(await repository.listDeletionCandidates(999999999)).toEqual([]);
    expect(await repository.beginDeletion('guest-1', 'delete', 999999999)).toBe(false);
  });

  it('records an explicit administrator deletion independently of retention', async () => {
    await repository.enroll({ ...enrollment, deletionAfterDays: null });
    expect(
      await repository.beginAdministrativeDeletion(
        'guest-1',
        'admin-delete-1',
        2000,
        '{"schemaVersion":1}',
        2000001
      )
    ).toBe(true);
    expect(await repository.get('guest-1')).toMatchObject({
      phase: 'deleting',
      deletion_operation_id: 'admin-delete-1',
      deletion_route_json: '{"schemaVersion":1}',
      deletion_started_at_ms: 2000001,
    });
    expect(
      await repository.beginAdministrativeDeletion(
        'guest-1',
        'admin-delete-2',
        2001,
        '{"schemaVersion":1}'
      )
    ).toBe(false);
    expect(await repository.completeDeletion('guest-1', 'admin-delete-2', 2002)).toBe(false);
    expect(await repository.completeDeletion('guest-1', 'admin-delete-1', 2002)).toBe(true);
    expect(await repository.get('guest-1')).toMatchObject({
      phase: 'deleted',
      deletion_operation_id: 'admin-delete-1',
      deleted_at: 2002,
    });
  });

  it('acquires the hold once, rejects deletion during it, and expires at its exact boundary', async () => {
    await repository.enroll(enrollment);
    expect(await repository.acquireHold('guest-1', 87400, 10)).toMatchObject({
      upgrade_hold_until: 88000,
    });
    expect(await repository.beginDeletion('guest-1', 'delete-1', 87999)).toBe(false);
    await repository.acquireHold('guest-1', 89000, 60);
    expect(await repository.get('guest-1')).toMatchObject({ upgrade_hold_until: 88000 });
    expect(await repository.beginDeletion('guest-1', 'delete-1', 88000)).toBe(true);
    expect(await repository.acquireHold('guest-1', 88001, 10)).toBeNull();
    expect(await repository.beginUpgrade('guest-1', 'upgrade-1', 88001, 88601)).toBe(false);
  });

  it('lets only one concurrent upgrade/delete claimant win', async () => {
    await repository.enroll(enrollment);
    const winners = await Promise.all([
      repository.beginUpgrade('guest-1', 'upgrade-1', 90000, 90600),
      repository.beginDeletion('guest-1', 'delete-1', 90000),
      repository.beginUpgrade('guest-1', 'upgrade-2', 90000, 90600),
    ]);
    expect(winners).toEqual([true, false, false]);
    expect(await repository.completeUpgrade('guest-1', 'upgrade-2', 90001)).toBe(false);
    expect(await repository.completeUpgrade('guest-1', 'upgrade-1', 90001)).toBe(true);
    expect(await repository.get('guest-1')).toMatchObject({
      phase: 'registered',
      deletion_due_at: null,
    });
    expect(await repository.listDeletionCandidates(999999)).toEqual([]);
  });

  it('rolls back the stored registration if lifecycle commit fails', async () => {
    await repository.enroll(enrollment);
    await repository.beginUpgrade('guest-1', 'upgrade-1', 1000, 1600);
    sqlite.exec(`CREATE TRIGGER fail_registration BEFORE UPDATE OF phase ON guest_account_lifecycle
      WHEN NEW.phase = 'registered' BEGIN SELECT RAISE(ABORT, 'commit_failed'); END;`);
    await expect(repository.completeUpgrade('guest-1', 'upgrade-1', 1001)).rejects.toThrow(
      'commit_failed'
    );
    expect(
      sqlite
        .prepare(
          'SELECT registration_state FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?'
        )
        .get('tenant-1', 'guest-1')
    ).toMatchObject({ registration_state: 'guest' });
    expect(await repository.get('guest-1')).toMatchObject({ phase: 'upgrading' });
    sqlite.exec('DROP TRIGGER fail_registration');
    expect(await repository.completeUpgrade('guest-1', 'upgrade-1', 1002)).toBe(true);
    expect(
      sqlite
        .prepare(
          'SELECT registration_state FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?'
        )
        .get('tenant-1', 'guest-1')
    ).toMatchObject({ registration_state: 'registered' });
    expect(
      sqlite
        .prepare(
          'SELECT registration_state FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?'
        )
        .get('tenant-2', 'guest-1')
    ).toMatchObject({ registration_state: 'guest' });
  });

  it('retains deletion ownership across retries and fences other tenants', async () => {
    await repository.enroll(enrollment);
    await otherTenant.enroll(enrollment);
    expect(await repository.beginDeletion('guest-1', 'delete-1', 90000)).toBe(true);
    expect(await repository.listDeletionCandidates(90001)).toHaveLength(1);
    expect(await repository.completeDeletion('guest-1', 'wrong', 90002)).toBe(false);
    expect(await otherTenant.completeDeletion('guest-1', 'delete-1', 90002)).toBe(false);
    expect(await repository.completeDeletion('guest-1', 'delete-1', 90002)).toBe(true);
    expect(await otherTenant.get('guest-1')).toMatchObject({ phase: 'active' });
  });

  it('applies reviewed retention only to the unchanged active revision', async () => {
    const row = await repository.enroll(enrollment);
    expect(await repository.applyRetention('guest-1', row.revision, 7, 'v2', 1001)).toBe(true);
    expect(await repository.get('guest-1')).toMatchObject({ deletion_due_at: 605800 });
    expect(await repository.applyRetention('guest-1', row.revision, 1, 'v3', 1002)).toBe(false);
    const current = await repository.get('guest-1');
    expect(await repository.applyRetention('guest-1', current!.revision, null, 'v4', 1003)).toBe(
      true
    );
    expect(await repository.listDeletionCandidates(99999999)).toEqual([]);
    await repository.beginUpgrade('guest-1', 'u1', 1004, 1604);
    expect(await repository.applyRetention('guest-1', current!.revision + 1, 1, 'v5', 1005)).toBe(
      false
    );
  });
});
