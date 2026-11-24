/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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
vi.mock('@authrim/ar-lib-logging/messaging', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildMessagingMock(
    await importOriginal<typeof import('@authrim/ar-lib-logging/messaging')>()
  )
);
vi.mock('../logging-message-payload-storage', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildPayloadStorageMock(
    await importOriginal<typeof import('../logging-message-payload-storage')>()
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
  messagingFakes,
  resetFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import { repairFinding } from './logging-control-b-fixtures';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const DAY = 24 * 3600 * 1000;
const RUN = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];
const REPAIR_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ];
const APPLY_SAFE = `${POLICIES}/message-job-repair-findings/apply-safe`;

function exportJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lexp_1',
    tenant_key: 'tk_a',
    log_type: 'audit',
    plane: 'archive',
    format: 'jsonl',
    status: 'failed',
    artifact_object_ref: 'artifacts/a1',
    manifest_object_ref: 'manifests/m1',
    checksum_sha256: null,
    record_count: 0,
    byte_count: 0,
    requested_by: 'admin-1',
    error_class: 'boom',
    filter_json: JSON.stringify({ tenant_key: 'tk_filter', source: 'catalog' }),
    created_at: 1,
    updated_at: 2,
    completed_at: null,
    expires_at: 123456,
    ...overrides,
  };
}

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mockAdapter.queryOne.mockImplementation(async (sql: string) =>
    String(sql).includes('FROM logging_export_jobs') ? exportJobRow() : null
  );
});
afterEach(() => vi.useRealTimers());

