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

import type { Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  auditWrite,
  envFixture,
  mockAdapter,
  repoFakes,
  resetFakes,
} from './logging-control-b-harness';
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

const serializedJob = {
  id: 'lcrj_1',
  job_kind: 'scan',
  status: 'completed',
  tenant_key: 'tk_a',
  log_type: 'audit',
  plane: 'archive',
  requested_action: null,
  progress_current: 2,
  progress_total: 3,
  preview_artifact_ref: 'r2://catalog-repair-jobs/v1/lcrj_1/preview.json',
  result: { finding_count: 2 },
  error_class: null,
  last_error: null,
  requested_by: 'admin-1',
  created_at: 10,
  updated_at: 20,
  started_at: 11,
  completed_at: null,
  cancel_requested_at: null,
  cancel_requested_by: null,
  metadata: { requested_inline: true },
};

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('GET /catalog-repair-jobs', () => {
  it('requires repair read and a valid scope', async () => {
    expect((await call(createApp([]), 'GET', JOBS)).status).toBe(403);
    const foreign = await call(createApp(READ), 'GET', `${JOBS}?tenant_key=other`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
    const invalid = await call(createPlatformApp(READ), 'GET', `${JOBS}?log_type=nope&plane=nope`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
    ]);
  });

  it('applies scope and status filters and serializes jobs', async () => {
    mockAdapter.query.mockResolvedValue([jobRow()]);
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${JOBS}?filter[tenant_key]=tk_1&filter[log_type]=audit&filter[plane]=archive&filter[status]=running&limit=999`
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([serializedJob]);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE tenant_key = ? AND log_type = ? AND plane = ? AND status = ?');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['tk_1', 'audit', 'archive', 'running', 200]);
    mockAdapter.query.mockClear();
    await call(createPlatformApp(READ), 'GET', JOBS);
    expect(mockAdapter.query.mock.calls[0][0]).not.toContain('WHERE');
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([50]);
    mockAdapter.query.mockClear();
    await call(createApp(READ), 'GET', `${JOBS}?status=failed`);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([
      await deriveTenantKeyFromTenantId('tenant-a', undefined),
      'failed',
      50,
    ]);
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', JOBS)).status).toBe(500);
  });
});

describe('POST /catalog-repair-jobs/scan', () => {
  const path = `${JOBS}/scan`;

  it('requires repair read and a valid scope', async () => {
    expect((await call(createApp([]), 'POST', path, {})).status).toBe(403);
    const invalid = await call(createPlatformApp(READ), 'POST', path, { log_type: 'nope' });
    expect(invalid.status).toBe(400);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect((await call(createApp(READ), 'POST', path, { tenant_key: 'other' })).status).toBe(403);
  });

  it('records the scan, stores a preview artifact and returns the job', async () => {
    repoFakes.detectCatalogRepairFindings.mockResolvedValue([
      finding(),
      finding({ id: 'f_other_tenant', tenantKey: 'tk_b' }),
      finding({ id: 'f_other_type', logType: 'normal' }),
      finding({ id: 'f_other_plane', plane: 'primary' }),
    ]);
    mockAdapter.queryOne.mockResolvedValue(jobRow());
    const res = await call(
      createPlatformApp(READ),
      'POST',
      `${path}?limit=7&pending_ttl_ms=120000`,
      {
        tenant_key: 'tk_a',
        log_type: 'audit',
        plane: 'archive',
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(serializedJob);
    const jobId = res.body.job_id as string;
    expect(jobId).toMatch(/^lcrj_/);
    expect(res.body).not.toHaveProperty('audit_id');
    expect(repoFakes.detectCatalogRepairFindings).toHaveBeenCalledWith({
      now: NOW,
      limit: 7,
      pendingTtlMs: 120000,
      tenantKey: 'tk_a',
    });
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][0]).toContain("VALUES (?, 'scan', 'running'");
    expect(executed[0][1]).toEqual([
      jobId,
      'tk_a',
      'audit',
      'archive',
      'admin-1',
      NOW,
      NOW,
      NOW,
      JSON.stringify({ requested_inline: true }),
    ]);
    const payload = {
      checked_at: NOW,
      pending_ttl_ms: 120000,
      finding_count: 1,
      findings: [finding()],
      scope: { tenant_key: 'tk_a', log_type: 'audit', plane: 'archive' },
    };
    expect(envFixture.EXPORT_ARTIFACTS.put).toHaveBeenCalledWith(
      `catalog-repair-jobs/v1/${jobId}/preview.json`,
      JSON.stringify(payload),
      {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { jobId, createdAt: String(NOW), artifactKind: 'catalog_repair_preview' },
      }
    );
    expect(executed[1][0]).toContain("SET status = 'completed'");
    expect(executed[1][1]).toEqual([
      1,
      1,
      `r2://catalog-repair-jobs/v1/${jobId}/preview.json`,
      JSON.stringify(payload),
      NOW,
      NOW,
      jobId,
    ]);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual([jobId]);
  });

  it('clamps the pending ttl, defaults the limit and works without an artifact bucket', async () => {
    const cases: Array<[string, number]> = [
      ['10', 60000],
      ['999999999', 86400000],
      ['abc', 900000],
      ['', 900000],
    ];
    for (const [ttl, expected] of cases) {
      repoFakes.detectCatalogRepairFindings.mockClear();
      await call(createPlatformApp(READ), 'POST', `${path}?pending_ttl_ms=${ttl}`, {});
      expect(repoFakes.detectCatalogRepairFindings.mock.calls[0][0]).toMatchObject({
        limit: 100,
        pendingTtlMs: expected,
        tenantKey: null,
      });
    }
    repoFakes.detectCatalogRepairFindings.mockClear();
    await call(createPlatformApp(READ), 'POST', `${path}?limit=9999`, {});
    expect(repoFakes.detectCatalogRepairFindings.mock.calls[0][0].limit).toBe(500);
    mockAdapter.execute.mockClear();
    const res = await call(createPlatformApp(READ), 'POST', path, {}, {}, {
      ...envFixture,
      EXPORT_ARTIFACTS: undefined,
    } as unknown as Env);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ finding_count: 0, findings: [] });
    expect((mockAdapter.execute.mock.calls[1][1] as unknown[])[2]).toBeNull();
  });

  it('marks the job failed when scanning throws', async () => {
    repoFakes.detectCatalogRepairFindings.mockRejectedValue(new Error('scan broke'));
    const res = await call(createPlatformApp(READ), 'POST', path, {});
    expect(res.status).toBe(500);
    const failed = mockAdapter.execute.mock.calls[1] as [string, unknown[]];
    expect(failed[0]).toContain("SET status = 'failed'");
    expect(failed[1]).toEqual([
      'catalog_repair_scan_failed',
      'scan broke',
      NOW,
      NOW,
      expect.stringMatching(/^lcrj_/),
    ]);
    mockAdapter.execute.mockClear();
    repoFakes.detectCatalogRepairFindings.mockRejectedValue('weird');
    await call(createPlatformApp(READ), 'POST', path, {});
    expect((mockAdapter.execute.mock.calls[1][1] as unknown[])[1]).toBe(
      'catalog_repair_scan_failed'
    );
  });
});

