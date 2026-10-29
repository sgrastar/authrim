import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { auditStatementConsentPage } from '../statement-consent-reference-audit';
import { retainStatementConsentPage } from '../consent-retention-jobs';
import { readConsentJob, type ConsentJobRow } from '../statement-consent-job-state';

const opened: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.db.close();
});
function core() {
  const s = openCoreStore();
  opened.push(s);
  return s;
}
function fixture() {
  const metadata = core(),
    first = core(),
    second = core();
  first.db.exec('PRAGMA foreign_keys=OFF');
  second.db.exec('PRAGMA foreign_keys=OFF');
  metadata.db
    .exec(`INSERT INTO consent_statements(id,tenant_id,slug,record_retention_days,created_at,updated_at) VALUES('terms','tenant-a','terms',1,1,1);
    INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,created_at,updated_at) VALUES('v1','tenant-a','terms','20261029',1,'active',1,1);`);
  return {
    metadata,
    first,
    second,
    stores: [
      { bindingRef: 'a', adapter: first.adapter },
      { bindingRef: 'b', adapter: second.adapter },
    ],
  };
}
function record(
  store: ReturnType<typeof core>,
  id: string,
  options: {
    statement?: string;
    version?: string;
    status?: string;
    tenant?: string;
    snapshot?: number | null;
    until?: number | null;
  } = {}
) {
  store.db
    .prepare(
      `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,consent_settings_snapshot_at,retain_until,created_at,updated_at)
    VALUES(?,?,?,?,?,'20261029',?,?,?,?,?)`
    )
    .run(
      id,
      options.tenant ?? 'tenant-a',
      id,
      options.statement ?? 'terms',
      options.version ?? 'v1',
      options.status ?? 'denied',
      options.snapshot ?? null,
      options.until ?? null,
      1,
      1
    );
}
function history(
  store: ReturnType<typeof core>,
  id: string,
  userId = id,
  statement = 'terms',
  snapshot: number | null = null,
  until: number | null = null
) {
  store.db
    .prepare(
      `INSERT INTO consent_item_history(id,tenant_id,user_id,statement_id,action,consent_settings_snapshot_at,retain_until,created_at) VALUES(?,'tenant-a',?,?,'denied',?,?,1)`
    )
    .run(id, userId, statement, snapshot, until);
}
const auditOptions = { rowPageSize: 2, shardPageSize: 2, sampleLimit: 1 };
const retentionOptions = { rowPageSize: 2, shardPageSize: 4 };
async function finishRetention(f: ReturnType<typeof fixture>) {
  for (let n = 0; n < 30; n++) {
    await retainStatementConsentPage(
      f.metadata.adapter,
      'tenant-a',
      f.stores,
      retentionOptions,
      200_000_000
    );
    if ((await readConsentJob(f.metadata.adapter, 'tenant-a', 'retention'))?.status === 'completed')
      return;
  }
  throw new Error('retention did not finish');
}
function payload(row: ConsentJobRow | null, key: 'config' | 'result' = 'config'): unknown {
  if (!row?.[key]) throw new Error('missing job payload');
  return JSON.parse(row[key]) as unknown;
}
describe('bounded reference audit and retention across real account shards', () => {
  it('resolves tenant/statement/version together, bounds samples, and never deletes evidence', async () => {
    const f = fixture();
    record(f.first, 'a');
    record(f.first, 'b', { statement: 'missing' });
    record(f.first, 'c', { version: 'missing' });
    record(f.second, 'a', { tenant: 'tenant-b', statement: 'missing' });
    record(f.second, 'b');
    await auditStatementConsentPage(f.metadata.adapter, 'tenant-a', f.stores, auditOptions);
    let row = await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit');
    expect(payload(row)).toMatchObject({
      shard: 0,
      after_id: 'b',
      scanned: 2,
      unresolved: 1,
    });
    await auditStatementConsentPage(f.metadata.adapter, 'tenant-a', f.stores, auditOptions);
    row = await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit');
    expect(row?.status).toBe('completed');
    expect(payload(row, 'result')).toMatchObject({
      scanned: 4,
      unresolved: 2,
      samples_truncated: true,
      samples: [{ record_id: 'b', missing_statement: true, missing_version: true }],
    });
    expect(await f.first.adapter.query('SELECT id FROM user_consent_records')).toHaveLength(3);
    expect(await readConsentJob(f.metadata.adapter, 'tenant-b', 'reference-audit')).toBeNull();
  });
  it('keeps the last completed shard on a failed next shard, then retries without double counting', async () => {
    const f = fixture();
    record(f.first, 'a');
    record(f.second, 'b');
    const failing = {
      ...f.stores[1],
      adapter: {
        ...f.second.adapter,
        query: vi.fn().mockRejectedValue(new Error('shard unavailable')),
      },
    };
    await expect(
      auditStatementConsentPage(
        f.metadata.adapter,
        'tenant-a',
        [f.stores[0], failing],
        auditOptions
      )
    ).rejects.toThrow('shard unavailable');
    expect(
      payload(await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit'))
    ).toMatchObject({ shard: 1, scanned: 1 });
    await auditStatementConsentPage(f.metadata.adapter, 'tenant-a', f.stores, auditOptions);
    expect(
      payload(await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit'), 'result')
    ).toMatchObject({ scanned: 2, unresolved: 0 });
  });
  it('does not acknowledge metadata read failures or obsolete target inventories', async () => {
    const f = fixture();
    record(f.first, 'a');
    record(f.second, 'b');
    const query = f.metadata.adapter.query.bind(f.metadata.adapter);
    const failing = {
      ...f.metadata.adapter,
      query: vi.fn().mockRejectedValue(new Error('metadata unavailable')),
    };
    await expect(
      auditStatementConsentPage(failing, 'tenant-a', f.stores, auditOptions)
    ).rejects.toThrow('metadata unavailable');
    expect(
      payload(await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit'))
    ).toMatchObject({ shard: 0, scanned: 0 });
    await auditStatementConsentPage({ ...f.metadata.adapter, query }, 'tenant-a', f.stores, {
      ...auditOptions,
      shardPageSize: 1,
    });
    await auditStatementConsentPage(
      f.metadata.adapter,
      'tenant-a',
      [{ ...f.stores[0], identity: { generation: 2 } }, f.stores[1]],
      { ...auditOptions, shardPageSize: 1 }
    );
    expect(
      payload(await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit'))
    ).toMatchObject({ shard: 1, scanned: 1 });
  });
  it('does not let an older worker overwrite a newer durable page', async () => {
    const f = fixture();
    record(f.first, 'a');
    record(f.first, 'b');
    record(f.first, 'c');
    const query = f.first.adapter.query.bind(f.first.adapter);
    let race = true;
    f.first.adapter.query = async <T>(...args: Parameters<typeof query>): Promise<T[]> => {
      const rows = await query<T>(...args);
      if (race) {
        race = false;
        await auditStatementConsentPage(f.metadata.adapter, 'tenant-a', f.stores, {
          ...auditOptions,
          rowPageSize: 1,
          shardPageSize: 1,
        });
        await auditStatementConsentPage(f.metadata.adapter, 'tenant-a', f.stores, {
          ...auditOptions,
          rowPageSize: 1,
          shardPageSize: 1,
        });
      }
      return rows;
    };
    await auditStatementConsentPage(f.metadata.adapter, 'tenant-a', f.stores, {
      ...auditOptions,
      rowPageSize: 1,
      shardPageSize: 1,
    });
    expect(
      payload(await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit'))
    ).toMatchObject({ scanned: 2, after_id: 'b' });
  });
  it('uses snapshot deadlines without definitions, and metadata days only for legacy rows', async () => {
    const f = fixture();
    record(f.first, 'a', { statement: 'absent', snapshot: 1, until: 2 });
    history(f.first, 'a', 'a', 'absent', 1, 2);
    record(f.first, 'b');
    history(f.first, 'b');
    record(f.first, 'c', { status: 'granted', snapshot: 1, until: 2 });
    history(f.first, 'c', 'c', 'terms', 1, 2);
    record(f.first, 'd', { snapshot: 1, until: null });
    history(f.first, 'd', 'd', 'terms', 1, null);
    record(f.second, 'e', { snapshot: 1, until: 300_000_000 });
    record(f.second, 'f', { tenant: 'tenant-b', snapshot: 1, until: 2 });
    record(f.second, 'g', { statement: 'absent' });
    history(f.second, 'g', 'g', 'absent');
    // Metadata policy does not exist in either account store; PostgreSQL returns its BIGINT as text.
    const query = f.metadata.adapter.query.bind(f.metadata.adapter);
    f.metadata.adapter.query = async <T>(...args: Parameters<typeof query>): Promise<T[]> => {
      const rows = await query(...args);
      return rows.map((r) =>
        typeof r === 'object' && r !== null && 'record_retention_days' in r
          ? { ...r, record_retention_days: '1' }
          : r
      ) as T[];
    };
    await finishRetention(f);
    expect(await f.first.adapter.query('SELECT id FROM user_consent_records ORDER BY id')).toEqual([
      { id: 'c' },
      { id: 'd' },
    ]);
    expect(await f.first.adapter.query('SELECT id FROM consent_item_history ORDER BY id')).toEqual([
      { id: 'c' },
      { id: 'd' },
    ]);
    expect(await f.second.adapter.query('SELECT id FROM user_consent_records ORDER BY id')).toEqual(
      [{ id: 'e' }, { id: 'f' }, { id: 'g' }]
    );
    expect(await f.second.adapter.query('SELECT id FROM consent_item_history')).toEqual([
      { id: 'g' },
    ]);
  });
  it('retains a durable cleanup cursor when a delete fails and retries only unfinished work', async () => {
    const f = fixture();
    record(f.first, 'a');
    history(f.first, 'a');
    record(f.second, 'b');
    history(f.second, 'b');
    f.second.db.exec(
      "CREATE TRIGGER injected_failure BEFORE DELETE ON consent_item_history BEGIN SELECT RAISE(ABORT,'delete_failure'); END"
    );
    await expect(
      retainStatementConsentPage(
        f.metadata.adapter,
        'tenant-a',
        f.stores,
        { rowPageSize: 2, shardPageSize: 4 },
        200_000_000
      )
    ).rejects.toThrow('delete_failure');
    expect(
      payload(await readConsentJob(f.metadata.adapter, 'tenant-a', 'retention'))
    ).toMatchObject({ shard: 1, phase: 'history' });
    f.second.db.exec('DROP TRIGGER injected_failure');
    await finishRetention(f);
    expect(await f.second.adapter.query('SELECT id FROM user_consent_records')).toEqual([]);
    expect(await f.second.adapter.query('SELECT id FROM consent_item_history')).toEqual([]);
  });
});
