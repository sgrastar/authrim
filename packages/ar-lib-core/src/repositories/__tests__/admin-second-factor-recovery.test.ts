import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { AdminSecondFactorRepository } from '../admin/admin-second-factor';
import {
  ADMIN_SECOND_FACTOR_RECOVERY_COMPLETION_WINDOW_MS,
  ADMIN_SECOND_FACTOR_RECOVERY_WAIT_MS,
  AdminSecondFactorRecoveryRepository,
  type AdminSecondFactorRecoveryInput,
} from '../admin/admin-second-factor-recovery';
import { sqliteAdapter } from './sqlite-core-schema';

const ADMIN_MIGRATIONS = new URL('../../../../../migrations/admin/d1/', import.meta.url);
const T0 = 1_000_000;
const AFTER_WAIT = T0 + ADMIN_SECOND_FACTOR_RECOVERY_WAIT_MS;

function adminSchema(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const fixture = sqliteAdapter('admin');
  for (const file of [
    '003_admin_session_passkey_evidence.sql',
    '004_admin_second_factors.sql',
    '005_admin_second_factor_recoveries.sql',
  ]) {
    fixture.db.exec(
      renderPortableMigrationSql(readMigrationSource(ADMIN_MIGRATIONS, file), 'sqlite')
    );
  }
  return fixture;
}

function request(overrides: Partial<AdminSecondFactorRecoveryInput> = {}) {
  return {
    admin_user_id: 'admin-1',
    tenant_id: 'default',
    credential_id: 'cred-new',
    public_key: 'cGs=',
    counter: 0,
    transports: ['usb'],
    label: 'New key',
    requested_session_id: 'sess-1',
    ...overrides,
  };
}

