import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  checkUserConsentSatisfaction,
  processConsentItemDecisions,
  resolveConsentRequirements,
} from '../../utils/consent-statements';
import { listUserStatementConsentRecords } from '../statement-consent-records';
import { singleDatabaseStatementConsent } from '../statement-consent-stores';

/**
 * Characterization of statement consent when the definitions and the records live in different
 * databases (metadata `tenant_core/default`, account `tenant_core/users`).
 *
 * These tests pin what the code does TODAY so the split can change it deliberately. Every pinned
 * defect is named in the test title; the PR that fixes it flips the assertion. The schema is the
 * executable D1 core schema, applied to both databases exactly as the migration runner applies it
 * to every core shard, so the account database holds empty copies of the definition tables.
 */

const TENANT = 'tenant-a';
const USER = 'user-a';
const STATEMENT = 'statement-terms';
const VERSION_ID = 'version-terms-1';
const VERSION = '20261025';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
  db: DatabaseSync;
  adapter: DatabaseAdapter;
}

function core(): Fixture {
  const fixture = sqliteAdapter('core');
  // D1 enforces foreign keys on every connection.
  fixture.db.exec('PRAGMA foreign_keys=ON');
  return fixture;
}

/** One statement with a current version, required by the tenant, retained for 30 days. */
async function seedDefinitions(adapter: DatabaseAdapter): Promise<void> {
  await adapter.execute(
    `INSERT INTO consent_statements(id,tenant_id,slug,is_active,record_retention_days,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    [STATEMENT, TENANT, 'terms', 1, 30, 1, 1]
  );
  await adapter.execute(
    `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [VERSION_ID, TENANT, STATEMENT, VERSION, 1, 'active', 1, 1, 1]
  );
  await adapter.execute(
    `INSERT INTO tenant_consent_requirements(id,tenant_id,statement_id,is_required,enforcement,display_order,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    ['req-1', TENANT, STATEMENT, 1, 'block', 0, 1, 1]
  );
}

const evidence = { client_id: 'client-a', user_agent: 'ua' };
const target = { [STATEMENT]: { version_id: VERSION_ID, version: VERSION } };

describe('statement consent across metadata and account databases (current behaviour)', () => {
  let metadata: Fixture;
  let account: Fixture;

  beforeEach(async () => {
    metadata = core();
    account = core();
    await seedDefinitions(metadata.adapter);
  });

  afterEach(() => {
    metadata.db.close();
    account.db.close();
  });

  describe('single database', () => {
    it('resolves, records and satisfies a required statement through one adapter', async () => {
      const stores = singleDatabaseStatementConsent(metadata.adapter);
      expect(stores.metadata).toBe(stores.account);

      const requirements = await resolveConsentRequirements(stores.metadata, TENANT, null, {});
      expect(requirements.map((r) => r.statement_id)).toEqual([STATEMENT]);
      expect(requirements[0].is_required).toBe(true);

      const before = await checkUserConsentSatisfaction(stores.account, TENANT, USER, requirements);
      expect(before).toEqual({ satisfied: false, unsatisfied: [STATEMENT] });

      await processConsentItemDecisions(
        stores,
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        'iphash',
        target
      );

      const records = await listUserStatementConsentRecords(stores.account, TENANT, USER);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        statement_id: STATEMENT,
        version_id: VERSION_ID,
        version: VERSION,
        status: 'granted',
        record_retention_days_snapshot: 30,
      });
      // The retention snapshot is copied from the definition at agreement time.
      expect((records[0].retain_until ?? 0) - (records[0].granted_at ?? 0)).toBe(30 * DAY_MS);

      const history = await metadata.adapter.query<{ action: string }>(
        `SELECT action FROM consent_item_history WHERE tenant_id = ? AND user_id = ?`,
        [TENANT, USER]
      );
      expect(history.map((h) => h.action)).toEqual(['granted']);

      const after = await checkUserConsentSatisfaction(stores.account, TENANT, USER, requirements);
      expect(after).toEqual({ satisfied: true, unsatisfied: [] });
    });
  });

  describe('records are read from the account database alone', () => {
    it('lists a record that sits in the account database and nothing from metadata', async () => {
      // A row that exists without its definitions (written before a split or restored from a
      // backup) is stored with foreign keys off, as PostgreSQL stores it.
      account.db.exec('PRAGMA foreign_keys=OFF');
      await account.adapter.execute(
        `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,granted_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ['rec-1', TENANT, USER, STATEMENT, VERSION_ID, VERSION, 'granted', 10, 10, 10]
      );
      account.db.exec('PRAGMA foreign_keys=ON');

      const fromAccount = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
      expect(fromAccount.map((r) => r.id)).toEqual(['rec-1']);
      expect(await listUserStatementConsentRecords(metadata.adapter, TENANT, USER)).toEqual([]);
    });

    it('satisfies requirements resolved from metadata against records read from the account', async () => {
      account.db.exec('PRAGMA foreign_keys=OFF');
      await account.adapter.execute(
        `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,granted_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ['rec-1', TENANT, USER, STATEMENT, VERSION_ID, VERSION, 'granted', 10, 10, 10]
      );
      account.db.exec('PRAGMA foreign_keys=ON');

      const requirements = await resolveConsentRequirements(metadata.adapter, TENANT, null, {});
      const result = await checkUserConsentSatisfaction(
        account.adapter,
        TENANT,
        USER,
        requirements
      );
      expect(result).toEqual({ satisfied: true, unsatisfied: [] });
    });
  });

  describe('pinned defects of the split topology', () => {
    it('resolves requirements only from the adapter it is given: the account database holds none', async () => {
      // Callers must hand it the metadata database. Handed the account database (an empty copy of
      // the definition tables), a required statement is silently not asked.
      const fromMetadata = await resolveConsentRequirements(metadata.adapter, TENANT, null, {});
      const fromAccount = await resolveConsentRequirements(account.adapter, TENANT, null, {});
      expect(fromMetadata).toHaveLength(1);
      expect(fromAccount).toEqual([]);
    });

    it('records consent after M2 without account-local definitions or foreign keys', async () => {
      await expect(
        processConsentItemDecisions(
          { metadata: metadata.adapter, account: account.adapter },
          TENANT,
          USER,
          { [STATEMENT]: 'granted' },
          evidence,
          'iphash',
          target
        )
      ).resolves.toBeUndefined();
      expect(await listUserStatementConsentRecords(account.adapter, TENANT, USER)).toHaveLength(1);
    });

    it('takes the retention snapshot from the metadata definition even though the account database holds none', async () => {
      // PostgreSQL's baseline has no foreign keys. The retention days are read from the metadata
      // database and the record is written to the account database, so the snapshot is complete.
      account.db.exec('PRAGMA foreign_keys=OFF');
      await processConsentItemDecisions(
        { metadata: metadata.adapter, account: account.adapter },
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        'iphash',
        target
      );

      const [record] = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
      expect(record).toMatchObject({
        statement_id: STATEMENT,
        status: 'granted',
        record_retention_days_snapshot: 30,
      });
      expect(record.retain_until).toBeGreaterThan(Date.now());
    });

    it('stores the hash of the document agreed to on the record and its history', async () => {
      await metadata.adapter.execute(
        `UPDATE consent_statement_versions SET content_hash = ? WHERE id = ?`,
        ['a'.repeat(64), VERSION_ID]
      );
      await processConsentItemDecisions(
        singleDatabaseStatementConsent(metadata.adapter),
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        'iphash',
        target
      );
      const [row] = await metadata.adapter.query<{ content_hash: string | null }>(
        `SELECT content_hash FROM user_consent_records WHERE tenant_id = ?`,
        [TENANT]
      );
      expect(row.content_hash).toBe('a'.repeat(64));
      const [history] = await metadata.adapter.query<{ content_hash_after: string | null }>(
        `SELECT content_hash_after FROM consent_item_history WHERE tenant_id = ?`,
        [TENANT]
      );
      expect(history.content_hash_after).toBe('a'.repeat(64));
    });
  });
});
