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

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { createApp, destinationRow, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const UPDATE = ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE;
type Body = Record<string, any>;

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const res = await createApp([UPDATE], { platform: true }).request(
    `/api/admin/destinations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const current = (extra: Record<string, unknown> = {}) =>
  destinationRow({
    allowed_tenant_ids: JSON.stringify(['t1', 't2']),
    allowed_log_types: JSON.stringify(['diagnostic']),
    allowed_planes: JSON.stringify(['archive']),
    critical_allowed: 1,
    default_fallback_eligible: 1,
    retention_days: 30,
    region: 'eu',
    description: 'old',
    version: 3,
    ...extra,
  });

/** A request body equal to `current()`: nothing changes. */
const same = (extra: Record<string, unknown> = {}) => ({
  scope_type: 'platform',
  scope_id: 'global',
  provider: 'r2',
  name: 'archive',
  display_name: 'Archive',
  description: 'old',
  provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
  allowed_tenant_ids: ['t2', 't1'],
  allowed_log_types: ['diagnostic'],
  allowed_planes: ['archive'],
  region: 'eu',
  critical_allowed: true,
  default_fallback_eligible: true,
  retention_days: 30,
  encryption_mode: 'platform_managed',
  capabilities: ['archive_write'],
  ...extra,
});

function world(row: Record<string, unknown> | null, capabilities: string[] = ['archive_write']) {
  routeSql(mockAdapter, {
    one: [
      {
        match: /assignment_count/,
        result: {
          assignment_count: '2',
          logging_override_count: 1,
          fallback_policy_count: '3',
          critical_policy_count: 4,
          sensitive_detail_policy_count: 5,
        },
      },
      { match: /FROM admin_destinations/, result: row },
    ],
    many: [
      {
        match: /FROM admin_destination_capabilities/,
        result: capabilities.map((capability) => ({ capability })),
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

describe('POST /:id/diff-preview', () => {
  const preview = (body: unknown, headers: Record<string, string> = {}) =>
    call('POST', '/dest_1/diff-preview', body, headers);

  it('rejects an invalid body without touching the database', async () => {
    const res = await preview({ provider: 'r2' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields.map((f: Body) => f.path)).toEqual([
      'scope_type',
      'name',
      'display_name',
      'provider_config.bindingRef',
    ]);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('reports no changes for an equivalent request, with affected counts', async () => {
    world(current());
    const res = await preview(same());
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      destination_id: 'dest_1',
      current_version: 3,
      expected_version: null,
      changed: false,
      diff: [],
      dangerous_classification: 'none',
      dangerous_reasons: [],
      confirmation: null,
      affected_assignments: {
        storage_destination_assignments: 2,
        logging_destination_overrides: 1,
        logging_fallback_policies: 3,
        admin_logging_critical_policies: 4,
        admin_logging_sensitive_detail_policies: 5,
      },
    });
    expect(typeof res.body.item.previewed_at).toBe('number');
    expect(
      must(mockAdapter.queryOne.mock.calls.find(([s]) => String(s).includes('assignment_count')))[1]
    ).toEqual(['dest_1', 'dest_1', 'dest_1', 'dest_1', 'dest_1']);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('echoes the expected version from the body or If-Match', async () => {
    world(current());
    expect((await preview(same({ expected_version: 3 }))).body.item.expected_version).toBe(3);
    expect((await preview(same(), { 'if-match': '"v2"' })).body.item.expected_version).toBe(2);
  });

  it('defaults affected counts to zero when the aggregate row is missing', async () => {
    routeSql(mockAdapter, {
      one: [{ match: /FROM admin_destinations/, result: current() }],
    });
    const res = await preview(same());
    expect(res.body.item.affected_assignments).toEqual({
      storage_destination_assignments: 0,
      logging_destination_overrides: 0,
      logging_fallback_policies: 0,
      admin_logging_critical_policies: 0,
      admin_logging_sensitive_detail_policies: 0,
    });
  });

  it('lists each changed field with previous and next values (sets are normalized)', async () => {
    world(current());
    const res = await preview(
      same({
        scope_type: 'shared',
        scope_id: 'other',
        name: 'renamed',
        display_name: 'Renamed',
        description: 'new',
        allowed_tenant_ids: ['t3', 't1', 't3'],
        allowed_log_types: [],
        allowed_planes: ['primary', 'archive'],
        region: 'us',
        capabilities: ['log_sink_write', 'archive_write'],
        provider_config: { bindingRef: 'OTHER' },
      })
    );
    const byField = Object.fromEntries(res.body.item.diff.map((d: Body) => [d.field, d]));
    expect(Object.keys(byField).sort()).toEqual(
      [
        'scope_type',
        'scope_id',
        'provider_config',
        'name',
        'display_name',
        'description',
        'allowed_tenant_ids',
        'allowed_log_types',
        'allowed_planes',
        'region',
        'capabilities',
      ].sort()
    );
    expect(byField.scope_type).toEqual({
      field: 'scope_type',
      previous: 'platform',
      next: 'shared',
      changed: true,
    });
    expect(byField.allowed_tenant_ids).toMatchObject({
      previous: ['t1', 't2'],
      next: ['t1', 't3'],
    });
    expect(byField.allowed_log_types).toMatchObject({ previous: ['diagnostic'], next: null });
    expect(byField.allowed_planes).toMatchObject({
      previous: ['archive'],
      next: ['archive', 'primary'],
    });
    expect(byField.capabilities).toMatchObject({
      previous: ['archive_write'],
      next: ['archive_write', 'log_sink_write'],
    });
    expect(byField.provider_config).toMatchObject({
      previous: { bindingRef: 'AUDIT_ARCHIVE' },
      next: { bindingRef: 'OTHER' },
    });
    expect(res.body.item.changed).toBe(true);
    expect(res.body.item.dangerous_classification).toBe('review');
    expect(res.body.item.dangerous_reasons).toEqual([
      'tenant_allowlist_changed',
      'log_type_allowlist_changed',
      'plane_allowlist_changed',
      'provider_config_changed',
    ]);
    expect(res.body.item.confirmation).toBeNull();
  });

  it('tracks boolean, retention and encryption changes', async () => {
    world(current({ critical_allowed: 0, default_fallback_eligible: 0 }));
    const res = await preview(
      same({
        critical_allowed: true,
        default_fallback_eligible: true,
        retention_days: 90,
        encryption_mode: 'none',
      })
    );
    const byField = Object.fromEntries(res.body.item.diff.map((d: Body) => [d.field, d]));
    expect(byField.critical_allowed).toEqual({
      field: 'critical_allowed',
      previous: false,
      next: true,
      changed: true,
    });
    expect(byField.default_fallback_eligible).toMatchObject({ previous: false, next: true });
    expect(byField.retention_days).toMatchObject({ previous: 30, next: 90 });
    expect(byField.encryption_mode).toMatchObject({ previous: 'platform_managed', next: 'none' });
  });

  it.each([
    [
      'provider change',
      { provider: 'http', provider_config: { url: 'https://x.example.com' } },
      {},
      'provider_change',
    ],
    ['critical delivery removed', { critical_allowed: false }, {}, 'critical_delivery_removed'],
    [
      'fallback eligibility removed',
      { default_fallback_eligible: false },
      {},
      'fallback_eligibility_removed',
    ],
    ['encryption weakened', { encryption_mode: 'external_managed' }, {}, 'encryption_weakened'],
    ['retention reduced', { retention_days: 29 }, {}, 'retention_reduced'],
  ])('classifies %s as dangerous', async (_name, request, row, reason) => {
    world(current(row));
    const res = await preview(same(request));
    expect(res.body.item.dangerous_classification).toBe('dangerous');
    expect(res.body.item.dangerous_reasons).toContain(reason);
    expect(res.body.item.confirmation).toBe('CONFIRM DESTINATION CHANGE archive');
  });

  it('does not flag benign changes as dangerous', async () => {
    world(current());
    for (const request of [
      { retention_days: 31 },
      { retention_days: undefined },
      { critical_allowed: true },
      { encryption_mode: 'platform_managed' },
    ]) {
      const res = await preview(same(request));
      expect(res.body.item.dangerous_classification).not.toBe('dangerous');
    }
    world(current({ encryption_mode: 'external_managed', retention_days: null }));
    const weakenedAlready = await preview(same({ encryption_mode: 'none', retention_days: 5 }));
    expect(weakenedAlready.body.item.dangerous_reasons).not.toContain('encryption_weakened');
    expect(weakenedAlready.body.item.dangerous_reasons).not.toContain('retention_reduced');
  });

  it('keeps dangerous classification when review reasons follow', async () => {
    world(current());
    const res = await preview(same({ critical_allowed: false, allowed_planes: ['primary'] }));
    expect(res.body.item.dangerous_classification).toBe('dangerous');
    expect(res.body.item.dangerous_reasons).toEqual([
      'critical_delivery_removed',
      'plane_allowlist_changed',
    ]);
  });
});

describe('PATCH /:id', () => {
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    call('PATCH', '/dest_1', body, headers);

  it('rejects invalid bodies before reading the row', async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('applies a non-delivery change without step-up using one atomic batch', async () => {
    world(current());
    const res = await patch(same({ display_name: 'Pretty', description: 'new' }), {
      'if-match': '"v3"',
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: 'dest_1',
      version: 4,
      updated_at: expect.any(Number),
    });
    expect(res.body.audit_id).toBe('audit_1');
    expect(stepUp).not.toHaveBeenCalled();
    const statements = mockAdapter.batch.mock.calls[0][0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    expect(statements[0].sql).toContain('UPDATE admin_destinations');
    expect(statements[0].sql).toContain('version = version + 1');
    expect(statements[0].params.slice(0, 6)).toEqual([
      'platform',
      'global',
      'object_storage',
      'r2',
      'archive',
      'Pretty',
    ]);
    expect(statements[0].params.at(-2)).toBe('dest_1');
    expect(statements[0].params.at(-1)).toBe(3);
    expect(statements.length).toBeGreaterThan(1);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'storage_destination.update',
        severity: 'warn',
        before: expect.objectContaining({ version: 3, name: 'archive' }),
        after: expect.objectContaining({ version: 4, name: 'archive' }),
      })
    );
    expect(mockAdapter.batch).toHaveBeenCalledTimes(1);
  });

  it('audits info severity when neither side is critical', async () => {
    world(current({ critical_allowed: 0 }));
    await patch(same({ critical_allowed: false, description: 'x' }));
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
  });

  it('gates a delivery change as destination.update with the resulting state', async () => {
    world(current());
    const res = await patch(same({ provider_config: { bindingRef: 'OTHER' } }));
    expect(res.status).toBe(200);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'webhook.destination.update',
      targetIds: ['dest_1'],
      params: expect.objectContaining({
        kind: 'destination.update',
        provider: 'r2',
        allowed_tenant_ids: ['t1', 't2'],
        capabilities: ['archive_write'],
        critical_allowed: true,
        retention_days: 30,
        provider_config_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(stepUp.mock.calls[0][1].alsoCovers).toBeUndefined();
  });

  it('gates retention-only shortening as audit.retention.shorten', async () => {
    world(current());
    await patch(same({ retention_days: 7 }));
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'audit.retention.shorten',
      params: expect.objectContaining({ kind: 'destination.retention', retention_days: 7 }),
    });
    expect(stepUp.mock.calls[0][1].alsoCovers).toBeUndefined();
  });

  it('treats a finite retention replacing unlimited as shortened', async () => {
    world(current({ retention_days: null }));
    await patch(same({ retention_days: 365 }));
    expect(stepUp.mock.calls[0][1].operation).toBe('audit.retention.shorten');
  });

  it('does not gate retention extension or removal', async () => {
    world(current());
    await patch(same({ retention_days: 60 }));
    await patch(same({ retention_days: null }));
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('covers both operations when a change also shortens retention', async () => {
    world(current());
    await patch(same({ region: 'us', retention_days: 5 }));
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'webhook.destination.update',
      alsoCovers: ['audit.retention.shorten'],
      params: expect.objectContaining({ kind: 'destination.update', region: 'us' }),
    });
  });

  it('returns the step-up refusal and a 409 when the compare-and-set lost', async () => {
    world(current());
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    expect((await patch(same({ region: 'us' }))).status).toBe(428);
    expect(mockAdapter.batch).not.toHaveBeenCalled();
    mockAdapter.batch.mockResolvedValue([{ rowsAffected: 0 }]);
    const lost = await patch(same({ display_name: 'x' }));
    expect(lost.status).toBe(409);
    expect(lost.body.details.conflict).toEqual({ reason: 'concurrent_modification' });
    expect(auditWrite).not.toHaveBeenCalled();
    mockAdapter.batch.mockResolvedValue(undefined);
    expect((await patch(same({ display_name: 'x' }))).status).toBe(409);
  });

  it('treats missing stored JSON arrays and invalid config as unchanged-safe', async () => {
    world(current({ allowed_tenant_ids: 'not json', allowed_log_types: null, allowed_planes: '' }));
    const res = await patch(
      same({
        allowed_tenant_ids: undefined,
        allowed_log_types: undefined,
        allowed_planes: undefined,
      })
    );
    expect(res.status).toBe(200);
    expect(stepUp).not.toHaveBeenCalled();
    world(current({ provider_config: 'garbage' }));
    const bad = await patch(same({ provider_config: { bindingRef: 'X' } }));
    expect(bad.status).toBe(200);
    expect(stepUp).toHaveBeenCalledTimes(1);
  });

  it('keeps stored json object config parseable for non-object values', async () => {
    world(current({ provider_config: JSON.stringify([1, 2]) }));
    const res = await patch(same({ provider_config: { bindingRef: 'X' } }));
    expect(res.status).toBe(200);
    expect(stepUp).toHaveBeenCalledTimes(1);
  });
});
