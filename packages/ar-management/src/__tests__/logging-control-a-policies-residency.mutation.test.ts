/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

const P = ADMIN_PERMISSIONS;
type Body = Record<string, any>;

let kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

async function assign(destinationRegion: string | null, extra: Record<string, unknown> = {}) {
  routeSql(mockAdapter, {
    one: [
      { match: /FROM storage_destination_assignments/, result: { id: 'sda' } },
      {
        match: /FROM admin_destinations/,
        result: destinationRow({
          scope_type: 'shared',
          health_status: 'healthy',
          provider: 'http',
          region: destinationRegion,
          provider_config: JSON.stringify({ url: 'https://logs.example.test' }),
        }),
      },
    ],
  });
  const res = await createApp([P.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
    '/api/admin/logging-policies/assignments',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: 'tenant-a',
        log_type: 'webhook',
        plane: 'external_sink',
        destination_id: 'dest_1',
        ...extra,
      }),
    },
    { DB_ADMIN: {}, AUTHRIM_CONFIG: kv }
  );
  return { status: res.status, body: await res.json<Body>() };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  kv = {
    get: vi.fn(async (key: string) =>
      key === 'settings:tenant:tenant-a:tenant'
        ? JSON.stringify({ 'tenant.residency_profile_id': 'builtin:residency:eu' })
        : null
    ),
    put: vi.fn(),
  };
});

describe('residency checks for tenant assignments', () => {
  it('rejects destinations without a region when the residency profile restricts regions', async () => {
    const res = await assign(null);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'destination_id',
        code: 'region_mismatch',
        message: 'Destination region is not compatible with the residency policy.',
      },
    ]);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects blank regions and regions outside the profile', async () => {
    expect((await assign('   ')).body.details.fields[0].code).toBe('region_mismatch');
    expect((await assign('enam')).body.details.fields[0].code).toBe('region_mismatch');
  });

  it('accepts a region inside the profile regardless of case and whitespace', async () => {
    for (const region of ['weur', ' EEUR ', 'Weur']) {
      const res = await assign(region);
      expect(res.status).toBe(201);
    }
  });

  it('does not restrict tenants whose residency profile has no region limits', async () => {
    kv.get.mockResolvedValue(null);
    const res = await assign(null);
    expect(res.status).toBe(201);
  });
});
