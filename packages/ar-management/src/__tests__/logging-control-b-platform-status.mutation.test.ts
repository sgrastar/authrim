/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- admin API response bodies are untyped JSON in these route tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);
vi.mock('../log-read-adapter', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildReadAdapterMock(
    await importOriginal<typeof import('../log-read-adapter')>()
  )
);
const statusFakes = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../log-platform-status', () => ({ buildLogPlatformStatus: statusFakes.build }));

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { LogQueryIncompleteError } from '../log-archive-query';
import { readAdapterFakes, resetFakes } from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 10, 26, 6, 0, 0);
const PATH = `${ADMIN_LOGGING}/platform-status`;
const READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ];

function armReadAdapter(queryOne: () => Promise<unknown>) {
  readAdapterFakes.queryOne.mockImplementation(queryOne);
  readAdapterFakes.hasArchive.mockReturnValue(true);
  readAdapterFakes.coverage.mockReturnValue({
    consistency: 'eventual',
    pending_deliveries: 2,
    complete: false,
  });
  readAdapterFakes.createLogReadAdapter.mockReturnValue({
    adapter: { queryOne: readAdapterFakes.queryOne, query: readAdapterFakes.query },
    hasArchive: readAdapterFakes.hasArchive,
    coverage: readAdapterFakes.coverage,
  });
}

beforeEach(() => {
  resetFakes();
  statusFakes.build.mockReset();
  statusFakes.build.mockImplementation(
    async (input: { readProbe: unknown; tenantId: unknown }) => ({
      generated_at: NOW,
      archive: { read_probe: input.readProbe },
      scope: input.tenantId,
    })
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('GET /platform-status', () => {
  it('requires the overview read permission', async () => {
    armReadAdapter(async () => ({ total: 0 }));
    expect((await call(createApp([]), 'GET', PATH)).status).toBe(403);
    expect(statusFakes.build).not.toHaveBeenCalled();
  });

  it('passes the read probe and the tenant scope to the status builder', async () => {
    armReadAdapter(async () => ({ total: 12 }));
    const res = await call(createApp(READ), 'GET', PATH);
    expect(res.status).toBe(200);
    expect(res.body.item.archive.read_probe).toEqual({
      ok: true,
      reason: null,
      has_archive: true,
      coverage: { consistency: 'eventual', pending_deliveries: 2, complete: false },
    });
    expect(statusFakes.build).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', platform: false, now: NOW })
    );
    expect(readAdapterFakes.createLogReadAdapter.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-a',
      dataset: 'admin.admin_audit_log',
      window: { fromMs: NOW - 24 * 60 * 60 * 1000 },
    });
  });

  it('answers 200 with the incomplete reason when the archive read fails', async () => {
    armReadAdapter(async () => {
      throw new LogQueryIncompleteError('archive_file_read_budget_exceeded');
    });
    const res = await call(createApp(READ), 'GET', PATH);
    expect(res.status).toBe(200);
    expect(res.body.item.archive.read_probe).toEqual({
      ok: false,
      reason: 'archive_file_read_budget_exceeded',
      has_archive: false,
      coverage: null,
    });
  });

  it('counts every tenant for a platform caller', async () => {
    armReadAdapter(async () => ({ total: 0 }));
    const res = await call(createPlatformApp(READ), 'GET', PATH);
    expect(res.status).toBe(200);
    expect(res.body.item.scope).toBeNull();
    expect(statusFakes.build).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: null, platform: true, tenantKey: null })
    );
  });

  it('turns an unexpected failure into a 500, not a log_query_incomplete', async () => {
    armReadAdapter(async () => ({ total: 0 }));
    statusFakes.build.mockRejectedValue(new Error('d1_down'));
    const res = await call(createApp(READ), 'GET', PATH);
    expect(res.status).toBe(500);
  });
});
