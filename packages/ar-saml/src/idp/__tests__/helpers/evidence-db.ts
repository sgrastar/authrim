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
  /** Make every read of the evidence table fail with this error (null: stop failing). */
  failEvidenceReads(error: Error | null): void;
  clearEvidence(): void;
  /** Delete the SP trust rows, the release consent records and the withdrawal generations. */
  clearConsent(): void;
  /** Mark an SP trusted (or skipping authorization consent) in the tenant's trust policies. */
  trustSP(
    spEntityId: string,
    flags?: { trusted?: boolean; skipAuthorizationConsent?: boolean }
  ): void;
  /** A person's current release decision on an SP, as the consent screen would have written it. */
  saveReleaseDecision(input: {
    spEntityId: string;
    userId?: string;
    presented: string[];
    approved: string[];
    declined?: string[];
    mode?: 'once' | 'every_time' | 'when_items_change';
    basis?: 'user' | 'trust' | 'not_asked';
    refused?: boolean;
    revision?: number;
    generation?: number;
  }): void;
  /** Withdraw: the person's generation for an SP (what a withdrawal moves). */
  setReleaseGeneration(spEntityId: string, generation: number, userId?: string): void;
  /** The current decision row (or null). */
  releaseDecision(spEntityId: string, userId?: string): { decision_revision: number } | null;
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
  for (const file of ['001_0_5_0_core_baseline.sql', '011_saml_sp_release_consent.sql']) {
    db.exec(renderForSqlite(readFileSync(new URL(file, MIGRATIONS), 'utf8')));
  }
  let reads = 0;
  let evidenceError: Error | null = null;
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('assurance_evidence')) {
        reads += 1;
        if (evidenceError) throw evidenceError;
      }
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      if (sql.includes('assurance_evidence')) {
        reads += 1;
        if (evidenceError) throw evidenceError;
      }
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
    failEvidenceReads: (error) => {
      evidenceError = error;
    },
    clearEvidence: () => {
      db.exec('DELETE FROM assurance_evidence');
    },
    clearConsent: () => {
      db.exec(
        'DELETE FROM client_trust_policies; DELETE FROM saml_sp_release_consents; DELETE FROM saml_sp_release_consent_revocations;'
      );
    },
    trustSP(spEntityId, flags = {}) {
      db.prepare(
        `INSERT INTO client_trust_policies
           (id, tenant_id, name, display_name, target_type, target_id, first_party, trusted,
            skip_authorization_consent, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'saml_sp', ?, 0, ?, ?, 1, 1, 1)`
      ).run(
        `trust:${spEntityId}`,
        EVIDENCE_TENANT,
        `trust:${spEntityId}`,
        'Trust',
        spEntityId,
        flags.trusted ? 1 : 0,
        flags.skipAuthorizationConsent ? 1 : 0
      );
    },
    saveReleaseDecision(input) {
      const json = (names: string[]) => JSON.stringify([...names].sort());
      db.prepare(
        `INSERT INTO saml_sp_release_consents
           (tenant_id, user_id, sp_entity_id, presented_json, approved_json, declined_json, mode,
            basis, refused, decision_revision, consent_generation, decided_at, created_at,
            updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`
      ).run(
        EVIDENCE_TENANT,
        input.userId ?? userId,
        input.spEntityId,
        json(input.presented),
        json(input.approved),
        json(input.declined ?? []),
        input.mode ?? 'once',
        input.basis ?? 'user',
        input.refused ? 1 : 0,
        input.revision ?? 1,
        input.generation ?? 0
      );
    },
    setReleaseGeneration(spEntityId, generation, forUser) {
      db.prepare(
        `INSERT INTO saml_sp_release_consent_revocations
           (tenant_id, user_id, sp_entity_id, generation, revoked_at)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (tenant_id, user_id, sp_entity_id) DO UPDATE SET generation = excluded.generation`
      ).run(EVIDENCE_TENANT, forUser ?? userId, spEntityId, generation);
    },
    releaseDecision(spEntityId, forUser) {
      return (
        (db
          .prepare(
            `SELECT decision_revision FROM saml_sp_release_consents
              WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?`
          )
          .get(EVIDENCE_TENANT, forUser ?? userId, spEntityId) as
          | { decision_revision: number }
          | undefined) ?? null
      );
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
