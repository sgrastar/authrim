import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyImportedAssurance,
  assertAssuranceColumnsFree,
  importedAssuranceEvidence,
  parseImportedAssurance,
} from '../user-import-assurance';
import { normalizeImportRecord, normalizeImportRow } from '../user-import-jobs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Date.parse('2026-10-11T00:00:00Z');

describe('assurance columns of a CSV import', () => {
  it('reads an IAL, and when the identity was proofed', () => {
    expect(parseImportedAssurance({ email: 'a@example.com' }, NOW)).toBeNull();
    expect(parseImportedAssurance({ ial: '', ial_verified_at: '  ' }, NOW)).toBeNull();
    expect(parseImportedAssurance({ ial: 'IAL2' }, NOW)).toEqual({ ial: 'IAL2', verifiedAt: null });
    expect(parseImportedAssurance({ ial: ' ial3 ', ial_verified_at: '2026-09-01' }, NOW)).toEqual({
      ial: 'IAL3',
      verifiedAt: Date.parse('2026-09-01T00:00:00Z'),
    });
    expect(
      parseImportedAssurance({ ial: 'IAL2', ial_verified_at: '2026-09-01T09:00:00+09:00' }, NOW)
    ).toEqual({ ial: 'IAL2', verifiedAt: Date.parse('2026-09-01T00:00:00Z') });
  });

  it.each([
    [{ ial: 'IAL4' }, 'Unsupported ial: IAL4'],
    [{ ial: 'high' }, 'Unsupported ial: high'],
    [{ ial_verified_at: '2026-09-01' }, 'ial_verified_at needs ial'],
    [{ ial: 'IAL2', ial_verified_at: 'last spring' }, 'Invalid ial_verified_at: last spring'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-01T00:00:00' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-13-45' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-10-12' }, 'ial_verified_at must not be in the future'],
    // A day that does not exist is refused, not rolled over into the next month.
    [{ ial: 'IAL2', ial_verified_at: '2026-02-30' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-02-31' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-02-29' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2100-02-29' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-04-31' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-13-01' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-00-10' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-00' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-02-31T00:00:00Z' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-01T24:00:00Z' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-01T10:60:00Z' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-01T10:00:60Z' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-01T10:00:00+24:00' }, 'Invalid ial_verified_at'],
    [{ ial: 'IAL2', ial_verified_at: '2026-09-01T10:00:00+09:60' }, 'Invalid ial_verified_at'],
  ])('refuses %j', (record, message) => {
    expect(() => parseImportedAssurance(record as Record<string, string>, NOW)).toThrow(message);
  });

  it('accepts the days that do exist, leap day included', () => {
    expect(parseImportedAssurance({ ial: 'IAL2', ial_verified_at: '2024-02-29' }, NOW)).toEqual({
      ial: 'IAL2',
      verifiedAt: Date.parse('2024-02-29T00:00:00Z'),
    });
    expect(parseImportedAssurance({ ial: 'IAL2', ial_verified_at: '2000-02-29' }, NOW)?.ial).toBe(
      'IAL2'
    );
    expect(
      parseImportedAssurance({ ial: 'IAL2', ial_verified_at: '2026-04-30T23:59:59-05:30' }, NOW)
        ?.ial
    ).toBe('IAL2');
  });

  it('is taken from the row without becoming a custom attribute', () => {
    const { input, assurance } = normalizeImportRow({
      email: 'a@example.com',
      ial: 'IAL2',
      ial_verified_at: '2026-09-01',
      department: 'Physics',
    });
    expect(input).toMatchObject({ email: 'a@example.com', department: 'Physics' });
    expect(assurance).toMatchObject({ ial: 'IAL2' });
    expect(input).not.toHaveProperty('ial');
    expect(input).not.toHaveProperty('ial_verified_at');
    expect(normalizeImportRow({ email: 'a@example.com' }).assurance).toBeNull();
    expect(normalizeImportRecord({ email: 'a@example.com', ial: 'IAL3' })).not.toHaveProperty(
      'ial'
    );
    expect(() => normalizeImportRecord({ email: 'a@example.com', ial: 'x' })).toThrow('ial');
  });

  it('is recorded as import evidence of the job, at the time given or the time of import', () => {
    expect(importedAssuranceEvidence({ ial: 'IAL2', verifiedAt: 1_000 }, 'job-1', NOW)).toEqual({
      level: 'IAL2',
      evidenceType: 'import',
      issuerRef: 'import:job-1',
      verifiedAt: 1_000,
      contentId: { kind: 'import', parts: ['IAL2', 1_000] },
    });
    expect(
      importedAssuranceEvidence({ ial: 'IAL3', verifiedAt: null }, 'job-1', NOW)
    ).toMatchObject({
      level: 'IAL3',
      verifiedAt: NOW,
    });
  });
});

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

function sqliteAdapter(db: DatabaseSync): DatabaseAdapter {
  const run = (sql: string, params?: unknown[]) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
  });
  return {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run(sql, params),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map((statement) => run(statement.sql, statement.params)),
  } as unknown as DatabaseAdapter;
}

