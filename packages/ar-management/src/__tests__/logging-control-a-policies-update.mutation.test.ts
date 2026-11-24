/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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
import { createApp, destinationRow, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const P = ADMIN_PERMISSIONS;
const BASE = '/api/admin/logging-policies';
type Body = Record<string, any>;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; headers?: Record<string, string> } = {}
) {
  const res = await createApp(perms, { platform: opts.platform ?? false }).request(
    `${BASE}${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const overrideRow = (extra: Record<string, unknown> = {}) => ({
  id: 'pol_1',
  tenant_id: 'tenant-a',
  log_type: 'diagnostic',
  plane: 'external_sink',
  destination_id: 'dest_1',
  fallback_policy_id: null,
  enabled: 1,
  managed_by: 'tenant',
  change_protection: 'approval_required',
  approval_policy_id: null,
  policy_hash: 'sha256:old',
  created_by: 'u',
  updated_by: 'u',
  created_at: 1,
  updated_at: 2,
  version: 4,
  ...extra,
});

const fallbackRow = (extra: Record<string, unknown> = {}) => ({
  id: 'fb_1',
  scope_type: 'tenant',
  scope_id: 'tenant-a',
  log_type: 'diagnostic',
  plane: 'external_sink',
  fallback_destination_id: null,
  failure_mode: 'retry_then_dlq',
  created_at: 1,
  updated_at: 2,
  version: 3,
  ...extra,
});

function world(rows: {
  override?: unknown;
  fallback?: unknown;
  destination?: unknown;
  assigned?: boolean;
  duplicate?: unknown;
}) {
  routeSql(mockAdapter, {
    one: [
      { match: /FROM logging_destination_overrides/, result: rows.override ?? null },
      { match: /SELECT id FROM logging_fallback_policies/, result: rows.duplicate ?? null },
      { match: /FROM logging_fallback_policies/, result: rows.fallback ?? null },
      {
        match: /FROM storage_destination_assignments/,
        result: rows.assigned === false ? null : { id: 'sda' },
      },
      {
        match: /FROM admin_destinations/,
        result:
          rows.destination === undefined
            ? destinationRow({ health_status: 'healthy', default_fallback_eligible: 1 })
            : rows.destination,
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
});

describe('PATCH /rows/:rowId (override update)', () => {
  const TENANT = [P.LOGGING_TENANT_OVERRIDES_UPDATE];
  const body = (extra: Record<string, unknown> = {}) => ({
    log_type: 'diagnostic',
    plane: 'external_sink',
    destination_id: 'dest_1',
    tenant_id: 'tenant-a',
    ...extra,
  });

  it('validates expected_version and If-Match', async () => {
    for (const expected_version of [0, -2, 'zz']) {
      const res = await call(TENANT, 'PATCH', '/rows/pol_1', body({ expected_version }));
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'expected_version',
          code: 'invalid_value',
          message: 'Expected version must be a positive integer.',
        },
      ]);
    }
    const header = await call(TENANT, 'PATCH', '/rows/pol_1', body(), {
      headers: { 'if-match': 'bogus' },
    });
    expect(header.body.details.fields).toEqual([
      { path: 'If-Match', code: 'invalid_value', message: 'If-Match must contain a version ETag.' },
    ]);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('404s unknown rows and keeps tenant admins to their own rows', async () => {
    world({});
    expect((await call(TENANT, 'PATCH', '/rows/pol_1', body())).status).toBe(404);
    world({ override: overrideRow({ tenant_id: null }) });
    expect((await call(TENANT, 'PATCH', '/rows/pol_1', body())).status).toBe(403);
    world({ override: overrideRow({ tenant_id: 'tenant-b' }) });
    const foreign = await call(TENANT, 'PATCH', '/rows/pol_1', body());
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('reports version conflicts from the body or If-Match', async () => {
    world({ override: overrideRow() });
    const res = await call(TENANT, 'PATCH', '/rows/pol_1', body({ expected_version: 2 }));
    expect(res.status).toBe(409);
    expect(res.body.details.conflict).toEqual({ expected_version: 2, actual_version: 4 });
    const etag = await call(TENANT, 'PATCH', '/rows/pol_1', body(), {
      headers: { 'if-match': '"v3"' },
    });
    expect(etag.body.details.conflict).toEqual({ expected_version: 3, actual_version: 4 });
  });

  it('inherits the tenant from the stored row when the body omits it', async () => {
    world({ override: overrideRow() });
    const res = await call(
      TENANT,
      'PATCH',
      '/rows/pol_1',
      body({ tenant_id: undefined, expected_version: 4 })
    );
    expect(res.status).toBe(200);
    expect(res.body.item.tenant_id).toBe('tenant-a');
    expect(res.body.item.version).toBe(5);
  });

  it('updates metadata-only changes without step-up and keeps the stored protection', async () => {
    world({ override: overrideRow() });
    const res = await call(TENANT, 'PATCH', '/rows/pol_1', body({ approval_policy_id: 'appr_9' }));
    expect(res.status).toBe(200);
    expect(stepUp).not.toHaveBeenCalled();
    expect(res.body.item).toMatchObject({
      id: 'pol_1',
      managed_by: 'tenant',
      change_protection: 'confirm',
      approval_policy_id: 'appr_9',
      enabled: 1,
      version: 5,
    });
    const [sql, p] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('UPDATE logging_destination_overrides');
    expect(p.slice(0, 10)).toEqual([
      'tenant-a',
      'diagnostic',
      'external_sink',
      'dest_1',
      null,
      1,
      'tenant',
      'confirm',
      'appr_9',
      res.body.item.policy_hash,
    ]);
    expect(p.slice(-2)).toEqual(['pol_1', 4]);
    const history = mockAdapter.execute.mock.calls[1];
    expect(String(history[0])).toContain('INSERT INTO logging_destination_override_history');
    expect(history[1][5]).toBe('dest_1');
    expect(history[1][11]).toBe('approval_required');
    expect(history[1][16]).toBe(res.body.item.policy_hash);
    expect(history[1][17]).toBe(4);
    expect(history[1][18]).toBe(5);
    expect(history[1][21]).toBe('update');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_destination_override.update',
        severity: 'info',
        before: expect.objectContaining({ enabled: true, version: 4, policy_hash: 'sha256:old' }),
        after: expect.objectContaining({ approval_policy_id: 'appr_9', version: 5 }),
      })
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['destination change', { destination_id: 'dest_2' }],
    ['fallback policy change', { fallback_policy_id: 'fb_x' }],
    ['disable', { enabled: false }],
    ['log type change', { log_type: 'webhook' }],
    ['plane change', { plane: 'archive' }],
  ])(
    'gates a %s as assignment.update with the stored tenant',
    async (_n, change: Record<string, unknown>) => {
      world({ override: overrideRow() });
      const res = await call(TENANT, 'PATCH', '/rows/pol_1', body(change));
      expect(res.status).toBe(200);
      expect(stepUp).toHaveBeenCalledTimes(1);
      expect(stepUp.mock.calls[0][1]).toMatchObject({
        operation: 'webhook.destination.update',
        targetTenantId: 'tenant-a',
        targetIds: ['pol_1'],
        params: expect.objectContaining({
          kind: 'logging.assignment.update',
          tenant_id: 'tenant-a',
        }),
      });
    }
  );

  it('gates a tenant move and targets the context tenant for platform rows', async () => {
    world({ override: overrideRow({ tenant_id: null, managed_by: 'platform' }) });
    const res = await call(
      [P.LOGGING_PLATFORM_DEFAULTS_UPDATE, P.LOGGING_TENANT_OVERRIDES_UPDATE],
      'PATCH',
      '/rows/pol_1',
      body({ tenant_id: 'tenant-a' }),
      { platform: true }
    );
    expect(res.status).toBe(200);
    expect(stepUp.mock.calls[0][1]).toMatchObject({ targetTenantId: 'tenant-a' });
    expect(stepUp.mock.calls[0][1].params.tenant_id).toBe('tenant-a');
  });

  it('returns the step-up refusal, 409 on a lost update and 500 on failure', async () => {
    world({ override: overrideRow() });
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await call(TENANT, 'PATCH', '/rows/pol_1', body({ enabled: false }))).status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const lost = await call(TENANT, 'PATCH', '/rows/pol_1', body({ approval_policy_id: 'x' }));
    expect(lost.status).toBe(409);
    expect(lost.body.details.conflict.reason).toBe('concurrent_modification');
    expect(auditWrite).not.toHaveBeenCalled();
    mockAdapter.queryOne.mockRejectedValue(new Error('db'));
    expect((await call(TENANT, 'PATCH', '/rows/pol_1', body())).status).toBe(500);
  });

  it('checks the destination and the critical-policy rules before writing', async () => {
    world({ override: overrideRow(), destination: null });
    expect((await call(TENANT, 'PATCH', '/rows/pol_1', body())).status).toBe(404);
    world({ override: overrideRow() });
    expect(
      (await call([P.LOGGING_PLATFORM_DEFAULTS_UPDATE], 'PATCH', '/rows/pol_1', body())).status
    ).toBe(403);
    world({ override: overrideRow(), assigned: false });
    expect((await call(TENANT, 'PATCH', '/rows/pol_1', body())).body.details.fields[0].code).toBe(
      'tenant_not_allowed'
    );
    world({
      override: overrideRow({ tenant_id: null, log_type: 'audit', plane: 'archive' }),
      destination: destinationRow({ health_status: 'healthy', critical_allowed: 1 }),
    });
    const critical = await call(
      [P.LOGGING_PLATFORM_DEFAULTS_UPDATE, P.LOGGING_CRITICAL_UPDATE],
      'PATCH',
      '/pol_1',
      {
        log_type: 'audit',
        plane: 'archive',
        destination_id: 'dest_1',
        confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
      },
      { platform: true }
    );
    expect(critical.status).toBe(200);
    expect(critical.body.item.managed_by).toBe('platform');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
  });
});

describe('PATCH /fallbacks/:id', () => {
  const TENANT = [P.LOGGING_TENANT_OVERRIDES_UPDATE];
  const body = (extra: Record<string, unknown> = {}) => ({
    scope_type: 'tenant',
    scope_id: 'tenant-a',
    log_type: 'diagnostic',
    plane: 'external_sink',
    failure_mode: 'retry_then_dlq',
    ...extra,
  });
  const patch = (
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    perms: string[] = TENANT,
    platform = false
  ) => call(perms, 'PATCH', '/fallbacks/fb_1', body(extra), { headers, platform });

  it('validates expected_version and If-Match', async () => {
    const bad = await patch({ expected_version: 0 });
    expect(bad.body.details.fields).toEqual([
      {
        path: 'expected_version',
        code: 'invalid_value',
        message: 'Expected version must be a positive integer.',
      },
    ]);
    const header = await patch({}, { 'if-match': 'nope' });
    expect(header.body.details.fields[0]).toMatchObject({ path: 'If-Match' });
    const both = await call(TENANT, 'PATCH', '/fallbacks/fb_1', {});
    expect(both.body.details.fields.map((f: Body) => f.path)).toEqual([
      'log_type',
      'plane',
      'failure_mode',
    ]);
  });

  it('404s unknown rows and restricts tenant admins to their own tenant fallbacks', async () => {
    world({});
    expect((await patch()).status).toBe(404);
    world({ fallback: fallbackRow({ scope_type: 'platform', scope_id: 'global' }) });
    expect((await patch()).status).toBe(403);
    world({ fallback: fallbackRow({ scope_id: 'tenant-b' }) });
    expect((await patch()).status).toBe(403);
    world({ fallback: fallbackRow() });
    expect((await patch()).status).toBe(200);
  });

  it('applies the permission rules and version checks', async () => {
    world({ fallback: fallbackRow() });
    expect((await patch({}, {}, [P.LOGGING_PLATFORM_DEFAULTS_UPDATE])).status).toBe(403);
    const conflict = await patch({ expected_version: 9 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.details.conflict).toEqual({ expected_version: 9, actual_version: 3 });
    const etag = await patch({}, { 'if-match': 'W/"v1"' });
    expect(etag.body.details.conflict).toEqual({ expected_version: 1, actual_version: 3 });
  });

  it('skips the step-up and duplicate probe when nothing changed', async () => {
    world({ fallback: fallbackRow() });
    const res = await patch({ expected_version: 3 });
    expect(res.status).toBe(200);
    expect(stepUp).not.toHaveBeenCalled();
    expect(
      mockAdapter.queryOne.mock.calls.some(([s]) =>
        String(s).startsWith('SELECT id FROM logging_fallback_policies')
      )
    ).toBe(false);
    expect(res.body.item).toMatchObject({
      id: 'fb_1',
      version: 4,
      failure_mode: 'retry_then_dlq',
      fallback_destination_id: null,
    });
    const [sql, p] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('UPDATE logging_fallback_policies');
    expect(p).toEqual([
      'tenant',
      'tenant-a',
      'diagnostic',
      'external_sink',
      null,
      'retry_then_dlq',
      res.body.item.updated_at,
      'fb_1',
      3,
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_fallback_policy.update',
        severity: 'info',
        before: expect.objectContaining({ version: 3, fallback_destination_id: null }),
        after: expect.objectContaining({ version: 4 }),
      })
    );
  });

  it.each([
    ['failure mode', { failure_mode: 'platform_default' }],
    ['plane', { plane: 'archive' }],
    ['log type', { log_type: 'webhook' }],
  ])(
    'gates a %s change and checks the key for duplicates',
    async (_n, change: Record<string, unknown>) => {
      world({ fallback: fallbackRow() });
      const res = await patch(change);
      expect(res.status).toBe(200);
      expect(stepUp.mock.calls[0][1]).toMatchObject({
        operation: 'webhook.destination.update',
        targetTenantId: 'tenant-a',
        targetIds: ['fb_1'],
        params: expect.objectContaining({ kind: 'logging.fallback.update' }),
      });
      const probe = must(
        mockAdapter.queryOne.mock.calls.find(([s]) =>
          String(s).startsWith('SELECT id FROM logging_fallback_policies')
        )
      );
      expect(probe[1]).toEqual([
        'tenant',
        'tenant-a',
        (change.log_type as string | undefined) ?? 'diagnostic',
        (change.plane as string | undefined) ?? 'external_sink',
      ]);
    }
  );

  it('reports duplicates but ignores the row itself', async () => {
    world({ fallback: fallbackRow(), duplicate: { id: 'fb_other' } });
    const dup = await patch({ failure_mode: 'platform_default' });
    expect(dup.status).toBe(409);
    expect(dup.body.details.conflict).toEqual({ reason: 'fallback_policy_exists' });
    expect(stepUp).not.toHaveBeenCalled();
    world({ fallback: fallbackRow(), duplicate: { id: 'fb_1' } });
    expect((await patch({ failure_mode: 'platform_default' })).status).toBe(200);
  });

  it('validates a fallback destination and surfaces step-up, race and database failures', async () => {
    world({
      fallback: fallbackRow(),
      destination: destinationRow({ health_status: 'healthy', default_fallback_eligible: 0 }),
    });
    const notEligible = await patch({ fallback_destination_id: 'dest_1' });
    expect(notEligible.body.details.fields[0]).toMatchObject({
      path: 'fallback_destination_id',
      code: 'fallback_not_allowed',
    });
    world({ fallback: fallbackRow(), destination: null });
    expect((await patch({ fallback_destination_id: 'dest_1' })).status).toBe(404);
    world({ fallback: fallbackRow() });
    const moved = await patch({ fallback_destination_id: 'dest_1' });
    expect(moved.status).toBe(200);
    expect(moved.body.item.fallback_destination_id).toBe('dest_1');
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await patch({ failure_mode: 'platform_default' })).status).toBe(428);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    expect((await patch({ failure_mode: 'platform_default' })).status).toBe(409);
    mockAdapter.queryOne.mockRejectedValue(new Error('db'));
    expect((await patch()).status).toBe(500);
  });

  it('audits warn severity for critical fallbacks', async () => {
    world({
      fallback: fallbackRow({
        scope_type: 'platform',
        scope_id: 'global',
        log_type: 'audit',
        plane: 'archive',
      }),
    });
    const res = await call(
      [P.LOGGING_PLATFORM_DEFAULTS_UPDATE, P.LOGGING_CRITICAL_UPDATE],
      'PATCH',
      '/fallbacks/fb_1',
      {
        scope_type: 'platform',
        log_type: 'audit',
        plane: 'archive',
        failure_mode: 'platform_default',
        confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
      },
      { platform: true }
    );
    expect(res.status).toBe(200);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
  });
});
