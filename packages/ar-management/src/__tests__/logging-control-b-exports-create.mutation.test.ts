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

import {
  auditWrite,
  envFixture,
  mockAdapter,
  messagingFakes,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const CREATE = 'admin:logging:exports:create';
const SENSITIVE = 'admin:logging:sensitive_detail:export';
const EXPORTS = `${POLICIES}/exports`;
const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const withoutBinding = (name: string) => ({ ...envFixture, [name]: undefined }) as unknown as Env;

describe('POST /exports validation and gates', () => {
  it('requires the export create permission', async () => {
    const res = await call(createApp([]), 'POST', EXPORTS, {});
    expect(res.status).toBe(403);
    expect(res.body.details.permission).toEqual({
      required_permission: CREATE,
      reason: 'export_create_permission_required',
    });
  });

  it('requires the export artifact bucket', async () => {
    const res = await call(
      createApp([CREATE]),
      'POST',
      EXPORTS,
      {},
      {},
      withoutBinding('EXPORT_ARTIFACTS')
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'destination',
        code: 'bucket_unavailable',
        message: 'Export artifact bucket is unavailable.',
      },
    ]);
  });

  it('refuses a tenant or tenant key outside the caller tenant', async () => {
    const byId = await call(createApp([CREATE]), 'POST', EXPORTS, { tenant_id: 'tenant-b' });
    expect(byId.status).toBe(403);
    expect(byId.body.details.permission.reason).toBe('tenant_id_scope_mismatch');
    const byKey = await call(createApp([CREATE]), 'POST', EXPORTS, { tenant_key: 'tk_other' });
    expect(byKey.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
    expect(messagingFakes.writePayload).not.toHaveBeenCalled();
  });

  it('requires the sensitive-detail permission for the plane and for full detail', async () => {
    const expected = {
      required_permission: SENSITIVE,
      reason: 'sensitive_detail_export_permission_required',
    };
    for (const body of [
      { plane: 'sensitive_detail' },
      { detail_scope: 'full' },
      { include_detail: true },
    ]) {
      const res = await call(createApp([CREATE]), 'POST', EXPORTS, body);
      expect(res.status).toBe(403);
      expect(res.body.details.permission).toEqual(expected);
    }
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('requires the payload bucket and the encryption key', async () => {
    const noBucket = await call(
      createApp([CREATE]),
      'POST',
      EXPORTS,
      {},
      {},
      withoutBinding('AUDIT_ARCHIVE')
    );
    expect(noBucket.status).toBe(400);
    expect(noBucket.body.details.fields).toEqual([
      {
        path: 'LOGGING_MESSAGE_PAYLOAD_BUCKET',
        code: 'binding_unavailable',
        message: 'No R2 bucket is configured for logging message payloads.',
      },
    ]);
    const noKey = await call(
      createApp([CREATE]),
      'POST',
      EXPORTS,
      {},
      {},
      withoutBinding('OBJECT_ENCRYPTION_ROOT_KEY')
    );
    expect(noKey.body.details.fields).toEqual([
      {
        path: 'OBJECT_ENCRYPTION_ROOT_KEY',
        code: 'binding_unavailable',
        message: 'The logging payload encryption key is not configured.',
      },
    ]);
    expect(messagingFakes.writePayload).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });
});

describe('POST /exports creation', () => {
  it('queues a plain catalog export for a platform caller', async () => {
    const res = await call(createPlatformApp([CREATE]), 'POST', EXPORTS, {
      format: 'csv',
      log_type: 'audit',
      plane: 'archive',
      tenant_key: 'tk_1',
      time_start: 100,
      time_end: 200,
      limit: 25,
      idempotency_key: ' idem-1 ',
    });
    expect(res.status).toBe(202);
    const id = res.body.result.id as string;
    expect(id).toMatch(/^lexp_/);
    const filters = {
      tenant_key: 'tk_1',
      log_type: 'audit',
      plane: 'archive',
      source: 'catalog',
      time_start: 100,
      time_end: 200,
      limit: 25,
      include_payload: false,
      detail_scope: 'none',
    };
    expect(res.body.result).toEqual({
      id,
      job_id: id,
      message_job_id: expect.stringMatching(/^lmj_/),
      status: 'queued',
      format: 'csv',
      queued: true,
      queue_binding: 'LOGGING_DELIVERY_QUEUE',
      polling: {
        export: `/api/admin/logging-policies/exports/${id}`,
        message_job: `/api/admin/logging-policies/message-jobs/${res.body.result.message_job_id}`,
      },
      created_at: NOW,
      expires_at: NOW + 7 * DAY,
    });
    expect(res.body.audit_id).toBe('audit-id-1');
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();

    const jobId = res.body.result.message_job_id as string;
    expect(messagingFakes.writePayload).toHaveBeenCalledWith(expect.anything(), {
      bucket: envFixture.AUDIT_ARCHIVE,
      jobId,
      payloadType: 'export_build',
      schemaVersion: 1,
      lane: 'default',
      criticality: 'standard',
      sourceType: 'payload_object',
      tenantKey: 'tk_1',
      payload: {
        payload_type: 'export_build',
        schema_version: 1,
        payload_id: expect.stringMatching(/^qpl_/),
        message_job_id: jobId,
        tenant_key: 'tk_1',
        lane: 'default',
        created_at: NOW,
        export_job_id: id,
        phase: 'plan',
        partition_strategy: 'time_bucket_shard',
        snapshot_cutoff_at: NOW,
        requested_by: 'admin-1',
        filters,
      },
      now: NOW,
    });
    const inserts = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(inserts[0][0]).toContain('INSERT INTO logging_export_jobs');
    expect(inserts[0][1]).toEqual([
      id,
      'tk_1',
      'audit',
      'archive',
      'csv',
      'queued',
      null,
      null,
      null,
      0,
      0,
      'admin-1',
      null,
      JSON.stringify(filters),
      NOW,
      NOW,
      null,
      NOW + 7 * DAY,
    ]);
    expect(messagingFakes.createJob).toHaveBeenCalledWith({
      id: jobId,
      kind: 'export_build',
      lane: 'default',
      criticality: 'standard',
      priority: 10,
      topology: { tenantKey: 'tk_1', topologyType: 'unknown', topologyResolvedAt: NOW },
      scopeType: 'tenant',
      scopeId: 'tk_1',
      scopeKey: 'tenant:tk_1',
      sourceType: 'payload_object',
      sourceId: id,
      payloadObjectRef: 'payloads/obj.json',
      payloadSha256: 'sha-1',
      payloadType: 'export_build',
      payloadSchemaVersion: 1,
      redactedSummary: { redacted: true },
      validationSummary: { valid: true },
      idempotencyKey: 'idem-1',
      dedupeUntil: NOW + DAY,
      notBefore: NOW,
      maxAttempts: 5,
      attemptPolicy: { maxAttempts: 5, leaseTimeoutMs: 600000 },
      requestedBy: 'admin-1',
      reason: 'logging export build requested',
      now: NOW,
      expiresAt: NOW + 7 * DAY,
    });
    expect(inserts[1][0]).toContain('INSERT INTO logging_message_export_builds');
    expect(inserts[1][1]).toEqual([
      expect.stringMatching(/^lexp_/),
      jobId,
      id,
      'plan',
      'time_bucket_shard',
      null,
      null,
      null,
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
      null,
      JSON.stringify({ filters }),
      NOW,
      NOW,
    ]);
    expect(messagingFakes.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ export_job_id: id, phase: 'plan' }),
      expect.anything()
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_export.create',
        resourceType: 'logging_export_job',
        resourceId: id,
        result: 'success',
        severity: 'info',
        metadata: {
          export_id: id,
          message_job_id: jobId,
          format: 'csv',
          status: 'queued',
          queue_payload_id: 'qpl_1',
          queue_binding: 'LOGGING_DELIVERY_QUEUE',
        },
      })
    );
  });

  it('defaults format, limit, source and the platform topology', async () => {
    const res = await call(createPlatformApp([CREATE]), 'POST', EXPORTS, { format: 'weird' });
    expect(res.body.result.format).toBe('jsonl');
    const insert = mockAdapter.execute.mock.calls[0][1] as unknown[];
    expect(insert.slice(1, 5)).toEqual([null, null, null, 'jsonl']);
    expect(JSON.parse(insert[13] as string)).toEqual({
      tenant_key: null,
      log_type: null,
      plane: null,
      source: 'catalog',
      time_start: null,
      time_end: null,
      limit: 1000,
      include_payload: false,
      detail_scope: 'none',
    });
    const job = messagingFakes.createJob.mock.calls[0][0];
    expect(job).toMatchObject({
      topology: { tenantKey: null, topologyType: 'platform', topologyResolvedAt: NOW },
      scopeType: 'platform',
      scopeId: null,
      scopeKey: 'platform',
      idempotencyKey: `export_build:${res.body.result.id}:${NOW}`,
    });
    expect(
      (await call(createPlatformApp([CREATE]), 'POST', EXPORTS, { format: 'zip' })).body.result
        .format
    ).toBe('zip');
  });

  it('clamps the limit and ignores non-positive time bounds', async () => {
    const cases: Array<[unknown, number]> = [
      [9999, 5000],
      [5000, 5000],
      [2.7, 2],
      [0, 1000],
      [-5, 1000],
      ['50', 1000],
    ];
    for (const [limit, expected] of cases) {
      mockAdapter.execute.mockClear();
      await call(createPlatformApp([CREATE]), 'POST', EXPORTS, {
        limit,
        time_start: 0,
        time_end: -1,
      });
      const filters = JSON.parse((mockAdapter.execute.mock.calls[0][1] as string[])[13]);
      expect(filters).toMatchObject({ limit: expected, time_start: null, time_end: null });
    }
  });

  it('exports record-indexed data in bulk and gates payload export behind step-up', async () => {
    const res = await call(createPlatformApp([CREATE]), 'POST', EXPORTS, {
      source: 'record_index',
      include_payload: true,
      tenant_id: 'tenant-q',
    });
    expect(res.status).toBe(202);
    const payload = messagingFakes.writePayload.mock.calls[0][1];
    expect(payload).toMatchObject({
      lane: 'bulk',
      criticality: 'standard',
      payload: { partition_strategy: 'query_page', lane: 'bulk' },
    });
    expect(payload.payload.filters).toMatchObject({
      source: 'record_index',
      include_payload: true,
    });
    expect(messagingFakes.createJob.mock.calls[0][0]).toMatchObject({ priority: 0, lane: 'bulk' });
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(1);
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1]).toMatchObject({
      operation: 'log.sensitive.export',
      targetTenantId: 'tenant-q',
      params: {
        kind: 'logging.export.create',
        format: 'jsonl',
        source: 'record_index',
        include_payload: true,
        detail_scope: 'none',
      },
    });
    const viaFlag = await call(createPlatformApp([CREATE]), 'POST', EXPORTS, {
      include_records: true,
    });
    expect(viaFlag.status).toBe(202);
    expect(messagingFakes.writePayload.mock.calls[1][1].payload.filters.source).toBe(
      'record_index'
    );
    expect(messagingFakes.writePayload.mock.calls[1][1].payload.filters.include_payload).toBe(
      false
    );
  });

  it('ignores include_payload for catalog exports', async () => {
    await call(createPlatformApp([CREATE]), 'POST', EXPORTS, { include_payload: true });
    expect(messagingFakes.writePayload.mock.calls[0][1].payload.filters.include_payload).toBe(
      false
    );
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    await call(createPlatformApp([CREATE]), 'POST', EXPORTS, {
      source: 'record_index',
      include_payload: 'yes',
    });
    expect(messagingFakes.writePayload.mock.calls[1][1].payload.filters.include_payload).toBe(
      false
    );
  });

  it('treats sensitive-detail and full-detail exports as critical step-up operations', async () => {
    const app = createPlatformApp([CREATE, SENSITIVE]);
    const res = await call(app, 'POST', EXPORTS, {
      plane: 'sensitive_detail',
      include_payload: true,
    });
    expect(res.status).toBe(202);
    expect(messagingFakes.writePayload.mock.calls[0][1]).toMatchObject({
      criticality: 'critical',
      lane: 'bulk',
      payload: { partition_strategy: 'chunk_index' },
    });
    expect(messagingFakes.createJob.mock.calls[0][0]).toMatchObject({
      criticality: 'critical',
      priority: 100,
    });
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].targetTenantId).toBe('tenant-a');
    const full = await call(app, 'POST', EXPORTS, { detail_scope: 'full' });
    expect(full.status).toBe(202);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(2);
    expect(stepUpFakes.requireAdminStepUp.mock.calls[1][1].params).toMatchObject({
      detail_scope: 'full',
    });
    const viaFlag = await call(app, 'POST', EXPORTS, { include_detail: true });
    expect(viaFlag.status).toBe(202);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(3);
  });

  it('writes nothing when step-up is refused and answers 500 on storage failure', async () => {
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    const refused = await call(createPlatformApp([CREATE, SENSITIVE]), 'POST', EXPORTS, {
      plane: 'sensitive_detail',
    });
    expect(refused.status).toBe(401);
    expect(messagingFakes.writePayload).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp([CREATE]), 'POST', EXPORTS, {})).status).toBe(500);
  });

  it('scopes a tenant admin export to its own tenant key', async () => {
    const res = await call(createApp([CREATE]), 'POST', EXPORTS, {});
    expect(res.status).toBe(202);
    const tenantKey = messagingFakes.writePayload.mock.calls[0][1].tenantKey as string;
    expect(tenantKey).toMatch(/^t_/);
    expect(messagingFakes.createJob.mock.calls[0][0]).toMatchObject({
      scopeType: 'tenant',
      scopeId: tenantKey,
      scopeKey: `tenant:${tenantKey}`,
    });
  });
});
