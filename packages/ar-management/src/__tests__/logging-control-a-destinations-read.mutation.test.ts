/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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
type Body = Record<string, any>;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean } = {}
) {
  const res = await createApp(perms, { platform: opts.platform ?? false }).request(
    `/api/admin/destinations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>(), headers: res.headers };
}

function world(row: Record<string, unknown> | null, assigned = true) {
  routeSql(mockAdapter, {
    one: [
      { match: /FROM storage_destination_assignments/, result: assigned ? { id: 'sda' } : null },
      { match: /FROM admin_destinations/, result: row },
    ],
    many: [
      {
        match: /FROM admin_destination_capabilities/,
        result: [{ capability: 'archive_write', source: 'provider_default', enabled: 1 }],
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

describe('GET /:id visibility', () => {
  const READ = [P.STORAGE_DESTINATIONS_READ];
  const get = (opts: { platform?: boolean } = {}) => call(READ, 'GET', '/dest_1', undefined, opts);

  it('shows platform admins the full record with credentials metadata and an ETag', async () => {
    world(
      destinationRow({
        allowed_tenant_ids: JSON.stringify(['t1']),
        credential_ref: 'd1secret://x#v2',
        credential_version: 2,
        next_credential_ref: 'd1secret://x#v3',
        next_credential_version: 3,
        previous_credential_ref: 'd1secret://x#v1',
        previous_credential_retire_after: 99,
        rotation_status: 'retiring',
        provider_config: JSON.stringify({ bindingRef: 'B', prefix: 'p' }),
        version: 6,
      })
    );
    const res = await get({ platform: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v6"');
    expect(res.body.item).toMatchObject({
      id: 'dest_1',
      provider: 'r2',
      runtime_supported: true,
      allowed_tenant_ids: JSON.stringify(['t1']),
      rotation_status: 'retiring',
      provider_config: { bindingRef: 'B', prefix: 'p' },
      credential_ref: 'd1secret://x#v2',
      credential_version: 2,
      next_credential_ref: 'd1secret://x#v3',
      next_credential_version: 3,
      previous_credential_ref: 'd1secret://x#v1',
      previous_credential_retire_after: 99,
      version: 6,
      capabilities: [{ capability: 'archive_write', source: 'provider_default', enabled: 1 }],
    });
  });

  it('falls back to an empty provider config for unparseable stored values', async () => {
    for (const stored of ['not json', '[1]', 'null', '']) {
      world(destinationRow({ provider_config: stored }));
      const res = await get({ platform: true });
      expect(res.body.item.provider_config).toEqual({});
    }
  });

  it('hides credentials and the tenant allowlist from tenant admins', async () => {
    world(
      destinationRow({
        scope_type: 'shared',
        credential_ref: 'd1secret://x#v2',
        allowed_tenant_ids: '["t1"]',
      })
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.item.provider).toBe('r2');
    for (const key of [
      'allowed_tenant_ids',
      'provider_config',
      'credential_ref',
      'rotation_status',
      'next_credential_ref',
    ]) {
      expect(res.body.item).not.toHaveProperty(key);
    }
    const probe = must(
      mockAdapter.queryOne.mock.calls.find(([s]) =>
        String(s).includes('storage_destination_assignments')
      )
    );
    expect(probe[1]).toEqual(['dest_1', 'tenant-a', 'tenant-a', null, null, null, null]);
  });

  it('lets tenant admins read their own tenant destinations without an assignment probe', async () => {
    world(destinationRow({ scope_type: 'tenant', scope_id: 'tenant-a' }), false);
    expect((await get()).status).toBe(200);
    expect(
      mockAdapter.queryOne.mock.calls.some(([s]) =>
        String(s).includes('storage_destination_assignments')
      )
    ).toBe(false);
    world(destinationRow({ scope_type: 'tenant', scope_id: 'tenant-b' }));
    expect((await get()).status).toBe(404);
  });

  it('answers 404 to tenants for unassigned platform destinations and unknown scopes', async () => {
    world(destinationRow({ scope_type: 'platform' }), false);
    expect((await get()).status).toBe(404);
    world(destinationRow({ scope_type: 'platform' }), true);
    expect((await get()).status).toBe(200);
    world(destinationRow({ scope_type: 'weird' }), true);
    expect((await get()).status).toBe(404);
  });

  it('marks unsupported providers in the detail', async () => {
    world(destinationRow({ provider: 'logpush' }));
    const res = await get({ platform: true });
    expect(res.body.item).toMatchObject({
      runtime_supported: false,
      runtime_status: 'unsupported',
      runtime_unsupported_reason: 'provider_runtime_not_implemented',
    });
  });
});

describe('small destination edge cases', () => {
  it('provider-preview accepts an http provider without a url (required-field error only)', async () => {
    const res = await call(
      [P.STORAGE_DESTINATIONS_CREATE],
      'POST',
      '/provider-preview',
      { provider: 'http' },
      { platform: true }
    );
    expect(res.body.item.validation.errors).toEqual([
      {
        path: 'provider_config.url',
        code: 'required',
        message: 'Provider config field is required.',
      },
    ]);
    const nonObject = await call(
      [P.STORAGE_DESTINATIONS_CREATE],
      'POST',
      '/provider-preview',
      { provider: 'r2', provider_config: [1] },
      { platform: true }
    );
    expect(nonObject.body.item.provider_config).toEqual({});
    expect(nonObject.body.item.validation.errors[0].path).toBe('provider_config.bindingRef');
  });

  it('diff-preview treats stored allowlists that are not JSON arrays as empty', async () => {
    const stored = destinationRow({
      allowed_tenant_ids: 'not json',
      allowed_log_types: '{"a":1}',
      allowed_planes: '[1,"a",null]',
      version: 2,
    });
    routeSql(mockAdapter, { one: [{ match: /FROM admin_destinations/, result: stored }] });
    const res = await call(
      [P.STORAGE_DESTINATIONS_UPDATE],
      'POST',
      '/dest_1/diff-preview',
      {
        scope_type: 'platform',
        provider: 'r2',
        name: 'archive',
        display_name: 'Archive',
        provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
        retention_days: 30,
        capabilities: ['archive_write'],
      },
      { platform: true }
    );
    expect(res.status).toBe(200);
    const byField = Object.fromEntries(res.body.item.diff.map((d: Body) => [d.field, d]));
    expect(byField.allowed_tenant_ids).toBeUndefined();
    expect(byField.allowed_log_types).toBeUndefined();
    expect(byField.allowed_planes).toMatchObject({ previous: ['a'], next: null });
    expect(res.body.item.dangerous_reasons).toEqual(['plane_allowlist_changed']);
  });
});
