/**
 * A real SQLite database with the D1 core schema (the repository's migrations), holding one
 * person and their assurance evidence, so an IAL read runs the production query against the
 * production columns. Counts the reads of the evidence table.
 */
import { readFileSync } from 'node:fs';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

type SqlValue = string | number | null;

/** The part of node:sqlite this uses (the package's Node typings predate the module). */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: SqlValue[]): unknown[];
    get(...params: SqlValue[]): unknown;
    run(...params: SqlValue[]): { changes: number | bigint };
  };
}

const MIGRATIONS = new URL('../../../../../../migrations/core/d1/', import.meta.url);

/** What the migrations' portable tokens render to on SQLite (ar-lib-core migrations/sql-portability). */
function renderForSqlite(sql: string): string {
  return sql
    .replaceAll(
      '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
      "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
    )
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

export const EVIDENCE_TENANT = 'tenant-a';
export const EVIDENCE_USER = 'user-1';

export interface EvidenceDb {
  db: SqliteDatabase;
  adapter: DatabaseAdapter;
  /** How many times the evidence table was queried since the last reset. */
  evidenceReads(): number;
  resetReads(): void;
  clearEvidence(): void;
  addEvidence(
    id: string,
    level: string,
    overrides?: Partial<{
      framework: string | null;
      verified_at: number | null;
      expires_at: number | null;
      revoked_at: number | null;
    }>
  ): void;
}

export async function createEvidenceDb(userId: string = EVIDENCE_USER): Promise<EvidenceDb> {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_0_5_0_core_baseline.sql']) {
    db.exec(renderForSqlite(readFileSync(new URL(file, MIGRATIONS), 'utf8')));
  }
  let reads = 0;
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('assurance_evidence')) reads += 1;
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      if (sql.includes('assurance_evidence')) reads += 1;
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
      };
    },
  } as unknown as DatabaseAdapter;

  db.prepare(
    `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
     VALUES (?, ?, 'person', 1, 1)`
  ).run(`subject:${userId}`, EVIDENCE_TENANT);
  db.prepare(
    `INSERT INTO identity_accounts
       (id, tenant_id, account_type, legacy_user_id, primary_subject_id, created_at, updated_at)
     VALUES (?, ?, 'user', ?, ?, 1, 1)`
  ).run(`account:${userId}`, EVIDENCE_TENANT, userId, `subject:${userId}`);

  return {
    db,
    adapter,
    evidenceReads: () => reads,
    resetReads: () => {
      reads = 0;
    },
    clearEvidence: () => {
      db.exec('DELETE FROM assurance_evidence');
    },
    addEvidence(id, level, overrides = {}) {
      const row = {
        framework: 'nist_800_63',
        verified_at: Date.now() - 86_400_000,
        expires_at: null,
        revoked_at: null,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO assurance_evidence
           (id, tenant_id, subject_id, evidence_type, assurance_framework, assurance_level,
            verified_at, expires_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, 'admin_attestation', ?, ?, ?, ?, ?, 1, 1)`
      ).run(
        id,
        EVIDENCE_TENANT,
        `subject:${userId}`,
        row.framework,
        level,
        row.verified_at,
        row.expires_at,
        row.revoked_at
      );
    },
  };
}