describe('assurance of an imported account that exists', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    db.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/core/d1/016_assurance_evidence_revoked_by.sql'),
        'utf8'
      )
    );
    db.exec(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
       VALUES ('subject-a', 'tenant-a', 'person', 100, 100);
       INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, legacy_user_id, primary_subject_id,
         created_at, updated_at
       ) VALUES ('account-a', 'tenant-a', 'person', 'active', 'user-a', 'subject-a', 100, 100)`
    );
    adapter = sqliteAdapter(db);
  });

  afterEach(() => db.close());

  const active = () =>
    db
      .prepare(
        `SELECT evidence_type, issuer_ref, assurance_level, verified_at, revoked_by
           FROM assurance_evidence WHERE revoked_at IS NULL ORDER BY created_at, id`
      )
      .all();
  const apply = (
    assurance: Parameters<typeof applyImportedAssurance>[5],
    job = 'job-1',
    importedAt = NOW
  ) => applyImportedAssurance(adapter, 'tenant-a', 'user-a', job, importedAt, assurance);
  const revokeAll = () =>
    db
      .prepare(
        `UPDATE assurance_evidence SET revoked_at = 9, revoked_by = 'admin:a' WHERE revoked_at IS NULL`
      )
      .run();

  it('records import evidence when the row gives an IAL', async () => {
    expect(await apply({ ial: 'IAL2', verifiedAt: 5_000 })).toBe('recorded');

    expect(active()).toEqual([
      {
        evidence_type: 'import',
        issuer_ref: 'import:job-1',
        assurance_level: 'IAL2',
        verified_at: 5_000,
        revoked_by: null,
      },
    ]);
  });

  it('keeps what is held when the row gives none', async () => {
    await apply({ ial: 'IAL2', verifiedAt: 5_000 });

    expect(await apply(undefined, 'job-2')).toBe('kept');
    expect(active()).toHaveLength(1);
  });

  it('replaces the evidence of an earlier import with the new level', async () => {
    await apply({ ial: 'IAL2', verifiedAt: 5_000 });

    expect(await apply({ ial: 'IAL3', verifiedAt: 6_000 }, 'job-2')).toBe('recorded');

    expect(active()).toEqual([
      {
        evidence_type: 'import',
        issuer_ref: 'import:job-2',
        assurance_level: 'IAL3',
        verified_at: 6_000,
        revoked_by: null,
      },
    ]);
  });

  it('records a lower level too: a row states what the import asserts', async () => {
    await apply({ ial: 'IAL3', verifiedAt: 5_000 });

    expect(await apply({ ial: 'IAL1', verifiedAt: 6_000 }, 'job-2')).toBe('recorded');
    expect(active()).toMatchObject([{ assurance_level: 'IAL1' }]);
  });

  it('leaves an import again of the same level alone, not refreshing when it was proofed', async () => {
    await apply({ ial: 'IAL2', verifiedAt: null });
    const first = active();

    expect(await apply({ ial: 'IAL2', verifiedAt: null }, 'job-2')).toBe('unchanged');
    expect(active()).toEqual(first);
    // The same level proofed at the same time is unchanged as well; another time replaces it.
    await apply({ ial: 'IAL2', verifiedAt: 5_000 }, 'job-3');
    expect(await apply({ ial: 'IAL2', verifiedAt: 5_000 }, 'job-4')).toBe('unchanged');
    expect(await apply({ ial: 'IAL2', verifiedAt: 7_000 }, 'job-5')).toBe('recorded');
  });

  it('processed again it records nothing new, and brings back nothing an administrator revoked', async () => {
    expect(await apply({ ial: 'IAL2', verifiedAt: 5_000 }, 'job-1')).toBe('recorded');
    revokeAll();

    // The row is processed again after a failure before the job's progress was saved.
    expect(await apply({ ial: 'IAL2', verifiedAt: 5_000 }, 'job-1')).toBe('unchanged');

    expect(active()).toEqual([]);
    expect(db.prepare(`SELECT count(*) AS n FROM assurance_evidence`).get()).toEqual({ n: 1 });
  });

  it('names the evidence by its content alone: another job with the same content brings back nothing either', async () => {
    await apply({ ial: 'IAL2', verifiedAt: 5_000 }, 'job-1');
    revokeAll();

    expect(await apply({ ial: 'IAL2', verifiedAt: 5_000 }, 'job-2')).toBe('unchanged');
    expect(active()).toEqual([]);

    // A new verification is new evidence.
    expect(await apply({ ial: 'IAL2', verifiedAt: 5_001 }, 'job-2')).toBe('recorded');
    expect(await apply({ ial: 'IAL3', verifiedAt: 5_000 }, 'job-2')).toBe('recorded');
    expect(active()).toMatchObject([{ assurance_level: 'IAL3', issuer_ref: 'import:job-2' }]);
  });

  it('counts a row without ial_verified_at from the time of the import, so a retry is the same evidence', async () => {
    expect(await apply({ ial: 'IAL2', verifiedAt: null }, 'job-1', 7_000)).toBe('recorded');
    expect(active()).toMatchObject([{ verified_at: 7_000 }]);
    revokeAll();

    // The same job again after an administrator revoked it: nothing comes back.
    expect(await apply({ ial: 'IAL2', verifiedAt: null }, 'job-1', 7_000)).toBe('unchanged');
    expect(active()).toEqual([]);
    // Another import (another time) is a new verification.
    expect(await apply({ ial: 'IAL2', verifiedAt: null }, 'job-3', 9_000)).toBe('recorded');
    expect(active()).toMatchObject([{ verified_at: 9_000 }]);
  });

  it('judges a row without ial_verified_at by the time of the import, the same before and after earlier evidence is revoked', async () => {
    // Evidence in force from an earlier import, proofed at T0.
    await apply({ ial: 'IAL3', verifiedAt: 1_000 }, 'job-0');

    // Job A (created at T1) has a row of the same level without a date: another time is a new
    // claim, so it is recorded (and replaces the earlier evidence) rather than judged unchanged.
    expect(await apply({ ial: 'IAL3', verifiedAt: null }, 'job-a', 7_000)).toBe('recorded');
    expect(active()).toMatchObject([{ issuer_ref: 'import:job-a', verified_at: 7_000 }]);

    // The earlier evidence is revoked (it already is), the evidence in force too, and the row of
    // the job is processed again: nothing new.
    revokeAll();
    expect(await apply({ ial: 'IAL3', verifiedAt: null }, 'job-a', 7_000)).toBe('unchanged');
    expect(active()).toEqual([]);
    expect(db.prepare(`SELECT count(*) AS n FROM assurance_evidence`).get()).toEqual({ n: 2 });
  });

  it('does not let revoking the evidence of another source make a retried date-less row record anew', async () => {
    db.exec(
      `INSERT INTO assurance_evidence (
         id, tenant_id, subject_id, evidence_type, issuer_ref, assurance_framework,
         assurance_level, verified_at, created_at, updated_at
       ) VALUES ('admin-0', 'tenant-a', 'subject-a', 'admin_attestation', 'admin:a',
                 'nist_800_63', 'IAL3', 1000, 1, 1)`
    );

    expect(await apply({ ial: 'IAL3', verifiedAt: null }, 'job-a', 7_000)).toBe('recorded');
    db.prepare(
      `UPDATE assurance_evidence SET revoked_at = 9, revoked_by = 'admin:a' WHERE id = 'admin-0'`
    ).run();
    expect(await apply({ ial: 'IAL3', verifiedAt: null }, 'job-a', 7_000)).toBe('unchanged');
    revokeAll();
    expect(await apply({ ial: 'IAL3', verifiedAt: null }, 'job-a', 7_000)).toBe('unchanged');
    expect(active()).toEqual([]);

    // A later import is a new verification.
    expect(await apply({ ial: 'IAL3', verifiedAt: null }, 'job-b', 9_000)).toBe('recorded');
    expect(active()).toMatchObject([{ verified_at: 9_000 }]);
  });

  it('never touches evidence of another source', async () => {
    db.exec(
      `INSERT INTO assurance_evidence (
         id, tenant_id, subject_id, evidence_type, issuer_ref, assurance_framework,
         assurance_level, verified_at, created_at, updated_at
       ) VALUES ('admin-1', 'tenant-a', 'subject-a', 'admin_attestation', 'admin:a',
                 'nist_800_63', 'IAL3', 1000, 1, 1)`
    );

    await apply({ ial: 'IAL2', verifiedAt: 5_000 });

    expect(
      (active() as Array<{ evidence_type: string }>).map((row) => row.evidence_type).sort()
    ).toEqual(['admin_attestation', 'import']);
  });

  it('fails for an account with no subject, rather than recording nowhere', async () => {
    await expect(
      applyImportedAssurance(adapter, 'tenant-a', 'nobody', 'job-1', NOW, {
        ial: 'IAL2',
        verifiedAt: null,
      })
    ).rejects.toThrow('import_assurance_subject_missing');
  });
});

describe('custom attributes named like the assurance columns', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    adapter = sqliteAdapter(db);
  });
  afterEach(() => db.close());

  const define = (tenant: string, key: string, active = 1) =>
    db
      .prepare(
        `INSERT INTO custom_claim_schemas (id, tenant_id, field_key, active_field_key, display_label, field_type, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'string', ?, 1, 1)`
      )
      .run(`s-${tenant}-${key}-${active}`, tenant, key, active ? key : null, key, active);

  it('refuses a file whose ial column would be read as assurance, not as the attribute', async () => {
    define('tenant-a', 'ial');

    await expect(
      assertAssuranceColumnsFree(adapter, 'tenant-a', { email: 'a@example.com', ial: 'IAL3' })
    ).rejects.toThrow('custom attribute named ial');
    await expect(
      assertAssuranceColumnsFree(adapter, 'tenant-a', { email: 'a@example.com', ial: '' })
    ).rejects.toThrow('rename the custom attribute or remove the column');
  });

  it('names the verified-at column too, and each tenant has its own attributes', async () => {
    db.exec('DELETE FROM custom_claim_schemas');
    define('tenant-a', 'ial_verified_at');
    define('tenant-b', 'ial');

    await expect(
      assertAssuranceColumnsFree(adapter, 'tenant-a', { ial_verified_at: '2026-09-01' })
    ).rejects.toThrow('ial_verified_at');
  });

  it('lets a file through when there is no such attribute, is inactive, or the column is absent', async () => {
    define('tenant-a', 'ial', 0);
    define('tenant-a', 'department');

    await expect(
      assertAssuranceColumnsFree(adapter, 'tenant-a', { email: 'a@example.com', ial: 'IAL2' })
    ).resolves.toBeUndefined();
    // Without the columns nothing is looked up at all.
    const failing = {
      query: async () => {
        throw new Error('no read expected');
      },
    } as unknown as DatabaseAdapter;
    await expect(
      assertAssuranceColumnsFree(failing, 'tenant-a', { email: 'a@example.com', department: 'x' })
    ).resolves.toBeUndefined();
  });

  it('does not take an unreadable definition list for no attribute', async () => {
    const failing = {
      query: async () => {
        throw new Error('d1 down');
      },
    } as unknown as DatabaseAdapter;

    await expect(assertAssuranceColumnsFree(failing, 'tenant-a', { ial: 'IAL2' })).rejects.toThrow(
      'd1 down'
    );
    // The next row asks again.
    await expect(assertAssuranceColumnsFree(failing, 'tenant-a', { ial: 'IAL2' })).rejects.toThrow(
      'd1 down'
    );
  });

  it('sees an attribute that was activated while the job ran, row by row', async () => {
    const row = { email: 'a@example.com', ial: 'IAL2' };
    define('tenant-a', 'ial', 0);
    await expect(assertAssuranceColumnsFree(adapter, 'tenant-a', row)).resolves.toBeUndefined();

    // The attribute is activated again (as a deactivated one's own row, or a new one).
    db.exec('DELETE FROM custom_claim_schemas');
    define('tenant-a', 'ial', 1);

    await expect(assertAssuranceColumnsFree(adapter, 'tenant-a', row)).rejects.toThrow(
      'custom attribute named ial'
    );
  });

  it('reads once for a row that has the columns, and not at all for one that has not', async () => {
    const query = vi.fn(async () => []);
    const counting = { query } as unknown as DatabaseAdapter;

    await assertAssuranceColumnsFree(counting, 'tenant-a', { email: 'a@example.com' });
    expect(query).not.toHaveBeenCalled();
    await assertAssuranceColumnsFree(counting, 'tenant-a', { ial: 'IAL2' });
    await assertAssuranceColumnsFree(counting, 'tenant-a', { ial: 'IAL2' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
