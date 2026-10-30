import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { processConsentItemDecisions, activateVersion } from '../../utils/consent-statements';
import { withdrawStatementConsent } from '../statement-consent-writes';
import { projectStatementConsentGeneration } from '../statement-consent-generations';
import { listUserStatementConsentRecords } from '../statement-consent-records';
import type { StatementConsentStores } from '../statement-consent-stores';

/**
 * Writes of statement consent when the definitions (metadata database) and the subject's records
 * (account database) are different databases. The account database has the D1 core schema with
 * its foreign keys switched off, as it will once they are removed from the record tables.
 */

const TENANT = 'tenant-a';
const USER = 'user-a';
const STATEMENT = 'statement-terms';
const VERSION_ID = 'version-terms-1';
const HASH = 'b'.repeat(64);
const evidence = { client_id: 'client-a', user_agent: 'ua' };
const target = { [STATEMENT]: { version_id: VERSION_ID, version: '20261025' } };

interface Fixture {
  db: DatabaseSync;
  adapter: DatabaseAdapter;
}

function core(): Fixture {
  return sqliteAdapter('core');
}

async function seedDefinitions(adapter: DatabaseAdapter, withdrawalAllowed = 1): Promise<void> {
  await adapter.execute(
    `INSERT INTO consent_statements(id,tenant_id,slug,is_active,withdrawal_allowed,record_retention_days,reconsent_interval_days,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [STATEMENT, TENANT, 'terms', 1, withdrawalAllowed, 30, 90, 1, 1]
  );
  await adapter.execute(
    `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,content_hash,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [VERSION_ID, TENANT, STATEMENT, '20261025', 1, 'active', 1, HASH, 1, 1]
  );
}