describe('AdminSecondFactorRecoveryRepository in the real admin schema', () => {
  let db: DatabaseSync;
  let recoveries: AdminSecondFactorRecoveryRepository;
  let factors: AdminSecondFactorRepository;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = adminSchema());
    recoveries = new AdminSecondFactorRecoveryRepository(adapter);
    factors = new AdminSecondFactorRepository(adapter);
    for (const id of ['admin-1', 'admin-2']) {
      db.prepare(
        `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
         VALUES (?, 'default', ?, ?, ?)`
      ).run(id, `${id}@example.com`, Date.now(), Date.now());
    }
    const session = db.prepare(
      `INSERT INTO admin_sessions (
         id, tenant_id, admin_user_id, created_at, expires_at, second_factor_id,
         second_factor_verified_at
       ) VALUES (?, 'default', ?, 1, 9999999999999, ?, ?)`
    );
    session.run('sess-1', 'admin-1', 'old', 5);
    session.run('sess-2', 'admin-1', null, null);
    session.run('sess-other', 'admin-2', null, null);
  });

  /** Files a request and marks its notices sent, as the route does. */
  async function file(input = request(), now = T0) {
    const result = await recoveries.create(input, now);
    if (result.created) await recoveries.markNotified(result.recovery.id, now);
    return result;
  }

  async function oldFactor(credentialId = 'cred-old') {
    const result = await factors.insertWebAuthn(
      {
        admin_user_id: 'admin-1',
        credential_id: credentialId,
        public_key: 'cGs=',
        counter: 0,
        backup_eligible: false,
        backup_state: false,
      },
      { firstOnly: false }
    );
    if (!result.inserted) throw new Error('setup failed');
    return result.factor;
  }

  it('files one pending request per admin with its waiting period', async () => {
    const first = await file();
    const second = await file(request({ credential_id: 'cred-2' }));

    expect(first).toMatchObject({
      created: true,
      recovery: {
        status: 'pending',
        not_before: AFTER_WAIT,
        expires_at: AFTER_WAIT + ADMIN_SECOND_FACTOR_RECOVERY_COMPLETION_WINDOW_MS,
      },
    });
    expect(second).toEqual({ created: false, reason: 'already_pending' });
  });

  it('closes a request past its window so a new one can be filed', async () => {
    await file();
    const later = AFTER_WAIT + ADMIN_SECOND_FACTOR_RECOVERY_COMPLETION_WINDOW_MS;

    const again = await recoveries.create(request({ credential_id: 'cred-2' }), later);

    expect(again.created).toBe(true);
    expect(
      db.prepare('SELECT status FROM admin_second_factor_recoveries ORDER BY requested_at').all()
    ).toEqual([{ status: 'expired' }, { status: 'pending' }]);
  });

  it('refuses a credential that is already a passkey or a second factor', async () => {
    await oldFactor('cred-new');

    expect(await file()).toEqual({
      created: false,
      reason: 'credential_in_use',
    });
  });

  it('never completes a request whose notices did not all go out, and closes it on the next', async () => {
    const old = await oldFactor();
    const unseen = await recoveries.create(request(), T0);
    if (!unseen.created) throw new Error('setup failed');

    expect(await recoveries.findOpenByUser('admin-1', T0)).toBeNull();
    expect(await recoveries.listOpenByTenant('default', T0)).toEqual([]);
    expect(await recoveries.complete('admin-1', 'sess-1', AFTER_WAIT)).toEqual({
      completed: false,
      reason: 'not_found',
    });
    expect(await factors.isActive('admin-1', old.id)).toBe(true);

    expect((await file(request({ credential_id: 'cred-2' }), T0 + 1)).created).toBe(true);
    expect(await recoveries.findById(unseen.recovery.id)).toMatchObject({ status: 'expired' });
    expect(await recoveries.markNotified(unseen.recovery.id, T0 + 2)).toBe(false);
  });

  it('does not complete before the waiting period ends', async () => {
    await file();

    expect(await recoveries.complete('admin-1', 'sess-1', AFTER_WAIT - 1)).toEqual({
      completed: false,
      reason: 'too_early',
    });
  });

  it('replaces the factors and ends the other sessions in one completion', async () => {
    const old = await oldFactor();
    await file();

    const result = await recoveries.complete('admin-1', 'sess-1', AFTER_WAIT);
    if (!result.completed) throw new Error('not completed');

    const active = await factors.listActiveByUser('admin-1');
    expect(active.map((factor) => [factor.id, factor.credential_id])).toEqual([
      [result.secondFactorId, 'cred-new'],
    ]);
    expect(await factors.isActive('admin-1', old.id)).toBe(false);
    expect(
      db
        .prepare(
          'SELECT id, second_factor_id, second_factor_verified_at FROM admin_sessions ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 'sess-1', second_factor_id: null, second_factor_verified_at: null },
      { id: 'sess-other', second_factor_id: null, second_factor_verified_at: null },
    ]);
    expect(await recoveries.findOpenByUser('admin-1', AFTER_WAIT)).toBeNull();
    expect(await recoveries.complete('admin-1', 'sess-1', AFTER_WAIT)).toEqual({
      completed: false,
      reason: 'not_found',
    });
  });

  it('changes nothing when the request was cancelled before completion', async () => {
    const old = await oldFactor();
    const filed = await file();
    if (!filed.created) throw new Error('setup failed');

    expect(
      await recoveries.cancel(
        filed.recovery.id,
        { tenantId: 'default' },
        { adminUserId: 'admin-2', reason: 'admin' },
        T0 + 1
      )
    ).toBe(true);

    expect(await recoveries.complete('admin-1', 'sess-1', AFTER_WAIT)).toEqual({
      completed: false,
      reason: 'not_found',
    });
    expect(await factors.isActive('admin-1', old.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 3 });
    expect(await recoveries.findById(filed.recovery.id)).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'admin-2',
      cancel_reason: 'admin',
    });
  });

  it('cancels only inside the given scope and only while pending', async () => {
    const filed = await file();
    if (!filed.created) throw new Error('setup failed');
    const id = filed.recovery.id;
    const by = { adminUserId: 'admin-2', reason: 'admin' as const };

    expect(await recoveries.cancel(id, { tenantId: 'tenant-b' }, by, T0)).toBe(false);
    expect(await recoveries.cancel(id, { adminUserId: 'admin-2' }, by, T0)).toBe(false);
    expect(
      await recoveries.cancel(
        id,
        { adminUserId: 'admin-1' },
        { adminUserId: 'admin-1', reason: 'requester' },
        T0
      )
    ).toBe(true);
    expect(await recoveries.cancel(id, { tenantId: 'default' }, by, T0)).toBe(false);
  });

  it('rolls the completion back when the new credential became a passkey meanwhile', async () => {
    const old = await oldFactor();
    await file();
    db.prepare(
      `INSERT INTO admin_passkeys (id, admin_user_id, credential_id, public_key, created_at)
       VALUES ('pk-1', 'admin-1', 'cred-new', 'cGs=', 1)`
    ).run();

    await expect(recoveries.complete('admin-1', 'sess-1', AFTER_WAIT)).rejects.toThrow();

    expect(await factors.isActive('admin-1', old.id)).toBe(true);
    expect(await recoveries.findOpenByUser('admin-1', AFTER_WAIT)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 3 });
  });

  it('lists only the tenant’s open requests', async () => {
    await file();
    await file(
      request({ admin_user_id: 'admin-2', tenant_id: 'tenant-b', credential_id: 'cred-b' })
    );

    expect((await recoveries.listOpenByTenant('default', T0)).map((r) => r.admin_user_id)).toEqual([
      'admin-1',
    ]);
  });
});
