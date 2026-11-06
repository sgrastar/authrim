import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { AdminPasskeyRepository } from '../admin/admin-passkey';
import { AdminSessionRepository } from '../admin/admin-session';
import {
  ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS,
  AdminSecondFactorRepository,
  type AdminWebAuthnSecondFactorInput,
} from '../admin/admin-second-factor';
import { sqliteAdapter } from './sqlite-core-schema';

const ADMIN_MIGRATIONS = new URL('../../../../../migrations/admin/d1/', import.meta.url);

function adminSchema(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const fixture = sqliteAdapter('admin');
  for (const file of ['003_admin_session_passkey_evidence.sql', '004_admin_second_factors.sql']) {
    fixture.db.exec(
      renderPortableMigrationSql(readMigrationSource(ADMIN_MIGRATIONS, file), 'sqlite')
    );
  }
  return fixture;
}

function addAdmin(db: DatabaseSync, id: string, createdAt = Date.now()): void {
  db.prepare(
    `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
     VALUES (?, 'default', ?, ?, ?)`
  ).run(id, `${id}@example.com`, createdAt, createdAt);
}

function key(credentialId: string, adminUserId = 'admin-1'): AdminWebAuthnSecondFactorInput {
  return {
    admin_user_id: adminUserId,
    credential_id: credentialId,
    public_key: 'cHVibGljLWtleQ==',
    counter: 0,
    transports: ['usb'],
    backup_eligible: false,
    backup_state: false,
    label: 'Key',
  };
}

