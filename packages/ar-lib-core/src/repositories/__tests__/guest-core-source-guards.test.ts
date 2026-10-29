import { afterEach, describe, expect, it } from 'vitest';
import { GuestLifecycleRepository } from '../guest-lifecycle';
import { sqliteAdapter } from './sqlite-core-schema';
import { guestDeletionReceiptFixture } from '../../services/__tests__/guest-deletion-receipt-fixture';
import { guestErasureBoundaryId } from '../../services/guest-deletion-receipt';
import { createGuestDeletionProgress } from '../../services/guest-deletion-progress';

const stores: ReturnType<typeof sqliteAdapter>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.db.close()));
async function fixture() {
  const store = sqliteAdapter();
  stores.push(store);
  store.db.exec('PRAGMA foreign_keys=ON');
  const route = guestDeletionReceiptFixture();
  store.db
    .prepare(
      'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,1,1)'
    )
    .run(route.tenantId, route.tenantId, 'key-guard', 'Fixture');
  store.db
    .prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at)
     VALUES(?,?,'user','active',?,'guest','active',1,1,1)`
    )
    .run(route.accountId, route.tenantId, route.userId);
  store.db
    .prepare(
      `INSERT INTO guest_account_lifecycle(tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at) VALUES(?,?,?,1,100,'policy:1',1)`
    )
    .run(route.tenantId, route.userId, 'app');
  const adapter = { ...store.adapter, getType: () => 'd1' };
  const repository = new GuestLifecycleRepository(adapter, route.tenantId);
  const passkey = (id: string, credential = id, userId = route.userId) =>
    store.db
      .prepare(
        'INSERT INTO passkeys(id,tenant_id,user_id,credential_id,public_key,counter,created_at) VALUES(?,?,?,?,?,0,1)'
      )
      .run(id, route.tenantId, userId, credential, 'fixture-key');
  passkey('key-1');
  passkey('key-2');
  store.db
    .prepare(
      'INSERT INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at) VALUES(?,?,?,?,1,1)'
    )
    .run('device-1', route.tenantId, route.userId, 'ab'.repeat(32));
  store.db
    .prepare(
      'INSERT INTO totp_credentials(id,tenant_id,user_id,secret_encrypted,created_at) VALUES(?,?,?,?,1)'
    )
    .run('totp-1', route.tenantId, route.userId, 'fixture-secret');
  store.db
    .prepare(
      'INSERT INTO totp_backup_codes(id,tenant_id,user_id,credential_id,code_hash,code_prefix,created_at) VALUES(?,?,?,?,?,?,1)'
    )
    .run('backup-1', route.tenantId, route.userId, 'totp-1', 'fixture-hash', 'fixture');
  await repository.admitDeletion({
    userId: route.userId,
    accountId: route.accountId,
    operationId: route.operationId,
    routeJson: JSON.stringify(route),
    expectedRevision: 1,
    accountRouteGeneration: 1,
    now: 2000,
    startedAtMs: 2000000,
    origin: 'admin',
    task: {
      auditId: route.completionAuditId,
      actorUserId: 'fixture-admin',
      ipAddress: 'fixture',
      userAgent: 'fixture',
      metadataJson: '{}',
      createdAt: 2000,
    },
  });
  const started = {
    ...route,
    execution: {
      phase: 'erasure_started' as const,
      boundaryId: await guestErasureBoundaryId(route.operationId),
      erasureStartedAtMs: 2000001,
    },
  };
  const start = () =>
    repository.confirmErasureStart({
      userId: route.userId,
      accountId: route.accountId,
      operationId: route.operationId,
      expectedRevision: 2,
      acceptedRouteJson: JSON.stringify(route),
      erasureStartedRouteJson: JSON.stringify(started),
      accountRouteGeneration: 1,
      now: 2001,
    });
  const progress = {
    ...(await createGuestDeletionProgress(started, [1])),
    stage: 'drain_passkeys' as const,
  };
  const save = (json: string) =>
    store.db
      .prepare('UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?')
      .run(json, route.completionAuditId);
  return { ...store, adapter, repository, route, started, start, progress, save, passkey };
}

describe('same-Core Guest source mutation admission', () => {
  it.each([
    "UPDATE passkeys SET credential_id='changed' WHERE id='key-1'",
    "DELETE FROM passkeys WHERE id='key-1'",
    "UPDATE guest_devices SET resume_credential_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE id='device-1'",
    "DELETE FROM guest_devices WHERE id='device-1'",
    "UPDATE identity_accounts SET lifecycle_state='deleted' WHERE registration_state='guest'",
    "DELETE FROM identity_accounts WHERE registration_state='guest'",
    "UPDATE totp_credentials SET secret_encrypted='changed' WHERE id='totp-1'",
    "DELETE FROM totp_credentials WHERE id='totp-1'",
    "UPDATE totp_backup_codes SET code_hash='changed' WHERE id='backup-1'",
    "DELETE FROM totp_backup_codes WHERE id='backup-1'",
  ])('freezes accepted source rows before capture: %s', async (sql) => {
    const f = await fixture();
    expect(() => f.db.exec(sql)).toThrow('guest_erasure_mutation_blocked');
    expect(f.db.prepare('SELECT count(*) AS n FROM passkeys').get()).toEqual({ n: 2 });
    expect(f.db.prepare('SELECT lifecycle_state FROM identity_accounts').get()).toEqual({
      lifecycle_state: 'active',
    });
  });

  it('rejects new credentials and excludes REPLACE of a different frozen owner by PK or unique key', async () => {
    const f = await fixture();
    expect(() => f.passkey('new-key')).toThrow('guest_erasure_mutation_blocked');
    for (const [id, credential] of [
      ['key-1', 'different'],
      ['different', 'key-1'],
    ]) {
      expect(() =>
        f.db
          .prepare(
            'INSERT OR REPLACE INTO passkeys(id,tenant_id,user_id,credential_id,public_key,created_at) VALUES(?,?,?,?,?,1)'
          )
          .run(id, f.route.tenantId, 'another-user', credential, 'fixture-key')
      ).toThrow('guest_erasure_mutation_blocked');
    }
    expect(() =>
      f.db
        .prepare(
          'INSERT OR REPLACE INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at) VALUES(?,?,?,?,1,1)'
        )
        .run('new-device', f.route.tenantId, 'another-user', 'ab'.repeat(32))
    ).toThrow('guest_erasure_mutation_blocked');
    expect(() =>
      f.db
        .prepare(
          `INSERT OR REPLACE INTO identity_accounts(id,tenant_id,legacy_user_id,account_type,lifecycle_state,created_at,updated_at) VALUES(?,?,?,'user','active',1,1)`
        )
        .run(f.route.accountId, f.route.tenantId, 'another-user')
    ).toThrow('guest_erasure_mutation_blocked');
    expect(f.db.prepare('SELECT user_id FROM passkeys WHERE id=?').get('key-1')).toEqual({
      user_id: f.route.userId,
    });
  });

  it('demonstrates that the REPLACE control really bypasses implicit DELETE triggers without the new INSERT guard', async () => {
    const f = await fixture();
    expect(f.db.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 0 });
    f.db.exec('DROP TRIGGER trg_guest_core_passkeys_insert');
    f.db
      .prepare(
        'INSERT OR REPLACE INTO passkeys(id,tenant_id,user_id,credential_id,public_key,created_at) VALUES(?,?,?,?,?,1)'
      )
      .run('key-1', f.route.tenantId, 'another-user', 'different', 'fixture-key');
    expect(f.db.prepare('SELECT user_id FROM passkeys WHERE id=?').get('key-1')).toEqual({
      user_id: 'another-user',
    });
  });

  it('rejects late TOTP credentials and backup codes and REPLACE of an existing frozen owner', async () => {
    const f = await fixture();
    const credential =
      'INSERT OR REPLACE INTO totp_credentials(id,tenant_id,user_id,secret_encrypted,created_at) VALUES(?,?,?,?,1)';
    const backup =
      'INSERT OR REPLACE INTO totp_backup_codes(id,tenant_id,user_id,code_hash,code_prefix,created_at) VALUES(?,?,?,?,?,1)';
    for (const [recordId, userId] of [
      ['late', f.route.userId],
      ['totp-1', 'another-user'],
    ])
      expect(() =>
        f.db.prepare(credential).run(recordId, f.route.tenantId, userId, 'fixture')
      ).toThrow('guest_erasure_mutation_blocked');
    for (const [recordId, userId] of [
      ['late', f.route.userId],
      ['backup-1', 'another-user'],
    ])
      expect(() =>
        f.db.prepare(backup).run(recordId, f.route.tenantId, userId, 'fixture-hash', 'fixture')
      ).toThrow('guest_erasure_mutation_blocked');
    f.db.prepare(credential).run('unrelated', f.route.tenantId, 'another-user', 'fixture');
    f.db
      .prepare(backup)
      .run('unrelated', f.route.tenantId, 'another-user', 'fixture-hash', 'fixture');
    expect(f.db.prepare('SELECT user_id FROM totp_credentials WHERE id=?').get('totp-1')).toEqual({
      user_id: f.route.userId,
    });
    expect(
      f.db.prepare('SELECT user_id FROM totp_backup_codes WHERE id=?').get('backup-1')
    ).toEqual({ user_id: f.route.userId });
  });

  it.each([
    ['totp_backup_codes', 'drain_totp_backup_codes', 'backup-1'],
    ['totp_credentials', 'drain_totp_credentials', 'totp-1'],
  ])(
    'only permits the exact %s page after B, with no residual write capability',
    async (table, stage, recordId) => {
      const f = await fixture();
      await f.start();
      const original = JSON.stringify({ ...f.progress, stage });
      f.save(original);
      f.save(JSON.stringify({ ...f.progress, corePermit: { table, ids: [recordId] } }));
      expect(() => f.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(recordId)).toThrow(
        'guest_erasure_mutation_blocked'
      );
      f.save(original);
      await f.adapter.batch([
        {
          sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?',
          params: [
            JSON.stringify({ ...f.progress, stage, corePermit: { table, ids: [recordId] } }),
            f.route.completionAuditId,
          ],
        },
        {
          sql: `DELETE FROM ${table} WHERE tenant_id=? AND user_id=? AND id=?`,
          params: [f.route.tenantId, f.route.userId, recordId],
        },
        {
          sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?',
          params: [original, f.route.completionAuditId],
        },
      ]);
      expect(f.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(recordId)).toBeUndefined();
      expect(
        f.db.prepare('SELECT execution_progress_json FROM guest_deletion_audit_outbox').get()
      ).toEqual({ execution_progress_json: original });
    }
  );

  it('requires the started receipt, original operation, allowed stage and exact PK before any drain', async () => {
    const f = await fixture();
    const permit = { ...f.progress, corePermit: { table: 'passkeys', ids: ['key-1'] } };
    f.save(JSON.stringify(permit));
    expect(() => f.db.exec("DELETE FROM passkeys WHERE id='key-1'")).toThrow(
      'guest_erasure_mutation_blocked'
    );
    await f.start();
    f.save(JSON.stringify({ ...permit, stage: 'capture_email' }));
    expect(() => f.db.exec("DELETE FROM passkeys WHERE id='key-1'")).toThrow(
      'guest_erasure_mutation_blocked'
    );
    f.save(JSON.stringify(permit));
    expect(() => f.db.exec("DELETE FROM passkeys WHERE id='key-2'")).toThrow(
      'guest_erasure_mutation_blocked'
    );
    f.db.prepare('UPDATE guest_deletion_audit_outbox SET operation_id=?').run('foreign-operation');
    expect(() => f.db.exec("DELETE FROM passkeys WHERE id='key-1'")).toThrow(
      'guest_erasure_mutation_blocked'
    );
  });

  it('rolls back both a partial DELETE statement and its temporary permit when the page includes an unpermitted row', async () => {
    const f = await fixture();
    await f.start();
    const original = JSON.stringify(f.progress);
    f.save(original);
    await expect(
      f.adapter.batch([
        {
          sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?',
          params: [
            JSON.stringify({ ...f.progress, corePermit: { table: 'passkeys', ids: ['key-1'] } }),
            f.route.completionAuditId,
          ],
        },
        {
          sql: 'DELETE FROM passkeys WHERE tenant_id=? AND user_id=?',
          params: [f.route.tenantId, f.route.userId],
        },
        {
          sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?',
          params: [original, f.route.completionAuditId],
        },
      ])
    ).rejects.toThrow('guest_erasure_mutation_blocked');
    expect(f.db.prepare('SELECT count(*) AS n FROM passkeys').get()).toEqual({ n: 2 });
    expect(
      f.db.prepare('SELECT execution_progress_json FROM guest_deletion_audit_outbox').get()
    ).toEqual({ execution_progress_json: original });
  });

  it('permits exactly one same-operation page and clears the permit in the atomic batch', async () => {
    const f = await fixture();
    await f.start();
    const next = JSON.stringify({ ...f.progress, revision: f.progress.revision + 1 });
    f.save(JSON.stringify(f.progress));
    await f.adapter.batch([
      {
        sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?',
        params: [
          JSON.stringify({ ...f.progress, corePermit: { table: 'passkeys', ids: ['key-1'] } }),
          f.route.completionAuditId,
        ],
      },
      {
        sql: 'DELETE FROM passkeys WHERE tenant_id=? AND user_id=? AND id=?',
        params: [f.route.tenantId, f.route.userId, 'key-1'],
      },
      {
        sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE audit_id=?',
        params: [next, f.route.completionAuditId],
      },
    ]);
    expect(f.db.prepare('SELECT id FROM passkeys ORDER BY id').all()).toEqual([{ id: 'key-2' }]);
    expect(
      f.db.prepare('SELECT execution_progress_json FROM guest_deletion_audit_outbox').get()
    ).toEqual({ execution_progress_json: next });
    expect(() => f.db.exec("DELETE FROM passkeys WHERE id='key-2'")).toThrow(
      'guest_erasure_mutation_blocked'
    );
  });

  it('does not retarget the canonical owner or route generation even with a final-core page permit', async () => {
    const f = await fixture();
    await f.start();
    f.save(
      JSON.stringify({
        ...f.progress,
        stage: 'final_core',
        corePermit: { table: 'identity_accounts', ids: [f.route.accountId] },
      })
    );
    expect(() => f.db.exec('UPDATE identity_accounts SET account_route_generation=2')).toThrow(
      'guest_erasure_mutation_blocked'
    );
    expect(() => f.db.exec("UPDATE identity_accounts SET lifecycle_state='active'")).toThrow(
      'guest_erasure_mutation_blocked'
    );
  });

  it('allows ordinary unrelated credential writes while keeping the deletion lifecycle monotone', async () => {
    const f = await fixture();
    f.passkey('unrelated', 'unrelated', 'another-user');
    expect(f.db.prepare('SELECT user_id FROM passkeys WHERE id=?').get('unrelated')).toEqual({
      user_id: 'another-user',
    });
    expect(() => f.db.exec("UPDATE guest_account_lifecycle SET phase='active'")).toThrow(
      'guest_erasure_lifecycle_immutable'
    );
  });

  it('fails closed when the admission epoch is missing', async () => {
    const f = await fixture();
    f.db.exec('DELETE FROM guest_core_mutation_epoch');
    expect(() => f.passkey('unrelated', 'unrelated', 'another-user')).toThrow(
      'guest_core_admission_unavailable'
    );
  });

  it('invalidates current-owner restore evidence on critical subject/profile changes, preserving metadata-only writes', async () => {
    const f = await fixture();
    const epoch = () =>
      f.db.prepare('SELECT revision FROM guest_core_mutation_epoch WHERE id=1').get()?.revision;
    const changes = (sql: string) => {
      const before = epoch();
      f.db.exec(sql);
      expect(epoch()).toBe(Number(before) + 1);
    };
    changes(
      "INSERT INTO identity_subjects(id,tenant_id,subject_type,created_at,updated_at) VALUES('parent-one','tenant-guest','person',1,1)"
    );
    changes(
      "INSERT INTO identity_subjects(id,tenant_id,subject_type,created_at,updated_at) VALUES('parent-two','tenant-guest','person',1,1)"
    );
    changes(
      "INSERT INTO profiles(id,tenant_id,subject_id,created_at,updated_at) VALUES('profile-one','tenant-guest','parent-one',1,1)"
    );
    const before = epoch();
    f.db.exec(
      "UPDATE identity_subjects SET display_label='Display',metadata_json='{}',updated_at=2 WHERE id='parent-one'"
    );
    f.db.exec(
      "UPDATE profiles SET locale='ja',metadata_json='{}',updated_at=2 WHERE id='profile-one'"
    );
    expect(epoch()).toBe(before);
    changes("UPDATE profiles SET subject_id='parent-two' WHERE id='profile-one'");
    changes("UPDATE profiles SET profile_type='organization' WHERE id='profile-one'");
    changes("UPDATE profiles SET lifecycle_state='deleted',deleted_at=3 WHERE id='profile-one'");
    changes(
      "UPDATE identity_subjects SET primary_account_id='another-account' WHERE id='parent-one'"
    );
    changes(
      "UPDATE identity_subjects SET lifecycle_state='deleted',deleted_at=3 WHERE id='parent-one'"
    );
    changes("DELETE FROM profiles WHERE id='profile-one'");
    changes("DELETE FROM identity_subjects WHERE id='parent-one'");
  });

  it('keeps the original receipt pins and never rolls an irreversible boundary back to accepted', async () => {
    const f = await fixture();
    const replace = (value: unknown) =>
      f.db
        .prepare('UPDATE guest_account_lifecycle SET deletion_route_json=?')
        .run(JSON.stringify(value));
    expect(() =>
      replace({ ...f.route, piiPin: { ...f.route.piiPin, assignmentGeneration: 2 } })
    ).toThrow('guest_erasure_lifecycle_immutable');
    await f.start();
    expect(() => replace(f.route)).toThrow('guest_erasure_lifecycle_immutable');
    expect(() =>
      replace({
        ...f.started,
        execution: {
          ...f.started.execution,
          erasureStartedAtMs: f.started.execution.erasureStartedAtMs + 1,
        },
      })
    ).toThrow('guest_erasure_lifecycle_immutable');
    expect(f.db.prepare('SELECT deletion_route_json FROM guest_account_lifecycle').get()).toEqual({
      deletion_route_json: JSON.stringify(f.started),
    });
    expect(() => f.passkey('late')).toThrow('guest_erasure_mutation_blocked');
  });

  it.each(['accepted', 'started', 'deleted'])(
    'preserves the %s freeze authority against direct identity changes, DELETE and REPLACE',
    async (phase) => {
      const f = await fixture();
      if (phase !== 'accepted') await f.start();
      if (phase === 'deleted') f.db.exec("UPDATE guest_account_lifecycle SET phase='deleted'");
      const before = f.db.prepare('SELECT * FROM guest_account_lifecycle').get();
      for (const sql of [
        "UPDATE guest_account_lifecycle SET tenant_id='other-tenant'",
        "UPDATE guest_account_lifecycle SET user_id='other-user'",
        "UPDATE guest_account_lifecycle SET deletion_operation_id='other-operation'",
        'UPDATE guest_account_lifecycle SET deletion_started_at_ms=deletion_started_at_ms+1',
        'DELETE FROM guest_account_lifecycle',
        `INSERT OR REPLACE INTO guest_account_lifecycle(tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at)
        SELECT tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at FROM guest_account_lifecycle`,
      ]) {
        expect(() => f.db.exec(sql)).toThrow('guest_erasure_lifecycle_immutable');
        expect(f.db.prepare('SELECT * FROM guest_account_lifecycle').get()).toEqual(before);
        expect(() => f.passkey('new-key')).toThrow('guest_erasure_mutation_blocked');
      }
    }
  );
});
