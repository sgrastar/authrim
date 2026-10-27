import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { runLogIcebergScheduledMaintenance } from '../log-iceberg-maintenance';
const mocks = vi.hoisted(() => ({
  delivery: vi.fn(),
  export: vi.fn(),
  retry: vi.fn(),
  retention: vi.fn(),
  snapshots: vi.fn(),
  erasure: vi.fn(),
  parse: vi.fn(),
  activate: vi.fn(),
  reconcile: vi.fn(),
  query: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  ensureDatabaseAdapter: () => ({ query: mocks.query }),
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-config', () => ({
  resolveLogIcebergConfig: mocks.parse,
  assertLogIcebergActivated: mocks.activate,
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-delivery', () => ({
  runLogIcebergDelivery: mocks.delivery,
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-export', () => ({
  runLogIcebergExport: mocks.export,
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-retry-cleanup', () => ({
  runLogIcebergRetryCleanup: mocks.retry,
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-retention', () => ({
  runLogIcebergRetention: mocks.retention,
  runLogIcebergSnapshotMaintenance: mocks.snapshots,
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-subject-erasure', () => ({
  eraseLogIcebergSubject: mocks.erasure,
}));
const env = {} as Env;
Object.assign(env, {
  DB_ADMIN: {},
  AUTHRIM_CONFIG: { get: mocks.get, put: mocks.put },
  LOG_ARCHIVE_WRITER: { reconcileCorePublications: mocks.reconcile },
});
const tick = (minute = 0) =>
  runLogIcebergScheduledMaintenance({ cron: '* * * * *', scheduledTime: minute * 60000 }, env);
describe('new-mode maintenance on the existing minute tick', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.parse.mockReturnValue({
      mode: 'scheduled',
      exportIntervalMinutes: 10,
      generation: 'generation',
      tableUuid: 'uuid',
    });
    mocks.query.mockResolvedValue([]);
    mocks.get.mockResolvedValue(null);
    mocks.put.mockResolvedValue(undefined);
    mocks.reconcile.mockResolvedValue({});
    mocks.delivery.mockResolvedValue({ queued: 0 });
    mocks.export.mockResolvedValue({ moved: 0 });
    mocks.retry.mockResolvedValue({});
    mocks.retention.mockResolvedValue({ complete: false, progressed: false });
    mocks.snapshots.mockResolvedValue({ complete: false, progressed: false });
    mocks.erasure.mockResolvedValue({ complete: false });
  });
  it('recovers publications, delivery and retry objects without exporting DB bodies in pipeline mode', async () => {
    mocks.parse.mockReturnValue({
      mode: 'pipeline',
      exportIntervalMinutes: null,
      generation: 'generation',
      tableUuid: 'uuid',
    });
    expect(await tick(1)).toEqual({ ran: true, mode: 'pipeline' });
    expect(mocks.reconcile).toHaveBeenCalledWith({ limit: 16 });
    expect(mocks.delivery).toHaveBeenCalledWith(env);
    expect(mocks.retry).toHaveBeenCalledWith(env);
    expect(mocks.export).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.every(([sql]) => !String(sql).includes('FROM log_iceberg_records'))
    ).toBe(true);
  });
  it('runs lifecycle every minute but exports only on the scheduled cadence', async () => {
    expect(await tick(9)).toEqual({ ran: true, mode: 'scheduled' });
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.snapshots).toHaveBeenCalledOnce();
    await tick(10);
    expect(mocks.export).toHaveBeenCalledWith(env);
    expect(mocks.delivery).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });
  it('does not run unrelated ticks or invalid configuration', async () => {
    expect(
      await runLogIcebergScheduledMaintenance({ cron: '*/10 * * * *', scheduledTime: 0 }, env)
    ).toEqual({ ran: false });
    expect(mocks.parse).not.toHaveBeenCalled();
    mocks.activate.mockImplementation(() => {
      throw new Error('not ready');
    });
    await expect(tick()).rejects.toThrow('not ready');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it('keeps local hot bodies and never pretends to export to a remote Catalog', async () => {
    mocks.parse.mockReturnValue({ mode: 'scheduled', localStagingOnly: true });
    await tick();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.snapshots).not.toHaveBeenCalled();
  });
  it('stops a waiting scope after one step and advances past a failing tenant', async () => {
    const a = { id: 'a'.repeat(64), tenant_id: 'tenant-a', source_dataset: 'core.audit_log' };
    const b = { id: 'b'.repeat(64), tenant_id: 'tenant-b', source_dataset: 'core.audit_log' };
    mocks.query.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([]);
    mocks.retention.mockRejectedValueOnce(new Error('frozen'));
    await expect(tick(1)).rejects.toThrow('log_iceberg_maintenance_deferred');
    expect(mocks.retention).toHaveBeenCalledTimes(2);
    expect(mocks.retention).toHaveBeenLastCalledWith(env, {
      tenantId: 'tenant-b',
      sourceDataset: 'core.audit_log',
    });
    expect(
      mocks.put.mock.calls.filter(([key]) => String(key).includes('retention-cursor'))
    ).toEqual([['jobs:log-iceberg:retention-cursor:generation', '']]);
    expect(mocks.snapshots).toHaveBeenCalledOnce();
  });
  it('limits progressing work to four steps per scope and resumes subject erasure', async () => {
    mocks.query
      .mockResolvedValueOnce([
        { id: 'a'.repeat(64), tenant_id: 'tenant-a', source_dataset: 'core.audit_log' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'b'.repeat(64),
          tenant_id: 'tenant-a',
          subject_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ]);
    mocks.retention.mockResolvedValue({ complete: false, progressed: true });
    await tick(1);
    expect(mocks.retention).toHaveBeenCalledTimes(4);
    expect(mocks.erasure).toHaveBeenCalledWith(env, {
      tenantId: 'tenant-a',
      sourceDataset: 'pii.pii_log',
      subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });
  it('does not starve lifecycle when publication reconciliation or export is unavailable', async () => {
    mocks.reconcile.mockRejectedValue(new Error('unavailable'));
    mocks.export.mockRejectedValue(new Error('catalog down'));
    await expect(tick()).rejects.toThrow('log_iceberg_maintenance_deferred');
    expect(mocks.snapshots).toHaveBeenCalledOnce();
  });
  it('records returned delivery failures instead of reporting a successful maintenance run', async () => {
    mocks.parse.mockReturnValue({
      mode: 'pipeline',
      exportIntervalMinutes: null,
      generation: 'generation',
      tableUuid: 'uuid',
    });
    mocks.delivery.mockResolvedValue({ failed: 1, queued: 0 });
    await expect(tick()).rejects.toThrow('log_iceberg_maintenance_deferred');
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(mocks.snapshots).toHaveBeenCalledOnce();
  });
  it('rejects invalid cursor metadata instead of resetting progress silently', async () => {
    mocks.get.mockResolvedValue('bad-cursor');
    await expect(tick(1)).rejects.toThrow('log_iceberg_maintenance_cursor_invalid');
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
