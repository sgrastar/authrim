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

const P = ADMIN_PERMISSIONS;
const BASE = '/api/admin/logging-policies';
type Body = Record<string, any>;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; tenantId?: string } = {}
) {
  const res = await createApp(perms, {
    platform: opts.platform ?? false,
    tenantId: opts.tenantId,
  }).request(
    `${BASE}${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>(), headers: res.headers };
}

/** Destination lookups and the storage assignment probe. */
function world(
  destination: Record<string, unknown> | null,
  opts: { assigned?: boolean; existingFallback?: unknown } = {}
) {
  routeSql(mockAdapter, {
    one: [
      {
        match: /FROM storage_destination_assignments/,
        result: opts.assigned === false ? null : { id: 'sda_1' },
      },
      { match: /FROM logging_fallback_policies/, result: opts.existingFallback ?? null },
      { match: /FROM admin_destinations/, result: destination },
    ],
  });
}

const healthy = (extra: Record<string, unknown> = {}) =>
  destinationRow({ health_status: 'healthy', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
});

describe('POST /assignments: success', () => {
  const perms = [P.LOGGING_PLATFORM_DEFAULTS_UPDATE];
  const base = { log_type: 'diagnostic', plane: 'external_sink', destination_id: 'dest_1' };

  it('writes the override, its history, and audits', async () => {
    world(healthy());
    const res = await call(
      perms,
      'POST',
      '/assignments',
      {
        ...base,
        destination_id: ' dest_1 ',
        fallback_policy_id: 'pol_fb',
        approval_policy_id: 'appr_1',
        change_protection: 'approval_required',
        enabled: false,
      },
      { platform: true }
    );
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      id: expect.stringMatching(/^pol_/),
      tenant_id: null,
      log_type: 'diagnostic',
      plane: 'external_sink',
      destination_id: 'dest_1',
      fallback_policy_id: 'pol_fb',
      enabled: 0,
      managed_by: 'platform',
      change_protection: 'approval_required',
      approval_policy_id: 'appr_1',
      version: 1,
      policy_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(res.body.item.created_at).toBe(res.body.item.updated_at);
    expect(res.body.audit_id).toBe('audit_1');
    const item = res.body.item;
    const [insertSql, p] = mockAdapter.execute.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO logging_destination_overrides');
    expect(p).toEqual([
      item.id,
      null,
      'diagnostic',
      'external_sink',
      'dest_1',
      'pol_fb',
      0,
      'platform',
      'approval_required',
      'appr_1',
      item.policy_hash,
      'admin-1',
      'admin-1',
      item.created_at,
      item.created_at,
      1,
    ]);
    const [histSql, h] = mockAdapter.execute.mock.calls[1];
    expect(histSql).toContain('INSERT INTO logging_destination_override_history');
    expect(h.slice(1, 8)).toEqual([
      item.id,
      null,
      'diagnostic',
      'external_sink',
      null,
      'dest_1',
      null,
    ]);
    expect(h[21]).toBe('create');
    expect(h[22]).toBeNull();
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'webhook.destination.update',
      params: {
        kind: 'logging.assignment.create',
        tenant_id: null,
        log_type: 'diagnostic',
        plane: 'external_sink',
        destination_id: 'dest_1',
        fallback_policy_id: 'pol_fb',
        enabled: false,
      },
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_destination_override.create',
        severity: 'info',
        after: expect.objectContaining({
          destination_id: 'dest_1',
          enabled: false,
          managed_by: 'platform',
        }),
      })
    );
  });

  it('marks tenant overrides of configurable types as tenant-managed with defaults', async () => {
    world(healthy());
    const res = await call([P.LOGGING_TENANT_OVERRIDES_UPDATE], 'POST', '/assignments', {
      ...base,
      log_type: 'webhook',
      tenant_id: 'tenant-a',
      change_protection: 'bogus',
      enabled: 'no',
    });
    expect(res.body.item).toMatchObject({
      tenant_id: 'tenant-a',
      managed_by: 'tenant',
      change_protection: 'confirm',
      enabled: 1,
    });
    expect(stepUp.mock.calls[0][1]).toMatchObject({ targetTenantId: 'tenant-a' });
  });

  it('hashes equal inputs equally and different inputs differently', async () => {
    world(healthy());
    const post = (extra: Record<string, unknown> = {}) =>
      call(perms, 'POST', '/assignments', { ...base, ...extra }, { platform: true });
    const a = await post();
    const b = await post();
    const c = await post({ enabled: false });
    expect(a.body.item.policy_hash).toBe(b.body.item.policy_hash);
    expect(a.body.item.policy_hash).not.toBe(c.body.item.policy_hash);
  });

  it('returns the step-up refusal and maps failures to 500', async () => {
    world(healthy());
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    const refused = await call(perms, 'POST', '/assignments', base, { platform: true });
    expect(refused.status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.execute.mockRejectedValue(new Error('db'));
    const failed = await call(perms, 'POST', '/assignments', base, { platform: true });
    expect(failed.status).toBe(500);
  });
});

describe('POST /fallbacks', () => {
  const perms = [P.LOGGING_PLATFORM_DEFAULTS_UPDATE];
  const post = (
    extra: Record<string, unknown> = {},
    opts: { platform?: boolean; perms?: string[] } = {}
  ) =>
    call(
      opts.perms ?? perms,
      'POST',
      '/fallbacks',
      { log_type: 'diagnostic', plane: 'external_sink', failure_mode: 'retry_then_dlq', ...extra },
      { platform: opts.platform ?? true }
    );

  it('validates log type, plane and failure mode', async () => {
    const res = await call(perms, 'POST', '/fallbacks', {}, { platform: true });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
      {
        path: 'failure_mode',
        code: 'invalid_value',
        message: 'Fallback failure mode is not supported.',
      },
    ]);
    const bad = await post({ failure_mode: 'explode' });
    expect(bad.body.details.fields).toHaveLength(1);
    expect(bad.body.details.fields[0].path).toBe('failure_mode');
  });

  it.each([
    'platform_default',
    'retry_then_platform_default',
    'retry_then_dlq',
    'drop_non_critical',
  ])('accepts failure mode %s without a fallback destination', async (mode) => {
    world(null);
    const res = await post({ failure_mode: mode });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      scope_type: 'platform',
      scope_id: 'global',
      fallback_destination_id: null,
      failure_mode: mode,
      version: 1,
    });
  });

  it('derives tenant scope ids from the context and honours explicit ones', async () => {
    world(null);
    const tenantPerms = [P.LOGGING_TENANT_OVERRIDES_UPDATE];
    const implicit = await post({ scope_type: 'tenant' }, { perms: tenantPerms, platform: false });
    expect(implicit.status).toBe(201);
    expect(implicit.body.item).toMatchObject({ scope_type: 'tenant', scope_id: 'tenant-a' });
    const explicit = await post(
      { scope_type: 'tenant', scope_id: ' tenant-x ' },
      { perms: tenantPerms, platform: true }
    );
    expect(explicit.body.item.scope_id).toBe('tenant-x');
    expect(must(stepUp.mock.calls.at(-1))[1]).toMatchObject({ targetTenantId: 'tenant-x' });
    const foreign = await post(
      { scope_type: 'tenant', scope_id: 'tenant-b' },
      { perms: tenantPerms, platform: false }
    );
    expect(foreign.status).toBe(403);
  });

  it('checks the fallback destination for eligibility and fallback approval', async () => {
    world(null);
    expect((await post({ fallback_destination_id: 'dest_x' })).status).toBe(404);
    world(healthy({ default_fallback_eligible: 0 }));
    const notEligible = await post({ fallback_destination_id: 'dest_1' });
    expect(notEligible.status).toBe(400);
    expect(notEligible.body.details.fields).toEqual([
      {
        path: 'fallback_destination_id',
        code: 'fallback_not_allowed',
        message: 'Destination is not approved as a fallback target.',
      },
    ]);
    world(healthy({ default_fallback_eligible: 1, lifecycle_status: 'disabled' }));
    const inactive = await post({ fallback_destination_id: 'dest_1' });
    expect(inactive.body.details.fields[0]).toMatchObject({
      path: 'fallback_destination_id',
      code: 'destination_inactive',
    });
    world(healthy({ default_fallback_eligible: 1 }), { assigned: false });
    const unassigned = await post({ fallback_destination_id: 'dest_1' });
    expect(unassigned.body.details.fields[0]).toMatchObject({
      path: 'fallback_destination_id',
      code: 'log_type_or_plane_not_allowed',
    });
  });

  it('creates with a fallback destination, writing the row and audit', async () => {
    world(healthy({ default_fallback_eligible: 1 }));
    const res = await post({ fallback_destination_id: ' dest_1 ' });
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item.fallback_destination_id).toBe('dest_1');
    const [sql, p] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO logging_fallback_policies');
    expect(p).toEqual([
      item.id,
      'platform',
      'global',
      'diagnostic',
      'external_sink',
      'dest_1',
      'retry_then_dlq',
      item.created_at,
      item.created_at,
      1,
    ]);
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      params: {
        kind: 'logging.fallback.create',
        scope_type: 'platform',
        scope_id: 'global',
        log_type: 'diagnostic',
        plane: 'external_sink',
        fallback_destination_id: 'dest_1',
        failure_mode: 'retry_then_dlq',
      },
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'logging_fallback_policy.create', severity: 'info' })
    );
  });

  it('detects duplicate keys before spending a step-up receipt', async () => {
    world(null, { existingFallback: { id: 'pol_existing' } });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.details.conflict).toEqual({ reason: 'fallback_policy_exists' });
    expect(stepUp).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    const probe = must(
      mockAdapter.queryOne.mock.calls.find(([s]) =>
        String(s).includes('FROM logging_fallback_policies')
      )
    );
    expect(probe[1]).toEqual(['platform', 'global', 'diagnostic', 'external_sink']);
  });

  it('applies the critical-policy rules and surfaces step-up and database failures', async () => {
    world(null);
    const criticalPerms = [P.LOGGING_PLATFORM_DEFAULTS_UPDATE, P.LOGGING_CRITICAL_UPDATE];
    const noConfirm = await post({ log_type: 'audit', plane: 'archive' }, { perms: criticalPerms });
    expect(noConfirm.body.details.fields[0].message).toBe(
      'Confirmation must be "CHANGE CRITICAL LOGGING audit:archive".'
    );
    const ok = await post(
      {
        log_type: 'audit',
        plane: 'archive',
        confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
      },
      { perms: criticalPerms }
    );
    expect(ok.status).toBe(201);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await post()).status).toBe(428);
    mockAdapter.execute.mockRejectedValue(new Error('db'));
    expect((await post()).status).toBe(500);
  });
});