describe('message-job-repair-findings/apply-safe', () => {
  it('requires the repair run permission', async () => {
    const res = await call(createApp(REPAIR_READ), 'POST', APPLY_SAFE, {});
    expect(res.status).toBe(403);
    expect(messagingFakes.listRepairFindings).not.toHaveBeenCalled();
  });

  it('lists open missing-part findings, bounded to 1-50 and defaulting to 25', async () => {
    messagingFakes.listRepairFindings.mockResolvedValue([]);
    const cases: Array<[unknown, number]> = [
      [10, 10],
      [51, 50],
      [0, 25],
      [1.5, 25],
      ['3', 25],
      [undefined, 25],
    ];
    for (const [limit, expected] of cases) {
      messagingFakes.listRepairFindings.mockClear();
      const res = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, { limit });
      expect(res.body.result).toEqual({
        applied_count: 0,
        skipped_count: 0,
        applied: [],
        skipped: [],
      });
      expect(messagingFakes.listRepairFindings).toHaveBeenCalledWith({
        status: 'open',
        findingType: 'missing_export_part',
        limit: expected,
      });
    }
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.message_job_repair.apply_safe',
        resourceType: 'logging_message_repair_finding',
        resourceId: 'bulk-safe-repair',
        severity: 'info',
        metadata: { requested_finding_id: null, applied_count: 0, skipped_count: 0 },
      })
    );
  });

  it('rebuilds the export partition and marks the finding repaired', async () => {
    messagingFakes.listRepairFindings.mockResolvedValue([repairFinding()]);
    const res = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, {});
    expect(res.status).toBe(200);
    const jobId = res.body.result.applied[0].message_job_id as string;
    expect(jobId).toMatch(/^lmj_/);
    expect(res.body.result).toEqual({
      applied_count: 1,
      skipped_count: 0,
      applied: [
        {
          id: 'lmrf_1',
          export_job_id: 'lexp_1',
          message_job_id: jobId,
          queued: true,
          queue_binding: 'LOGGING_DELIVERY_QUEUE',
          payload_object_ref: 'payloads/obj.json',
        },
      ],
      skipped: [],
    });
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['lexp_1']);
    const write = messagingFakes.writePayload.mock.calls[0][1];
    expect(write).toMatchObject({
      bucket: envFixture.AUDIT_ARCHIVE,
      jobId,
      lane: 'default',
      criticality: 'standard',
      tenantKey: 'tk_filter',
      payload: {
        export_job_id: 'lexp_1',
        phase: 'plan',
        partition_strategy: 'time_bucket_shard',
        tenant_key: 'tk_filter',
        requested_by: 'admin-1',
        filters: { tenant_key: 'tk_filter', source: 'catalog' },
      },
    });
    expect(messagingFakes.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: jobId,
        kind: 'export_build',
        priority: 10,
        topology: { tenantKey: 'tk_filter', topologyType: 'unknown', topologyResolvedAt: NOW },
        scopeType: 'tenant',
        scopeId: 'tk_filter',
        scopeKey: 'tenant:tk_filter',
        sourceId: 'lexp_1',
        parentJobId: 'lmj_1',
        depth: 1,
        idempotencyKey: `repair:lmrf_1:lexp_1:${NOW}`,
        dedupeUntil: NOW + DAY,
        reason: 'repair:lmrf_1:rebuild_export_partition',
        requestedBy: 'admin-1',
        expiresAt: 123456,
      })
    );
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][0]).toContain('INSERT INTO logging_message_export_builds');
    expect(executed[0][1]).toEqual([
      expect.stringMatching(/^lexp_/),
      jobId,
      'lexp_1',
      'plan',
      'time_bucket_shard',
      null,
      0,
      1,
      NOW,
      null,
      null,
      0,
      0,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      'not_required',
      JSON.stringify({
        filters: write.payload.filters,
        repair_finding_id: 'lmrf_1',
      }),
      NOW,
      NOW,
    ]);
    expect(executed[1][0]).toContain('UPDATE logging_export_jobs');
    expect(executed[1][1]).toEqual(['queued', NOW, 'lexp_1']);
    expect(messagingFakes.markRepairFindingApplied).toHaveBeenCalledWith({
      id: 'lmrf_1',
      status: 'safe_repaired',
      appliedBy: 'admin-1',
      now: NOW,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        severity: 'warn',
        metadata: { requested_finding_id: null, applied_count: 1, skipped_count: 0 },
      })
    );
  });

  it('derives lane, criticality and partitioning from the export filters', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { filter_json: JSON.stringify({ source: 'record_index' }), tenant_key: 'tk_row' },
        {
          lane: 'bulk',
          criticality: 'standard',
          strategy: 'query_page',
          priority: 0,
          tenantKey: 'tk_row',
        },
      ],
      [
        { filter_json: JSON.stringify({ include_payload: true }), tenant_key: null },
        {
          lane: 'bulk',
          criticality: 'standard',
          strategy: 'time_bucket_shard',
          priority: 0,
          tenantKey: null,
        },
      ],
      [
        { plane: 'sensitive_detail', filter_json: 'not json' },
        {
          lane: 'default',
          criticality: 'critical',
          strategy: 'chunk_index',
          priority: 100,
          tenantKey: 'tk_a',
        },
      ],
    ];
    for (const [overrides, expected] of cases) {
      messagingFakes.writePayload.mockClear();
      messagingFakes.createJob.mockClear();
      mockAdapter.queryOne.mockResolvedValue(exportJobRow(overrides));
      messagingFakes.listRepairFindings.mockResolvedValue([repairFinding()]);
      const res = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, {});
      expect(res.status).toBe(200);
      const write = messagingFakes.writePayload.mock.calls[0][1];
      expect({
        lane: write.lane,
        criticality: write.criticality,
        strategy: write.payload.partition_strategy,
        tenantKey: write.tenantKey,
      }).toEqual({
        lane: expected.lane,
        criticality: expected.criticality,
        strategy: expected.strategy,
        tenantKey: expected.tenantKey,
      });
      const job = messagingFakes.createJob.mock.calls[0][0];
      expect(job.priority).toBe(expected.priority);
      expect(job.scopeType).toBe(expected.tenantKey ? 'tenant' : 'platform');
      expect(job.topology.topologyType).toBe(expected.tenantKey ? 'unknown' : 'platform');
    }
    mockAdapter.queryOne.mockResolvedValue(exportJobRow({ expires_at: null }));
    await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, {});
    expect(messagingFakes.createJob.mock.calls.at(-1)?.[0].expiresAt).toBe(NOW + 7 * DAY);
  });

  it('skips findings that are not safe rebuild candidates or lack their export', async () => {
    messagingFakes.listRepairFindings.mockResolvedValue([
      repairFinding({ id: 'f_status', status: 'safe_repaired' }),
      repairFinding({ id: 'f_type', findingType: 'stuck_claim' }),
      repairFinding({ id: 'f_action', safeAction: null }),
      repairFinding({ id: 'f_noexport', impact: {} }),
      repairFinding({ id: 'f_emptyexport', impact: { export_job_id: '' } }),
      repairFinding({ id: 'f_missing', impact: { export_job_id: 'lexp_gone' } }),
    ]);
    mockAdapter.queryOne.mockImplementation(async (_sql: string, params?: unknown[]) =>
      params?.[0] === 'lexp_gone' ? null : exportJobRow()
    );
    const res = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, {});
    expect(res.body.result.applied_count).toBe(0);
    expect(res.body.result.skipped).toEqual([
      {
        id: 'f_status',
        reason: 'not_safe_rebuild_candidate',
        status: 'safe_repaired',
        finding_type: 'missing_export_part',
      },
      {
        id: 'f_type',
        reason: 'not_safe_rebuild_candidate',
        status: 'open',
        finding_type: 'stuck_claim',
      },
      {
        id: 'f_action',
        reason: 'not_safe_rebuild_candidate',
        status: 'open',
        finding_type: 'missing_export_part',
      },
      { id: 'f_noexport', reason: 'export_job_id_missing' },
      { id: 'f_emptyexport', reason: 'export_job_id_missing' },
      { id: 'f_missing', reason: 'export_job_not_found', export_job_id: 'lexp_gone' },
    ]);
    expect(res.body.result.skipped_count).toBe(6);
    expect(messagingFakes.markRepairFindingApplied).not.toHaveBeenCalled();
  });

  it('loads one finding by id and tolerates an unknown id', async () => {
    messagingFakes.getRepairFinding.mockResolvedValue(repairFinding());
    const res = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, { finding_id: ' lmrf_1 ' });
    expect(messagingFakes.getRepairFinding).toHaveBeenCalledWith('lmrf_1');
    expect(messagingFakes.listRepairFindings).not.toHaveBeenCalled();
    expect(res.body.result.applied_count).toBe(1);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'lmrf_1',
        metadata: { requested_finding_id: 'lmrf_1', applied_count: 1, skipped_count: 0 },
      })
    );
    messagingFakes.getRepairFinding.mockResolvedValue(null);
    const none = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, { finding_id: 'nope' });
    expect(none.body.result).toEqual({
      applied_count: 0,
      skipped_count: 0,
      applied: [],
      skipped: [],
    });
  });

  it('refuses findings of another tenant and fails without the payload bucket', async () => {
    messagingFakes.listRepairFindings.mockResolvedValue([repairFinding({ tenantKey: 'tk_other' })]);
    const foreign = await call(createApp(RUN), 'POST', APPLY_SAFE, {});
    expect(foreign.status).toBe(403);
    expect(foreign.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
    expect(messagingFakes.markRepairFindingApplied).not.toHaveBeenCalled();

    messagingFakes.listRepairFindings.mockResolvedValue([
      repairFinding({ tenantKey: await deriveTenantKeyFromTenantId('tenant-a', undefined) }),
    ]);
    expect((await call(createApp(RUN), 'POST', APPLY_SAFE, {})).status).toBe(200);

    const noBucket = await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, {}, {}, {
      ...envFixture,
      AUDIT_ARCHIVE: undefined,
    } as unknown as Env);
    expect(noBucket.status).toBe(500);
    messagingFakes.listRepairFindings.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(RUN), 'POST', APPLY_SAFE, {})).status).toBe(500);
  });
});
