import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  checkUserConsentSatisfaction,
  getConsentItemsForScreen,
  resolveConsentRequirements,
  StatementConsentAccountReadError,
} from '../../utils/consent-statements';
import { lookupStatementDefinitions } from '../statement-consent-definitions';
import type { StatementConsentStores } from '../statement-consent-stores';

/**
 * Reads of statement consent when the definitions (metadata database) and the subject's records
 * (account database) are different databases with the real D1 core schema and foreign keys on.
 */

const TENANT = 'tenant-a';
const USER = 'user-a';
const STATEMENT = 'statement-terms';
const OLD_VERSION_ID = 'version-terms-1';
const NEW_VERSION_ID = 'version-terms-2';

interface Fixture {
  db: DatabaseSync;
  adapter: DatabaseAdapter;
}

function core(): Fixture {
  const fixture = sqliteAdapter('core');
  fixture.db.exec('PRAGMA foreign_keys=ON');
  return fixture;
}

async function seedDefinitions(adapter: DatabaseAdapter): Promise<void> {
  await adapter.execute(
    `INSERT INTO consent_statements(id,tenant_id,slug,category,is_active,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    [STATEMENT, TENANT, 'terms', 'terms_of_service', 1, 1, 1]
  );
  for (const [id, version, current] of [
    [OLD_VERSION_ID, '20260101', 0],
    [NEW_VERSION_ID, '20261025', 1],
  ] as const) {
    await adapter.execute(
      `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, TENANT, STATEMENT, version, 1, current ? 'active' : 'archived', current, 1, 1]
    );
  }
  await adapter.execute(
    `INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    ['loc-en', TENANT, NEW_VERSION_ID, 'en', 'Terms', 'English description', 1, 1]
  );
  await adapter.execute(
    `INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    ['loc-ja', TENANT, NEW_VERSION_ID, 'ja', '利用規約', '', 1, 1]
  );
  await adapter.execute(
    `INSERT INTO tenant_consent_requirements(id,tenant_id,statement_id,is_required,enforcement,display_order,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    ['req-1', TENANT, STATEMENT, 1, 'block', 0, 1, 1]
  );
}

/** A record in the account database for an older version; its definitions are not there. */
async function seedOldRecord(account: Fixture): Promise<void> {
  account.db.exec('PRAGMA foreign_keys=OFF');
  await account.adapter.execute(
    `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,granted_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['rec-1', TENANT, USER, STATEMENT, OLD_VERSION_ID, '20260101', 'granted', 10, 10, 10]
  );
  account.db.exec('PRAGMA foreign_keys=ON');
}

/** Returns integers as strings, as node-postgres does for BIGINT columns. */
const asPostgres = (adapter: DatabaseAdapter): DatabaseAdapter =>
  ({
    ...adapter,
    query: async (sql: string, params?: unknown[]) =>
      (await adapter.query<Record<string, unknown>>(sql, params)).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === 'number' ? String(value) : value,
          ])
        )
      ),
  }) as DatabaseAdapter;