describe('POST /catalog-repair-jobs/apply-safe', () => {
  const path = `${JOBS}/apply-safe`;

  it('requires repair run and a valid scope', async () => {
    expect((await call(createApp(READ), 'POST', path, {})).status).toBe(403);
    expect((await call(createPlatformApp(RUN), 'POST', path, { plane: 'nope' })).status).toBe(400);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('applies safe repairs, records progress and audits by outcome', async () => {
    repoFakes.detectCatalogRepairFindings.mockResolvedValue([
      finding(),
      finding({ id: 'f_2' }),
      finding({ id: 'f_3' }),
    ]);
    repoFakes.applySafeCatalogRepairs.mockResolvedValue({
      applied: [{ id: 'f_1' }],
      skipped: [{ id: 'f_2' }],
    });
    mockAdapter.queryOne.mockResolvedValue(null);
    const res = await call(createPlatformApp(RUN), 'POST', path, { limit: 900, log_type: 'audit' });
    expect(res.status).toBe(200);
    const jobId = res.body.job_id as string;
    const payload = {
      checked_at: NOW,
      finding_count: 3,
      applied_count: 1,
      skipped_count: 1,
      applied: [{ id: 'f_1' }],
      skipped: [{ id: 'f_2' }],
      scope: { tenant_key: null, log_type: 'audit', plane: null },
    };
    expect(res.body.result).toEqual(payload);
    expect(res.body.audit_id).toBe('audit-id-1');
    expect(repoFakes.detectCatalogRepairFindings.mock.calls[0][0]).toMatchObject({ limit: 500 });
    expect(repoFakes.applySafeCatalogRepairs).toHaveBeenCalledWith(
      [finding(), finding({ id: 'f_2' }), finding({ id: 'f_3' })],
      NOW
    );
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][0]).toContain("VALUES (?, 'apply_safe', 'running'");
    expect(executed[0][1]).toEqual([
      jobId,
      null,
      'audit',
      null,
      'admin-1',
      NOW,
      NOW,
      NOW,
      JSON.stringify({ limit: 500 }),
    ]);
    expect(executed[1][1]).toEqual([
      2,
      3,
      `r2://catalog-repair-jobs/v1/${jobId}/preview.json`,
      JSON.stringify(payload),
      NOW,
      NOW,
      jobId,
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.catalog_repair_job.apply_safe',
        resourceType: 'logging_catalog_repair_job',
        resourceId: jobId,
        severity: 'warn',
        metadata: payload,
      })
    );
  });

  it('defaults the limit to unbounded and audits a no-op as info', async () => {
    mockAdapter.queryOne.mockResolvedValue(jobRow());
    const res = await call(createPlatformApp(RUN), 'POST', path, { limit: 0 });
    expect(res.body.result).toEqual(serializedJob);
    expect(JSON.parse((mockAdapter.execute.mock.calls[0][1] as string[])[8])).toEqual({
      limit: null,
    });
    expect(repoFakes.detectCatalogRepairFindings.mock.calls[0][0].limit).toBe(100);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
    for (const limit of [2.5, '3']) {
      mockAdapter.execute.mockClear();
      await call(createPlatformApp(RUN), 'POST', path, { limit });
      expect(JSON.parse((mockAdapter.execute.mock.calls[0][1] as string[])[8]).limit).toBeNull();
    }
    mockAdapter.execute.mockClear();
    await call(createPlatformApp(RUN), 'POST', path, { limit: 12 });
    expect(JSON.parse((mockAdapter.execute.mock.calls[0][1] as string[])[8]).limit).toBe(12);
  });

  it('marks the job failed when applying throws', async () => {
    repoFakes.applySafeCatalogRepairs.mockRejectedValue(new Error('apply broke'));
    const res = await call(createPlatformApp(RUN), 'POST', path, {});
    expect(res.status).toBe(500);
    const failed = mockAdapter.execute.mock.calls[1] as [string, unknown[]];
    expect(failed[1]).toEqual([
      'catalog_repair_apply_safe_failed',
      'apply broke',
      NOW,
      NOW,
      expect.stringMatching(/^lcrj_/),
    ]);
    mockAdapter.execute.mockClear();
    repoFakes.applySafeCatalogRepairs.mockRejectedValue('weird');
    await call(createPlatformApp(RUN), 'POST', path, {});
    expect((mockAdapter.execute.mock.calls[1][1] as unknown[])[1]).toBe(
      'catalog_repair_apply_safe_failed'
    );
  });
});
