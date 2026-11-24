/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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
import { createApp, destinationRow, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const P = ADMIN_PERMISSIONS;

type Body = Record<string, any>;
async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  env: Record<string, unknown> = { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
) {
  const res = await createApp(perms, { platform: true }).request(
    `/api/admin/destinations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {}, ...env }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const selectDestination = (row: Record<string, unknown> | null) => {
  let notificationReads = 0;
  routeSql(mockAdapter, {
    one: [
      {
        match: /FROM internal_notification_events/,
        // First read is the dedupe check (miss), the second reads the inserted row back.
        result: () =>
          notificationReads++ === 0 ? null : { id: 'evt_existing', status: 'pending' },
      },
      { match: /FROM admin_destinations/, result: row },
    ],
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
});

describe('health-check', () => {
  const url = '/dest_1/health-check';
  const HC = P.STORAGE_DESTINATIONS_HEALTH_CHECK;

  it('accepts the test permission as an alternative and denies others', async () => {
    selectDestination(destinationRow());
    expect((await call([P.STORAGE_DESTINATIONS_TEST], 'POST', url, {})).status).toBe(200);
    const denied = await call([], 'POST', url, {});
    expect(denied.status).toBe(403);
    const tenant = await createApp([HC]).request(
      `/api/admin/destinations${url}`,
      { method: 'POST' },
      {
        DB_ADMIN: {},
      }
    );
    expect(tenant.status).toBe(403);
    expect((await tenant.json<Body>()).details.permission.reason).toBe(
      'platform_authority_required'
    );
  });

  it('returns 404 for an unknown destination and 500 when persistence fails', async () => {
    selectDestination(null);
    expect((await call([HC], 'POST', url, {})).status).toBe(404);
    selectDestination(destinationRow());
    mockAdapter.execute.mockRejectedValue(new Error('boom'));
    expect((await call([HC], 'POST', url, {})).status).toBe(500);
  });

  it('fails an inactive destination and queues a high-severity notification', async () => {
    selectDestination(destinationRow({ lifecycle_status: 'disabled', health_status: 'healthy' }));
    const res = await call([HC], 'POST', url, { check_type: 'bogus' });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      destination_id: 'dest_1',
      check_type: 'quick',
      previous_health_status: 'healthy',
      next_health_status: 'failing',
      result: 'failure',
      error_class: 'destination_not_active',
    });
    expect(res.body.item.metadata).toEqual({ provider: 'r2', destination_kind: 'object_storage' });
    const sqls = mockAdapter.execute.mock.calls.map(([s]) => String(s));
    expect(sqls[0]).toContain('INSERT INTO admin_destination_health_events');
    expect(mockAdapter.execute.mock.calls[0][1].slice(1, 7)).toEqual([
      'dest_1',
      'quick',
      'healthy',
      'failing',
      'failure',
      'destination_not_active',
    ]);
    expect(sqls[1]).toContain('UPDATE admin_destinations');
    expect(mockAdapter.execute.mock.calls[1][1][0]).toBe('failing');
    expect(sqls.some((s) => s.includes('internal_notification_events'))).toBe(true);
    const notify = must(
      mockAdapter.execute.mock.calls.find(([s]) =>
        String(s).includes('internal_notification_events')
      )
    );
    expect(JSON.stringify(notify[1])).toContain('logging.destination.health.failing');
    expect(JSON.stringify(notify[1])).toContain('"high"');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure', severity: 'warn' })
    );
  });

  it('flags invalid provider config with the validation errors', async () => {
    selectDestination(destinationRow({ provider_config: '{}' }));
    const res = await call([HC], 'POST', url, { check_type: 'deep' });
    expect(res.body.item).toMatchObject({
      check_type: 'deep',
      next_health_status: 'failing',
      error_class: 'provider_config_invalid',
    });
    expect(res.body.item.metadata.validation_errors).toEqual([
      { field: 'bindingRef', message: 'required' },
    ]);
  });

  it('reports an unavailable r2 binding as unreachable with the binding name', async () => {
    selectDestination(destinationRow());
    const res = await call([HC], 'POST', url, {}, {});
    expect(res.body.item).toMatchObject({
      next_health_status: 'unreachable',
      error_class: 'r2_binding_unavailable',
    });
    expect(res.body.item.metadata.binding_ref).toBe('AUDIT_ARCHIVE');
    const notify = must(
      mockAdapter.execute.mock.calls.find(([s]) =>
        String(s).includes('internal_notification_events')
      )
    );
    expect(JSON.stringify(notify[1])).toContain('logging.destination.health.unreachable');
  });

  it('treats a quick r2 check as healthy without writing a probe', async () => {
    selectDestination(destinationRow({ health_status: 'degraded' }));
    const put = vi.fn();
    const res = await call([HC], 'POST', url, { check_type: 'quick' }, { AUDIT_ARCHIVE: { put } });
    expect(res.body.item).toMatchObject({
      next_health_status: 'healthy',
      result: 'success',
      error_class: null,
    });
    expect(put).not.toHaveBeenCalled();
    expect(
      mockAdapter.execute.mock.calls.some(([s]) =>
        String(s).includes('internal_notification_events')
      )
    ).toBe(false);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success', severity: 'info' })
    );
  });

  it.each(['deep', 'adaptive'])(
    'writes, heads and deletes a probe object for %s checks',
    async (checkType) => {
      selectDestination(
        destinationRow({
          provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: '/ops/' }),
        })
      );
      const bucket = {
        put: vi.fn().mockResolvedValue({}),
        head: vi.fn().mockResolvedValue({ key: 'x' }),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const res = await call(
        [HC],
        'POST',
        url,
        { check_type: checkType },
        { AUDIT_ARCHIVE: bucket }
      );
      expect(res.body.item).toMatchObject({
        result: 'success',
        next_health_status: 'healthy',
        check_type: checkType,
      });
      const key = bucket.put.mock.calls[0][0] as string;
      expect(key).toMatch(/^ops\/health\/dest_1-\d+\.txt$/);
      expect(bucket.put.mock.calls[0][1]).toBe('authrim destination health check');
      expect(bucket.head).toHaveBeenCalledWith(key);
      expect(bucket.delete).toHaveBeenCalledWith(key);
    }
  );

  it('degrades when the probe cannot be read back, using the default prefix', async () => {
    selectDestination(destinationRow());
    const bucket = { put: vi.fn(), head: vi.fn().mockResolvedValue(null), delete: vi.fn() };
    const res = await call([HC], 'POST', url, { check_type: 'deep' }, { AUDIT_ARCHIVE: bucket });
    expect(res.body.item).toMatchObject({
      next_health_status: 'degraded',
      result: 'partial',
      error_class: 'r2_head_missing_after_write',
    });
    expect(res.body.item.metadata.probe_key).toMatch(/^authrim\/health\/dest_1-/);
    expect(bucket.delete).toHaveBeenCalled();
    const notify = must(
      mockAdapter.execute.mock.calls.find(([s]) =>
        String(s).includes('internal_notification_events')
      )
    );
    expect(JSON.stringify(notify[1])).toContain('"medium"');
  });

  it('degrades a deep check on a bucket without head support', async () => {
    selectDestination(destinationRow());
    const res = await call(
      [HC],
      'POST',
      url,
      { check_type: 'deep' },
      { AUDIT_ARCHIVE: { put: vi.fn() } }
    );
    expect(res.body.item.error_class).toBe('r2_head_missing_after_write');
  });

  it('validates http sink urls', async () => {
    selectDestination(
      destinationRow({
        provider: 'http',
        provider_config: JSON.stringify({ url: 'http://example.com/x' }),
      })
    );
    const bad = await call([HC], 'POST', url, {});
    expect(bad.body.item).toMatchObject({
      error_class: 'http_sink_url_invalid',
      next_health_status: 'failing',
    });
    expect(bad.body.item.metadata).toMatchObject({ url_configured: true });
    selectDestination(
      destinationRow({
        provider: 'http',
        provider_config: JSON.stringify({ url: 'https://logs.example.com/in' }),
      })
    );
    const good = await call([HC], 'POST', url, {});
    expect(good.body.item).toMatchObject({ result: 'success', next_health_status: 'healthy' });
    expect(good.body.item.metadata.url_configured).toBe(true);
  });

  it('marks other providers as not supported', async () => {
    selectDestination(
      destinationRow({
        provider: 'aws_s3',
        provider_config: JSON.stringify({ bucket: 'b', region: 'r' }),
      })
    );
    const res = await call([HC], 'POST', url, {});
    expect(res.body.item).toMatchObject({
      next_health_status: 'degraded',
      result: 'partial',
      error_class: 'provider_health_check_not_supported',
    });
  });
});

describe('enable / disable / delete details', () => {
  it('enable switches lifecycle to active with a version-conditional update', async () => {
    selectDestination(destinationRow({ lifecycle_status: 'disabled', version: 4 }));
    const res = await call([P.STORAGE_DESTINATIONS_UPDATE], 'POST', '/dest_1/enable');
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ lifecycle_status: 'active', version: 5 });
    expect(mockAdapter.execute.mock.calls[0][1]).toEqual([
      'admin-1',
      expect.any(Number),
      'dest_1',
      4,
    ]);
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      targetIds: ['dest_1'],
      params: expect.objectContaining({ kind: 'destination.enable', lifecycle_status: 'active' }),
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'storage_destination.enable' })
    );
  });

  it('enable returns the refusal or a 409 when the version moved', async () => {
    selectDestination(destinationRow());
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await call([P.STORAGE_DESTINATIONS_UPDATE], 'POST', '/dest_1/enable')).status).toBe(
      428
    );
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const lost = await call([P.STORAGE_DESTINATIONS_UPDATE], 'POST', '/dest_1/enable');
    expect(lost.status).toBe(409);
  });

  it('disable requires the force confirmation and audits critical for critical destinations', async () => {
    selectDestination(destinationRow({ critical_allowed: 1, version: 2 }));
    const denied = await call([P.STORAGE_DESTINATIONS_UPDATE], 'POST', '/dest_1/disable', {
      confirmation: 'x',
    });
    expect(denied.body.details.fields[0].message).toBe(
      'Confirmation must be "FORCE DISABLE archive".'
    );
    const ok = await call([P.STORAGE_DESTINATIONS_UPDATE], 'POST', '/dest_1/disable', {
      confirmation: 'FORCE DISABLE archive',
    });
    expect(ok.body.item).toMatchObject({ lifecycle_status: 'disabled', version: 3 });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'storage_destination.force_disable', severity: 'critical' })
    );
  });

  it('delete validates confirmation and version, then soft-deletes', async () => {
    selectDestination(destinationRow({ version: 3, critical_allowed: 0 }));
    const perm = [P.STORAGE_DESTINATIONS_DELETE];
    const bad = await call(perm, 'DELETE', '/dest_1', { confirmation: 'DELETE DESTINATION other' });
    expect(bad.body.details.fields[0].message).toBe(
      'Confirmation must be "DELETE DESTINATION archive".'
    );
    const conflict = await call(perm, 'DELETE', '/dest_1', {
      confirmation: 'DELETE DESTINATION archive',
      expected_version: 9,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.details.conflict).toEqual({ expected_version: 9, actual_version: 3 });
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    const ok = await call(perm, 'DELETE', '/dest_1', {
      confirmation: 'DELETE DESTINATION archive',
      expected_version: 3,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ id: 'dest_1', lifecycle_status: 'deleted', version: 4 });
    expect(mockAdapter.execute.mock.calls[1][0]).toContain(
      'DELETE FROM admin_destination_capabilities'
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
  });
});