describe('statement consent reads across metadata and account databases', () => {
  let metadata: Fixture;
  let account: Fixture;
  let stores: StatementConsentStores;

  beforeEach(async () => {
    metadata = core();
    account = core();
    stores = { metadata: metadata.adapter, account: account.adapter };
    await seedDefinitions(metadata.adapter);
  });

  afterEach(() => {
    metadata.db.close();
    account.db.close();
  });

  describe('getConsentItemsForScreen', () => {
    it('shows the metadata definition with the status of the record in the account database', async () => {
      await seedOldRecord(account);

      const items = await getConsentItemsForScreen(stores, TENANT, null, USER, 'ja');

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        statement_id: STATEMENT,
        version_id: NEW_VERSION_ID,
        version: '20261025',
        title: '利用規約',
        is_required: true,
        current_status: 'granted',
        current_version: '20260101',
        needs_version_upgrade: true,
      });
    });

    it('asks for a statement the account has no record of yet', async () => {
      const items = await getConsentItemsForScreen(stores, TENANT, null, USER, 'en');

      expect(items).toHaveLength(1);
      expect(items[0].current_status).toBeUndefined();
      expect(items[0].needs_version_upgrade).toBe(false);
    });

    it('fails closed when the account records cannot be read, never asking again or skipping', async () => {
      const unavailable = {
        ...account.adapter,
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('user_consent_records')) throw new Error('account database down');
          return account.adapter.query(sql, params);
        },
      } as DatabaseAdapter;

      await expect(
        getConsentItemsForScreen(
          { metadata: metadata.adapter, account: unavailable },
          TENANT,
          null,
          USER,
          'en'
        )
      ).rejects.toBeInstanceOf(StatementConsentAccountReadError);
    });

    it('still requires a statement when integers come back as strings, as node-postgres returns BIGINT', async () => {
      await seedOldRecord(account);
      // D1 keeps a foreign key to the client table here; the PostgreSQL schema has none.
      metadata.db.exec('PRAGMA foreign_keys=OFF');
      await metadata.adapter.execute(
        `INSERT INTO client_consent_overrides(id,tenant_id,client_id,statement_id,requirement,display_order,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        ['override-1', TENANT, 'client-1', STATEMENT, 'inherit', 10, 1, 1]
      );
      metadata.db.exec('PRAGMA foreign_keys=ON');

      const items = await getConsentItemsForScreen(
        { metadata: asPostgres(metadata.adapter), account: asPostgres(account.adapter) },
        TENANT,
        'client-1',
        USER,
        'ja'
      );

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        statement_id: STATEMENT,
        display_order: 10,
        is_required: true,
        current_status: 'granted',
        needs_version_upgrade: true,
      });
    });

    it('expires a re-consent interval that has passed when granted_at comes back as a string', async () => {
      await metadata.adapter.execute(`UPDATE consent_statements SET reconsent_interval_days = 30`);
      account.db.exec('PRAGMA foreign_keys=OFF');
      await account.adapter.execute(
        `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,granted_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          'rec-old',
          TENANT,
          USER,
          STATEMENT,
          NEW_VERSION_ID,
          '20261025',
          'granted',
          Date.now() - 90 * 86_400_000,
          10,
          10,
        ]
      );
      account.db.exec('PRAGMA foreign_keys=ON');

      const requirements = await resolveConsentRequirements(
        asPostgres(metadata.adapter),
        TENANT,
        null,
        {}
      );
      const result = await checkUserConsentSatisfaction(
        asPostgres(account.adapter),
        TENANT,
        USER,
        requirements
      );

      expect(result).toEqual({ satisfied: false, unsatisfied: [STATEMENT] });
    });

    it('does not touch the account records when nothing is required', async () => {
      await metadata.adapter.execute(`UPDATE consent_statements SET is_active = 0`);
      const neverRead = {
        ...account.adapter,
        query: async (sql: string) => {
          if (sql.includes('user_consent_records')) throw new Error('must not be read');
          return [];
        },
      } as DatabaseAdapter;

      await expect(
        getConsentItemsForScreen(
          { metadata: metadata.adapter, account: neverRead },
          TENANT,
          null,
          USER,
          'en'
        )
      ).resolves.toEqual([]);
    });
  });

  describe('lookupStatementDefinitions', () => {
    it('falls back to English per field and omits what the metadata database does not have', async () => {
      const lookup = await lookupStatementDefinitions(
        metadata.adapter,
        TENANT,
        {
          statementIds: [STATEMENT, 'statement-gone'],
          versionIds: [NEW_VERSION_ID, OLD_VERSION_ID],
        },
        'ja'
      );

      expect(lookup.statements.get(STATEMENT)).toEqual({
        slug: 'terms',
        category: 'terms_of_service',
      });
      expect(lookup.statements.has('statement-gone')).toBe(false);
      // The Japanese description is empty text, so it is kept; the title is Japanese.
      expect(lookup.localizations.get(NEW_VERSION_ID)).toEqual({
        title: '利用規約',
        description: '',
      });
      // A version with no localization has no entry (the caller shows the slug).
      expect(lookup.localizations.has(OLD_VERSION_ID)).toBe(false);
    });

    it('reads more ids than fit in one statement', async () => {
      const ids = Array.from({ length: 95 }, (_, i) => `statement-${i}`);
      const lookup = await lookupStatementDefinitions(
        metadata.adapter,
        TENANT,
        { statementIds: [...ids, STATEMENT], versionIds: [] },
        'en'
      );
      expect([...lookup.statements.keys()]).toEqual([STATEMENT]);
    });

    it('never reads another tenant', async () => {
      const lookup = await lookupStatementDefinitions(
        metadata.adapter,
        'tenant-b',
        { statementIds: [STATEMENT], versionIds: [NEW_VERSION_ID] },
        'en'
      );
      expect(lookup.statements.size).toBe(0);
      expect(lookup.localizations.size).toBe(0);
    });
  });
});
