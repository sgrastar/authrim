/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  createApp,
  fanoutPayload,
  installMessageJobStore,
  resetAdapter,
  textObject,
} from './logging-control-a-harness';
import { must } from './helpers/must';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const RETRY = 'admin:logging:delivery:retry';
const EVENTS_READ = ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ;
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

describe('DLQ bulk replay', () => {
  const BULK = '/dlq/bulk-replay';

  it('previews open items with normalized filters and clamps the limit', async () => {
    mockAdapter.query.mockResolvedValue([dlqRow(), dlqRow({ id: 'dlq_2' })]);
    const res = await call([EVENTS_READ], 'POST', `${BULK}/preview`, {
      lane: 'critical',
      destination_id: ' dest_9 ',
      payload_type: 'delivery_fanout',
      limit: 5000,
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      item_count: 2,
      filters: {
        tenant_key: tenantKey,
        lane: 'critical',
        destination_id: 'dest_9',
        payload_type: 'delivery_fanout',
        limit: 100,
      },
    });
    const [sql, params] = mockAdapter.query.mock.calls[0];
    expect(sql).toContain(
      'status = ? AND tenant_key = ? AND lane = ? AND destination_id = ? AND payload_type = ?'
    );
    expect(params).toEqual(['open', tenantKey, 'critical', 'dest_9', 'delivery_fanout', 100]);
  });

  it('defaults the limit to 25 and ignores non-integer limits', async () => {
    for (const limit of [undefined, 1.5, -1, 'x']) {
      mockAdapter.query.mockClear();
      const res = await call(
        [EVENTS_READ],
        'POST',
        `${BULK}/preview`,
        limit === undefined ? {} : { limit }
      );
      expect(res.body.item.filters.limit).toBe(25);
      expect(res.body.item.filters.lane).toBeNull();
      expect(res.body.item.filters.destination_id).toBeNull();
    }
  });

  it('rejects unsupported lanes and foreign tenant filters, and requires the read permission', async () => {
    const lane = await call([EVENTS_READ], 'POST', `${BULK}/preview`, { lane: 'turbo' });
    expect(lane.status).toBe(400);
    expect(lane.body.details.fields).toEqual([
      { path: 'lane', code: 'invalid_lane', message: 'Unsupported delivery lane.' },
    ]);
    const foreign = await call([EVENTS_READ], 'POST', `${BULK}/preview`, { tenant_key: 'other' });
    expect(foreign.status).toBe(403);
    expect((await call([], 'POST', `${BULK}/preview`, {})).status).toBe(403);
    mockAdapter.query.mockRejectedValue(new Error('db'));
    expect((await call([EVENTS_READ], 'POST', `${BULK}/preview`, {})).status).toBe(500);
  });

  it('platform admins may filter by tenant_id or tenant_key', async () => {
    const byId = await call(
      [EVENTS_READ],
      'POST',
      `${BULK}/preview`,
      { tenant_id: 'tenant-a' },
      { platform: true }
    );
    expect(byId.body.item.filters.tenant_key).toBe(tenantKey);
    const byKey = await call(
      [EVENTS_READ],
      'POST',
      `${BULK}/preview`,
      { tenant_key: 'raw-key' },
      { platform: true }
    );
    expect(byKey.body.item.filters.tenant_key).toBe('raw-key');
    const mismatch = await call(
      [EVENTS_READ],
      'POST',
      `${BULK}/preview`,
      { tenant_id: 'tenant-a', tenant_key: 'raw-key' },
      { platform: true }
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.details.fields[0]).toEqual({
      path: 'tenant_id',
      code: 'tenant_key_mismatch',
      message: 'tenant_id and tenant_key do not refer to the same tenant.',
    });
    const all = await call([EVENTS_READ], 'POST', `${BULK}/preview`, {}, { platform: true });
    expect(all.body.item.filters.tenant_key).toBeNull();
    expect(must(mockAdapter.query.mock.calls.at(-1))[0]).not.toContain('tenant_key = ?');
  });

  it('tenant admins may not name another tenant_id', async () => {
    const res = await call([EVENTS_READ], 'POST', `${BULK}/preview`, { tenant_id: 'tenant-b' });
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_id_scope_mismatch');
    const own = await call([EVENTS_READ], 'POST', `${BULK}/preview`, {
      tenant_id: 'tenant-a',
      tenant_key: tenantKey,
    });
    expect(own.status).toBe(200);
  });

  it('applies replay per item and aggregates results (202 on partial success)', async () => {
    const good = dlqRow({ id: 'dlq_ok', payload_object_ref: 'dlq/ok.json' });
    const bad = dlqRow({ id: 'dlq_bad', status: 'purged' });
    installMessageJobStore(mockAdapter, {
      one: [
        {
          match: /FROM logging_dlq_items/,
          result: (_s: string, p: unknown[]) => ((p[0] as string) === 'dlq_ok' ? good : bad),
        },
      ],
      many: [{ match: /FROM logging_dlq_items/, result: [good, bad] }],
    });
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    const res = await call([RETRY], 'POST', `${BULK}/apply`, { reason: ' because ', limit: 500 });
    expect(res.status).toBe(202);
    expect(res.body.result).toMatchObject({
      requested_count: 2,
      applied_count: 1,
      failed_count: 1,
    });
    expect(res.body.result.applied[0]).toMatchObject({ dlq_item_id: 'dlq_ok' });
    expect(res.body.result.failed).toEqual([
      { dlq_item_id: 'dlq_bad', status: 400, error: expect.any(String) },
    ]);
    expect(mockAdapter.query.mock.calls[0][1].at(-1)).toBe(50);
    expect(queueSend.mock.calls[0][0].reason).toBe('because');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.delivery.bulk_retry',
        result: 'failure',
        severity: 'warn',
        metadata: expect.objectContaining({
          requested_count: 2,
          applied_count: 1,
          failed_count: 1,
        }),
      })
    );
  });

  it('uses the default reason for bulk replays', async () => {
    const good = dlqRow();
    installMessageJobStore(mockAdapter, {
      one: [{ match: /FROM logging_dlq_items/, result: good }],
      many: [{ match: /FROM logging_dlq_items/, result: [good] }],
    });
    archive.get.mockResolvedValue(textObject(JSON.stringify(fanoutPayload(tenantKey))));
    const res = await call([RETRY], 'POST', `${BULK}/apply`, {});
    expect(res.status).toBe(202);
    expect(queueSend.mock.calls[0][0].reason).toBe('bulk DLQ replay requested');
    expect(mockAdapter.query.mock.calls[0][1].at(-1)).toBe(10);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success', severity: 'info' })
    );
  });

  it('answers 409 when every item failed, 202 when none matched, and validates input', async () => {
    installMessageJobStore(mockAdapter, {
      many: [{ match: /FROM logging_dlq_items/, result: [dlqRow({ id: 'a', status: 'purged' })] }],
      one: [{ match: /FROM logging_dlq_items/, result: dlqRow({ id: 'a', status: 'purged' }) }],
    });
    const allFailed = await call([RETRY], 'POST', `${BULK}/apply`, {});
    expect(allFailed.status).toBe(409);
    expect(allFailed.body.result).toMatchObject({ applied_count: 0, failed_count: 1 });

    installMessageJobStore(mockAdapter, {});
    const none = await call([RETRY], 'POST', `${BULK}/apply`, { limit: 3 });
    expect(none.status).toBe(202);
    expect(none.body.result).toMatchObject({ requested_count: 0, applied: [], failed: [] });
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success', severity: 'info' })
    );
    expect(must(mockAdapter.query.mock.calls.at(-1))[1].at(-1)).toBe(3);

    expect((await call([], 'POST', `${BULK}/apply`, {})).status).toBe(403);
    expect((await call([RETRY], 'POST', `${BULK}/apply`, { lane: 'x' })).status).toBe(400);
    expect((await call([RETRY], 'POST', `${BULK}/apply`, { tenant_key: 'x' })).status).toBe(403);
    mockAdapter.query.mockRejectedValue(new Error('db'));
    expect((await call([RETRY], 'POST', `${BULK}/apply`, {})).status).toBe(500);
  });
});
