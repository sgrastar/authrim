/**
 * The record of a person's information release decision on a SAML SP, on the executable core D1
 * schema: written only under the current withdrawal generation, with a revision every decision
 * moves on, its history in the same batch, and a withdrawal that ends it.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  findSamlSpReleaseConsent,
  findSamlSpReleaseConsentGeneration,
  isSamlSpReleaseConsentChanged,
  listSamlSpReleaseConsentsWithProviders,
  recordSamlSpReleaseDecision,
  withdrawSamlSpReleaseConsent,
  type SamlSpReleaseDecision,
} from '../saml-release-consent-store';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);
type SqlValue = string | number | null;

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_0_5_0_core_baseline.sql', '011_saml_sp_release_consent.sql']) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  // The history's owner (consent_history.user_id → users_core) lives elsewhere in this schema.
  db.exec('PRAGMA foreign_keys = OFF');
  const values = (params: unknown[] = []) => params as SqlValue[];
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      const result = db.prepare(sql).run(...values(params));
      return { rowsAffected: Number(result.changes) };
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({
          rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
        }));
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

const KEY = { tenantId: 'tenant-a', userId: 'user-1', spEntityId: 'https://sp.example.edu/sp' };
const NAMEID = '["nameid","urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"]';
const MAIL = '["attribute","mail",null]';
const AFFILIATION = '["attribute","eduPersonAffiliation",null]';

function approval(overrides: Partial<SamlSpReleaseDecision> = {}): SamlSpReleaseDecision {
  return {
    presented: [NAMEID, MAIL, AFFILIATION],
    approved: [NAMEID, MAIL],
    declined: [AFFILIATION],
    mode: 'once',
    basis: 'user',
    refused: false,
    ...overrides,
  };
}

describe('SAML SP information release decisions', () => {
  it('records a decision at revision 1 and moves the revision on with each new one', async () => {
    const { adapter } = createDatabase();
    const first = await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval(),
      operationId: 'op-1',
      now: 1000,
    });
    expect(first.revision).toBe(1);
    const second = await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval({ approved: [NAMEID, MAIL, AFFILIATION], declined: [] }),
      operationId: 'op-2',
      now: 2000,
    });
    expect(second.revision).toBe(2);
    await expect(
      findSamlSpReleaseConsent(adapter, { ...KEY, consentGeneration: 0 })
    ).resolves.toMatchObject({
      revision: 2,
      approved: [AFFILIATION, NAMEID, MAIL].sort(),
      declined: [],
      refused: false,
      decidedAt: 2000,
    });
  });

  it('keeps each decision in the history, with its items and the SAML protocol', async () => {
    const { adapter, db } = createDatabase();
    await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval({ refused: true, approved: [], declined: [NAMEID, MAIL, AFFILIATION] }),
      operationId: 'op-1',
      now: 1000,
      history: { userAgent: 'test-agent' },
    });
    const rows = db
      .prepare('SELECT client_id, action, user_agent, metadata_json FROM consent_history')
      .all() as Array<{ client_id: string; action: string; metadata_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client_id: KEY.spEntityId, action: 'denied' });
    expect(JSON.parse(rows[0].metadata_json)).toMatchObject({
      protocol: 'saml',
      release: { refused: true, approved: [] },
    });
  });

  it('writes nothing under a withdrawal generation that has moved on', async () => {
    const { adapter, db } = createDatabase();
    await withdrawSamlSpReleaseConsent(adapter, { ...KEY, now: 500 });
    await expect(findSamlSpReleaseConsentGeneration(adapter, KEY)).resolves.toBe(1);
    const stale = recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval(),
      operationId: 'op-stale',
      now: 1000,
    });
    await expect(stale).rejects.toSatisfy(isSamlSpReleaseConsentChanged);
    expect(db.prepare('SELECT COUNT(*) AS n FROM saml_sp_release_consents').get()).toEqual({
      n: 0,
    });
    // Only the withdrawal's own history entry.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM consent_history WHERE action <> 'revoked'").get()
    ).toEqual({ n: 0 });
  });

  it('does not read a decision made under another generation', async () => {
    const { adapter } = createDatabase();
    await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval(),
      operationId: 'op-1',
      now: 1000,
    });
    await expect(
      findSamlSpReleaseConsent(adapter, { ...KEY, consentGeneration: 1 })
    ).resolves.toBeNull();
  });

  it('withdraws a decision: the record is gone and the generation moves on', async () => {
    const { adapter } = createDatabase();
    await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval(),
      operationId: 'op-1',
      now: 1000,
    });
    await expect(withdrawSamlSpReleaseConsent(adapter, { ...KEY, now: 2000 })).resolves.toEqual({
      withdrawn: true,
    });
    await expect(findSamlSpReleaseConsentGeneration(adapter, KEY)).resolves.toBe(1);
    await expect(
      findSamlSpReleaseConsent(adapter, { ...KEY, consentGeneration: 1 })
    ).resolves.toBeNull();
    await expect(withdrawSamlSpReleaseConsent(adapter, { ...KEY, now: 3000 })).resolves.toEqual({
      withdrawn: false,
    });
  });

  it('does not read a record it cannot parse as an approval', async () => {
    const { adapter, db } = createDatabase();
    await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval(),
      operationId: 'op-1',
      now: 1000,
    });
    db.prepare("UPDATE saml_sp_release_consents SET approved_json = 'not json'").run();
    await expect(
      findSamlSpReleaseConsent(adapter, { ...KEY, consentGeneration: 0 })
    ).resolves.toBeNull();
  });

  it('lists decisions with the SP name, and a trusted SP as approved by its trust', async () => {
    const { adapter, db } = createDatabase();
    await recordSamlSpReleaseDecision(adapter, {
      ...KEY,
      consentGeneration: 0,
      decision: approval(),
      operationId: 'op-1',
      now: 1000,
    });
    db.prepare(
      `INSERT INTO identity_providers (id, name, provider_type, config_json, created_at, updated_at,
         tenant_id) VALUES ('sp-1', 'Library', 'saml_sp', ?, 1, 1, 'tenant-a')`
    ).run(JSON.stringify({ entityId: KEY.spEntityId }));
    const listed = await listSamlSpReleaseConsentsWithProviders({
      accountCore: adapter,
      tenantMetadata: adapter,
      tenantId: KEY.tenantId,
      userId: KEY.userId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      spEntityId: KEY.spEntityId,
      spName: 'Library',
      currentBasis: null,
      release: { basis: 'user', refused: false },
    });
  });
});
