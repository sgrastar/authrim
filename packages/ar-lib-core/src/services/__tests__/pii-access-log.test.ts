import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
import type { DatabaseAdapter } from '../../db/adapter';
import { disclosedPiiFields, PiiAccessLog, schedulePiiAccessLog } from '../pii-access-log';
import * as retention from '../../utils/audit-log';
import { PIIAuditLogRepository } from '../../repositories/pii/audit-log';
import { logProducerFixture } from './log-iceberg-producer-fixture';
const context = {
  tenantId: 'tenant-a',
  actorId: 'admin-1',
  actorType: 'human',
  requestId: 'req-1',
  operation: 'admin.users.list',
};
const origin = () => {
  const batch = vi.fn(async () => {
    throw new Error('source PII database must not receive a log');
  });
  return { batch, adapter: { batch } as unknown as DatabaseAdapter };
};
it('names only personal fields actually returned with values', () => {
  expect(
    disclosedPiiFields({ email: 'a@example.invalid', name: '', phone_number: null, id: 'u' }, [
      'email',
      'name',
      'phone_number',
      'birthdate',
    ])
  ).toEqual(['email']);
});
describe.each(['scheduled', 'pipeline'] as const)('PII access log storage (%s)', (mode) => {
  let f: Awaited<ReturnType<typeof logProducerFixture>>;
  beforeEach(async () => {
    f = await logProducerFixture(mode, { separateAdmin: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.close();
  });
  const records = () =>
    mode === 'scheduled'
      ? f.adminDb
          .prepare('SELECT header_json FROM log_iceberg_records')
          .all()
          .map((r) => JSON.parse(String(r.header_json)) as Record<string, unknown>)
      : [...f.objects.values()].map((v) => JSON.parse(v.text) as Record<string, unknown>);
  it('records the original access fields as encrypted bodies with no actor/target in overview or PII DB', async () => {
    const a = origin(),
      b = origin(),
      log = new PiiAccessLog(context);
    log.add({ key: 'PII_A', adapter: a.adapter }, 'user-1', ['email', 'name']);
    log.add({ key: 'PII_B', adapter: b.adapter }, 'user-2', ['email']);
    log.add({ key: 'PII_A', adapter: a.adapter }, 'user-3', []);
    expect(await log.write(f.env)).toEqual({ written: 2, failedStores: 0 });
    expect(a.batch).not.toHaveBeenCalled();
    expect(b.batch).not.toHaveBeenCalled();
    const rows = await f.rows('pii.audit_log_pii');
    expect(rows.map((r) => r.target_user_id).sort()).toEqual(['user-1', 'user-2']);
    expect(rows.every((r) => r.user_id === 'admin-1')).toBe(true);
    expect(JSON.parse(String(rows.find((r) => r.target_user_id === 'user-1')?.details))).toEqual({
      fields: ['email', 'name'],
      operation: context.operation,
      request_id: 'req-1',
      actor_type: 'human',
    });
    for (const record of records()) {
      expect(record.subject_id).toBeNull();
      expect(record.request_id).toBeNull();
      expect(record.resource_id).toBeNull();
      expect(JSON.stringify(record)).not.toContain('admin-1');
      expect(JSON.stringify(record)).not.toContain('user-1');
      expect(Number(record.expires_at) - Number(record.event_at)).toBe(365 * 86400000);
    }
    if (mode === 'pipeline')
      expect(f.adminDb.prepare('SELECT count(*) n FROM log_iceberg_records').get()?.n).toBe(0);
    else expect(f.objects.size).toBe(0);
  });
  it('fixes a configured retention at occurrence time', async () => {
    vi.spyOn(retention, 'resolveTenantAuditRetentionFromEnv').mockResolvedValue({
      event: { days: 90, source: 'pii_config', variesByRoute: false, archived: true },
      pii: { days: 7, source: 'pii_config', variesByRoute: false, archived: true },
    });
    await new PIIAuditLogRepository(f.env, 'tenant-a').logAccess(
      'actor',
      'target',
      'pii_viewed',
      undefined,
      { tenant_id: 'tenant-a' }
    );
    const [record] = records();
    expect(Number(record.expires_at) - Number(record.event_at)).toBe(7 * 86400000);
  });
  it('fixes target-free conditional PII retention in the encrypted record expiry', async () => {
    const env = {
      ...f.env,
      AUTHRIM_CONFIG: {
        get: async (key: string) =>
          key === 'audit_routing_rules'
            ? JSON.stringify([
                {
                  name: 'other',
                  priority: 0,
                  enabled: true,
                  conditions: { tenantId: 'tenant-b' },
                  retention: { piiLogRetentionDays: 1 },
                },
                {
                  name: 'tenant',
                  priority: 1,
                  enabled: true,
                  conditions: { tenantId: 'tenant-a', logType: 'pii' },
                  retention: { piiLogRetentionDays: 14 },
                },
              ])
            : null,
      },
    };
    await new PIIAuditLogRepository(env, 'tenant-a').logAccess(
      'actor',
      'target',
      'pii_viewed',
      undefined,
      { tenant_id: 'tenant-a' }
    );
    const [record] = records();
    expect(Number(record.expires_at) - Number(record.event_at)).toBe(14 * 86400000);
    expect((await f.rows('pii.audit_log_pii'))[0].target_user_id).toBe('target');
  });
  it('keeps the original bounded batches when a page has many disclosures', async () => {
    const log = new PiiAccessLog(context),
      source = origin();
    for (let i = 0; i < 120; i++)
      log.add({ key: 'PII_A', adapter: source.adapter }, `user-${i}`, ['email']);
    const write = vi.spyOn(f.env.LOG_ARCHIVE_WRITER!, 'writeRecords');
    const tenantKey = vi.spyOn(f.env.LOG_ARCHIVE_WRITER!, 'resolveTenantKey');
    expect(await log.write(f.env)).toEqual({ written: 120, failedStores: 0 });
    expect(write.mock.calls.map(([request]) => request.records.length)).toEqual([50, 50, 20]);
    expect(source.batch).not.toHaveBeenCalled();
    expect(tenantKey).toHaveBeenCalledTimes(3);
  });
  it('continues the next origin group after a new-storage failure', async () => {
    const log = new PiiAccessLog(context);
    log.add({ key: 'A', adapter: origin().adapter }, 'user-1', ['email']);
    log.add({ key: 'B', adapter: origin().adapter }, 'user-2', ['name']);
    vi.spyOn(f.env.LOG_ARCHIVE_WRITER!, 'writeRecords').mockRejectedValueOnce(
      new Error('log_store_unavailable')
    );
    expect(await log.write(f.env)).toEqual({ written: 1, failedStores: 1 });
    expect((await f.rows('pii.audit_log_pii')).map((r) => r.target_user_id)).toEqual(['user-2']);
  });
  it('writes through the tenant-bound repository without an old DB adapter', async () => {
    const repository = new PIIAuditLogRepository(f.env, 'tenant-a');
    const row = await repository.logAccess(
      'actor-1',
      'target-1',
      'pii_viewed',
      { fields: ['name'] },
      { tenant_id: 'tenant-a' }
    );
    expect(await f.rows('pii.audit_log_pii')).toMatchObject([
      { id: row.id, user_id: 'actor-1', target_user_id: 'target-1' },
    ]);
    await expect(
      repository.createAuditLog({ tenant_id: 'tenant-b', action: 'pii_viewed' })
    ).rejects.toThrow('tenant_mismatch');
  });
  it('schedules best-effort writes after the response and skips an empty read', async () => {
    const log = new PiiAccessLog(context);
    log.add({ key: 'A', adapter: origin().adapter }, 'user-1', ['email']);
    const waitUntil = vi.fn();
    await expect(
      schedulePiiAccessLog(f.env, { waitUntil }, log, 'tenant-a')
    ).resolves.toBeUndefined();
    expect(waitUntil).toHaveBeenCalledOnce();
    waitUntil.mockClear();
    await schedulePiiAccessLog({}, { waitUntil }, new PiiAccessLog(context), 'tenant-a');
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
