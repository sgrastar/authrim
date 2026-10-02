import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { resolveUserEffectiveIAL, IAL_FRAMEWORK } from '../../services/identity-assurance';
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