describe('statement consent writes across metadata and account databases', () => {
  let metadata: Fixture;
  let account: Fixture;
  let stores: StatementConsentStores;

  beforeEach(async () => {
    metadata = core();
    account = core();
    account.db.exec('PRAGMA foreign_keys=ON');
    stores = { metadata: metadata.adapter, account: account.adapter };
    await seedDefinitions(metadata.adapter);
  });

  afterEach(() => {
    metadata.db.close();
    account.db.close();
  });

  const count = async (adapter: DatabaseAdapter, table: string) =>
    (await adapter.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

  it('writes the record and its history to the account database only', async () => {
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      'iphash',
      target
    );

    expect(await count(account.adapter, 'user_consent_records')).toBe(1);
    expect(await count(account.adapter, 'consent_item_history')).toBe(1);
    expect(await count(metadata.adapter, 'user_consent_records')).toBe(0);
    expect(await count(metadata.adapter, 'consent_item_history')).toBe(0);
  });

  it('rolls the record back when the history write fails', async () => {
    account.db.exec(
      "CREATE TRIGGER injected_history_failure BEFORE INSERT ON consent_item_history BEGIN SELECT RAISE(ABORT, 'injected_history_failure'); END;"
    );
    await expect(
      processConsentItemDecisions(
        stores,
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        'iphash',
        target
      )
    ).rejects.toThrow('injected_history_failure');
    expect(await count(account.adapter, 'user_consent_records')).toBe(0);
    expect(await count(account.adapter, 'consent_item_history')).toBe(0);
  });

  it('keeps the document hash and the retention snapshot of the metadata definition', async () => {
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      'iphash',
      target
    );

    const [record] = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
    expect(record).toMatchObject({
      version_id: VERSION_ID,
      content_hash: HASH,
      record_retention_days_snapshot: 30,
      reconsent_interval_days_snapshot: 90,
    });
    const [history] = await account.adapter.query<{ content_hash_after: string | null }>(
      `SELECT content_hash_after FROM consent_item_history`
    );
    expect(history.content_hash_after).toBe(HASH);
  });

  it('withdraws a grant, keeping the hash of what had been agreed to', async () => {
    const grant = { [STATEMENT]: 'granted' as const };
    const deny = { [STATEMENT]: 'denied' as const };
    await processConsentItemDecisions(stores, TENANT, USER, grant, evidence, 'iphash', target);
    await processConsentItemDecisions(stores, TENANT, USER, deny, evidence, 'iphash', target);

    const [record] = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
    expect(record).toMatchObject({ status: 'withdrawn', content_hash: HASH });
    const history = await account.adapter.query<{
      action: string;
      content_hash_after: string | null;
    }>(`SELECT action, content_hash_after FROM consent_item_history ORDER BY created_at, action`);
    expect(history.map((row) => row.action).sort()).toEqual(['granted', 'withdrawn']);
    expect(history.every((row) => row.content_hash_after === HASH)).toBe(true);
  });

  it('enforces the withdrawal setting of the metadata definition', async () => {
    await metadata.adapter.execute(`UPDATE consent_statements SET withdrawal_allowed = 0`);
    const grant = { [STATEMENT]: 'granted' as const };
    const deny = { [STATEMENT]: 'denied' as const };
    const locked = {
      [STATEMENT]: { ...target[STATEMENT], withdrawal_allowed: false },
    };
    await processConsentItemDecisions(stores, TENANT, USER, grant, evidence, 'iphash', locked);
    await processConsentItemDecisions(stores, TENANT, USER, deny, evidence, 'iphash', locked);

    const [record] = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
    expect(record.status).toBe('granted');
  });

  it('records a refusal with the hash of the document that was shown', async () => {
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'denied' },
      evidence,
      'iphash',
      target
    );

    const [record] = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
    expect(record).toMatchObject({ status: 'denied', content_hash: HASH });
  });

  it('records a refusal of a newer version against that version and its hash', async () => {
    const NEW_VERSION_ID = 'version-terms-2';
    await account.adapter.execute(
      `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,created_at,updated_at,content_hash)
       VALUES('legacy-expired',?,?,?,?,?,'expired',1,1,?)`,
      [TENANT, USER, STATEMENT, VERSION_ID, '20261025', HASH]
    );
    await metadata.adapter.execute(`UPDATE consent_statement_versions SET is_current = 0`);
    await metadata.adapter.execute(
      `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,content_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [NEW_VERSION_ID, TENANT, STATEMENT, '20261101', 1, 'active', 1, 'c'.repeat(64), 1, 1]
    );

    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'denied' },
      evidence,
      'iphash',
      { [STATEMENT]: { version_id: NEW_VERSION_ID, version: '20261101' } }
    );

    const [record] = await listUserStatementConsentRecords(account.adapter, TENANT, USER);
    expect(record).toMatchObject({
      status: 'denied',
      version_id: NEW_VERSION_ID,
      version: '20261101',
      content_hash: 'c'.repeat(64),
    });
    const [latest] = await account.adapter.query<{
      version_id_after: string;
      content_hash_after: string;
    }>(
      `SELECT version_id_after, content_hash_after FROM consent_item_history WHERE action = 'denied'`
    );
    expect(latest).toEqual({
      version_id_after: NEW_VERSION_ID,
      content_hash_after: 'c'.repeat(64),
    });
  });

  it('writes nothing when the definition cannot be found', async () => {
    await metadata.adapter.execute(`DELETE FROM consent_statement_versions`);
    await processConsentItemDecisions(stores, TENANT, USER, { [STATEMENT]: 'granted' }, evidence);

    expect(await count(account.adapter, 'user_consent_records')).toBe(0);
  });

  it('bootstraps a legacy record at revision zero before its first transition', async () => {
    await account.adapter.execute(
      "INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,created_at,updated_at) VALUES('legacy',?,?,?,?,?,'withdrawn',1,1)",
      [TENANT, USER, STATEMENT, VERSION_ID, '20261025']
    );
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      undefined,
      target
    );
    expect(
      await account.adapter.queryOne(
        'SELECT revision,withdrawal_generation FROM statement_consent_key_states'
      )
    ).toEqual({ revision: 1, withdrawal_generation: 0 });
    expect(await account.adapter.queryOne('SELECT id,status FROM user_consent_records')).toEqual({
      id: 'legacy',
      status: 'granted',
    });
  });
  it('recovers a committed batch with a lost acknowledgement without duplicating history', async () => {
    const batch = account.adapter.batch.bind(account.adapter);
    let lose = true;
    account.adapter.batch = async (statements) => {
      const result = await batch(statements);
      if (lose) {
        lose = false;
        throw new Error('lost_ack');
      }
      return result;
    };
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      undefined,
      target
    );
    expect(await count(account.adapter, 'consent_item_history')).toBe(1);
    expect(await count(account.adapter, 'statement_consent_operations')).toBe(1);
  });
  it('refuses unsupported backends before making any account writes', async () => {
    const unsupported = { ...account.adapter, getType: () => 'dsql' };
    await expect(
      processConsentItemDecisions(
        { metadata: metadata.adapter, account: unsupported },
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        undefined,
        target
      )
    ).rejects.toThrow('statement_consent_atomic_backend_unsupported');
    expect(await count(account.adapter, 'user_consent_records')).toBe(0);
    expect(await count(account.adapter, 'statement_consent_guards')).toBe(0);
  });
  it('withdraws retained evidence atomically after definition removal and audits the admin actor', async () => {
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      undefined,
      target
    );
    await metadata.adapter.execute('DELETE FROM consent_statement_versions');
    await metadata.adapter.execute('DELETE FROM consent_statements');
    expect(
      await withdrawStatementConsent(stores, TENANT, USER, STATEMENT, {
        actor: { id: 'admin-a', type: 'admin' },
      })
    ).toBe('withdrawn');
    expect(
      await account.adapter.queryOne('SELECT status,content_hash FROM user_consent_records')
    ).toEqual({ status: 'withdrawn', content_hash: HASH });
    expect(
      await account.adapter.queryOne(
        "SELECT metadata_json FROM consent_item_history WHERE action='withdrawn'"
      )
    ).toEqual({ metadata_json: JSON.stringify({ initiated_by: 'admin', actor_id: 'admin-a' }) });
  });
  it('keeps withdrawal available after a statement guard closes, while rejecting further grants', async () => {
    await processConsentItemDecisions(
      stores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      undefined,
      target
    );
    await projectStatementConsentGeneration(account.adapter, TENANT, {
      statement_id: STATEMENT,
      definition_generation: 0,
      closed_generation: 0,
      mode: 'closed',
    });
    await expect(
      processConsentItemDecisions(
        stores,
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        undefined,
        target
      )
    ).rejects.toThrow('statement_consent_transition_rejected');
    expect(
      await withdrawStatementConsent(stores, TENANT, USER, STATEMENT, {
        actor: { id: 'admin-a', type: 'admin' },
      })
    ).toBe('withdrawn');
  });
  it('refuses restored keys without the target guard identity instead of trusting a new identity', async () => {
    await account.adapter.execute(
      "INSERT INTO statement_consent_key_states(tenant_id,user_id,statement_id,account_id,physical_id,restore_epoch,revision,withdrawal_generation,updated_at) VALUES(?,?,?,'source-account','source-physical','source-epoch',0,0,1)",
      [TENANT, USER, STATEMENT]
    );
    await expect(
      processConsentItemDecisions(
        stores,
        TENANT,
        USER,
        { [STATEMENT]: 'granted' },
        evidence,
        undefined,
        target
      )
    ).rejects.toThrow('statement_consent_restore_rebind_required');
    expect(await count(account.adapter, 'statement_consent_guards')).toBe(0);
  });

  it.each(['put', 'delete'])(
    'rejects activation after a concurrent draft localization %s',
    async (action) => {
      await metadata.adapter.execute(
        `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,created_at,updated_at)
      VALUES('draft',?,?,'20261029',1,'draft',1,1)`,
        [TENANT, STATEMENT]
      );
      await metadata.adapter.execute(
        `INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,document_url,created_at,updated_at)
      VALUES('draft-loc',?,'draft','en','Terms','Terms','https://example.com/old',1,1)`,
        [TENANT]
      );
      const batch = metadata.adapter.batch.bind(metadata.adapter);
      let race = true;
      const racing: DatabaseAdapter = {
        ...metadata.adapter,
        batch: async (statements) => {
          if (race) {
            race = false;
            await batch([
              {
                sql: "UPDATE consent_statement_versions SET updated_at=updated_at+1 WHERE id='draft' AND tenant_id=?",
                params: [TENANT],
              },
              {
                sql:
                  action === 'put'
                    ? "UPDATE consent_statement_localizations SET document_url='https://example.com/new' WHERE version_id='draft' AND tenant_id=?"
                    : "DELETE FROM consent_statement_localizations WHERE version_id='draft' AND tenant_id=?",
                params: [TENANT],
              },
            ]);
          }
          return batch(statements);
        },
      };
      await expect(activateVersion(racing, TENANT, STATEMENT, 'draft')).rejects.toThrow(
        'document_changed'
      );
      expect(
        await metadata.adapter.queryOne(
          "SELECT status,is_current,content_hash FROM consent_statement_versions WHERE id='draft'"
        )
      ).toEqual({ status: 'draft', is_current: 0, content_hash: null });
      expect(
        await metadata.adapter.queryOne(
          'SELECT is_current FROM consent_statement_versions WHERE id=?',
          [VERSION_ID]
        )
      ).toEqual({ is_current: 1 });
      expect(
        await metadata.adapter.queryOne('SELECT definition_generation FROM consent_statements')
      ).toEqual({ definition_generation: 0 });
      expect(
        await metadata.adapter.query('SELECT * FROM statement_consent_projection_jobs')
      ).toEqual([]);
    }
  );

  it('rolls activation and generation back when durable projection enqueue fails', async () => {
    await metadata.adapter.execute(
      "INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,created_at,updated_at) VALUES('loc',?,?,'en','Terms','Terms',1,1)",
      [TENANT, VERSION_ID]
    );
    metadata.db.exec(
      "CREATE TRIGGER injected_enqueue_failure BEFORE INSERT ON statement_consent_projection_jobs BEGIN SELECT RAISE(ABORT,'enqueue_failure'); END;"
    );
    await expect(activateVersion(metadata.adapter, TENANT, STATEMENT, VERSION_ID)).rejects.toThrow(
      'enqueue_failure'
    );
    expect(
      await metadata.adapter.queryOne('SELECT definition_generation FROM consent_statements')
    ).toEqual({ definition_generation: 0 });
    expect(
      await metadata.adapter.queryOne(
        'SELECT content_hash,is_current FROM consent_statement_versions'
      )
    ).toEqual({ content_hash: HASH, is_current: 1 });
  });
  it('normalizes string BIGINT values at every account and metadata read boundary', async () => {
    const strings = (adapter: DatabaseAdapter): DatabaseAdapter => ({
      ...adapter,
      queryOne: async <T>(...args: Parameters<DatabaseAdapter['queryOne']>): Promise<T | null> => {
        const value = await adapter.queryOne<T>(...args);
        return value && typeof value === 'object'
          ? (Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [
                key,
                typeof entry === 'number' ? String(entry) : entry,
              ])
            ) as T)
          : value;
      },
    });
    const stringStores = { metadata: strings(metadata.adapter), account: strings(account.adapter) };
    await processConsentItemDecisions(
      stringStores,
      TENANT,
      USER,
      { [STATEMENT]: 'granted' },
      evidence,
      undefined,
      target
    );
    await processConsentItemDecisions(
      stringStores,
      TENANT,
      USER,
      { [STATEMENT]: 'denied' },
      evidence,
      undefined,
      target
    );
    expect(
      await account.adapter.queryOne(
        'SELECT revision,withdrawal_generation FROM statement_consent_key_states'
      )
    ).toEqual({ revision: 2, withdrawal_generation: 1 });
    expect(
      await account.adapter.queryOne(
        'SELECT record_retention_days_snapshot FROM user_consent_records'
      )
    ).toEqual({ record_retention_days_snapshot: 30 });
  });

  it('bumps the definition generation and durably queues projection with version activation', async () => {
    await metadata.adapter.execute(
      "INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,created_at,updated_at) VALUES('loc',?,?, 'en','Terms','Terms',1,1)",
      [TENANT, VERSION_ID]
    );
    await activateVersion(metadata.adapter, TENANT, STATEMENT, VERSION_ID);
    expect(
      await metadata.adapter.queryOne(
        'SELECT definition_generation FROM consent_statements WHERE id=?',
        [STATEMENT]
      )
    ).toEqual({ definition_generation: 1 });
    expect(
      await metadata.adapter.queryOne(
        'SELECT definition_generation,cursor_binding_ref FROM statement_consent_projection_jobs'
      )
    ).toEqual({ definition_generation: 1, cursor_binding_ref: null });
  });
});
