import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { processConsentItemDecisions } from '../../utils/consent-statements';
import { projectStatementConsentGeneration } from '../statement-consent-generations';

describe('production writers with step-B database enforcement', () => {
  let metadata: ReturnType<typeof sqliteAdapter>;
  let account: ReturnType<typeof sqliteAdapter>;
  const target = { terms: { version_id: 'v1', version: '20261025' } };
  const projection = {
    statement_id: 'terms',
    definition_generation: 1,
    closed_generation: 0,
    mode: 'enforced' as const,
  };
  const write = (user = 'user-a', decision: 'granted' | 'denied' = 'granted') =>
    processConsentItemDecisions(
      { metadata: metadata.adapter, account: account.adapter },
      'tenant-a',
      user,
      { terms: decision },
      {},
      undefined,
      target
    );
  beforeEach(async () => {
    metadata = sqliteAdapter('core');
    account = sqliteAdapter('core');
    account.db.exec('PRAGMA foreign_keys=ON');
    await metadata.adapter.execute(
      "INSERT INTO consent_statements(id,tenant_id,slug,is_active,created_at,updated_at) VALUES('terms','tenant-a','terms',1,1,1)"
    );
    await metadata.adapter.execute(
      "INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,content_hash,created_at,updated_at) VALUES('v1','tenant-a','terms','20261025',1,'active',1,?,1,1)",
      ['b'.repeat(64)]
    );
  });
  afterEach(() => {
    metadata.db.close();
    account.db.close();
  });

  it('admits repeated consent, another user, and withdrawal without replacing authority', async () => {
    await write();
    await write();
    await write('user-b');
    await write('user-a', 'denied');
    expect(
      await account.adapter.query(
        'SELECT user_id,status FROM user_consent_records ORDER BY user_id'
      )
    ).toEqual([
      { user_id: 'user-a', status: 'withdrawn' },
      { user_id: 'user-b', status: 'granted' },
    ]);
    expect(
      await account.adapter.queryOne('SELECT COUNT(*) AS n FROM consent_item_history')
    ).toEqual({ n: 3 });
  });
  it('updates and retries generation projection, including retirement closure', async () => {
    await write();
    await projectStatementConsentGeneration(account.adapter, 'tenant-a', projection);
    await projectStatementConsentGeneration(account.adapter, 'tenant-a', projection);
    await projectStatementConsentGeneration(account.adapter, 'tenant-a', {
      ...projection,
      definition_generation: 2,
      closed_generation: 1,
      mode: 'closed',
    });
    await expect(
      projectStatementConsentGeneration(account.adapter, 'tenant-a', projection)
    ).rejects.toThrow('statement_consent_projection_stale');
    expect(
      await account.adapter.queryOne(
        "SELECT mode,definition_generation,closed_generation FROM statement_consent_guards WHERE scope_kind='statement'"
      )
    ).toEqual({ mode: 'closed', definition_generation: 2, closed_generation: 1 });
  });
  it('keeps REPLACE and identity mutation forbidden', async () => {
    await write();
    for (const table of ['statement_consent_guards', 'statement_consent_key_states']) {
      await expect(
        account.adapter.execute(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)
      ).rejects.toThrow(/replace_guard/);
      await expect(
        account.adapter.execute(`UPDATE ${table} SET physical_id='other'`)
      ).rejects.toThrow(/guard_monotonic|key_update_guard/);
    }
  });
  it('bootstraps two users concurrently without replacing their shared statement guard', async () => {
    await Promise.all([write('user-a'), write('user-b')]);
    expect(
      await account.adapter.queryOne('SELECT COUNT(*) AS n FROM statement_consent_key_states')
    ).toEqual({ n: 2 });
    expect(
      await account.adapter.queryOne('SELECT COUNT(*) AS n FROM user_consent_records')
    ).toEqual({ n: 2 });
  });
  it('recovers a competing creator after its primary-key failure only from the committed row', async () => {
    const execute = account.adapter.execute.bind(account.adapter);
    let raced = false;
    account.adapter.execute = async (sql, params) => {
      if (!raced && sql.startsWith('INSERT INTO statement_consent_key_states')) {
        raced = true;
        await execute(sql, params); // the competing creator committed this exact key
        throw Object.assign(new Error('concurrent_primary_key_violation'), { code: '23505' });
      }
      return execute(sql, params);
    };
    await write();
    expect(raced).toBe(true);
    expect(
      await account.adapter.queryOne('SELECT revision FROM statement_consent_key_states')
    ).toEqual({ revision: 1 });
  });
  it.each(['tenant', 'statement', 'key'])(
    'rereads a %s bootstrap after an ambiguous insert result',
    async (kind) => {
      const execute = account.adapter.execute.bind(account.adapter);
      let injected = false;
      account.adapter.execute = async (sql, params) => {
        const result = await execute(sql, params);
        if (
          !injected &&
          sql.startsWith('INSERT INTO statement_consent_') &&
          (kind === 'key' ? sql.includes('key_states') : sql.includes(`'${kind}'`))
        ) {
          injected = true;
          throw new Error('injected_bootstrap_result_unknown');
        }
        return result;
      };
      await write();
      await write();
      expect(injected).toBe(true);
      expect(
        await account.adapter.queryOne('SELECT COUNT(*) AS n FROM consent_item_history')
      ).toEqual({ n: 1 });
    }
  );
});
