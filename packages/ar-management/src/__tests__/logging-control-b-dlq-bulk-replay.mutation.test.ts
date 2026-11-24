/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  auditWrite,
  envFixture,
  messagingFakes,
  mockAdapter,
  resetFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const RETRY = 'admin:logging:delivery:retry';
const READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];
const BULK_PREVIEW = `${POLICIES}/dlq/bulk-replay/preview`;
const BULK_APPLY = `${POLICIES}/dlq/bulk-replay/apply`;

function fanout(overrides: Record<string, unknown> = {}) {
  return {
    payload_type: 'delivery_fanout',
    schema_version: 1,
    payload_id: 'qpl_original',
    tenant_key: 'tk_a',
    lane: 'default',
    created_at: 1000,
    catalog_id: 'obj_1',
    object_key: 'logs/chunk.jsonl',
    destination_id: 'dest_1',
    log_type: 'audit',
    plane: 'archive',
    record_count: 1,
    ...overrides,
  };
}

function dlqRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq_1',
    tenant_key: 'tk_a',
    payload_type: 'delivery_fanout',
    schema_version: 1,
    lane: 'default',
    destination_id: 'dest_1',
    payload_object_ref: 'dlq/tenant_key=tk_a/item.json',
    error_class: 'delivery_failed',
    attempt_count: 3,
    status: 'open',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function textObject(text: string) {
  return { text: async () => text, size: new TextEncoder().encode(text).byteLength };
}

function arrange(input: {
  dlq?: Record<string, ReturnType<typeof dlqRow>>;
  event?: Record<string, unknown> | null;
  catalog?: Record<string, unknown> | null;
  objects?: Record<string, unknown>;
}) {
  mockAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes('FROM logging_dlq_items')) return input.dlq?.[String(params?.[0])] ?? null;
    if (text.includes('FROM logging_delivery_events')) return input.event ?? null;
    if (text.includes('FROM log_object_catalog')) return input.catalog ?? null;
    return null;
  });
  envFixture.AUDIT_ARCHIVE.get.mockImplementation(
    async (ref: string) => input.objects?.[ref] ?? null
  );
}

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('dlq bulk replay preview', () => {
  it('requires delivery-events read, a supported lane and tenant scope', async () => {
    expect((await call(createApp([]), 'POST', BULK_PREVIEW, {})).status).toBe(403);
    const lane = await call(createApp(READ), 'POST', BULK_PREVIEW, { lane: 'fast' });
    expect(lane.status).toBe(400);
    expect(lane.body.details.fields).toEqual([
      { path: 'lane', code: 'invalid_lane', message: 'Unsupported delivery lane.' },
    ]);
    const foreign = await call(createApp(READ), 'POST', BULK_PREVIEW, { tenant_key: 'tk_other' });
    expect(foreign.status).toBe(403);
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('lists open items with every filter and echoes them', async () => {
    mockAdapter.query.mockResolvedValue([dlqRow()]);
    const res = await call(createPlatformApp(READ), 'POST', BULK_PREVIEW, {
      tenant_key: 'tk_1',
      lane: 'critical',
      destination_id: ' dest_9 ',
      payload_type: 'delivery_fanout',
      limit: 7,
    });
    expect(res.status).toBe(200);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'WHERE status = ? AND tenant_key = ? AND lane = ? AND destination_id = ? AND payload_type = ?'
    );
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(params).toEqual(['open', 'tk_1', 'critical', 'dest_9', 'delivery_fanout', 7]);
    expect(res.body.item).toEqual({
      filters: {
        tenant_key: 'tk_1',
        lane: 'critical',
        destination_id: 'dest_9',
        payload_type: 'delivery_fanout',
        limit: 7,
      },
      item_count: 1,
      items: [dlqRow()],
    });
  });

  it('bounds the limit to 1-100 (default 25) and scopes tenant admins', async () => {
    const cases: Array<[unknown, number]> = [
      [500, 100],
      [100, 100],
      [0, 25],
      [2.5, 25],
      ['5', 25],
      [undefined, 25],
    ];
    for (const [limit, expected] of cases) {
      mockAdapter.query.mockClear();
      const res = await call(createPlatformApp(READ), 'POST', BULK_PREVIEW, { limit });
      expect(mockAdapter.query.mock.calls[0][1]).toEqual(['open', expected]);
      expect(res.body.item.filters).toEqual({
        tenant_key: null,
        lane: null,
        destination_id: null,
        payload_type: null,
        limit: expected,
      });
    }
    mockAdapter.query.mockClear();
    await call(createApp(READ), 'POST', BULK_PREVIEW, {});
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([
      'open',
      await deriveTenantKeyFromTenantId('tenant-a', undefined),
      25,
    ]);
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'POST', BULK_PREVIEW, {})).status).toBe(500);
  });
});

