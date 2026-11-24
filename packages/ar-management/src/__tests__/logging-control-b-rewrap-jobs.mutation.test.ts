/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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
vi.mock('@authrim/ar-lib-logging/keys', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildKeysMock(
    await importOriginal<typeof import('@authrim/ar-lib-logging/keys')>()
  )
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { auditWrite, keysFakes, mockAdapter, resetFakes } from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const REPAIR_RUN = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];
const REPAIR_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ];

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function notPlatform(permissions: string[]) {
  return createApp(permissions, ['ar_super_admin'], false);
}

describe('POST /rewrap-jobs', () => {
  const path = `${ADMIN_LOGGING}/rewrap-jobs`;
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    key_registry_id: 'kr_1',
    tenant_key: 'tk_a',
    surface: 'admin',
    log_type: 'normal',
    plane: 'primary',
    active_version: '3',
    from_version: '1',
    key_version_status: 'rewrap_required',
    object_catalog_id: 'obj_1',
    object_key: 'logs/a.chunk',
    record_count: '5',
    byte_count: '500',
    committed_at: 10,
    ...overrides,
  });

  it('requires the repair run permission and platform authority', async () => {
    expect((await call(createPlatformApp(READ_ONLY()), 'POST', path, {})).status).toBe(403);
    const res = await call(notPlatform(REPAIR_RUN), 'POST', path, { key_registry_id: 'kr_1' });
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('platform_authority_required');
  });

  it('validates the key registry id and from_version', async () => {
    const app = createPlatformApp(REPAIR_RUN);
    const none = await call(app, 'POST', path, {});
    expect(none.status).toBe(400);
    expect(none.body.details.fields).toEqual([
      { path: 'key_registry_id', code: 'required', message: 'Key registry id is required.' },
    ]);
    const bad = await call(app, 'POST', path, { key_registry_id: 'kr_1', from_version: 'x' });
    expect(bad.body.details.fields).toEqual([
      {
        path: 'from_version',
        code: 'invalid_value',
        message: 'from_version must be a positive integer.',
      },
    ]);
    const both = await call(app, 'POST', path, { from_version: 0 });
    expect(both.body.details.fields.map((f: { path: string }) => f.path)).toEqual([
      'key_registry_id',
      'from_version',
    ]);
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('selects rewrap candidates, optionally pinned to a version, with a bounded limit', async () => {
    const app = createPlatformApp(REPAIR_RUN);
    const cases: Array<[unknown, number]> = [
      [500, 100],
      [100, 100],
      [7, 7],
      [0, 25],
      [2.5, 25],
      [undefined, 25],
    ];
    for (const [limit, expected] of cases) {
      mockAdapter.query.mockClear();
      const res = await call(app, 'POST', path, { key_registry_id: ' kr_1 ', limit });
      expect(res.status).toBe(202);
      const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE kr.id = ?');
      expect(sql).not.toContain('kv.version = ?');
      expect(params).toEqual(['kr_1', expected]);
    }
    mockAdapter.query.mockClear();
    await call(app, 'POST', path, { key_registry_id: 'kr_1', from_version: '2' });
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND loc.encryption_scope IS NOT NULL AND kv.version = ?');
    expect(params).toEqual(['kr_1', 2, 25]);
  });

  it('enqueues a job per candidate with its priority and skips candidates already queued', async () => {
    keysFakes.enqueue.mockImplementation(async (input: { priority: number }) => ({
      id: 'lrj_new',
      priority: input.priority,
    }));
    mockAdapter.query.mockResolvedValue([
      candidate(),
      candidate({ object_catalog_id: 'obj_2', key_version_status: 'compromised' }),
      candidate({ object_catalog_id: 'obj_3', log_type: 'admin_audit' }),
      candidate({ object_catalog_id: 'obj_4', plane: 'sensitive_detail' }),
      candidate({ object_catalog_id: 'obj_5', plane: 'archive' }),
      candidate({ object_catalog_id: 'obj_6', log_type: 'audit' }),
      candidate({ object_catalog_id: 'obj_dup' }),
    ]);
    mockAdapter.queryOne.mockImplementation(async (_sql: string, params?: unknown[]) =>
      String(params?.[3]).includes('obj_dup') ? { id: 'lrj_old', status: 'queued' } : null
    );
    const res = await call(createPlatformApp(REPAIR_RUN), 'POST', path, {
      key_registry_id: 'kr_1',
      from_version: 1,
    });
    expect(res.status).toBe(202);
    expect(res.body.result.candidate_count).toBe(7);
    expect(res.body.result.created_count).toBe(6);
    expect(res.body.result.skipped_count).toBe(1);
    expect(res.body.result.key_registry_id).toBe('kr_1');
    expect(res.body.result.created.map((job: { priority: number }) => job.priority)).toEqual([
      40, 0, 20, 10, 20, 20,
    ]);
    expect(res.body.result.created[0]).toEqual({
      id: 'lrj_new',
      object_catalog_id: 'obj_1',
      from_version: 1,
      to_version: 3,
      priority: 40,
    });
    expect(res.body.result.skipped).toEqual([
      { object_catalog_id: 'obj_dup', existing_job_id: 'lrj_old', existing_status: 'queued' },
    ]);
    const lookup = mockAdapter.queryOne.mock.calls[0] as [string, unknown[]];
    expect(lookup[0]).toContain('FROM logging_rewrap_jobs');
    expect(lookup[1]).toEqual(['kr_1', 1, 3, '%"object_catalog_id":"obj_1"%']);
    expect(keysFakes.enqueue.mock.calls[0][0]).toEqual({
      keyRegistryId: 'kr_1',
      fromVersion: 1,
      toVersion: 3,
      priority: 40,
      metadata: {
        object_catalog_id: 'obj_1',
        object_key: 'logs/a.chunk',
        tenant_key: 'tk_a',
        log_type: 'normal',
        plane: 'primary',
        surface: 'admin',
        reason: 'default_archive',
        record_count: 5,
        byte_count: 500,
      },
      now: NOW,
    });
    expect(keysFakes.enqueue.mock.calls[1][0].metadata.reason).toBe('compromised');
    expect(keysFakes.enqueue.mock.calls[3][0].metadata.reason).toBe('sensitive_detail');
    expect(keysFakes.enqueue.mock.calls[2][0].metadata.reason).toBe('critical_archive');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.rewrap_jobs.create',
        resourceType: 'logging_key_registry',
        resourceId: 'kr_1',
        severity: 'warn',
        metadata: {
          requested_limit: 25,
          candidate_count: 7,
          created_count: 6,
          skipped_count: 1,
          from_version: 1,
        },
      })
    );
  });

  it('audits an empty run as info with no pinned version', async () => {
    const res = await call(createPlatformApp(REPAIR_RUN), 'POST', path, {
      key_registry_id: 'kr_1',
    });
    expect(res.body.result).toEqual({
      key_registry_id: 'kr_1',
      candidate_count: 0,
      created_count: 0,
      skipped_count: 0,
      created: [],
      skipped: [],
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        severity: 'info',
        metadata: {
          requested_limit: 25,
          candidate_count: 0,
          created_count: 0,
          skipped_count: 0,
          from_version: null,
        },
      })
    );
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect(
      (await call(createPlatformApp(REPAIR_RUN), 'POST', path, { key_registry_id: 'kr_1' })).status
    ).toBe(500);
  });
});

