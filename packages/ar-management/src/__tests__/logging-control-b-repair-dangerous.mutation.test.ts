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
import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  auditWrite,
  envFixture,
  mockAdapter,
  messagingFakes,
  resetFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import { messageJob, repairFinding, serializedMessageJob } from './logging-control-b-fixtures';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const DAY = 24 * 3600 * 1000;
const RUN = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];
const REPAIR_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ];
const EVENTS_READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];
const PREVIEW = `${POLICIES}/message-job-repair-findings/lmrf_1/dangerous/preview`;
const APPLY_DANGEROUS = `${POLICIES}/message-job-repair-findings/lmrf_1/dangerous/apply`;
const CONFIRMATION = 'APPLY MESSAGE REPAIR lmrf_1';

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

describe('dangerous message repair', () => {
  it('previews the cleanup a dangerous repair would do', async () => {
    messagingFakes.getRepairFinding.mockResolvedValue(repairFinding());
    expect((await call(createApp(EVENTS_READ), 'POST', PREVIEW, {})).status).toBe(403);
    const res = await call(createPlatformApp(REPAIR_READ), 'POST', PREVIEW, {});
    expect(res.status).toBe(200);
    expect(messagingFakes.getRepairFinding).toHaveBeenCalledWith('lmrf_1');
    expect(res.body.item).toEqual({
      action: 'mark_export_failed_and_cleanup_manifest',
      finding_id: 'lmrf_1',
      export_job_id: 'lexp_1',
      confirmation: CONFIRMATION,
      impact: {
        finding: expect.objectContaining({ id: 'lmrf_1', finding_type: 'missing_export_part' }),
        export_job: expect.objectContaining({ id: 'lexp_1', manifest_object_ref: 'manifests/m1' }),
        deletes_objects: ['parts/p1', 'manifests/m1'],
        updates: [
          'logging_export_jobs',
          'logging_message_export_builds',
          'logging_message_repair_findings',
        ],
      },
    });
  });

  it('previews only the objects that exist', async () => {
    messagingFakes.getRepairFinding.mockResolvedValue(
      repairFinding({ impact: { export_job_id: 'lexp_1', part_object_ref: '' } })
    );
    mockAdapter.queryOne.mockResolvedValue(exportJobRow({ manifest_object_ref: null }));
    const res = await call(createPlatformApp(REPAIR_READ), 'POST', PREVIEW, {});
    expect(res.body.item.impact.deletes_objects).toEqual([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    messagingFakes.getRepairFinding.mockResolvedValue(repairFinding());
    const noJob = await call(createPlatformApp(REPAIR_READ), 'POST', PREVIEW, {});
    expect(noJob.body.item.impact.export_job).toBeNull();
    expect(noJob.body.item.impact.deletes_objects).toEqual(['parts/p1']);
  });

  const guards: Array<[string, string, string, boolean]> = [
    ['preview', PREVIEW, 'REPAIR_READ', false],
    ['apply', APPLY_DANGEROUS, 'RUN', true],
  ];
  for (const [name, path, perm, needsConfirmation] of guards) {
    const permissions = perm === 'RUN' ? RUN : REPAIR_READ;
    const body = needsConfirmation ? { confirmation: CONFIRMATION } : {};
    describe(`${name} guards`, () => {
      it('answers 404 for an unknown finding and refuses another tenant', async () => {
        messagingFakes.getRepairFinding.mockResolvedValue(null);
        const missing = await call(createPlatformApp(permissions), 'POST', path, body);
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
        messagingFakes.getRepairFinding.mockResolvedValue(repairFinding({ tenantKey: 'tk_other' }));
        const foreign = await call(createApp(permissions), 'POST', path, body);
        expect(foreign.status).toBe(403);
        expect(foreign.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
      });

      it('rejects findings without a dangerous repair or without an export job id', async () => {
        messagingFakes.getRepairFinding.mockResolvedValue(repairFinding({ dangerousAction: null }));
        const notDangerous = await call(createPlatformApp(permissions), 'POST', path, body);
        expect(notDangerous.status).toBe(400);
        expect(notDangerous.body.details.fields).toEqual([
          {
            path: 'finding_id',
            code: 'not_dangerous_repairable',
            message: 'Finding has no supported dangerous repair.',
          },
        ]);
        messagingFakes.getRepairFinding.mockResolvedValue(repairFinding({ impact: {} }));
        const noExport = await call(createPlatformApp(permissions), 'POST', path, body);
        expect(noExport.body.details.fields).toEqual([
          {
            path: 'impact.export_job_id',
            code: 'required',
            message: 'Repair finding does not include export job id.',
          },
        ]);
        messagingFakes.getRepairFinding.mockRejectedValue(new Error('x'));
        expect((await call(createPlatformApp(permissions), 'POST', path, body)).status).toBe(500);
      });
    });
  }

  it('requires the exact confirmation and the run permission to apply', async () => {
    expect(
      (await call(createApp(REPAIR_READ), 'POST', APPLY_DANGEROUS, { confirmation: CONFIRMATION }))
        .status
    ).toBe(403);
    for (const confirmation of [
      undefined,
      '',
      'APPLY MESSAGE REPAIR other',
      CONFIRMATION.toLowerCase(),
    ]) {
      const res = await call(createPlatformApp(RUN), 'POST', APPLY_DANGEROUS, { confirmation });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: `Confirmation must be "${CONFIRMATION}".`,
        },
      ]);
    }
    expect(messagingFakes.getRepairFinding).not.toHaveBeenCalled();
  });

  it('fails the export, deletes its objects and marks the finding applied', async () => {
    messagingFakes.getRepairFinding.mockResolvedValue(repairFinding());
    const res = await call(createPlatformApp(RUN), 'POST', APPLY_DANGEROUS, {
      confirmation: ` ${CONFIRMATION} `,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      action: 'mark_export_failed_and_cleanup_manifest',
      finding_id: 'lmrf_1',
      export_job_id: 'lexp_1',
      applied_at: NOW,
    });
    expect(envFixture.EXPORT_ARTIFACTS.delete.mock.calls).toEqual([['parts/p1'], ['manifests/m1']]);
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][0]).toContain('UPDATE logging_export_jobs');
    expect(executed[0][1]).toEqual(['failed', 'dangerous_repair_applied', NOW, NOW, 'lexp_1']);
    expect(executed[1][0]).toContain('UPDATE logging_message_export_builds');
    expect(executed[1][1]).toEqual([
      'completed',
      JSON.stringify({
        dangerous_repair: true,
        finding_id: 'lmrf_1',
        action: 'mark_export_failed_and_cleanup_manifest',
        applied_by: 'admin-1',
      }),
      NOW,
      'lexp_1',
    ]);
    expect(messagingFakes.markRepairFindingApplied).toHaveBeenCalledWith({
      id: 'lmrf_1',
      status: 'dangerous_applied',
      appliedBy: 'admin-1',
      now: NOW,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.message_job_repair.apply_dangerous',
        resourceType: 'logging_message_repair_finding',
        resourceId: 'lmrf_1',
        severity: 'critical',
        metadata: {
          action: 'mark_export_failed_and_cleanup_manifest',
          export_job_id: 'lexp_1',
          confirmation: CONFIRMATION,
          impact: { export_job_id: 'lexp_1', part_object_ref: 'parts/p1' },
        },
      })
    );
  });

  it('skips deletions that do not apply', async () => {
    messagingFakes.getRepairFinding.mockResolvedValue(
      repairFinding({ impact: { export_job_id: 'lexp_1', part_object_ref: 7 } })
    );
    mockAdapter.queryOne.mockResolvedValue(exportJobRow({ manifest_object_ref: null }));
    await call(createPlatformApp(RUN), 'POST', APPLY_DANGEROUS, { confirmation: CONFIRMATION });
    expect(envFixture.EXPORT_ARTIFACTS.delete).not.toHaveBeenCalled();

    messagingFakes.getRepairFinding.mockResolvedValue(repairFinding());
    mockAdapter.queryOne.mockResolvedValue(null);
    await call(createPlatformApp(RUN), 'POST', APPLY_DANGEROUS, { confirmation: CONFIRMATION });
    expect(envFixture.EXPORT_ARTIFACTS.delete.mock.calls).toEqual([['parts/p1']]);

    envFixture.EXPORT_ARTIFACTS.delete.mockClear();
    mockAdapter.queryOne.mockResolvedValue(exportJobRow());
    const noBucket = await call(
      createPlatformApp(RUN),
      'POST',
      APPLY_DANGEROUS,
      { confirmation: CONFIRMATION },
      {},
      { ...envFixture, EXPORT_ARTIFACTS: undefined } as unknown as Env
    );
    expect(noBucket.status).toBe(200);
    expect(envFixture.EXPORT_ARTIFACTS.delete).not.toHaveBeenCalled();
  });
});

