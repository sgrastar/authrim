import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';

const mocks = vi.hoisted(() => ({
  metadata: null as DatabaseAdapter | null,
  stores: [] as Array<{ bindingRef: string; adapter: DatabaseAdapter }>,
  directory: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  listEnvironmentTenantDefaultStores: mocks.directory,
}));
vi.mock('../compliance/tenant-stores', () => ({
  tenantCoreStores: vi.fn(async () => mocks.stores),
}));
import { processConsentRetentionJobs } from '../consent-retention-jobs';
import { processStatementConsentReferenceAuditJobs } from '../statement-consent-reference-audit';
import { readConsentJob } from '../statement-consent-job-state';
const opened: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.db.close();
  vi.restoreAllMocks();
});
function core() {
  const s = openCoreStore();
  opened.push(s);
  return s;
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.stores = [];
});
function config() {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}
function setup(routed = true) {
  const metadata = core(),
    account = core();
  mocks.metadata = metadata.adapter;
  mocks.stores = [{ bindingRef: 'account-a', adapter: account.adapter }];
  mocks.directory.mockResolvedValue([
    { tenantId: 'tenant-a', store: { source: metadata.adapter, bindingRef: 'metadata' } },
  ]);
  const kv = config();
  const env = {
    DB: metadata.adapter,
    AUTHRIM_CONFIG: kv,
    ...(routed ? { TENANT_RUNTIME_REGISTRY: {} } : {}),
  } as unknown as Env;
  return { metadata, account, kv, env };
}
describe('consent maintenance scheduler routing', () => {
  it('purges snapshot evidence in account shards even with no metadata definition', async () => {
    const f = setup();
    f.account.db.exec(`PRAGMA foreign_keys=OFF;
      INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,consent_settings_snapshot_at,retain_until,created_at,updated_at)
      VALUES('r','tenant-a','u','absent','absent','20261029','denied',1,2,1,1)`);
    await processConsentRetentionJobs(f.env, log);
    await processConsentRetentionJobs(f.env, log);
    expect(await f.account.adapter.query('SELECT * FROM user_consent_records')).toEqual([]);
    expect((await readConsentJob(f.metadata.adapter, 'tenant-a', 'retention'))?.status).toBe(
      'completed'
    );
    // No stored cursor means the first page: the directory rejects an empty string as a cursor.
    expect(mocks.directory).toHaveBeenCalledWith(f.env, { limit: 4, afterTenantId: undefined });
  });
  it('fails closed before accessing a store when the routed directory is unavailable', async () => {
    const f = setup();
    const query = vi.spyOn(f.metadata.adapter, 'query');
    mocks.directory.mockRejectedValueOnce(new Error('environment_tenant_directory_unavailable'));
    await expect(processConsentRetentionJobs(f.env, log)).rejects.toThrow(
      'environment_tenant_directory_unavailable'
    );
    expect(query).not.toHaveBeenCalled();
    expect(f.kv.put).not.toHaveBeenCalled();
  });
  it('works without routing and configures bounded pages with environment over KV over defaults', async () => {
    const f = setup(false);
    const env = {
      ...f.env,
      CONSENT_REFERENCE_AUDIT_ROW_PAGE_SIZE: '1',
      KV: { get: vi.fn(async () => '2') },
    } as unknown as Env;
    await processStatementConsentReferenceAuditJobs(env, log);
    expect((await readConsentJob(f.metadata.adapter, 'tenant-a', 'reference-audit'))?.status).toBe(
      'completed'
    );
    expect(mocks.directory).not.toHaveBeenCalled();
    await expect(
      processStatementConsentReferenceAuditJobs(
        { ...env, CONSENT_REFERENCE_AUDIT_ROW_PAGE_SIZE: '0' } as unknown as Env,
        log
      )
    ).rejects.toThrow('statement_consent_job_setting_invalid');
  });
});
