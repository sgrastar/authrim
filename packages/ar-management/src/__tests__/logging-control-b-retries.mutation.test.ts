/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- admin API response bodies are untyped JSON in these route tests */
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
  messagingFakes,
  mockAdapter,
  resetFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const DAY = 24 * 3600 * 1000;
const RETRY = 'admin:logging:delivery:retry';
const READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];
const RETRIES = `${POLICIES}/retries`;

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

const withEnv = (extra: Record<string, unknown>) => ({ ...envFixture, ...extra }) as unknown as Env;

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('POST /retries', () => {
  const app = () => createPlatformApp([RETRY]);

  it('requires the retry permission and a supported source', async () => {
    expect((await call(createApp(READ), 'POST', RETRIES, {})).status).toBe(403);
    for (const body of [
      {},
      { source_type: 'nope', source_id: 'x' },
      { source_type: 'dlq_item' },
      { source_type: 'dlq_item', source_id: '  ' },
    ]) {
      const res = await call(app(), 'POST', RETRIES, body);
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'source_type',
          code: 'invalid_retry_source',
          message:
            'source_type must be dlq_item, delivery_event, or payload_object with source_id.',
        },
      ]);
    }
  });

  it('queues a retry for an open dlq item with all request options', async () => {
    arrange({
      dlq: { dlq_1: dlqRow() },
      objects: {
        'dlq/tenant_key=tk_a/item.json': textObject(JSON.stringify(fanout({ lane: 'bulk' }))),
      },
    });
    const res = await call(app(), 'POST', RETRIES, {
      source_type: 'dlq_item',
      source_id: 'dlq_1',
      reason: 'because',
      idempotency_key: 'idem-1',
      not_before: 5000,
      dedupe_until: 6000,
      max_attempts: 3,
      lease_timeout_ms: 90000,
    });
    expect(res.status).toBe(202);
    const jobId = res.body.result.id as string;
    expect(res.body.result).toEqual({
      id: jobId,
      kind: 'retry_delivery',
      status: 'queued',
      lane: 'bulk',
      criticality: 'standard',
      tenant_key: 'tk_a',
      source_type: 'dlq_item',
      source_id: 'dlq_1',
      payload_object_ref: 'payloads/obj.json',
      queue_payload_id: 'qpl_1',
      queue_binding: 'LOGGING_DELIVERY_QUEUE',
      queued: true,
      polling: { job: `/api/admin/logging-policies/message-jobs/${jobId}` },
    });
    expect(messagingFakes.writePayload).toHaveBeenCalledWith(expect.anything(), {
      bucket: envFixture.AUDIT_ARCHIVE,
      jobId,
      payloadType: 'retry_delivery',
      schemaVersion: 1,
      lane: 'bulk',
      criticality: 'standard',
      sourceType: 'dlq_item',
      tenantKey: 'tk_a',
      payload: {
        payload_type: 'retry_delivery',
        schema_version: 1,
        payload_id: expect.stringMatching(/^qpl_/),
        message_job_id: jobId,
        tenant_key: 'tk_a',
        lane: 'bulk',
        created_at: NOW,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        retry_id: jobId,
        idempotency_key: 'idem-1',
        target_payload_hash: 'dlq/tenant_key=tk_a/item.json',
        requested_by: 'admin-1',
        reason: 'because',
        replay_payload: fanout({ lane: 'bulk' }),
      },
      now: NOW,
    });
    expect(messagingFakes.createJob).toHaveBeenCalledWith({
      id: jobId,
      kind: 'retry_delivery',
      lane: 'bulk',
      criticality: 'standard',
      priority: 0,
      topology: { tenantKey: 'tk_a', topologyType: 'unknown', topologyResolvedAt: NOW },
      scopeType: 'tenant',
      scopeId: 'tk_a',
      scopeKey: 'tenant:tk_a',
      sourceType: 'dlq_item',
      sourceId: 'dlq_1',
      payloadObjectRef: 'payloads/obj.json',
      payloadSha256: 'sha-1',
      payloadType: 'retry_delivery',
      payloadSchemaVersion: 1,
      redactedSummary: { redacted: true },
      validationSummary: { valid: true },
      idempotencyKey: 'idem-1',
      dedupeUntil: 6000,
      notBefore: 5000,
      maxAttempts: 3,
      attemptPolicy: { maxAttempts: 3, leaseTimeoutMs: 90000 },
      requestedBy: 'admin-1',
      reason: 'because',
      errorClass: null,
      now: NOW,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.delivery.retry',
        resourceType: 'logging_message_job',
        resourceId: jobId,
        severity: 'info',
        metadata: {
          message_job_id: jobId,
          source_type: 'dlq_item',
          source_id: 'dlq_1',
          tenant_key: 'tk_a',
          lane: 'bulk',
          criticality: 'standard',
          queued: true,
          queue_binding: 'LOGGING_DELIVERY_QUEUE',
        },
      })
    );
  });

  it('uses defaults for the retry options and a derived idempotency key', async () => {
    arrange({
      dlq: { dlq_1: dlqRow() },
      objects: {
        'dlq/tenant_key=tk_a/item.json': textObject(JSON.stringify(fanout())),
      },
    });
    await call(app(), 'POST', RETRIES, { source_type: 'dlq_item', source_id: 'dlq_1' });
    const payload = messagingFakes.writePayload.mock.calls[0][1].payload;
    expect(payload.idempotency_key).toBe(
      'retry_delivery:dlq_item:dlq_1:dlq/tenant_key=tk_a/item.json'
    );
    expect(payload.reason).toBeUndefined();
    expect(messagingFakes.createJob.mock.calls[0][0]).toMatchObject({
      lane: 'default',
      priority: 10,
      dedupeUntil: NOW + DAY,
      notBefore: NOW,
      maxAttempts: 5,
      attemptPolicy: { maxAttempts: 5, leaseTimeoutMs: 300000 },
      reason: null,
    });
    messagingFakes.createJob.mockClear();
    await call(app(), 'POST', RETRIES, {
      source_type: 'dlq_item',
      source_id: 'dlq_1',
      max_attempts: 'x',
      lease_timeout_ms: -1,
      not_before: '5',
      dedupe_until: '6',
    });
    expect(messagingFakes.createJob.mock.calls[0][0]).toMatchObject({
      maxAttempts: 5,
      attemptPolicy: { maxAttempts: 5, leaseTimeoutMs: 300000 },
      notBefore: NOW,
      dedupeUntil: NOW + DAY,
    });
  });

  it('refuses dlq items that are missing, closed or of another tenant', async () => {
    arrange({ dlq: { dlq_closed: dlqRow({ id: 'dlq_closed', status: 'purged' }) } });
    const missing = await call(app(), 'POST', RETRIES, {
      source_type: 'dlq_item',
      source_id: 'nope',
    });
    expect(missing.status).toBe(404);
    const closed = await call(app(), 'POST', RETRIES, {
      source_type: 'dlq_item',
      source_id: 'dlq_closed',
    });
    expect(closed.body.details.fields).toEqual([
      { path: 'status', code: 'invalid_state', message: 'Only open DLQ items can be modified.' },
    ]);
    arrange({ dlq: { dlq_1: dlqRow({ tenant_key: 'tk_other' }) } });
    const foreign = await call(createApp([RETRY]), 'POST', RETRIES, {
      source_type: 'dlq_item',
      source_id: 'dlq_1',
    });
    expect(foreign.status).toBe(403);
    expect(messagingFakes.writePayload).not.toHaveBeenCalled();
  });

  it('explains why a dlq payload cannot be replayed', async () => {
    const ref = 'dlq/tenant_key=tk_a/item.json';
    const body = { source_type: 'dlq_item', source_id: 'dlq_1' };
    const field = (res: Awaited<ReturnType<typeof call>>) => res.body.details.fields[0];
    arrange({ dlq: { dlq_1: dlqRow() } });
    const absent = await call(app(), 'POST', RETRIES, body);
    expect(field(absent)).toEqual({
      path: 'payload_object_ref',
      code: 'payload_object_not_found',
      message: 'Retry payload object cannot be read.',
    });
    const noBucket = await call(
      app(),
      'POST',
      RETRIES,
      body,
      {},
      withEnv({ AUDIT_ARCHIVE: undefined })
    );
    expect(field(noBucket).code).toBe('payload_object_not_found');
    arrange({ dlq: { dlq_1: dlqRow() }, objects: { [ref]: textObject('{nope') } });
    expect(field(await call(app(), 'POST', RETRIES, body))).toEqual({
      path: 'payload_object_ref',
      code: 'payload_object_malformed_json',
      message: 'Retry payload object must be JSON.',
    });
    arrange({ dlq: { dlq_1: dlqRow() }, objects: { [ref]: textObject('{"a":1}') } });
    expect(field(await call(app(), 'POST', RETRIES, body))).toEqual({
      path: 'payload_object_ref',
      code: 'unsupported_retry_payload',
      message: 'Retry source payload must contain a supported logging delivery queue payload.',
    });
  });

  it('accepts queue payloads wrapped in body or bodyJson', async () => {
    const ref = 'dlq/tenant_key=tk_a/item.json';
    for (const wrapped of [{ body: fanout() }, { bodyJson: JSON.stringify(fanout()) }]) {
      messagingFakes.writePayload.mockClear();
      arrange({
        dlq: { dlq_1: dlqRow() },
        objects: { [ref]: textObject(JSON.stringify(wrapped)) },
      });
      const res = await call(app(), 'POST', RETRIES, {
        source_type: 'dlq_item',
        source_id: 'dlq_1',
      });
      expect(res.status).toBe(202);
      expect(messagingFakes.writePayload.mock.calls[0][1].payload.replay_payload).toEqual(fanout());
    }
  });

  it('keeps critical retries for platform administrators', async () => {
    const ref = 'dlq/tenant_key=tk_a/item.json';
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a', undefined);
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ lane: 'critical' }, true],
      [{ log_type: 'admin_audit' }, true],
      [{ log_type: 'security' }, true],
      [{ log_type: 'audit' }, false],
    ];
    for (const [overrides, critical] of cases) {
      messagingFakes.writePayload.mockClear();
      arrange({
        dlq: { dlq_1: dlqRow({ tenant_key: tenantKey, payload_object_ref: ref }) },
        objects: {
          [ref]: textObject(JSON.stringify(fanout({ tenant_key: tenantKey, ...overrides }))),
        },
      });
      const tenantRes = await call(createApp([RETRY]), 'POST', RETRIES, {
        source_type: 'dlq_item',
        source_id: 'dlq_1',
      });
      if (critical) {
        expect(tenantRes.status).toBe(403);
        expect(tenantRes.body.details.permission).toEqual({
          required_scope: 'platform',
          reason: 'critical_logging_retry_requires_platform_admin',
        });
        expect(messagingFakes.writePayload).not.toHaveBeenCalled();
        const platformRes = await call(app(), 'POST', RETRIES, {
          source_type: 'dlq_item',
          source_id: 'dlq_1',
        });
        expect(platformRes.status).toBe(202);
        expect(messagingFakes.writePayload.mock.calls[0][1]).toMatchObject({
          criticality: 'critical',
        });
        expect(messagingFakes.createJob.mock.calls.at(-1)?.[0]).toMatchObject({
          criticality: 'critical',
          priority: 100,
        });
        expect(auditWrite).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ severity: 'warn' })
        );
      } else {
        expect(tenantRes.status).toBe(202);
      }
    }
  });

  it('requires the payload bucket before writing', async () => {
    arrange({
      event: {
        id: 'evt_1',
        tenant_key: 'tk_a',
        destination_id: 'dest_1',
        object_catalog_id: 'obj_1',
        log_type: 'audit',
        plane: 'archive',
        lane: 'default',
      },
      catalog: {
        id: 'obj_1',
        status: 'committed',
        object_key: 'logs/chunk.jsonl',
        record_count: '4',
      },
    });
    const res = await call(
      app(),
      'POST',
      RETRIES,
      { source_type: 'delivery_event', source_id: 'evt_1' },
      {},
      withEnv({ AUDIT_ARCHIVE: undefined })
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'LOGGING_MESSAGE_PAYLOAD_BUCKET',
        code: 'binding_unavailable',
        message: 'No R2 bucket is configured for logging message payloads.',
      },
    ]);
  });

  it('retries a committed delivery event through a rebuilt fanout payload', async () => {
    arrange({
      event: {
        id: 'evt_1',
        tenant_key: 'tk_a',
        destination_id: 'dest_1',
        object_catalog_id: 'obj_1',
        log_type: 'audit',
        plane: 'archive',
        lane: 'bulk',
      },
      catalog: {
        id: 'obj_1',
        status: 'committed',
        object_key: 'logs/chunk.jsonl',
        record_count: '4',
      },
    });
    const res = await call(app(), 'POST', RETRIES, {
      source_type: 'delivery_event',
      source_id: 'evt_1',
    });
    expect(res.status).toBe(202);
    const write = messagingFakes.writePayload.mock.calls[0][1];
    expect(write.payload.replay_payload).toEqual({
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: expect.stringMatching(/^qpl_/),
      tenant_key: 'tk_a',
      lane: 'bulk',
      created_at: NOW,
      catalog_id: 'obj_1',
      object_key: 'logs/chunk.jsonl',
      destination_id: 'dest_1',
      log_type: 'audit',
      plane: 'archive',
      record_count: 4,
    });
    expect(write.payload.target_payload_hash).toBe('logs/chunk.jsonl');
    expect(write.payload.idempotency_key).toBe(
      'retry_delivery:delivery_event:evt_1:logs/chunk.jsonl'
    );
  });

  it('rejects delivery events that cannot be replayed', async () => {
    const body = { source_type: 'delivery_event', source_id: 'evt_1' };
    arrange({});
    expect((await call(app(), 'POST', RETRIES, body)).status).toBe(404);
    const event = {
      id: 'evt_1',
      tenant_key: 'tk_a',
      destination_id: 'dest_1',
      object_catalog_id: 'obj_1',
      log_type: 'audit',
      plane: 'archive',
      lane: 'default',
    };
    arrange({ event: { ...event, tenant_key: 'tk_other' } });
    expect((await call(createApp([RETRY]), 'POST', RETRIES, body)).status).toBe(403);
    for (const partial of [{ destination_id: null }, { object_catalog_id: null }]) {
      arrange({ event: { ...event, ...partial } });
      const res = await call(app(), 'POST', RETRIES, body);
      expect(res.body.details.fields).toEqual([
        {
          path: 'source_id',
          code: 'delivery_event_not_replayable',
          message: 'Delivery event must reference a destination and catalog object to be retried.',
        },
      ]);
    }
    for (const catalog of [
      null,
      { id: 'obj_1', status: 'pending', object_key: 'k', record_count: 1 },
    ]) {
      arrange({ event, catalog });
      const res = await call(app(), 'POST', RETRIES, body);
      expect(res.body.details.fields).toEqual([
        {
          path: 'source_id',
          code: 'catalog_object_not_replayable',
          message: 'Delivery event catalog object must exist and be committed.',
        },
      ]);
    }
  });

  it('only lets platform administrators retry raw payload objects', async () => {
    const body = { source_type: 'payload_object', source_id: 'payloads/raw.json' };
    const denied = await call(createApp([RETRY]), 'POST', RETRIES, body);
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'payload_object_retry_requires_platform_admin',
    });
    const field = (res: Awaited<ReturnType<typeof call>>) => res.body.details.fields[0];
    arrange({});
    expect(field(await call(app(), 'POST', RETRIES, body))).toEqual({
      path: 'payload_object_ref',
      code: 'payload_object_not_found',
      message: 'Retry payload object cannot be read.',
    });
    expect(
      field(await call(app(), 'POST', RETRIES, body, {}, withEnv({ AUDIT_ARCHIVE: undefined })))
        .code
    ).toBe('payload_bucket_unavailable');
    arrange({ objects: { 'payloads/raw.json': textObject('nope') } });
    expect(field(await call(app(), 'POST', RETRIES, body)).code).toBe(
      'payload_object_malformed_json'
    );
    arrange({ objects: { 'payloads/raw.json': textObject('{}') } });
    expect(field(await call(app(), 'POST', RETRIES, body)).code).toBe('unsupported_retry_payload');
  });

  it('retries a raw payload object, preferring an explicit object ref', async () => {
    arrange({
      objects: {
        'payloads/raw.json': textObject(JSON.stringify(fanout())),
        'payloads/explicit.json': textObject(
          JSON.stringify(fanout({ lane: 'critical', tenant_key: 'tk_x' }))
        ),
      },
    });
    const plain = await call(app(), 'POST', RETRIES, {
      source_type: 'payload_object',
      source_id: 'payloads/raw.json',
    });
    expect(plain.status).toBe(202);
    expect(messagingFakes.writePayload.mock.calls[0][1].payload).toMatchObject({
      target_payload_hash: 'payloads/raw.json',
      tenant_key: 'tk_a',
    });
    const explicit = await call(app(), 'POST', RETRIES, {
      source_type: 'payload_object',
      source_id: 'ignored',
      payload_object_ref: 'payloads/explicit.json',
    });
    expect(explicit.status).toBe(202);
    expect(messagingFakes.writePayload.mock.calls[1][1]).toMatchObject({
      lane: 'critical',
      tenantKey: 'tk_x',
      criticality: 'critical',
    });
    mockAdapter.queryOne.mockClear();
    const tenantAdmin = await call(createPlatformApp([RETRY]), 'POST', RETRIES, {
      source_type: 'payload_object',
      source_id: 'payloads/raw.json',
    });
    expect(tenantAdmin.status).toBe(202);
  });

  it('answers 500 when the job cannot be created', async () => {
    arrange({
      dlq: { dlq_1: dlqRow() },
      objects: { 'dlq/tenant_key=tk_a/item.json': textObject(JSON.stringify(fanout())) },
    });
    messagingFakes.createJob.mockRejectedValue(new Error('x'));
    const res = await call(app(), 'POST', RETRIES, { source_type: 'dlq_item', source_id: 'dlq_1' });
    expect(res.status).toBe(500);
  });
});
