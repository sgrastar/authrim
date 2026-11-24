/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { createApp, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const READ = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ;
const RUN = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN;
type Body = Record<string, any>;

let exportBucket: { put: ReturnType<typeof vi.fn> };
let tenantKey: string;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; bucket?: boolean } = {}
) {
  const res = await createApp(perms, { platform: opts.platform ?? false }).request(
    `/api/admin/admin-logging${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      DB_ADMIN: {},
      ...(opts.bucket === false ? {} : { EXPORT_ARTIFACTS: exportBucket }),
    }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const jobRow = (extra: Record<string, unknown> = {}) => ({
  id: 'lcrj_1',
  job_kind: 'scan',
  status: 'completed',
  tenant_key: 'tk',
  log_type: 'audit',
  plane: 'archive',
  requested_action: null,
  progress_current: '4',
  progress_total: '9',
  preview_artifact_ref: 'r2://x',
  result_json: JSON.stringify({ finding_count: 4 }),
  error_class: null,
  last_error: null,
  requested_by: 'admin-1',
  created_at: '100',
  updated_at: 200,
  started_at: '110',
  completed_at: null,
  cancel_requested_at: '',
  cancel_requested_by: null,
  metadata_json: JSON.stringify({ requested_inline: true }),
  ...extra,
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  exportBucket = { put: vi.fn().mockResolvedValue({}) };
  tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
});

describe('catalog repair scope parsing', () => {
  it('requires the repair read permission', async () => {
    for (const [method, path] of [
      ['GET', '/catalog-repair-jobs'],
      ['POST', '/catalog-repair-jobs/scan'],
      ['GET', '/catalog-repairs'],
      ['POST', '/catalog-repairs/dangerous/preview'],
    ]) {
      const res = await call([], method, path, method === 'POST' ? {} : undefined, {
        platform: true,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    for (const [method, path] of [
      ['POST', '/catalog-repair-jobs/apply-safe'],
      ['POST', '/catalog-repair-jobs/lcrj_1/cancel'],
      ['POST', '/catalog-repairs/apply-safe'],
      ['POST', '/catalog-repairs/dangerous/apply'],
    ]) {
      const res = await call([READ], method, path, {}, { platform: true });
      expect(res.status).toBe(403);
    }
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('pins tenant admins to their own tenant key and refuses another one', async () => {
    const own = await call([READ], 'GET', '/catalog-repair-jobs');
    expect(own.status).toBe(200);
    expect(mockAdapter.query.mock.calls[0][0]).toContain('WHERE tenant_key = ?');
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([tenantKey, 50]);

    for (const query of ['?tenant_key=other', '?filter[tenant_key]=other']) {
      const res = await call([READ], 'GET', `/catalog-repair-jobs${query}`);
      expect(res.status).toBe(403);
      expect(res.body.details.permission).toEqual({
        required_scope: 'current_tenant',
        reason: 'tenant_key_scope_mismatch',
      });
    }
    const same = await call([READ], 'GET', `/catalog-repair-jobs?tenant_key=${tenantKey}`);
    expect(same.status).toBe(200);
    const body = await call([READ], 'POST', '/catalog-repair-jobs/scan', { tenant_key: 'other' });
    expect(body.status).toBe(403);
  });

  it('lets platform admins filter by any tenant key, log type, plane and status', async () => {
    mockAdapter.query.mockClear();
    const res = await call(
      [READ],
      'GET',
      '/catalog-repair-jobs?filter[tenant_key]=tk&filter[log_type]=audit&filter[plane]=archive&filter[status]=failed&limit=7',
      undefined,
      { platform: true }
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0];
    expect(sql).toContain('WHERE tenant_key = ? AND log_type = ? AND plane = ? AND status = ?');
    expect(params).toEqual(['tk', 'audit', 'archive', 'failed', 7]);

    mockAdapter.query.mockClear();
    await call(
      [READ],
      'GET',
      '/catalog-repair-jobs?tenant_key=t2&log_type=job&plane=primary&status=queued',
      undefined,
      { platform: true }
    );
    expect(mockAdapter.query.mock.calls[0][1]).toEqual(['t2', 'job', 'primary', 'queued', 50]);

    mockAdapter.query.mockClear();
    await call([READ], 'GET', '/catalog-repair-jobs?limit=9999', undefined, { platform: true });
    expect(mockAdapter.query.mock.calls[0][0]).not.toContain('WHERE');
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([200]);
  });

  it('rejects unsupported log types and planes together', async () => {
    const res = await call(
      [READ],
      'GET',
      '/catalog-repair-jobs?log_type=bad&plane=worse',
      undefined,
      { platform: true }
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
    ]);
    const one = await call([READ], 'GET', '/catalog-repair-jobs?plane=worse', undefined, {
      platform: true,
    });
    expect(one.body.details.fields).toHaveLength(1);
    expect(one.body.details.fields[0].path).toBe('plane');
  });

  it('serializes job rows with numeric coercion and tolerant JSON parsing', async () => {
    mockAdapter.query.mockResolvedValue([
      jobRow(),
      jobRow({
        id: 'lcrj_2',
        result_json: '{broken',
        metadata_json: '[1]',
        progress_total: null,
        started_at: null,
      }),
    ]);
    const res = await call([READ], 'GET', '/catalog-repair-jobs', undefined, { platform: true });
    expect(res.body.items[0]).toEqual({
      id: 'lcrj_1',
      job_kind: 'scan',
      status: 'completed',
      tenant_key: 'tk',
      log_type: 'audit',
      plane: 'archive',
      requested_action: null,
      progress_current: 4,
      progress_total: 9,
      preview_artifact_ref: 'r2://x',
      result: { finding_count: 4 },
      error_class: null,
      last_error: null,
      requested_by: 'admin-1',
      created_at: 100,
      updated_at: 200,
      started_at: 110,
      completed_at: null,
      cancel_requested_at: null,
      cancel_requested_by: null,
      metadata: { requested_inline: true },
    });
    expect(res.body.items[1]).toMatchObject({
      result: {},
      metadata: {},
      progress_total: null,
      started_at: null,
    });
    mockAdapter.query.mockRejectedValue(new Error('db'));
    expect(
      (await call([READ], 'GET', '/catalog-repair-jobs', undefined, { platform: true })).status
    ).toBe(500);
  });
});

describe('catalog repair job scan / apply-safe', () => {
  const jobsInsert = () =>
    must(
      mockAdapter.execute.mock.calls.find(([s]) =>
        String(s).includes('INSERT INTO logging_catalog_repair_jobs')
      )
    );

  it('records a scan job, writes the preview artifact and completes the job', async () => {
    routeSql(mockAdapter, {
      one: [{ match: /FROM logging_catalog_repair_jobs/, result: jobRow({ id: 'lcrj_x' }) }],
    });
    const res = await call(
      [READ],
      'POST',
      '/catalog-repair-jobs/scan',
      { log_type: 'audit', plane: 'archive' },
      { platform: true }
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ id: 'lcrj_x', job_kind: 'scan' });
    expect(res.body.job_id).toMatch(/^lcrj_/);
    const jobId = res.body.job_id as string;
    const [insertSql, p] = jobsInsert();
    expect(insertSql).toContain("'scan', 'running'");
    expect(p.slice(0, 5)).toEqual([jobId, null, 'audit', 'archive', 'admin-1']);
    expect(p[8]).toBe(JSON.stringify({ requested_inline: true }));
    expect(exportBucket.put).toHaveBeenCalledTimes(1);
    const [key, payload, options] = exportBucket.put.mock.calls[0];
    expect(key).toBe(`catalog-repair-jobs/v1/${jobId}/preview.json`);
    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({
      finding_count: 0,
      findings: [],
      pending_ttl_ms: 15 * 60 * 1000,
      scope: { tenant_key: null, log_type: 'audit', plane: 'archive' },
    });
    expect(options).toEqual({
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        jobId,
        createdAt: String(parsed.checked_at),
        artifactKind: 'catalog_repair_preview',
      },
    });
    const update = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes("SET status = 'completed'"))
    );
    expect(update[1]).toEqual([
      0,
      0,
      `r2://${key}`,
      JSON.stringify(parsed),
      parsed.checked_at,
      parsed.checked_at,
      jobId,
    ]);
  });

  it('stores no artifact reference without an export bucket and echoes the payload without a row', async () => {
    const res = await call(
      [READ],
      'POST',
      '/catalog-repair-jobs/scan',
      {},
      { platform: true, bucket: false }
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ finding_count: 0, findings: [] });
    const update = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes("SET status = 'completed'"))
    );
    expect(update[1][2]).toBeNull();
  });

  it('honours pending_ttl_ms bounds when detecting', async () => {
    for (const [query, expected] of [
      ['pending_ttl_ms=1', 60 * 1000],
      ['pending_ttl_ms=999999999999', 24 * 60 * 60 * 1000],
      ['pending_ttl_ms=120000', 120000],
      ['pending_ttl_ms=abc', 15 * 60 * 1000],
    ] as const) {
      const res = await call([READ], 'GET', `/catalog-repairs?${query}`, undefined, {
        platform: true,
      });
      expect(res.body.page.pending_ttl_ms).toBe(expected);
      expect(res.body.page.checked_at).toEqual(expect.any(Number));
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    }
  });

  it('marks the scan job failed and answers 500 when detection fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('scan boom'));
    const res = await call([READ], 'POST', '/catalog-repair-jobs/scan', {}, { platform: true });
    expect(res.status).toBe(500);
    const failed = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes("SET status = 'failed'"))
    );
    expect(failed[1].slice(0, 2)).toEqual(['catalog_repair_scan_failed', 'scan boom']);
    expect(failed[1][4]).toMatch(/^lcrj_/);
  });

  it('uses the generic failure message for non-Error rejections', async () => {
    mockAdapter.query.mockRejectedValue('nope');
    await call([READ], 'POST', '/catalog-repair-jobs/scan', {}, { platform: true });
    const failed = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes("SET status = 'failed'"))
    );
    expect(failed[1][1]).toBe('catalog_repair_scan_failed');
  });

  it('applies safe repairs as a job with limit metadata and audit', async () => {
    routeSql(mockAdapter, {
      one: [
        { match: /FROM logging_catalog_repair_jobs/, result: jobRow({ job_kind: 'apply_safe' }) },
      ],
    });
    const res = await call(
      [RUN],
      'POST',
      '/catalog-repair-jobs/apply-safe',
      { limit: 9999 },
      { platform: true }
    );
    expect(res.status).toBe(200);
    expect(res.body.audit_id).toBe('audit_1');
    expect(res.body.job_id).toMatch(/^lcrj_/);
    expect(jobsInsert()[0]).toContain("'apply_safe', 'running'");
    expect(jobsInsert()[1][8]).toBe(JSON.stringify({ limit: 500 }));
    const parsed = JSON.parse(exportBucket.put.mock.calls[0][1]);
    expect(parsed).toMatchObject({
      finding_count: 0,
      applied_count: 0,
      skipped_count: 0,
      applied: [],
      skipped: [],
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.catalog_repair_job.apply_safe',
        resourceType: 'logging_catalog_repair_job',
        resourceId: res.body.job_id,
        severity: 'info',
      })
    );
    const update = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes("SET status = 'completed'"))
    );
    expect(update[1].slice(0, 2)).toEqual([0, 0]);
  });

  it('stores a null limit when none (or an invalid one) is given and fails the job on errors', async () => {
    await call([RUN], 'POST', '/catalog-repair-jobs/apply-safe', { limit: -2 }, { platform: true });
    expect(jobsInsert()[1][8]).toBe(JSON.stringify({ limit: null }));
    mockAdapter.query.mockRejectedValue(new Error('apply boom'));
    const res = await call(
      [RUN],
      'POST',
      '/catalog-repair-jobs/apply-safe',
      {},
      { platform: true }
    );
    expect(res.status).toBe(500);
    const failed = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes("SET status = 'failed'"))
    );
    expect(failed[1].slice(0, 2)).toEqual(['catalog_repair_apply_safe_failed', 'apply boom']);
  });

  it('rejects an out-of-scope tenant before creating any job', async () => {
    const res = await call([RUN], 'POST', '/catalog-repair-jobs/apply-safe', {
      tenant_key: 'other',
    });
    expect(res.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });
});

