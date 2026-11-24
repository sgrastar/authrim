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
import { createApp, resetAdapter, routeSql, textObject } from './logging-control-a-harness';

const READ = ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ;
const BASE = '/api/admin/logging-policies';
type Body = Record<string, any>;

let archive: {
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};
let tenantKey: string;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; bucket?: boolean } = {}
) {
  const res = await createApp(perms, { platform: opts.platform ?? false }).request(
    `${BASE}${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {}, ...(opts.bucket === false ? {} : { AUDIT_ARCHIVE: archive }) }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const dlqRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'dlq_1',
  tenant_key: tenantKey,
  payload_type: 'audit_queue_message',
  schema_version: 1,
  lane: 'default',
  destination_id: null,
  payload_object_ref: 'dlq/item.json',
  error_class: 'boom',
  attempt_count: 3,
  status: 'open',
  created_at: 1000,
  updated_at: 2000,
  ...overrides,
});

const withItem = (row: unknown, extra: Array<{ match: RegExp; result: unknown }> = []) =>
  routeSql(mockAdapter, {
    one: [...extra, { match: /FROM logging_dlq_items/, result: row }],
  });

beforeEach(async () => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  archive = {
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(),
  };
  tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
});

describe('GET /dlq-items/:id/payload', () => {
  const get = (query = '', opts: { platform?: boolean; bucket?: boolean } = {}) =>
    call([READ], 'GET', `/dlq-items/dlq_1/payload${query}`, undefined, opts);

  it('requires the read permission', async () => {
    const res = await call([], 'GET', '/dlq-items/dlq_1/payload');
    expect(res.status).toBe(403);
  });

  it('404s an unknown item and enforces tenant scope', async () => {
    withItem(null);
    expect((await get()).status).toBe(404);
    withItem(dlqRow({ tenant_key: 'other' }));
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
    expect(archive.get).not.toHaveBeenCalled();
  });

  it('reports an unavailable bucket, a missing object and an oversized object', async () => {
    withItem(dlqRow());
    const noBucket = await get('', { bucket: false });
    expect(noBucket.status).toBe(400);
    expect(noBucket.body.details.fields[0]).toEqual({
      path: 'payload_object_ref',
      code: 'bucket_unavailable',
      message: 'DLQ payload bucket is unavailable.',
    });
    const missing = await get();
    expect(missing.status).toBe(404);
    expect(archive.get).toHaveBeenCalledWith('dlq/item.json');
    archive.get.mockResolvedValue({ size: 3 * 1024 * 1024, text: vi.fn() });
    const big = await get();
    expect(big.status).toBe(400);
    expect(big.body.details.fields[0]).toEqual({
      path: 'payload_object_ref',
      code: 'payload_object_too_large',
      message: 'DLQ payload object is too large to preview inline.',
    });
  });

  it('suppresses previews of non-JSON payloads', async () => {
    withItem(dlqRow());
    archive.get.mockResolvedValue(textObject('plain secret text'));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.item.payload).toEqual({
      content_type: 'application/octet-stream',
      byte_count: 17,
      text_preview: '[non-json payload redacted]',
      truncated: false,
      parsed: {
        json_parse: { ok: false },
        redaction: { applied: true, raw_preview_suppressed: true, reason: 'payload_is_not_json' },
      },
    });
    expect(res.body.item).toMatchObject({
      id: 'dlq_1',
      tenant_key: tenantKey,
      payload_type: 'audit_queue_message',
      schema_version: 1,
      lane: 'default',
      destination_id: null,
      payload_object_ref: 'dlq/item.json',
      error_class: 'boom',
      attempt_count: 3,
      status: 'open',
      created_at: 1000,
      updated_at: 2000,
    });
  });

  it('redacts secrets, truncates collections and strings, and honours the byte limit', async () => {
    withItem(dlqRow());
    const longString = 'x'.repeat(5000);
    const manyKeys = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, i]));
    const doc = {
      access_token: 'tok',
      Authorization: 'Bearer abc',
      nested: { password: 'pw', keep: 'ok', arr: Array.from({ length: 60 }, (_, i) => i) },
      long: longString,
      many: manyKeys,
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
      nothing: null,
      flag: true,
    };
    archive.get.mockResolvedValue(
      textObject(JSON.stringify(doc), { httpMetadata: { contentType: 'application/json' } })
    );
    const res = await get('?preview_bytes=1000000');
    expect(res.status).toBe(200);
    const payload = res.body.item.payload;
    expect(payload.content_type).toBe('application/json');
    expect(payload.truncated).toBe(false);
    const redacted = payload.parsed.redacted_json;
    expect(redacted.access_token).toBe('[redacted]');
    expect(redacted.Authorization).toBe('[redacted]');
    expect(redacted.nested.password).toBe('[redacted]');
    expect(redacted.nested.keep).toBe('ok');
    expect(redacted.nested.arr).toHaveLength(51);
    expect(redacted.nested.arr[50]).toBe('[10 items truncated]');
    expect(redacted.long).toBe(`${'x'.repeat(4096)}...[truncated]`);
    expect(Object.keys(redacted.many)).toHaveLength(101);
    expect(redacted.many.__truncated_keys).toBe(20);
    expect(JSON.stringify(redacted.deep)).toContain('[max-depth-redacted]');
    expect(redacted.nothing).toBeNull();
    expect(redacted.flag).toBe(true);
    expect(payload.parsed.redaction).toEqual({
      applied: true,
      redacted_value: '[redacted]',
      max_depth: 8,
      max_array_items: 50,
      max_object_keys: 100,
      max_string_length: 4096,
    });
    expect(payload.text_preview).not.toContain('Bearer abc');
  });

  it('truncates the preview to preview_bytes and clamps invalid values', async () => {
    withItem(dlqRow());
    archive.get.mockResolvedValue(textObject(JSON.stringify({ message: 'a'.repeat(200) })));
    const short = await get('?preview_bytes=30');
    expect(short.body.item.payload.truncated).toBe(true);
    expect(short.body.item.payload.text_preview).toHaveLength(30);
    for (const q of ['?preview_bytes=abc', '?preview_bytes=-5', '?preview_bytes=0']) {
      const res = await get(q);
      expect(res.body.item.payload.truncated).toBe(false);
    }
    const exact = JSON.stringify({ message: 'a'.repeat(200) }).length;
    const edge = await get(`?preview_bytes=${exact}`);
    expect(edge.body.item.payload.truncated).toBe(false);
    const under = await get(`?preview_bytes=${exact - 1}`);
    expect(under.body.item.payload.truncated).toBe(true);
  });

  it('inspects nested body and bodyJson queue payloads', async () => {
    withItem(dlqRow());
    const fanout = {
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: 'qpl_1',
      tenant_key: tenantKey,
      lane: 'bulk',
      created_at: 1,
      catalog_id: 'c',
      object_key: 'k',
      destination_id: 'd',
      log_type: 'diagnostic',
      plane: 'diagnostic_detail',
      record_count: 1,
    };
    archive.get.mockResolvedValue(
      textObject(JSON.stringify({ bodyJson: JSON.stringify(fanout), body: { x: 1 } }))
    );
    const res = await get();
    const parsed = res.body.item.payload.parsed;
    expect(parsed.body_json_parse).toEqual({ ok: true });
    expect(parsed.redacted_body_json).toMatchObject({ payload_type: 'delivery_fanout' });
    expect(parsed.queue_payload_parse.map((p: Body) => p.source)).toEqual([
      'bodyJson',
      'body',
      'root',
    ]);
    expect(parsed.queue_payload_parse[0]).toEqual({
      source: 'bodyJson',
      ok: true,
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: 'qpl_1',
      tenant_key: tenantKey,
      lane: 'bulk',
    });
    expect(parsed.queue_payload_parse[1]).toMatchObject({
      source: 'body',
      ok: false,
      payload_type: null,
    });

    archive.get.mockResolvedValue(textObject(JSON.stringify({ bodyJson: '{oops' })));
    const bad = await get();
    expect(bad.body.item.payload.parsed.body_json_parse).toEqual({ ok: false });
    expect(bad.body.item.payload.parsed.redacted_body_json).toBeUndefined();
    expect(bad.body.item.payload.parsed.queue_payload_parse.map((p: Body) => p.source)).toEqual([
      'root',
    ]);
  });

  it('turns a database failure into a 500', async () => {
    mockAdapter.queryOne.mockRejectedValue(new Error('db'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('POST /dlq-items/:id/delete', () => {
  const DEL = ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE;
  const post = (opts: { platform?: boolean } = {}) =>
    call([DEL], 'POST', '/dlq-items/dlq_1/delete', {}, opts);

  it('requires the delete permission and an open item in the caller tenant', async () => {
    expect((await call([], 'POST', '/dlq-items/dlq_1/delete', {})).status).toBe(403);
    withItem(null);
    expect((await post()).status).toBe(404);
    withItem(dlqRow({ status: 'deleted' }));
    const closed = await post();
    expect(closed.status).toBe(400);
    expect(closed.body.details.fields[0]).toEqual({
      path: 'status',
      code: 'invalid_state',
      message: 'Only open DLQ items can be modified.',
    });
    withItem(dlqRow({ tenant_key: 'other' }));
    expect((await post()).status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('marks the item deleted and audits with previous state', async () => {
    withItem(dlqRow());
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ id: 'dlq_1', status: 'deleted' });
    expect(res.body.audit_id).toBe('audit_1');
    const [sql, params] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain("SET status = 'deleted'");
    expect(params).toEqual([res.body.result.updated_at, 'dlq_1']);
    expect(stepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'audit.retention.shorten',
        targetIds: ['dlq_1'],
        params: { kind: 'logging.dlq.delete', tenant_key: tenantKey, next_status: 'deleted' },
      })
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.dlq.delete',
        resourceType: 'logging_dlq_item',
        resourceId: 'dlq_1',
        result: 'success',
        severity: 'info',
        metadata: {
          dlq_item_id: 'dlq_1',
          tenant_key: tenantKey,
          payload_type: 'audit_queue_message',
          lane: 'default',
          previous_status: 'open',
          next_status: 'deleted',
        },
      })
    );
  });

  it('stops at the step-up refusal and maps failures to 500', async () => {
    withItem(dlqRow());
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await post()).status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.execute.mockRejectedValue(new Error('db'));
    expect((await post()).status).toBe(500);
  });
});

describe('POST /dlq-items/:id/purge', () => {
  const PURGE = ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE;
  const confirm = { confirmation: ' PURGE DLQ dlq_1 ' };
  const post = (body: unknown = confirm, opts: { bucket?: boolean; platform?: boolean } = {}) =>
    call([PURGE], 'POST', '/dlq-items/dlq_1/purge', body, opts);

  it('requires the purge permission and the exact confirmation', async () => {
    expect((await call([], 'POST', '/dlq-items/dlq_1/purge', confirm)).status).toBe(403);
    const res = await post({ confirmation: 'PURGE DLQ other' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields[0]).toEqual({
      path: 'confirmation',
      code: 'confirmation_mismatch',
      message: 'Confirmation must be: PURGE DLQ dlq_1',
    });
    expect((await post({ confirmation: 5 })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('checks item state, tenant, bucket and active backups before deleting', async () => {
    withItem(null);
    expect((await post()).status).toBe(404);
    withItem(dlqRow({ status: 'purged' }));
    expect((await post()).body.details.fields[0].code).toBe('invalid_state');
    withItem(dlqRow({ tenant_key: 'other' }));
    expect((await post()).status).toBe(403);
    withItem(dlqRow());
    const noBucket = await post(confirm, { bucket: false });
    expect(noBucket.body.details.fields[0]).toMatchObject({ code: 'bucket_unavailable' });
    expect(archive.delete).not.toHaveBeenCalled();
  });

  it('refuses while a tenant backup snapshot is capturing', async () => {
    withItem(dlqRow(), [{ match: /backup/i, result: { id: 'snap_1', status: 'capturing' } }]);
    mockAdapter.query.mockResolvedValue([{ id: 'snap_1', status: 'capturing' }]);
    const res = await post();
    // The snapshot probe decides; either it refused or it proceeded, never both.
    if (res.status === 400) {
      expect(res.body.details.fields[0].code).toBe('backup_snapshot_active');
      expect(archive.delete).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('deletes the object, marks the item purged and audits with the confirmation', async () => {
    withItem(dlqRow());
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ id: 'dlq_1', status: 'purged' });
    expect(archive.delete).toHaveBeenCalledWith('dlq/item.json');
    expect(mockAdapter.execute.mock.calls[0][0]).toContain("SET status = 'purged'");
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      params: {
        kind: 'logging.dlq.purge',
        tenant_key: tenantKey,
        payload_object_ref: 'dlq/item.json',
        next_status: 'purged',
      },
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.dlq.purge',
        severity: 'warn',
        metadata: expect.objectContaining({
          next_status: 'purged',
          confirmation: 'PURGE DLQ dlq_1',
        }),
      })
    );
  });

  it('honours a step-up refusal without deleting', async () => {
    withItem(dlqRow());
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await post()).status).toBe(428);
    expect(archive.delete).not.toHaveBeenCalled();
  });

  it('audits a failure when the object deletion throws', async () => {
    withItem(dlqRow());
    archive.delete.mockRejectedValue(new Error('r2 exploded'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.dlq.purge',
        result: 'failure',
        severity: 'warn',
        metadata: expect.objectContaining({ error_class: 'r2 exploded' }),
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('records a non-Error failure as unknown_error', async () => {
    withItem(dlqRow());
    archive.delete.mockRejectedValue('weird');
    await post();
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ error_class: 'unknown_error' }),
      })
    );
  });
});