describe('AdminSecondFactorRepository in the real admin schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let repo: AdminSecondFactorRepository;

  beforeEach(() => {
    ({ db, adapter } = adminSchema());
    repo = new AdminSecondFactorRepository(adapter);
    addAdmin(db, 'admin-1');
    addAdmin(db, 'admin-2');
  });

  it('registers a first factor once, even when two first enrollments race', async () => {
    const results = await Promise.all([
      repo.insertWebAuthn(key('cred-a'), { firstOnly: true }),
      repo.insertWebAuthn(key('cred-b'), { firstOnly: true }),
    ]);

    expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
    expect(results.find((result) => !result.inserted)).toEqual({
      inserted: false,
      reason: 'already_enrolled',
    });
    expect(await repo.listActiveByUser('admin-1')).toHaveLength(1);
  });

  it('refuses a first enrollment once the window has closed, even with an earlier challenge', async () => {
    addAdmin(db, 'admin-old', 1_000);
    db.prepare('UPDATE admin_users SET second_factor_grace_started_at = NULL WHERE id = ?').run(
      'admin-old'
    );

    expect(await repo.insertWebAuthn(key('cred-a', 'admin-old'), { firstOnly: true })).toEqual({
      inserted: false,
      reason: 'enrollment_closed',
    });
    // Inside the window by the clock the caller passes, it goes through.
    expect(
      (await repo.insertWebAuthn(key('cred-a', 'admin-old'), { firstOnly: true, now: 2_000 }))
        .inserted
    ).toBe(true);
  });

  it('aborts a raw insert of the same credential into the other table, rolling back its batch', async () => {
    await repo.insertWebAuthn(key('cred-factor'), { firstOnly: false });
    await expect(
      adapter.batch([
        {
          sql: `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
                VALUES ('admin-invited', 'default', 'invited@example.com', 1, 1)`,
        },
        {
          sql: `INSERT INTO admin_passkeys (id, admin_user_id, credential_id, public_key, created_at)
                VALUES ('pk-1', 'admin-invited', 'cred-factor', 'cGs=', 1)`,
        },
      ])
    ).rejects.toThrow('second factor');
    expect(
      db.prepare("SELECT id FROM admin_users WHERE id = 'admin-invited'").get()
    ).toBeUndefined();

    db.prepare(
      `INSERT INTO admin_passkeys (id, admin_user_id, credential_id, public_key, created_at)
       VALUES ('pk-2', 'admin-1', 'cred-login', 'cGs=', 1)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO admin_second_factors (id, admin_user_id, kind, credential_id, created_at)
           VALUES ('sf-x', 'admin-1', 'webauthn_credential', 'cred-login', 1)`
        )
        .run()
    ).toThrow('admin passkey');
  });

  it('adds more factors outside first enrollment', async () => {
    await repo.insertWebAuthn(key('cred-a'), { firstOnly: true });
    const second = await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });

    expect(second.inserted).toBe(true);
    expect((await repo.listActiveByUser('admin-1')).map((factor) => factor.credential_id)).toEqual(
      expect.arrayContaining(['cred-a', 'cred-b'])
    );
  });

  it('refuses a credential that is a sign-in passkey, in either direction', async () => {
    const passkeys = new AdminPasskeyRepository(adapter);
    await passkeys.createPasskey({
      admin_user_id: 'admin-1',
      credential_id: 'cred-login',
      public_key: 'cGs=',
    });

    expect(await repo.insertWebAuthn(key('cred-login'), { firstOnly: false })).toEqual({
      inserted: false,
      reason: 'credential_in_use',
    });

    await repo.insertWebAuthn(key('cred-factor'), { firstOnly: false });
    await expect(
      passkeys.createPasskey({
        admin_user_id: 'admin-1',
        credential_id: 'cred-factor',
        public_key: 'cGs=',
      })
    ).rejects.toThrow('second factor');
    expect(await passkeys.credentialExists('cred-factor')).toBe(true);
    expect(await passkeys.findByCredentialId('cred-factor')).toBeNull();
  });

  it('never registers a revoked credential again', async () => {
    const first = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    if (!first.inserted) throw new Error('setup failed');
    expect(await repo.revoke('admin-1', first.factor.id)).toEqual({ revoked: true });

    expect(await repo.insertWebAuthn(key('cred-a'), { firstOnly: false })).toEqual({
      inserted: false,
      reason: 'credential_in_use',
    });
  });

  it('refuses to revoke the last active factor, even when two removals race', async () => {
    const a = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    const b = await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    if (!a.inserted || !b.inserted) throw new Error('setup failed');

    const results = await Promise.all([
      repo.revoke('admin-1', a.factor.id),
      repo.revoke('admin-1', b.factor.id),
    ]);

    expect(results).toContainEqual({ revoked: true });
    expect(results).toContainEqual({ revoked: false, reason: 'minimum_reached' });
    expect(await repo.listActiveByUser('admin-1')).toHaveLength(1);
  });

  it('reports another admin’s factor as not found', async () => {
    const a = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    if (!a.inserted) throw new Error('setup failed');

    expect(await repo.revoke('admin-2', a.factor.id)).toEqual({
      revoked: false,
      reason: 'not_found',
    });
    expect(await repo.isActive('admin-1', a.factor.id)).toBe(true);
    expect(await repo.isActive('admin-2', a.factor.id)).toBe(false);
  });

  it('clears the revoked factor from sessions that verified it, and only that factor', async () => {
    const a = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    const b = await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    if (!a.inserted || !b.inserted) throw new Error('setup failed');
    const insertSession = db.prepare(
      `INSERT INTO admin_sessions (
         id, tenant_id, admin_user_id, created_at, expires_at, second_factor_id,
         second_factor_verified_at
       ) VALUES (?, 'default', 'admin-1', 1, 9999999999999, ?, 5)`
    );
    insertSession.run('sess-a', a.factor.id);
    insertSession.run('sess-b', b.factor.id);

    await repo.revoke('admin-1', a.factor.id);

    const rows = db
      .prepare(
        'SELECT id, second_factor_id, second_factor_verified_at FROM admin_sessions ORDER BY id'
      )
      .all();
    expect(rows).toEqual([
      { id: 'sess-a', second_factor_id: null, second_factor_verified_at: null },
      { id: 'sess-b', second_factor_id: b.factor.id, second_factor_verified_at: 5 },
    ]);
  });

  it('lets an administrator revoke even the last factor, clearing it from sessions', async () => {
    const only = await repo.insertWebAuthn(key('cred-only'), { firstOnly: false });
    if (!only.inserted) throw new Error('setup failed');
    db.prepare(
      `INSERT INTO admin_sessions (
         id, tenant_id, admin_user_id, created_at, expires_at, second_factor_id,
         second_factor_verified_at
       ) VALUES ('sess-a', 'default', 'admin-1', 1, 9999999999999, ?, 5)`
    ).run(only.factor.id);

    expect(await repo.revokeByAdmin('admin-1', only.factor.id)).toBe(true);
    expect(await repo.listActiveByUser('admin-1')).toEqual([]);
    expect(
      db.prepare("SELECT second_factor_id FROM admin_sessions WHERE id = 'sess-a'").get()
    ).toEqual({ second_factor_id: null });
    // Once only, and never another admin's factor.
    expect(await repo.revokeByAdmin('admin-1', only.factor.id)).toBe(false);
    const other = await repo.insertWebAuthn(key('cred-other', 'admin-2'), { firstOnly: false });
    if (!other.inserted) throw new Error('setup failed');
    expect(await repo.revokeByAdmin('admin-1', other.factor.id)).toBe(false);
    expect(await repo.isActive('admin-2', other.factor.id)).toBe(true);

    // The first enrollment is once: with its only key revoked, admin-1 (still inside the window)
    // cannot enroll a new one as a first factor.
    expect(await repo.hasEverEnrolled('admin-1')).toBe(true);
    expect(await repo.insertWebAuthn(key('cred-again'), { firstOnly: true })).toMatchObject({
      inserted: false,
    });
    expect(await repo.listActiveByUser('admin-1')).toEqual([]);
  });

  it('records a use only from the counter it was verified against, on an active factor', async () => {
    const a = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    const b = await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    if (!a.inserted || !b.inserted) throw new Error('setup failed');

    const use = (expectedCounter: number, counter: number) =>
      repo.recordUse(a.factor.id, { expectedCounter, counter, backupState: false, usedAt: 42 });
    // Two uses verified against counter 0: the second, older one must not move it back.
    expect(await use(0, 7)).toBe(true);
    expect(await use(0, 5)).toBe(false);
    await repo.revoke('admin-1', a.factor.id);
    expect(await use(7, 8)).toBe(false);

    expect(await repo.findActiveByCredentialId('cred-a')).toBeNull();
    expect((await repo.listByUser('admin-1')).find((f) => f.id === a.factor.id)).toMatchObject({
      counter: 7,
      last_used_at: 42,
      backup_eligible: false,
      backup_state: false,
      transports: ['usb'],
    });
  });

  it('records a second factor on a session only while the factor is the admin’s and active', async () => {
    const a = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    const b = await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    if (!a.inserted || !b.inserted) throw new Error('setup failed');
    db.prepare(
      `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at)
       VALUES ('sess-1', 'default', 'admin-1', 1, 9999999999999)`
    ).run();
    const sessions = new AdminSessionRepository(adapter, 'default');
    const record = (adminUserId: string, secondFactorId: string) =>
      sessions.recordSecondFactorVerification('sess-1', { adminUserId, secondFactorId }, 100);

    expect(await record('admin-2', a.factor.id)).toBe(false);
    await repo.revoke('admin-1', a.factor.id);
    // A verification that read the factor before it was revoked does not bring it back.
    expect(await record('admin-1', a.factor.id)).toBe(false);
    expect(await record('admin-1', b.factor.id)).toBe(true);
    expect(
      db.prepare("SELECT second_factor_id AS id FROM admin_sessions WHERE id = 'sess-1'").get()
    ).toEqual({ id: b.factor.id });
  });

  it('registers a Keyring holder key once, never again after revocation', async () => {
    const jkt = 'J'.repeat(43);
    const first = await repo.insertKeyringHolderKey(
      { admin_user_id: 'admin-1', holder_jkt: jkt, label: 'Keyring' },
      { firstOnly: true }
    );
    expect(first).toMatchObject({
      inserted: true,
      factor: { kind: 'keyring_holder_key', holder_jkt: jkt, credential_id: null },
    });
    if (!first.inserted) throw new Error('not inserted');
    expect(await repo.findActiveKeyringFactor('admin-1', jkt)).toMatchObject({
      id: first.factor.id,
    });
    expect(await repo.findActiveKeyringFactor('admin-2', jkt)).toBeNull();

    // The same key for another admin, or again for this one, is refused.
    expect(
      await repo.insertKeyringHolderKey(
        { admin_user_id: 'admin-2', holder_jkt: jkt },
        { firstOnly: false }
      )
    ).toEqual({ inserted: false, reason: 'credential_in_use' });

    await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    expect(await repo.revoke('admin-1', first.factor.id)).toMatchObject({ revoked: true });
    expect(await repo.findActiveKeyringFactor('admin-1', jkt)).toBeNull();
    expect(
      await repo.insertKeyringHolderKey(
        { admin_user_id: 'admin-1', holder_jkt: jkt },
        { firstOnly: false }
      )
    ).toEqual({ inserted: false, reason: 'credential_in_use' });
  });

  it('registers an added Keyring key only while the approving factor is the session evidence', async () => {
    const approving = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    if (!approving.inserted) throw new Error('not inserted');
    db.prepare(
      `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at)
       VALUES ('sess-k1', 'default', 'admin-1', 1, 9999999999999)`
    ).run();
    const session = { id: 'sess-k1' };
    const sessions = new AdminSessionRepository(adapter, 'default');
    await sessions.recordSecondFactorVerification(session.id, {
      adminUserId: 'admin-1',
      secondFactorId: approving.factor.id,
    });
    const approvedBy = { factorId: approving.factor.id, sessionId: session.id };

    // Revoked between the check and the insert: the insert itself refuses.
    await repo.insertWebAuthn(key('cred-b'), { firstOnly: false });
    expect(await repo.revoke('admin-1', approving.factor.id)).toMatchObject({ revoked: true });
    expect(
      await repo.insertKeyringHolderKey(
        { admin_user_id: 'admin-1', holder_jkt: 'M'.repeat(43) },
        { firstOnly: false, approvedBy }
      )
    ).toEqual({ inserted: false, reason: 'approval_revoked' });
    expect(await repo.findActiveKeyringFactor('admin-1', 'M'.repeat(43))).toBeNull();
  });

  it('adds a security key only while the approving factor is the session evidence', async () => {
    const approving = await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    if (!approving.inserted) throw new Error('not inserted');
    db.prepare(
      `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at)
       VALUES ('sess-w', 'default', 'admin-1', 1, 9999999999999)`
    ).run();
    const approvedBy = { factorId: approving.factor.id, sessionId: 'sess-w' };
    // Not yet the session's evidence: refused.
    expect(await repo.insertWebAuthn(key('cred-b'), { firstOnly: false, approvedBy })).toEqual({
      inserted: false,
      reason: 'approval_revoked',
    });
    await new AdminSessionRepository(adapter, 'default').recordSecondFactorVerification('sess-w', {
      adminUserId: 'admin-1',
      secondFactorId: approving.factor.id,
    });
    expect(
      await repo.insertWebAuthn(key('cred-b'), { firstOnly: false, approvedBy })
    ).toMatchObject({ inserted: true });
  });

  it('revokes the Keyring factor of a revoked credential and clears what it gave sessions', async () => {
    await repo.insertWebAuthn(key('cred-a'), { firstOnly: false });
    const keyring = await repo.insertKeyringHolderKey(
      { admin_user_id: 'admin-1', holder_jkt: 'R'.repeat(43) },
      { firstOnly: false }
    );
    if (!keyring.inserted) throw new Error('not inserted');
    db.prepare(
      `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at)
       VALUES ('sess-k2', 'default', 'admin-1', 1, 9999999999999)`
    ).run();
    const session = { id: 'sess-k2' };
    const sessions = new AdminSessionRepository(adapter, 'default');
    await sessions.recordSecondFactorVerification(session.id, {
      adminUserId: 'admin-1',
      secondFactorId: keyring.factor.id,
    });

    expect(await repo.revokeKeyringHolderKey('admin-1', 'R'.repeat(43))).toBe(true);
    expect(await repo.findActiveKeyringFactor('admin-1', 'R'.repeat(43))).toBeNull();
    const row = db
      .prepare('SELECT second_factor_id FROM admin_sessions WHERE id = ?')
      .get(session.id) as { second_factor_id: string | null };
    expect(row.second_factor_id).toBeNull();
    expect(await repo.revokeKeyringHolderKey('admin-1', 'R'.repeat(43))).toBe(false);
  });

  it('applies the first-enrollment rules to a Keyring holder key', async () => {
    await repo.insertWebAuthn(key('cred-a'), { firstOnly: true });
    expect(
      await repo.insertKeyringHolderKey(
        { admin_user_id: 'admin-1', holder_jkt: 'K'.repeat(43) },
        { firstOnly: true }
      )
    ).toEqual({ inserted: false, reason: 'already_enrolled' });
  });

  it('marks a Keyring factor used, only while it is active', async () => {
    const result = await repo.insertKeyringHolderKey(
      { admin_user_id: 'admin-1', holder_jkt: 'L'.repeat(43) },
      { firstOnly: false }
    );
    if (!result.inserted) throw new Error('not inserted');
    expect(await repo.touch(result.factor.id, 123)).toBe(true);
    expect((await repo.listByUser('admin-1'))[0].last_used_at).toBe(123);
  });

  it('starts the enrollment window at account creation unless the migration set it', async () => {
    addAdmin(db, 'admin-new', 5_000);
    db.prepare('UPDATE admin_users SET second_factor_grace_started_at = NULL WHERE id = ?').run(
      'admin-new'
    );

    expect(await repo.getEnrollmentGraceEndsAt('admin-new')).toBe(
      5_000 + ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS
    );
    expect(await repo.getEnrollmentGraceEndsAt('missing')).toBeNull();
  });

  it('gives accounts that existed at the migration a window from the migration', () => {
    const row = db
      .prepare('SELECT second_factor_grace_started_at AS started FROM admin_users WHERE id = ?')
      .get('admin-1') as { started: number | null } | undefined;
    // admin-1 was inserted after the migration ran, so it has no migration start of its own.
    expect(row?.started ?? null).toBeNull();

    const fresh = sqliteAdapter('admin');
    addAdmin(fresh.db, 'existing', 1_000);
    const before = Date.now();
    for (const file of ['003_admin_session_passkey_evidence.sql', '004_admin_second_factors.sql']) {
      fresh.db.exec(
        renderPortableMigrationSql(readMigrationSource(ADMIN_MIGRATIONS, file), 'sqlite')
      );
    }
    const migrated = fresh.db
      .prepare('SELECT second_factor_grace_started_at AS started FROM admin_users WHERE id = ?')
      .get('existing') as { started: number };
    expect(migrated.started).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
  });
});