describe('dlq bulk replay apply', () => {
  const app = () => createPlatformApp([RETRY]);

  it('requires the retry permission, a supported lane and tenant scope', async () => {
    expect((await call(createApp(READ), 'POST', BULK_APPLY, {})).status).toBe(403);
    const lane = await call(app(), 'POST', BULK_APPLY, { lane: 'fast' });
    expect(lane.body.details.fields[0].code).toBe('invalid_lane');
    expect(
      (await call(createApp([RETRY]), 'POST', BULK_APPLY, { tenant_id: 'tenant-b' })).status
    ).toBe(403);
  });

  it('bounds the batch to 1-50 (default 10) and replays nothing when there are no items', async () => {
    const cases: Array<[unknown, number]> = [
      [500, 50],
      [50, 50],
      [3, 3],
      [0, 10],
      [1.2, 10],
      [undefined, 10],
    ];
    for (const [limit, expected] of cases) {
      mockAdapter.query.mockClear();
      const res = await call(app(), 'POST', BULK_APPLY, { limit });
      expect(res.status).toBe(202);
      expect(res.body.result).toEqual({
        requested_count: 0,
        applied_count: 0,
        failed_count: 0,
        applied: [],
        failed: [],
      });
      expect(mockAdapter.query.mock.calls[0][1]).toEqual(['open', expected]);
    }
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.delivery.bulk_retry',
        resourceType: 'logging_dlq_item',
        resourceId: 'bulk-replay',
        result: 'success',
        severity: 'info',
        metadata: {
          requested_count: 0,
          applied_count: 0,
          failed_count: 0,
          tenant_key: null,
          lane: null,
        },
      })
    );
  });

  it('queues a retry job per item with the supplied reason', async () => {
    mockAdapter.query.mockResolvedValue([dlqRow({ id: 'dlq_1' }), dlqRow({ id: 'dlq_2' })]);
    arrange({
      dlq: { dlq_1: dlqRow({ id: 'dlq_1' }), dlq_2: dlqRow({ id: 'dlq_2' }) },
      objects: { 'dlq/tenant_key=tk_a/item.json': textObject(JSON.stringify(fanout())) },
    });
    const res = await call(app(), 'POST', BULK_APPLY, {
      lane: 'default',
      reason: ' cleanup ',
      tenant_key: 'tk_a',
    });
    expect(res.status).toBe(202);
    expect(res.body.result.requested_count).toBe(2);
    expect(res.body.result.applied_count).toBe(2);
    expect(res.body.result.failed).toEqual([]);
    expect(res.body.result.applied.map((a: { dlq_item_id: string }) => a.dlq_item_id)).toEqual([
      'dlq_1',
      'dlq_2',
    ]);
    expect(res.body.result.applied[0].message_job).toMatchObject({
      kind: 'retry_delivery',
      status: 'queued',
      lane: 'default',
      criticality: 'standard',
      tenant_key: 'tk_a',
      payload_object_ref: 'payloads/obj.json',
      source_type: 'dlq_item',
      source_id: 'dlq_1',
      queued: true,
    });
    expect(messagingFakes.writePayload.mock.calls[0][1].payload.reason).toBe('cleanup');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'success',
        severity: 'info',
        metadata: {
          requested_count: 2,
          applied_count: 2,
          failed_count: 0,
          tenant_key: 'tk_a',
          lane: 'default',
        },
      })
    );
    messagingFakes.writePayload.mockClear();
    mockAdapter.query.mockResolvedValue([dlqRow({ id: 'dlq_1' })]);
    await call(app(), 'POST', BULK_APPLY, {});
    expect(messagingFakes.writePayload.mock.calls[0][1].payload.reason).toBe(
      'bulk DLQ replay requested'
    );
  });

  it('reports failures per item and picks the status from the outcome mix', async () => {
    mockAdapter.query.mockResolvedValue([dlqRow({ id: 'dlq_ok' }), dlqRow({ id: 'dlq_gone' })]);
    arrange({
      dlq: {
        dlq_ok: dlqRow({ id: 'dlq_ok' }),
        dlq_gone: dlqRow({ id: 'dlq_gone', status: 'deleted' }),
      },
      objects: { 'dlq/tenant_key=tk_a/item.json': textObject(JSON.stringify(fanout())) },
    });
    const mixed = await call(app(), 'POST', BULK_APPLY, {});
    expect(mixed.status).toBe(202);
    expect(mixed.body.result).toMatchObject({
      requested_count: 2,
      applied_count: 1,
      failed_count: 1,
    });
    expect(mixed.body.result.failed).toEqual([
      { dlq_item_id: 'dlq_gone', status: 400, error: AR_ERROR_CODES.ADMIN_INVALID_REQUEST },
    ]);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure', severity: 'warn' })
    );

    mockAdapter.query.mockResolvedValue([dlqRow({ id: 'dlq_gone' })]);
    const allFailed = await call(app(), 'POST', BULK_APPLY, {});
    expect(allFailed.status).toBe(409);
    expect(allFailed.body.result).toMatchObject({ applied_count: 0, failed_count: 1 });

    mockAdapter.query.mockResolvedValue([dlqRow({ id: 'dlq_unknown' })]);
    const missing = await call(app(), 'POST', BULK_APPLY, {});
    expect(missing.body.result.failed[0]).toEqual({
      dlq_item_id: 'dlq_unknown',
      status: 404,
      error: AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND,
    });
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(app(), 'POST', BULK_APPLY, {})).status).toBe(500);
  });
});

describe('dlq replay convenience endpoints', () => {
  it('requires the retry permission and replays through both aliases', async () => {
    arrange({
      dlq: { dlq_1: dlqRow() },
      objects: { 'dlq/tenant_key=tk_a/item.json': textObject(JSON.stringify(fanout())) },
    });
    for (const alias of [`${POLICIES}/dlq/dlq_1/replay`, `${POLICIES}/dlq-items/dlq_1/replay`]) {
      expect((await call(createApp(READ), 'POST', alias)).status).toBe(403);
      messagingFakes.writePayload.mockClear();
      const res = await call(createPlatformApp([RETRY]), 'POST', alias);
      expect(res.status).toBe(202);
      expect(messagingFakes.writePayload.mock.calls[0][1].payload).toMatchObject({
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        reason: 'dlq replay requested from convenience endpoint',
      });
    }
    arrange({ dlq: {} });
    expect(
      (await call(createPlatformApp([RETRY]), 'POST', `${POLICIES}/dlq/missing/replay`)).status
    ).toBe(404);
  });
});
