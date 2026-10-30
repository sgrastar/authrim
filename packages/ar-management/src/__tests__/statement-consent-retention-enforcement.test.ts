import { afterEach, describe, expect, it } from 'vitest';
import { ensureStatementConsentTenantGuard } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { retainStatementConsentPage } from '../consent-retention-jobs';

const opened: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.db.close();
});
function store() {
  const f = openCoreStore();
  opened.push(f);
  return f;
}
async function fixture() {
  const metadata = store(),
    account = store();
  const now = Date.now();
  const insert = account.db.prepare(`INSERT INTO user_consent_records
    (id,tenant_id,user_id,statement_id,version_id,version,status,consent_settings_snapshot_at,retain_until,created_at,updated_at)
    VALUES(?,'tenant-a',?,'missing','missing','20261029',?,1,?,1,1)`);
  insert.run('expired', 'expired', 'denied', now - 10000);
  insert.run('future', 'future', 'withdrawn', now + 86400000);
  insert.run('granted', 'granted', 'granted', now - 10000);
  for (const id of ['expired', 'future', 'granted'])
    account.db
      .prepare(
        `INSERT INTO consent_item_history(id,tenant_id,user_id,statement_id,action,created_at,consent_settings_snapshot_at,retain_until)
      VALUES(?,'tenant-a',?,'missing','denied',1,1,?)`
      )
      .run(id, id, id === 'future' ? now + 86400000 : now - 10000);
  await ensureStatementConsentTenantGuard(account.adapter, 'tenant-a', now);
  const run = (at = now) =>
    retainStatementConsentPage(
      metadata.adapter,
      'tenant-a',
      [{ bindingRef: 'account', adapter: account.adapter }],
      { rowPageSize: 10, shardPageSize: 2 },
      at
    );
  return { metadata, account, now, run };
}
describe('retention under production enforcement', () => {
  it('rejects ordinary DELETE and purges only expired terminal evidence through the job', async () => {
    const f = await fixture();
    for (const table of ['user_consent_records', 'consent_item_history'])
      await expect(
        f.account.adapter.execute(`DELETE FROM ${table} WHERE id='expired'`)
      ).rejects.toThrow(/delete_guard/);
    await f.run();
    for (const table of ['user_consent_records', 'consent_item_history'])
      expect(await f.account.adapter.query(`SELECT id FROM ${table} ORDER BY id`)).toEqual([
        { id: 'future' },
        { id: 'granted' },
      ]);
    expect(
      await f.account.adapter.query('SELECT * FROM statement_consent_retention_permits')
    ).toEqual([]);
  });
  it('refuses a future cutoff even when a caller tries to classify future rows as expired', async () => {
    const f = await fixture();
    await expect(f.run(f.now + 2 * 86400000)).rejects.toThrow(/delete_guard/);
    expect(
      await f.account.adapter.queryOne('SELECT COUNT(*) AS n FROM consent_item_history')
    ).toEqual({ n: 3 });
    expect(
      await f.account.adapter.query('SELECT * FROM statement_consent_retention_permits')
    ).toEqual([]);
  });
  it('keeps failed pages pending and retries after a lost batch response without leftover authority', async () => {
    const f = await fixture();
    const batch = f.account.adapter.batch.bind(f.account.adapter);
    let lost = true;
    f.account.adapter.batch = async (statements) => {
      const result = await batch(statements);
      if (lost) {
        lost = false;
        throw new Error('lost_retention_response');
      }
      return result;
    };
    await expect(f.run()).rejects.toThrow('lost_retention_response');
    await f.run();
    expect(
      await f.account.adapter.query('SELECT * FROM statement_consent_retention_permits')
    ).toEqual([]);
    expect(
      await f.account.adapter.queryOne("SELECT id FROM user_consent_records WHERE id='future'")
    ).toEqual({ id: 'future' });
    expect(
      await f.account.adapter.queryOne("SELECT id FROM user_consent_records WHERE id='expired'")
    ).toBeNull();
  });
});
