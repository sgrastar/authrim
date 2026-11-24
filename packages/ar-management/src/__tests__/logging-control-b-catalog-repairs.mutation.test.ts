/* eslint-disable @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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
vi.mock('../log-read-adapter', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildReadAdapterMock(
    await importOriginal<typeof import('../log-read-adapter')>()
  )
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

import { auditWrite, mockAdapter, repoFakes, resetFakes } from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ];
const RUN = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];
const JOBS = `${ADMIN_LOGGING}/catalog-repair-jobs`;

const finding = (overrides: Record<string, unknown> = {}) => ({
  id: 'f_1',
  tenantKey: 'tk_a',
  logType: 'audit',
  plane: 'archive',
  ...overrides,
});

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lcrj_1',
    job_kind: 'scan',
    status: 'completed',
    tenant_key: 'tk_a',
    log_type: 'audit',
    plane: 'archive',
    requested_action: null,
    progress_current: '2',
    progress_total: '3',
    preview_artifact_ref: 'r2://catalog-repair-jobs/v1/lcrj_1/preview.json',
    result_json: '{"finding_count":2}',
    error_class: null,
    last_error: null,
    requested_by: 'admin-1',
    created_at: '10',
    updated_at: '20',
    started_at: '11',
    completed_at: null,
    cancel_requested_at: null,
    cancel_requested_by: null,
    metadata_json: '{"requested_inline":true}',
    ...overrides,
  };
}

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('POST /catalog-repair-jobs/:id/cancel', () => {
  const path = `${JOBS}/lcrj_1/cancel`;

  it('requires repair run, 404s unknown jobs and refuses finished jobs', async () => {
    expect((await call(createApp(READ), 'POST', path)).status).toBe(403);
    expect((await call(createPlatformApp(RUN), 'POST', path)).status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['lcrj_1']);
    for (const status of ['completed', 'failed', 'cancelled', 'cancel_requested']) {
      mockAdapter.queryOne.mockResolvedValue(jobRow({ status }));
      const res = await call(createPlatformApp(RUN), 'POST', path);
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'status',
          code: 'invalid_state',
          message: 'Only queued or running repair jobs can be cancelled.',
        },
      ]);
    }
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('cancels queued jobs at once and asks running jobs to stop', async () => {
    for (const [status, next, severity] of [
      ['queued', 'cancelled', 'info'],
      ['running', 'cancel_requested', 'warn'],
    ]) {
      mockAdapter.execute.mockClear();
      auditWrite.mockClear();
      mockAdapter.queryOne.mockResolvedValue(jobRow({ status }));
      const res = await call(createPlatformApp(RUN), 'POST', path);
      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({ id: 'lcrj_1', status: next, updated_at: NOW });
      const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(
        "completed_at = CASE WHEN status = 'queued' THEN ? ELSE completed_at END"
      );
      expect(params).toEqual([next, NOW, 'admin-1', NOW, NOW, 'lcrj_1']);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin_logging.catalog_repair_job.cancel',
          resourceType: 'logging_catalog_repair_job',
          resourceId: 'lcrj_1',
          severity,
          metadata: { previous_status: status },
        })
      );
    }
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(RUN), 'POST', path)).status).toBe(500);
  });
});

describe('catalog repairs', () => {
  const REPAIRS = `${ADMIN_LOGGING}/catalog-repairs`;

  it('lists findings with the checked time and pending ttl', async () => {
    expect((await call(createApp([]), 'GET', REPAIRS)).status).toBe(403);
    expect((await call(createPlatformApp(READ), 'GET', `${REPAIRS}?log_type=zz`)).status).toBe(400);
    repoFakes.detectCatalogRepairFindings.mockResolvedValue([
      finding(),
      finding({ id: 'f_b', plane: 'primary' }),
    ]);
    const res = await call(createPlatformApp(READ), 'GET', `${REPAIRS}?plane=archive&limit=3`);
    expect(res.body.items).toEqual([finding()]);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toEqual({ checked_at: NOW, pending_ttl_ms: 900000 });
    expect(repoFakes.detectCatalogRepairFindings).toHaveBeenCalledWith({
      now: NOW,
      limit: 3,
      pendingTtlMs: 900000,
      tenantKey: null,
    });
    repoFakes.detectCatalogRepairFindings.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', REPAIRS)).status).toBe(500);
  });

  it('applies safe repairs and audits the result', async () => {
    expect((await call(createApp(READ), 'POST', `${REPAIRS}/apply-safe`, {})).status).toBe(403);
    expect(
      (await call(createPlatformApp(RUN), 'POST', `${REPAIRS}/apply-safe`, { plane: 'zz' })).status
    ).toBe(400);
    repoFakes.detectCatalogRepairFindings.mockResolvedValue([finding(), finding({ id: 'f_2' })]);
    repoFakes.applySafeCatalogRepairs.mockResolvedValue({
      applied: [{ id: 'f_1' }],
      skipped: [{ id: 'f_2' }],
    });
    const res = await call(createPlatformApp(RUN), 'POST', `${REPAIRS}/apply-safe`, {
      limit: 600,
      tenant_key: 'tk_a',
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      checked_at: NOW,
      finding_count: 2,
      applied_count: 1,
      skipped_count: 1,
      applied: [{ id: 'f_1' }],
      skipped: [{ id: 'f_2' }],
    });
    expect(repoFakes.detectCatalogRepairFindings.mock.calls[0][0]).toMatchObject({
      limit: 500,
      tenantKey: 'tk_a',
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.catalog_repair.apply_safe',
        resourceType: 'log_object_catalog',
        resourceId: 'safe-auto-repair',
        severity: 'warn',
        metadata: {
          checked_at: NOW,
          pending_ttl_ms: 900000,
          finding_count: 2,
          applied_count: 1,
          skipped_count: 1,
          tenant_key: 'tk_a',
          log_type: null,
          plane: null,
        },
      })
    );
    repoFakes.applySafeCatalogRepairs.mockResolvedValue({ applied: [], skipped: [] });
    await call(createPlatformApp(RUN), 'POST', `${REPAIRS}/apply-safe`, {});
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
    repoFakes.applySafeCatalogRepairs.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(RUN), 'POST', `${REPAIRS}/apply-safe`, {})).status).toBe(
      500
    );
  });
});
