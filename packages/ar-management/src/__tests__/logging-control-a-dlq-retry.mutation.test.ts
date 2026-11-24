/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import type { Env } from '@authrim/ar-lib-core';
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

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  createApp,
  fanoutPayload,
  installMessageJobStore,
  resetAdapter,
  textObject,
} from './logging-control-a-harness';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const RETRY = 'admin:logging:delivery:retry';
const BASE = '/api/admin/logging-policies';

type Body = Record<string, any>;
let archive: {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let queueSend: ReturnType<typeof vi.fn>;
let tenantKey: string;

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB_ADMIN: {},
    OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
    AUDIT_ARCHIVE: archive,
    LOGGING_MESSAGE_QUEUE: { send: queueSend },
    LOGGING_MESSAGE_CRITICAL_QUEUE: { send: queueSend },
    LOGGING_MESSAGE_BULK_QUEUE: { send: queueSend },
    ...extra,
  } as unknown as Env;
}

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; env?: Env } = {}
) {
  const res = await createApp(perms, { platform: opts.platform ?? false }).request(
    `${BASE}${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    opts.env ?? makeEnv()
  );
  return { status: res.status, body: await res.json<Body>() };
}

const dlqRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'dlq_1',
  tenant_key: tenantKey,
  payload_type: 'delivery_fanout',
  schema_version: 1,
  lane: 'default',
  destination_id: 'dest_1',
  payload_object_ref: 'dlq/item.json',
  error_class: 'boom',
  attempt_count: 3,
  status: 'open',
  created_at: 1000,
  updated_at: 2000,
  ...overrides,
});

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  tenant_key: tenantKey,
  destination_id: 'dest_1',
  log_type: 'diagnostic',
  plane: 'diagnostic_detail',
  lane: 'default',
  status: 'failed',
  attempt_count: 1,
  error_class: 'x',
  object_catalog_id: 'obj_1',
  ...overrides,
});

const catalogRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'obj_1',
  tenant_key: tenantKey,
  log_type: 'diagnostic',
  plane: 'diagnostic_detail',
  object_key: 'logs/chunk-1.jsonl',
  object_kind: 'log_chunk',
  status: 'committed',
  record_count: '7',
  byte_count: 10,
  ...overrides,
});

function sources(rows: { dlq?: unknown; event?: unknown; catalog?: unknown }) {
  return installMessageJobStore(mockAdapter, {
    one: [
      { match: /FROM logging_dlq_items/, result: rows.dlq ?? null },
      { match: /FROM logging_delivery_events/, result: rows.event ?? null },
      { match: /FROM log_object_catalog/, result: rows.catalog ?? null },
    ],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  archive = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  queueSend = vi.fn().mockResolvedValue(undefined);
  tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
});

describe('POST /retries request validation', () => {
  it('requires the retry permission', async () => {
    const res = await call([], 'POST', '/retries', { source_type: 'dlq_item', source_id: 'dlq_1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  });

  it.each([
    [{}],
    [{ source_type: 'dlq_item' }],
    [{ source_type: 'dlq_item', source_id: '  ' }],
    [{ source_type: 'other', source_id: 'x' }],
    [{ source_id: 'x' }],
  ])('rejects %j', async (body) => {
    const res = await call([RETRY], 'POST', '/retries', body);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'source_type',
        code: 'invalid_retry_source',
        message: 'source_type must be dlq_item, delivery_event, or payload_object with source_id.',
      },
    ]);
  });
});

describe('POST /retries from a DLQ item', () => {
  const post = (
    extra: Record<string, unknown> = {},
    opts: { platform?: boolean; env?: Env } = {}
  ) =>
    call(
      [RETRY],
      'POST',
      '/retries',
      { source_type: 'dlq_item', source_id: 'dlq_1', ...extra },
      opts
    );

  it('404s an unknown item and rejects items that are not open', async () => {
    sources({});
    expect((await post()).status).toBe(404);
    sources({ dlq: dlqRow({ status: 'purged' }) });
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.details.fields[0]).toMatchObject({ path: 'status', code: 'invalid_state' });
  });

  it('refuses another tenant key', async () => {
    sources({ dlq: dlqRow({ tenant_key: 'someone-else' }) });
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.details.permission).toEqual({
      required_scope: 'current_tenant',
      reason: 'tenant_key_scope_mismatch',
    });
  });

  it('reports an unreadable, oversized, malformed or unsupported payload object', async () => {
    sources({ dlq: dlqRow() });
    const missing = await post();
    expect(missing.body.details.fields[0]).toEqual({
      path: 'payload_object_ref',
      code: 'payload_object_not_found',
      message: 'Retry payload object cannot be read.',
    });
    expect(archive.get).toHaveBeenCalledWith('dlq/item.json');

    archive.get.mockResolvedValue({ size: 2 * 1024 * 1024, text: vi.fn() });
    const big = await post();
    expect(big.body.details.fields[0]).toMatchObject({ code: 'payload_object_too_large' });

    archive.get.mockResolvedValue(textObject('{not json'));
    const bad = await post();
    expect(bad.body.details.fields[0]).toMatchObject({ code: 'payload_object_malformed_json' });

    archive.get.mockResolvedValue(textObject(JSON.stringify({ hello: 'world' })));
    const unsupported = await post();
    expect(unsupported.body.details.fields[0]).toMatchObject({ code: 'unsupported_retry_payload' });
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('treats a missing bucket binding like an unreadable object', async () => {
    sources({ dlq: dlqRow() });
    const res = await post({}, { env: makeEnv({ AUDIT_ARCHIVE: undefined }) });
    expect(res.status).toBe(400);
    expect(res.body.details.fields[0].code).toBe('payload_object_not_found');
  });

  it('enqueues a standard retry with defaults, reading nested body/bodyJson payloads', async () => {
    sources({ dlq: dlqRow() });
    const payload = fanoutPayload(tenantKey);
    const wrappers: unknown[] = [payload, { body: payload }, { bodyJson: JSON.stringify(payload) }];
    for (const wrapper of wrappers) {
      queueSend.mockClear();
      archive.get.mockResolvedValue(textObject(JSON.stringify(wrapper)));
      const res = await post({ reason: ' manual ' });
      expect(res.status).toBe(202);
      expect(res.body.result).toMatchObject({
        kind: 'retry_delivery',
        status: 'queued',
        lane: 'default',
        criticality: 'standard',
        tenant_key: tenantKey,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        queued: true,
        queue_binding: 'LOGGING_MESSAGE_QUEUE',
      });
      expect(res.body.result.polling.job).toBe(`${BASE}/message-jobs/${res.body.result.id}`);
      expect(res.body.audit_id).toBe('audit_1');
      expect(queueSend).toHaveBeenCalledTimes(1);
      expect(queueSend.mock.calls[0][0]).toMatchObject({
        payload_type: 'retry_delivery',
        source_id: 'dlq_1',
        reason: 'manual',
        requested_by: 'admin-1',
        target_payload_hash: 'dlq/item.json',
        idempotency_key: 'retry_delivery:dlq_item:dlq_1:dlq/item.json',
        replay_payload: payload,
      });
    }
  });

  it('stores the job with default priority, attempts and dedupe window', async () => {
    const store = sources({ dlq: dlqRow() });
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    const before = Date.now();
    const res = await post();
    expect(res.status).toBe(202);
    const job = store.inserts[0];
    expect(job).toMatchObject({
      kind: 'retry_delivery',
      lane: 'default',
      criticality: 'standard',
      priority: 10,
      scope_type: 'tenant',
      scope_id: tenantKey,
      scope_key: `tenant:${tenantKey}`,
      source_type: 'dlq_item',
      source_id: 'dlq_1',
      max_attempts: 5,
      requested_by: 'admin-1',
      reason: null,
      payload_type: 'retry_delivery',
    });
    expect(JSON.parse(job.attempt_policy_json as string)).toEqual({
      maxAttempts: 5,
      leaseTimeoutMs: 300000,
    });
    expect(Number(job.dedupe_until) - Number(job.created_at)).toBe(24 * 60 * 60 * 1000);
    expect(job.not_before).toBe(job.created_at);
    expect(Number(job.created_at)).toBeGreaterThanOrEqual(before);
    expect(archive.put).toHaveBeenCalledTimes(1);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.delivery.retry',
        severity: 'info',
        metadata: expect.objectContaining({ criticality: 'standard', queued: true }),
      })
    );
  });

  it('honours optional scheduling fields and a bulk lane', async () => {
    const store = sources({ dlq: dlqRow({ lane: 'bulk' }) });
    archive.get.mockResolvedValue(
      textObject(JSON.stringify(fanoutPayload(tenantKey, { lane: 'bulk' })))
    );
    const res = await post({
      idempotency_key: 'idem-1',
      not_before: 5000,
      dedupe_until: 9000,
      max_attempts: 2,
      lease_timeout_ms: 1234,
      payload_object_ref: 'ignored/for/dlq.json',
    });
    expect(res.status).toBe(202);
    expect(res.body.result.queue_binding).toBe('LOGGING_MESSAGE_BULK_QUEUE');
    expect(store.inserts[0]).toMatchObject({
      lane: 'bulk',
      priority: 0,
      idempotency_key: 'idem-1',
      not_before: 5000,
      dedupe_until: 9000,
      max_attempts: 2,
    });
    expect(JSON.parse(store.inserts[0].attempt_policy_json as string)).toEqual({
      maxAttempts: 2,
      leaseTimeoutMs: 1234,
    });
    expect(queueSend.mock.calls[0][0].idempotency_key).toBe('idem-1');
  });

  it('ignores invalid numeric options', async () => {
    const store = sources({ dlq: dlqRow() });
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    await post({ max_attempts: 0, lease_timeout_ms: 'abc', not_before: '5', dedupe_until: null });
    expect(store.inserts[0]).toMatchObject({ max_attempts: 5 });
    expect(Number(store.inserts[0].dedupe_until) - Number(store.inserts[0].created_at)).toBe(
      24 * 60 * 60 * 1000
    );
  });

  it('keeps critical retries to platform administrators', async () => {
    sources({ dlq: dlqRow({ lane: 'critical' }) });
    archive.get.mockResolvedValue(
      textObject(JSON.stringify(fanoutPayload(tenantKey, { lane: 'critical' })))
    );
    const tenant = await post();
    expect(tenant.status).toBe(403);
    expect(tenant.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'critical_logging_retry_requires_platform_admin',
    });
    const platform = await post({}, { platform: true });
    expect(platform.status).toBe(202);
    expect(platform.body.result).toMatchObject({
      criticality: 'critical',
      queue_binding: 'LOGGING_MESSAGE_CRITICAL_QUEUE',
    });
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
  });

  it.each(['security', 'admin_audit'])('treats %s log types as critical', async (logType) => {
    sources({ dlq: dlqRow() });
    archive.get.mockResolvedValue(
      textObject(JSON.stringify(fanoutPayload(tenantKey, { log_type: logType })))
    );
    expect((await post()).status).toBe(403);
  });

  it('reports a missing payload bucket after the source resolved, and 500 on store failure', async () => {
    sources({ dlq: dlqRow() });
    let reads = 0;
    const flaky = {
      get: vi.fn(async () =>
        reads++ === 0 ? textObject(JSON.stringify(fanoutPayload(tenantKey))) : null
      ),
      put: vi.fn(),
    };
    // First resolve works via the archive, then the payload bucket accessor is the same binding.
    const ok = await post({}, { env: makeEnv({ AUDIT_ARCHIVE: flaky }) });
    expect(ok.status).toBe(202);

    sources({ dlq: dlqRow() });
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    archive.put.mockRejectedValue(new Error('r2 down'));
    const failed = await post();
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('POST /retries from a delivery event', () => {
  const post = (extra: Record<string, unknown> = {}, opts: { platform?: boolean } = {}) =>
    call(
      [RETRY],
      'POST',
      '/retries',
      { source_type: 'delivery_event', source_id: 'evt_1', ...extra },
      opts
    );

  it('404s an unknown event and enforces tenant scope', async () => {
    sources({});
    expect((await post()).status).toBe(404);
    sources({ event: eventRow({ tenant_key: 'other' }) });
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
  });

  it('requires a destination and a catalog object', async () => {
    for (const row of [eventRow({ destination_id: null }), eventRow({ object_catalog_id: null })]) {
      sources({ event: row });
      const res = await post();
      expect(res.status).toBe(400);
      expect(res.body.details.fields[0]).toEqual({
        path: 'source_id',
        code: 'delivery_event_not_replayable',
        message: 'Delivery event must reference a destination and catalog object to be retried.',
      });
    }
  });

  it('requires a committed catalog object', async () => {
    for (const catalog of [null, catalogRow({ status: 'staged' })]) {
      sources({ event: eventRow(), catalog });
      const res = await post();
      expect(res.status).toBe(400);
      expect(res.body.details.fields[0]).toMatchObject({
        path: 'source_id',
        code: 'catalog_object_not_replayable',
      });
    }
  });

  it('builds a delivery_fanout replay payload from the catalog', async () => {
    sources({ event: eventRow({ lane: 'weird' }), catalog: catalogRow() });
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body.result.lane).toBe('default');
    const message = queueSend.mock.calls[0][0];
    expect(message.replay_payload).toMatchObject({
      payload_type: 'delivery_fanout',
      schema_version: 1,
      tenant_key: tenantKey,
      lane: 'default',
      catalog_id: 'obj_1',
      object_key: 'logs/chunk-1.jsonl',
      destination_id: 'dest_1',
      log_type: 'diagnostic',
      plane: 'diagnostic_detail',
      record_count: 7,
    });
    expect(message.replay_payload.payload_id).toMatch(/^qpl_/);
    expect(message.target_payload_hash).toBe('logs/chunk-1.jsonl');
    expect(message.idempotency_key).toBe('retry_delivery:delivery_event:evt_1:logs/chunk-1.jsonl');
  });

  it('is critical for a critical lane event', async () => {
    sources({ event: eventRow({ lane: 'critical' }), catalog: catalogRow() });
    expect((await post()).status).toBe(403);
    expect((await post({}, { platform: true })).status).toBe(202);
  });
});

describe('POST /retries from a payload object', () => {
  const post = (
    extra: Record<string, unknown> = {},
    opts: { platform?: boolean; env?: Env } = {}
  ) =>
    call(
      [RETRY],
      'POST',
      '/retries',
      { source_type: 'payload_object', source_id: 'obj/ref.json', ...extra },
      opts
    );

  it('requires platform authority', async () => {
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'payload_object_retry_requires_platform_admin',
    });
    expect(archive.get).not.toHaveBeenCalled();
  });

  it('maps each payload read failure to a field error', async () => {
    sources({});
    const platform = { platform: true };
    const noBucket = await post({}, { platform: true, env: makeEnv({ AUDIT_ARCHIVE: undefined }) });
    expect(noBucket.body.details.fields[0]).toEqual({
      path: 'payload_object_ref',
      code: 'payload_bucket_unavailable',
      message: 'Retry payload object cannot be read.',
    });
    const missing = await post({}, platform);
    expect(missing.body.details.fields[0].code).toBe('payload_object_not_found');
    expect(archive.get).toHaveBeenCalledWith('obj/ref.json');
    archive.get.mockResolvedValue({ size: 5 * 1024 * 1024, text: vi.fn() });
    expect((await post({}, platform)).body.details.fields[0].code).toBe('payload_object_too_large');
    archive.get.mockResolvedValue(textObject('nope'));
    expect((await post({}, platform)).body.details.fields[0].code).toBe(
      'payload_object_malformed_json'
    );
    archive.get.mockResolvedValue(textObject('{"a":1}'));
    expect((await post({}, platform)).body.details.fields[0]).toMatchObject({
      code: 'unsupported_retry_payload',
    });
  });

  it('prefers payload_object_ref over source_id and enqueues', async () => {
    sources({});
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    const res = await post({ payload_object_ref: 'explicit/ref.json' }, { platform: true });
    expect(res.status).toBe(202);
    expect(archive.get).toHaveBeenCalledWith('explicit/ref.json');
    expect(queueSend.mock.calls[0][0].target_payload_hash).toBe('explicit/ref.json');
  });

  it('falls back to source_id when payload_object_ref is blank', async () => {
    sources({});
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    await post({ payload_object_ref: '   ' }, { platform: true });
    expect(archive.get).toHaveBeenCalledWith('obj/ref.json');
  });
});

describe('DLQ replay convenience routes', () => {
  it('require the retry permission and both aliases enqueue', async () => {
    expect((await call([], 'POST', '/dlq/dlq_1/replay')).status).toBe(403);
    sources({ dlq: dlqRow() });
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    for (const path of ['/dlq/dlq_1/replay', '/dlq-items/dlq_1/replay']) {
      const res = await call([RETRY], 'POST', path);
      expect(res.status).toBe(202);
    }
    expect(queueSend.mock.calls[0][0].reason).toBe(
      'dlq replay requested from convenience endpoint'
    );
  });

  it('returns the source failure and converts exceptions into 500', async () => {
    sources({});
    expect((await call([RETRY], 'POST', '/dlq/missing/replay')).status).toBe(404);
    mockAdapter.queryOne.mockRejectedValue(new Error('db'));
    expect((await call([RETRY], 'POST', '/dlq/dlq_1/replay')).status).toBe(500);
  });

  it('reports the missing message payload bucket when the DLQ bucket is the only one', async () => {
    sources({ dlq: dlqRow({ lane: 'bulk' }) });
    // Source resolution needs AUDIT_ARCHIVE too, so a missing bucket surfaces as unreadable payload.
    const res = await call([RETRY], 'POST', '/dlq/dlq_1/replay', undefined, {
      env: makeEnv({ AUDIT_ARCHIVE: undefined }),
    });
    expect(res.status).toBe(400);
  });
});