describe('catalog repair job cancel', () => {
  const cancel = (id = 'lcrj_1') =>
    call([RUN], 'POST', `/catalog-repair-jobs/${id}/cancel`, {}, { platform: true });

  it('404s unknown jobs and refuses finished ones', async () => {
    expect((await cancel()).status).toBe(404);
    routeSql(mockAdapter, {
      one: [{ match: /logging_catalog_repair_jobs/, result: jobRow({ status: 'completed' }) }],
    });
    const res = await cancel();
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'status',
        code: 'invalid_state',
        message: 'Only queued or running repair jobs can be cancelled.',
      },
    ]);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('cancels queued jobs immediately and requests cancellation of running ones', async () => {
    routeSql(mockAdapter, {
      one: [{ match: /logging_catalog_repair_jobs/, result: jobRow({ status: 'queued' }) }],
    });
    const queued = await cancel();
    expect(queued.body.result).toMatchObject({ id: 'lcrj_1', status: 'cancelled' });
    expect(mockAdapter.execute.mock.calls[0][1].slice(0, 3)).toEqual([
      'cancelled',
      expect.any(Number),
      'admin-1',
    ]);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info', metadata: { previous_status: 'queued' } })
    );
    mockAdapter.execute.mockClear();
    routeSql(mockAdapter, {
      one: [{ match: /logging_catalog_repair_jobs/, result: jobRow({ status: 'running' }) }],
    });
    const running = await cancel();
    expect(running.body.result.status).toBe('cancel_requested');
    expect(mockAdapter.execute.mock.calls[0][1][0]).toBe('cancel_requested');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn', metadata: { previous_status: 'running' } })
    );
    mockAdapter.execute.mockRejectedValue(new Error('db'));
    expect((await cancel()).status).toBe(500);
  });
});
