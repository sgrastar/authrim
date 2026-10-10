import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  assuranceEvidenceId,
  resolveUserEffectiveIAL,
  IAL_FRAMEWORK,
  IAL_FRAMEWORK_PENDING,
} from '../../services/identity-assurance';
import { CanonicalIdentityRepository } from '../identity';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/** The executable D1 schema, so a statement naming a column the table lacks fails here. */
function sqliteAdapter(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  const run = (statement: PreparedStatement) => {
    const changes = Number(db.prepare(statement.sql).run(...values(statement.params)).changes);
    return { success: true, rowsAffected: changes };
  };
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return run({ sql, params });
    },
    async batch(statements: PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

describe('assurance evidence', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let repository: CanonicalIdentityRepository;

  beforeEach(() => {
    ({ db, adapter } = sqliteAdapter());
    repository = new CanonicalIdentityRepository(adapter, 'tenant-a');
    db.prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
       VALUES ('subject:user-1', 'tenant-a', 'person', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO identity_accounts
         (id, tenant_id, account_type, legacy_user_id, primary_subject_id, created_at, updated_at)
       VALUES ('account:user-1', 'tenant-a', 'user', 'user-1', 'subject:user-1', 1, 1)`
    ).run();
  });

  it('records, lists and revokes evidence in the real schema', async () => {
    const recorded = await repository.createAssuranceEvidence({
      id: 'ev-1',
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      issuer_ref: 'admin:admin-1',
      assurance_framework: IAL_FRAMEWORK,
      assurance_level: 'IAL2',
      verified_at: 1_000,
    });
    expect(recorded).toMatchObject({ id: 'ev-1', revoked_at: null });
    // The same id again is the same evidence: left as it is.
    await repository.createAssuranceEvidence({
      id: 'ev-1',
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      assurance_level: 'IAL3',
    });
    expect(await repository.findAssuranceEvidence('ev-1')).toMatchObject({
      assurance_level: 'IAL2',
      issuer_ref: 'admin:admin-1',
      verified_at: 1_000,
    });
    expect(await repository.listAssuranceEvidenceForSubject('subject:user-1')).toHaveLength(1);

    expect(await repository.revokeAssuranceEvidence('ev-1', 'admin:a', 2_000)).toBe(true);
    expect(await repository.revokeAssuranceEvidence('ev-1', 'admin:b', 3_000)).toBe(false);
    expect(await repository.listAssuranceEvidenceForSubject('subject:user-1')).toHaveLength(0);
    expect(
      await repository.listAssuranceEvidenceForSubject('subject:user-1', { includeRevoked: true })
    ).toMatchObject([{ id: 'ev-1', revoked_at: 2_000, revoked_by: 'admin:a' }]);
    // Another tenant's repository sees none of it.
    expect(
      await new CanonicalIdentityRepository(adapter, 'tenant-b').findAssuranceEvidence('ev-1')
    ).toBeNull();
  });

  it('replaces what one source asserts, leaving other sources alone', async () => {
    const source = { evidenceType: 'scim', issuerRef: 'scim:token-1' };
    const level = (assurance_level: string) => ({
      assurance_framework: IAL_FRAMEWORK,
      assurance_level,
      verified_at: 1_000,
    });
    await repository.createAssuranceEvidence({
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      ...level('IAL2'),
    });
    const first = await repository.replaceAssuranceEvidenceFromSource(
      'subject:user-1',
      source,
      level('IAL2')
    );
    const second = await repository.replaceAssuranceEvidenceFromSource(
      'subject:user-1',
      source,
      level('IAL3')
    );
    const active = await repository.listAssuranceEvidenceForSubject('subject:user-1');
    expect(active.map((row) => row.id).sort()).toEqual(
      [second!.id, active.find((row) => row.evidence_type === 'admin_attestation')!.id].sort()
    );
    expect((await repository.findAssuranceEvidence(first!.id))?.revoked_at).not.toBeNull();

    // Nothing from the source any more: its evidence is revoked, the admin's stays.
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, null);
    expect(
      (await repository.listAssuranceEvidenceForSubject('subject:user-1')).map(
        (row) => row.evidence_type
      )
    ).toEqual(['admin_attestation']);
  });

  it('changes nothing when a replacement is run again, or a late one arrives', async () => {
    const source = { evidenceType: 'scim', issuerRef: 'scim:token-1' };
    const at = (id: string, assurance_level: string) => ({
      id,
      assurance_framework: IAL_FRAMEWORK,
      assurance_level,
      verified_at: 1_000,
    });
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('a', 'IAL2'));
    // The same replacement again (a retried batch): its own evidence stays in force.
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('a', 'IAL2'));
    expect(
      (await repository.listAssuranceEvidenceForSubject('subject:user-1')).map((row) => row.id)
    ).toEqual(['a']);
    // A later replacement, then the first one late: the later one stays.
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('b', 'IAL3'));
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('a', 'IAL2'));
    expect(
      (await repository.listAssuranceEvidenceForSubject('subject:user-1')).map((row) => row.id)
    ).toEqual(['b']);
  });

  it('replaces what a kind of source asserts whichever issuer asserted it, when told to', async () => {
    const level = (assurance_level: string) => ({
      assurance_framework: IAL_FRAMEWORK,
      assurance_level,
      verified_at: 1_000,
    });
    const job = (n: number) => ({
      evidenceType: 'import',
      issuerRef: `import:job-${n}`,
      anyIssuer: true,
    });
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', job(1), level('IAL2'));
    await repository.createAssuranceEvidence({
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      issuer_ref: 'import:job-1',
      ...level('IAL3'),
    });
    expect(
      (await repository.listActiveAssuranceEvidenceFromSource('user-1', job(2))).map(
        (row) => row.issuer_ref
      )
    ).toEqual(['import:job-1']);

    const second = await repository.replaceAssuranceEvidenceFromSource(
      'subject:user-1',
      job(2),
      level('IAL3')
    );
    const active = await repository.listAssuranceEvidenceForSubject('subject:user-1');
    expect(active.map((row) => [row.evidence_type, row.issuer_ref]).sort()).toEqual([
      ['admin_attestation', 'import:job-1'],
      ['import', 'import:job-2'],
    ]);
    expect(second).toMatchObject({ issuer_ref: 'import:job-2', assurance_level: 'IAL3' });
    // Whoever replaced it is named as the one who revoked the earlier evidence.
    const all = await repository.listAssuranceEvidenceForSubject('subject:user-1', {
      includeRevoked: true,
    });
    expect(all.find((row) => row.revoked_at !== null)).toMatchObject({
      issuer_ref: 'import:job-1',
      revoked_by: 'import:job-2',
    });
  });

  it('changes nothing when the evidence id is another tenant’s, and removes without an id', async () => {
    const source = { evidenceType: 'scim', issuerRef: 'scim:token-1' };
    const at = (id: string) => ({
      id,
      assurance_framework: IAL_FRAMEWORK,
      assurance_level: 'IAL2',
      verified_at: 1_000,
    });
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('mine'));
    db.prepare(
      `INSERT INTO assurance_evidence (id, tenant_id, subject_id, evidence_type, created_at, updated_at)
       VALUES ('theirs', 'tenant-b', 'subject:x', 'scim', 1, 1), ('', 'tenant-a', 'subject:x', 'scim', 1, 1)`
    ).run();
    await expect(
      repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('theirs'))
    ).rejects.toThrow('assurance_evidence_id_conflict');
    expect(
      (await repository.listAssuranceEvidenceForSubject('subject:user-1')).map((row) => row.id)
    ).toEqual(['mine']);
    // Removal revokes the source's evidence, whatever ids other evidence has.
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, null);
    expect(await repository.listAssuranceEvidenceForSubject('subject:user-1')).toEqual([]);
  });

  it('records nothing and revokes nothing when the id is taken for another subject', async () => {
    const source = { evidenceType: 'scim', issuerRef: 'scim:token-1' };
    const at = (id: string) => ({
      id,
      assurance_framework: IAL_FRAMEWORK,
      assurance_level: 'IAL2',
      verified_at: 1_000,
    });
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('kept'));
    // The id taken after the guard looked (as by a concurrent replacement): the plain insert
    // fails the batch, so the revocation it made is undone with it.
    const execute = adapter.batch.bind(adapter);
    adapter.batch = async (statements) =>
      execute([
        ...statements.slice(0, -1),
        {
          sql: `INSERT INTO assurance_evidence
                  (id, tenant_id, subject_id, evidence_type, created_at, updated_at)
                VALUES ('raced', 'tenant-a', 'subject:other', 'scim', 1, 1)`,
        },
        statements[statements.length - 1]!,
      ]);
    await expect(
      repository.replaceAssuranceEvidenceFromSource('subject:user-1', source, at('raced'))
    ).rejects.toThrow();
    expect(
      (await repository.listAssuranceEvidenceForSubject('subject:user-1')).map((row) => row.id)
    ).toEqual(['kept']);
  });

  it('returns what is stored for an id already recorded, and refuses one of another subject', async () => {
    const base = {
      id: 'ev-3',
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      assurance_framework: IAL_FRAMEWORK,
    };
    await repository.createAssuranceEvidence({ ...base, assurance_level: 'IAL2' });
    await repository.revokeAssuranceEvidence('ev-3', 'admin:a', 2_000);
    expect(
      await repository.createAssuranceEvidence({ ...base, assurance_level: 'IAL3' })
    ).toMatchObject({ assurance_level: 'IAL2', revoked_at: 2_000 });
    await expect(
      repository.createAssuranceEvidence({ ...base, subject_id: 'subject:other' })
    ).rejects.toThrow('assurance_evidence_id_conflict');
  });

  it('records the evidence an account is created with once, in force at once, whatever is retried', async () => {
    const evidence = {
      level: 'IAL2' as const,
      evidenceType: 'tenant_policy',
      issuerRef: 'tenant_policy',
      verifiedAt: 1_000,
    };
    const recorded = await repository.recordInitialAssurance('subject:user-1', evidence);
    expect(recorded).toMatchObject({
      evidence_type: 'tenant_policy',
      issuer_ref: 'tenant_policy',
      assurance_framework: IAL_FRAMEWORK,
      assurance_level: 'IAL2',
      verified_at: 1_000,
      expires_at: null,
      revoked_at: null,
    });
    expect(recorded.id).toMatch(/^assurance-evidence:initial:/);
    expect(await resolveUserEffectiveIAL(adapter, 'tenant-a', 'user-1', 5_000)).toMatchObject({
      level: 'IAL2',
      evidenceId: recorded.id,
    });

    // A retry (even with other values) is the same evidence, left as it is.
    const again = await repository.recordInitialAssurance('subject:user-1', {
      ...evidence,
      level: 'IAL3',
      verifiedAt: 2_000,
    });
    expect(again).toMatchObject({ id: recorded.id, assurance_level: 'IAL2', verified_at: 1_000 });
    expect(await repository.listAssuranceEvidenceForSubject('subject:user-1')).toHaveLength(1);

    // Revoked afterwards, a retry does not bring it back.
    await repository.revokeAssuranceEvidence(recorded.id, 'admin:a', 3_000);
    await repository.recordInitialAssurance('subject:user-1', evidence);
    expect(await repository.listAssuranceEvidenceForSubject('subject:user-1')).toHaveLength(0);
    expect((await resolveUserEffectiveIAL(adapter, 'tenant-a', 'user-1', 5_000)).level).toBe(
      'IAL1'
    );
  });

  it('names a claim made at creation by its content, the same id as when it is made later', async () => {
    const claim = {
      level: 'IAL2' as const,
      evidenceType: 'scim',
      issuerRef: 'scim:tok',
      verifiedAt: 1_000,
      expiresAt: null,
      contentId: { kind: 'scim', parts: ['tok', 'IAL2', 1_000, null] },
    };
    const recorded = await repository.recordInitialAssurance('subject:user-1', claim);
    expect(recorded.id).toBe(
      await assuranceEvidenceId('scim', ['tenant-a', 'subject:user-1', 'tok', 'IAL2', 1_000, null])
    );
    await repository.revokeAssuranceEvidence(recorded.id, 'admin:a', 2_000);
    // The same content again, at creation or by replacement, is the revoked evidence.
    await repository.recordInitialAssurance('subject:user-1', claim);
    expect(await repository.listAssuranceEvidenceForSubject('subject:user-1')).toEqual([]);
  });

  it('lists what one source asserts for an account, by the account’s user id', async () => {
    const source = { evidenceType: 'scim', issuerRef: 'scim:token-1' };
    const other = { evidenceType: 'scim', issuerRef: 'scim:token-2' };
    const level = (assurance_level: string) => ({
      assurance_framework: IAL_FRAMEWORK,
      assurance_level,
      verified_at: 1_000,
    });
    expect(await repository.listActiveAssuranceEvidenceFromSource('user-1', source)).toEqual([]);

    const mine = await repository.replaceAssuranceEvidenceFromSource(
      'subject:user-1',
      source,
      level('IAL2')
    );
    await repository.replaceAssuranceEvidenceFromSource('subject:user-1', other, level('IAL3'));
    await repository.createAssuranceEvidence({
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      issuer_ref: 'scim:token-1',
      ...level('IAL3'),
    });

    expect(
      (await repository.listActiveAssuranceEvidenceFromSource('user-1', source)).map(
        (row) => row.id
      )
    ).toEqual([mine!.id]);
    // Revoked evidence, another tenant's repository and another account see none.
    await repository.revokeAssuranceEvidence(mine!.id, 'scim:token-1', 2_000);
    expect(await repository.listActiveAssuranceEvidenceFromSource('user-1', source)).toEqual([]);
    expect(
      await new CanonicalIdentityRepository(
        adapter,
        'tenant-b'
      ).listActiveAssuranceEvidenceFromSource('user-1', other)
    ).toEqual([]);
    expect(await repository.listActiveAssuranceEvidenceFromSource('user-2', other)).toEqual([]);
  });

  describe('the version of the person', () => {
    const version = () =>
      (
        db
          .prepare(`SELECT updated_at FROM identity_subjects WHERE id = 'subject:user-1'`)
          .get() as { updated_at: number }
      ).updated_at;
    const level = { assurance_framework: IAL_FRAMEWORK, assurance_level: 'IAL2', verified_at: 1 };

    it('moves when evidence is recorded, put in force, revoked or replaced, so a version made of it changes', async () => {
      let seen = version();
      const moved = () => {
        const next = version();
        expect(next).toBeGreaterThan(seen);
        seen = next;
      };

      await repository.createAssuranceEvidence({
        id: 'v-1',
        subject_id: 'subject:user-1',
        evidence_type: 'admin_attestation',
        ...level,
        assurance_framework: IAL_FRAMEWORK_PENDING,
      });
      moved();
      await repository.activateAssuranceEvidence('v-1');
      moved();
      await repository.revokeAssuranceEvidence('v-1', 'admin:a', 5_000);
      moved();
      await repository.replaceAssuranceEvidenceFromSource(
        'subject:user-1',
        { evidenceType: 'scim', issuerRef: 'scim:t' },
        level
      );
      moved();
      await repository.replaceAssuranceEvidenceFromSource(
        'subject:user-1',
        { evidenceType: 'scim', issuerRef: 'scim:t' },
        null
      );
      moved();
    });

    it('moves strictly even when the clock has not, and leaves other people alone', async () => {
      db.prepare(`UPDATE identity_subjects SET updated_at = ? WHERE id = 'subject:user-1'`).run(
        9_000_000_000_000
      );
      db.prepare(
        `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
         VALUES ('subject:user-2', 'tenant-a', 'person', 1, 7)`
      ).run();
      await repository.createAssuranceEvidence({
        id: 'v-2',
        subject_id: 'subject:user-1',
        evidence_type: 'admin_attestation',
        ...level,
      });
      expect(version()).toBe(9_000_000_000_001);
      await repository.revokeAssuranceEvidence('v-2', 'admin:a');
      expect(version()).toBe(9_000_000_000_002);
      expect(
        (
          db
            .prepare(`SELECT updated_at FROM identity_subjects WHERE id = 'subject:user-2'`)
            .get() as {
            updated_at: number;
          }
        ).updated_at
      ).toBe(7);
    });
  });

  describe('the version of the person never goes back', () => {
    const version = () =>
      (
        db
          .prepare(`SELECT updated_at FROM identity_subjects WHERE id = 'subject:user-1'`)
          .get() as { updated_at: number }
      ).updated_at;
    const ahead = 9_000_000_000_000;
    const setVersion = (value: number) =>
      db
        .prepare(`UPDATE identity_subjects SET updated_at = ? WHERE id = 'subject:user-1'`)
        .run(value);

    it('moves forward past a version that evidence set ahead of a delayed sync', async () => {
      // Evidence is revoked (the version moves to T + 1000), then a profile sync that read its
      // clock earlier writes: the version stays ahead of what the old ETag was made of.
      setVersion(ahead);
      expect(
        await repository.updateSubjectRuntimeFields('subject:user-1', {
          lifecycleState: 'active',
          displayLabel: null,
        })
      ).toBe(true);
      expect(version()).toBeGreaterThan(ahead);
      const synced = version();
      await repository.transitionSubjectLifecycle('subject:user-1', 'suspended');
      expect(version()).toBeGreaterThan(synced);
    });

    it('stays ahead after a revocation followed by a delayed sync', async () => {
      await repository.createAssuranceEvidence({
        id: 'm-1',
        subject_id: 'subject:user-1',
        evidence_type: 'admin_attestation',
        assurance_framework: IAL_FRAMEWORK,
        assurance_level: 'IAL2',
        verified_at: 1,
      });
      setVersion(ahead);
      await repository.revokeAssuranceEvidence('m-1', 'admin:a');
      const revoked = version();
      expect(revoked).toBeGreaterThan(ahead);

      await repository.updateSubjectRuntimeFields('subject:user-1', {
        lifecycleState: 'active',
      });
      expect(version()).toBeGreaterThan(revoked);
    });
  });

  it('names evidence by what it is, so the same claim has one id', async () => {
    const id = await assuranceEvidenceId('scim', ['t', 's', 'tok', 'IAL2', 1, null]);
    expect(id).toMatch(/^assurance-evidence:scim:[0-9a-f]{64}$/);
    expect(await assuranceEvidenceId('scim', ['t', 's', 'tok', 'IAL2', 1, null])).toBe(id);
    // A part that differs, or a null that is not a "null" string, is another id.
    expect(await assuranceEvidenceId('scim', ['t', 's', 'tok', 'IAL3', 1, null])).not.toBe(id);
    expect(await assuranceEvidenceId('scim', ['t', 's', 'tok', 'IAL2', 1, 'null'])).not.toBe(id);
    expect(await assuranceEvidenceId('import', ['t', 's', 'tok', 'IAL2', 1, null])).not.toBe(id);
    // The parts cannot run into each other.
    expect(await assuranceEvidenceId('scim', ['ab', 'c'])).not.toBe(
      await assuranceEvidenceId('scim', ['a', 'bc'])
    );
  });

  it('reads a person’s IAL through their account', async () => {
    expect(await resolveUserEffectiveIAL(adapter, 'tenant-a', 'user-1', 5_000)).toEqual({
      level: 'IAL1',
      evidenceId: null,
      verifiedAt: null,
    });
    await repository.createAssuranceEvidence({
      id: 'ev-2',
      subject_id: 'subject:user-1',
      evidence_type: 'admin_attestation',
      assurance_framework: IAL_FRAMEWORK,
      assurance_level: 'IAL2',
      verified_at: 1_000,
      expires_at: 10_000,
    });
    expect(await resolveUserEffectiveIAL(adapter, 'tenant-a', 'user-1', 5_000)).toEqual({
      level: 'IAL2',
      evidenceId: 'ev-2',
      verifiedAt: 1_000,
    });
    // Expired, or for another tenant's account: IAL1.
    expect((await resolveUserEffectiveIAL(adapter, 'tenant-a', 'user-1', 10_000)).level).toBe(
      'IAL1'
    );
    expect((await resolveUserEffectiveIAL(adapter, 'tenant-b', 'user-1', 5_000)).level).toBe(
      'IAL1'
    );
  });
});