describe('GET /message-jobs/:id', () => {
  const path = `${POLICIES}/message-jobs/lmj_1`;

  it('requires delivery-events read, 404s unknown jobs and enforces tenancy', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    messagingFakes.getJob.mockResolvedValue(null);
    expect((await call(createApp(EVENTS_READ), 'GET', path)).status).toBe(404);
    expect(messagingFakes.getJob).toHaveBeenCalledWith('lmj_1');
    messagingFakes.getJob.mockResolvedValue(messageJob({ tenantKey: 'tk_other' }));
    expect((await call(createApp(EVENTS_READ), 'GET', path)).status).toBe(403);
  });

  it('returns the serialized job to its own tenant', async () => {
    const job = messageJob({ tenantKey: await deriveTenantKeyFromTenantId('tenant-a', undefined) });
    messagingFakes.getJob.mockResolvedValue(job);
    const res = await call(createApp(EVENTS_READ), 'GET', path);
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual(serializedMessageJob(job));
    messagingFakes.getJob.mockRejectedValue(new Error('x'));
    expect((await call(createApp(EVENTS_READ), 'GET', path)).status).toBe(500);
  });
});

describe('POST /message-jobs/:id/cancel', () => {
  const path = `${POLICIES}/message-jobs/lmj_1/cancel`;
  const CREATE = 'admin:logging:exports:create';
  const RETRY = 'admin:logging:delivery:retry';

  it('answers 404 before checking permission and requires the kind-specific permission', async () => {
    messagingFakes.getJob.mockResolvedValue(null);
    expect((await call(createPlatformApp([]), 'POST', path, {})).status).toBe(404);
    messagingFakes.getJob.mockResolvedValue(messageJob({ kind: 'retry_delivery' }));
    const retry = await call(createPlatformApp([CREATE]), 'POST', path, {});
    expect(retry.status).toBe(403);
    expect(retry.body.details.permission).toEqual({
      required_permission: RETRY,
      reason: 'message_job_cancel_permission_required',
    });
    messagingFakes.getJob.mockResolvedValue(messageJob({ kind: 'export_build' }));
    const exp = await call(createPlatformApp([RETRY]), 'POST', path, {});
    expect(exp.body.details.permission.required_permission).toBe(CREATE);
    expect(messagingFakes.requestCancel).not.toHaveBeenCalled();
  });

  it('refuses another tenant and non-cancellable states', async () => {
    messagingFakes.getJob.mockResolvedValue(messageJob({ tenantKey: 'tk_other' }));
    expect((await call(createApp([CREATE]), 'POST', path, {})).status).toBe(403);
    for (const status of ['completed', 'failed', 'dlq', 'cancelled', 'expired', 'blocked']) {
      messagingFakes.getJob.mockResolvedValue(messageJob({ status }));
      const res = await call(createPlatformApp([CREATE]), 'POST', path, {});
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'status',
          code: 'not_cancellable',
          message: 'Message job is not cancellable in its current state.',
        },
      ]);
    }
    expect(messagingFakes.requestCancel).not.toHaveBeenCalled();
  });

  it('cancels a queued or retrying retry job immediately', async () => {
    for (const status of ['queued', 'retrying']) {
      messagingFakes.requestCancel.mockClear();
      messagingFakes.markCancelled.mockClear();
      auditWrite.mockClear();
      const job = messageJob({ kind: 'retry_delivery', status, criticality: 'critical' });
      const updated = messageJob({ kind: 'retry_delivery', status: 'cancelled' });
      messagingFakes.getJob.mockResolvedValueOnce(job).mockResolvedValueOnce(updated);
      const res = await call(createPlatformApp([RETRY]), 'POST', path, { reason: 'duplicate' });
      expect(res.status).toBe(200);
      expect(res.body.result).toEqual(serializedMessageJob(updated));
      expect(messagingFakes.requestCancel).toHaveBeenCalledWith('lmj_1', 'admin-1', NOW);
      expect(messagingFakes.markCancelled).toHaveBeenCalledWith('lmj_1', NOW);
      expect(mockAdapter.execute).not.toHaveBeenCalled();
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'logging.message_job.cancel',
          resourceType: 'logging_message_job',
          resourceId: 'lmj_1',
          severity: 'warn',
          metadata: {
            message_job_id: 'lmj_1',
            kind: 'retry_delivery',
            previous_status: status,
            current_status: 'cancelled',
            tenant_key: 'tk_a',
            reason: 'duplicate',
          },
        })
      );
    }
  });

  it('only requests cancellation of a claimed or running job and tolerates an empty body', async () => {
    for (const status of ['claimed', 'running']) {
      messagingFakes.markCancelled.mockClear();
      const job = messageJob({ kind: 'retry_delivery', status });
      messagingFakes.getJob.mockResolvedValue(job);
      const res = await call(createPlatformApp([RETRY]), 'POST', path);
      expect(res.status).toBe(200);
      expect(messagingFakes.markCancelled).not.toHaveBeenCalled();
      expect(res.body.result.status).toBe(status);
      expect(auditWrite).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          severity: 'info',
          metadata: expect.objectContaining({ reason: null }),
        })
      );
    }
    messagingFakes.getJob.mockResolvedValue(messageJob({ kind: 'retry_delivery' }));
    await call(createPlatformApp([RETRY]), 'POST', path, { reason: 5 });
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: null }) })
    );
  });

  it('cancels an export, marks its records and queues a cleanup job', async () => {
    const job = messageJob({ rootJobId: 'lmj_root', depth: 2, expiresAt: 9999 });
    messagingFakes.getJob.mockResolvedValue(job);
    const res = await call(createPlatformApp([CREATE]), 'POST', path, {});
    expect(res.status).toBe(200);
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][0]).toContain('UPDATE logging_export_jobs');
    expect(executed[0][1]).toEqual(['cancelled', NOW, NOW, 'lexp_1']);
    expect(executed[1][0]).toContain('UPDATE logging_message_export_builds');
    expect(executed[1][1]).toEqual(['queued', NOW, 'lmj_1']);
    const cleanupJobId = messagingFakes.createJob.mock.calls[0][0].id as string;
    expect(cleanupJobId).toMatch(/^lmj_/);
    expect(messagingFakes.writePayload).toHaveBeenCalledWith(expect.anything(), {
      bucket: envFixture.AUDIT_ARCHIVE,
      jobId: cleanupJobId,
      payloadType: 'export_build',
      schemaVersion: 1,
      lane: 'bulk',
      criticality: 'standard',
      sourceType: 'payload_object',
      tenantKey: 'tk_a',
      payload: expect.objectContaining({
        phase: 'cleanup',
        partition_strategy: 'manifest_shard',
        cleanup_reason: 'cancelled',
        export_job_id: 'lexp_1',
        message_job_id: cleanupJobId,
        requested_by: 'admin-1',
        snapshot_cutoff_at: NOW,
        lane: 'bulk',
      }),
      now: NOW,
    });
    expect(messagingFakes.createJob).toHaveBeenCalledWith({
      id: cleanupJobId,
      kind: 'export_build',
      lane: 'bulk',
      criticality: 'standard',
      priority: 0,
      topology: {
        tenantId: 'tenant-a',
        tenantKey: 'tk_a',
        topologyType: 'control_plane_d1',
        databaseBindingRef: 'DB_A',
        connectionRef: 'conn-a',
        topologySnapshotVersion: 3,
        topologyResolvedAt: 900,
      },
      scopeType: 'tenant',
      scopeId: 'tk_a',
      scopeKey: 'tenant:tk_a',
      sourceType: 'payload_object',
      sourceId: 'lexp_1',
      rootJobId: 'lmj_root',
      parentJobId: 'lmj_1',
      depth: 3,
      payloadObjectRef: 'payloads/obj.json',
      payloadSha256: 'sha-1',
      payloadType: 'export_build',
      payloadSchemaVersion: 1,
      redactedSummary: { redacted: true },
      validationSummary: { valid: true },
      idempotencyKey: `export_cleanup:lexp_1:lmj_1:${NOW}`,
      dedupeUntil: NOW + DAY,
      notBefore: NOW,
      maxAttempts: 5,
      attemptPolicy: { maxAttempts: 5, leaseTimeoutMs: 600000 },
      requestedBy: 'admin-1',
      reason: 'logging export cancellation cleanup',
      now: NOW,
      expiresAt: 9999,
    });
    expect(executed[2][0]).toContain('INSERT INTO logging_message_export_builds');
    expect(executed[2][1]).toEqual([
      expect.stringMatching(/^lexp_/),
      cleanupJobId,
      'lexp_1',
      'cleanup',
      'manifest_shard',
      'cancelled',
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
      'queued',
      JSON.stringify({ cleanup_reason: 'cancelled', cancelled_message_job_id: 'lmj_1' }),
      NOW,
      NOW,
    ]);
    expect(messagingFakes.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'cleanup' }),
      expect.anything()
    );
  });

  it('uses the job itself as the root of its cleanup and skips cleanup without a bucket', async () => {
    messagingFakes.getJob.mockResolvedValue(messageJob({ topologyResolvedAt: null }));
    await call(createPlatformApp([CREATE]), 'POST', path, {});
    const created = messagingFakes.createJob.mock.calls[0][0];
    expect(created.rootJobId).toBe('lmj_1');
    expect(created.depth).toBe(1);
    expect(created.topology.topologyResolvedAt).toBe(NOW);

    messagingFakes.createJob.mockClear();
    messagingFakes.enqueue.mockClear();
    mockAdapter.execute.mockClear();
    const res = await call(createPlatformApp([CREATE]), 'POST', path, {}, {}, {
      ...envFixture,
      AUDIT_ARCHIVE: undefined,
    } as unknown as Env);
    expect(res.status).toBe(200);
    expect(mockAdapter.execute).toHaveBeenCalledTimes(2);
    expect(messagingFakes.createJob).not.toHaveBeenCalled();
    expect(messagingFakes.enqueue).not.toHaveBeenCalled();
  });

  it('answers 500 when cancellation fails', async () => {
    messagingFakes.getJob.mockResolvedValue(messageJob());
    messagingFakes.requestCancel.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp([CREATE]), 'POST', path, {})).status).toBe(500);
  });
});