function READ_ONLY() {
  return REPAIR_READ;
}

describe('rewrap job state changes', () => {
  const job = (overrides: Record<string, unknown> = {}) => ({
    id: 'lrj_1',
    key_registry_id: 'kr_1',
    from_version: '1',
    to_version: '2',
    priority: '40',
    status: 'failed',
    created_at: '100',
    started_at: '110',
    completed_at: '120',
    metadata: JSON.stringify({
      object_catalog_id: 'obj_1',
      object_key: 'k',
      tenant_key: 'tk_a',
      log_type: 'audit',
      plane: 'archive',
      reason: 'critical_archive',
      error: 'boom',
    }),
    ...overrides,
  });
  const base = `${ADMIN_LOGGING}/rewrap-jobs/lrj_1`;

  for (const action of ['retry', 'cancel', 'priority']) {
    it(`${action} requires the repair run permission and platform authority`, async () => {
      expect(
        (await call(createPlatformApp(REPAIR_READ), 'POST', `${base}/${action}`, { priority: 5 }))
          .status
      ).toBe(403);
      const res = await call(notPlatform(REPAIR_RUN), 'POST', `${base}/${action}`, { priority: 5 });
      expect(res.status).toBe(403);
      expect(res.body.details.permission.reason).toBe('platform_authority_required');
      expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    });
    it(`${action} answers 404 for an unknown job`, async () => {
      const res = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/${action}`, {
        priority: 5,
      });
      expect(res.status).toBe(404);
      expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['lrj_1']);
    });
  }

  it('retries failed or skipped jobs and records why', async () => {
    for (const status of ['failed', 'skipped']) {
      mockAdapter.execute.mockClear();
      auditWrite.mockClear();
      mockAdapter.queryOne.mockResolvedValue(job({ status }));
      const res = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/retry`, {
        reason: ' fix ',
      });
      expect(res.status).toBe(200);
      const metadata = {
        object_catalog_id: 'obj_1',
        object_key: 'k',
        tenant_key: 'tk_a',
        log_type: 'audit',
        plane: 'archive',
        reason: 'critical_archive',
        error: 'boom',
        retry_requested_by: 'admin-1',
        retry_requested_at: NOW,
        retry_reason: 'fix',
        previous_status: status,
      };
      expect(res.body.result).toEqual({
        id: 'lrj_1',
        key_registry_id: 'kr_1',
        from_version: 1,
        to_version: 2,
        priority: 40,
        status: 'queued',
        created_at: 100,
        started_at: null,
        completed_at: null,
        object_catalog_id: 'obj_1',
        object_key: 'k',
        tenant_key: 'tk_a',
        log_type: 'audit',
        plane: 'archive',
        reason: 'critical_archive',
        error: 'boom',
        metadata,
      });
      const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("SET status = 'queued'");
      expect(sql).toContain('WHERE id = ? AND status = ?');
      expect(params).toEqual([JSON.stringify(metadata), 'lrj_1', status]);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin_logging.rewrap_jobs.retry',
          resourceType: 'logging_rewrap_job',
          resourceId: 'lrj_1',
          severity: 'warn',
          metadata: {
            key_registry_id: 'kr_1',
            from_version: 1,
            to_version: 2,
            previous_status: status,
            next_status: 'queued',
            reason: 'fix',
          },
        })
      );
    }
    mockAdapter.queryOne.mockResolvedValue(job({ metadata: null }));
    const dflt = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/retry`);
    expect(dflt.body.result.metadata.retry_reason).toBe('manual retry requested');
    expect(dflt.body.result).toMatchObject({ object_catalog_id: null, error: null, reason: null });
  });

  it('refuses to retry jobs that are not failed or skipped', async () => {
    for (const status of ['queued', 'running', 'completed']) {
      mockAdapter.queryOne.mockResolvedValue(job({ status }));
      const res = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/retry`, {});
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'status',
          code: 'invalid_state',
          message: 'Only failed or skipped rewrap jobs can be retried.',
        },
      ]);
    }
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/retry`, {})).status).toBe(
      500
    );
  });

  it('cancels queued, running or failed jobs by skipping them', async () => {
    for (const [status, severity] of [
      ['queued', 'info'],
      ['running', 'warn'],
      ['failed', 'info'],
    ]) {
      mockAdapter.execute.mockClear();
      auditWrite.mockClear();
      mockAdapter.queryOne.mockResolvedValue(job({ status }));
      const res = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/cancel`, {
        reason: 'obsolete',
      });
      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({
        id: 'lrj_1',
        status: 'skipped',
        completed_at: NOW,
        from_version: 1,
      });
      expect(res.body.result.metadata).toMatchObject({
        cancelled_by: 'admin-1',
        cancelled_at: NOW,
        cancellation_reason: 'obsolete',
        previous_status: status,
      });
      const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("SET status = 'skipped'");
      expect(params).toEqual([NOW, JSON.stringify(res.body.result.metadata), 'lrj_1', status]);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin_logging.rewrap_jobs.cancel',
          severity,
          metadata: expect.objectContaining({
            previous_status: status,
            next_status: 'skipped',
            reason: 'obsolete',
          }),
        })
      );
    }
    mockAdapter.queryOne.mockResolvedValue(job({ status: 'queued' }));
    const dflt = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/cancel`);
    expect(dflt.body.result.metadata.cancellation_reason).toBe('manual cancellation requested');
  });

  it('refuses to cancel finished jobs', async () => {
    for (const status of ['completed', 'skipped']) {
      mockAdapter.queryOne.mockResolvedValue(job({ status }));
      const res = await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/cancel`, {});
      expect(res.body.details.fields).toEqual([
        {
          path: 'status',
          code: 'invalid_state',
          message: 'Only queued, running, or failed rewrap jobs can be cancelled.',
        },
      ]);
    }
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(REPAIR_RUN), 'POST', `${base}/cancel`, {})).status).toBe(
      500
    );
  });

  it('validates and applies a priority change for queued jobs only', async () => {
    const app = createPlatformApp(REPAIR_RUN);
    for (const priority of [-1, 1001, 'abc', undefined, null]) {
      const res = await call(app, 'POST', `${base}/priority`, { priority });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'priority',
          code: 'invalid_value',
          message: 'Priority must be an integer from 0 to 1000.',
        },
      ]);
    }
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    mockAdapter.queryOne.mockResolvedValue(job({ status: 'running' }));
    const running = await call(app, 'POST', `${base}/priority`, { priority: 5 });
    expect(running.body.details.fields).toEqual([
      {
        path: 'status',
        code: 'invalid_state',
        message: 'Only queued rewrap jobs can change priority.',
      },
    ]);
    for (const priority of [0, 1000, '15']) {
      mockAdapter.execute.mockClear();
      mockAdapter.queryOne.mockResolvedValue(job({ status: 'queued' }));
      const res = await call(app, 'POST', `${base}/priority`, { priority });
      expect(res.status).toBe(200);
      expect(res.body.result.priority).toBe(Number(priority));
      expect(res.body.result.metadata).toMatchObject({
        priority_changed_by: 'admin-1',
        priority_changed_at: NOW,
        previous_priority: 40,
      });
      const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("WHERE id = ? AND status = 'queued'");
      expect(params).toEqual([Number(priority), JSON.stringify(res.body.result.metadata), 'lrj_1']);
    }
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.rewrap_jobs.priority_update',
        severity: 'info',
        metadata: { key_registry_id: 'kr_1', previous_priority: 40, next_priority: 15 },
      })
    );
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(app, 'POST', `${base}/priority`, { priority: 3 })).status).toBe(500);
  });
});
