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

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { createApp, destinationRow, resetAdapter } from './logging-control-a-harness';

const env = { DB_ADMIN: {} } as unknown as Env;
const P = ADMIN_PERMISSIONS;
const CRED_WRITE = P.STORAGE_DESTINATIONS_CREDENTIALS_WRITE;

type Body = Record<string, any>;
async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const res = await app.request(
    `/api/admin/destinations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
  return { status: res.status, body: await res.json<Body>(), headers: res.headers };
}

const validCreate = {
  scope_type: 'platform',
  provider: 'r2',
  name: 'archive',
  provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
});

describe('destination routes: permission and platform guards', () => {
  const guarded: Array<[string, string, string, unknown]> = [
    ['GET detail', 'GET', '/dest_1', undefined],
    ['POST diff-preview', 'POST', '/dest_1/diff-preview', validCreate],
    ['PATCH', 'PATCH', '/dest_1', validCreate],
    ['DELETE', 'DELETE', '/dest_1', {}],
    ['POST disable', 'POST', '/dest_1/disable', {}],
    ['POST enable', 'POST', '/dest_1/enable', {}],
    ['POST credentials/prepare', 'POST', '/dest_1/credentials/prepare', { secret_value: 'x' }],
    ['POST credentials/ready', 'POST', '/dest_1/credentials/ready', {}],
    ['POST credentials/activate', 'POST', '/dest_1/credentials/activate', {}],
    ['POST credentials/retire-previous', 'POST', '/dest_1/credentials/retire-previous', {}],
  ];

  it.each(guarded)('%s refuses callers without the permission', async (_n, method, path, body) => {
    const res = await call(createApp([], { platform: true }), method, path, body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  const platformOnly = guarded.filter(([n]) => n !== 'GET detail');
  const permissionFor = (path: string, method: string) =>
    path.includes('credentials')
      ? CRED_WRITE
      : method === 'DELETE'
        ? P.STORAGE_DESTINATIONS_DELETE
        : P.STORAGE_DESTINATIONS_UPDATE;

  it.each(platformOnly)('%s requires platform authority', async (_n, method, path, body) => {
    const res = await call(
      createApp([permissionFor(path, method)], { platform: false }),
      method,
      path,
      body
    );
    expect(res.status).toBe(403);
    expect(res.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'platform_authority_required',
    });
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it.each(platformOnly.filter(([, , path]) => !path.endsWith('diff-preview') || true))(
    '%s answers 404 for an unknown destination',
    async (_n, method, path, body) => {
      const res = await call(
        createApp([permissionFor(path, method)], { platform: true }),
        method,
        path,
        body
      );
      // PATCH/diff-preview need a valid body to reach the lookup; all fixtures above supply one.
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      expect(mockAdapter.execute).not.toHaveBeenCalled();
      expect(mockAdapter.batch).not.toHaveBeenCalled();
    }
  );

  it('GET detail returns 404 for an unknown destination', async () => {
    const res = await call(
      createApp([P.STORAGE_DESTINATIONS_READ], { platform: true }),
      'GET',
      '/nope'
    );
    expect(res.status).toBe(404);
  });

  it.each(guarded)('%s turns a database failure into a 500', async (_n, method, path, body) => {
    mockAdapter.queryOne.mockRejectedValue(new Error('db down'));
    const perm = _n === 'GET detail' ? P.STORAGE_DESTINATIONS_READ : permissionFor(path, method);
    const res = await call(createApp([perm], { platform: true }), method, path, body);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });

  it('list and create fail with 500 when the database throws', async () => {
    mockAdapter.query.mockRejectedValue(new Error('db down'));
    const list = await call(
      createApp([P.STORAGE_DESTINATIONS_LIST], { platform: true }),
      'GET',
      ''
    );
    expect(list.status).toBe(500);

    mockAdapter.execute.mockRejectedValue(new Error('db down'));
    const created = await call(
      createApp([P.STORAGE_DESTINATIONS_CREATE], { platform: true }),
      'POST',
      '',
      validCreate
    );
    expect(created.status).toBe(500);
  });
});

describe('destination list filters', () => {
  it.each(['platform', 'tenant', 'shared'])('filters by scope_type=%s', async (scope) => {
    await call(
      createApp([P.STORAGE_DESTINATIONS_LIST], { platform: true }),
      'GET',
      `?scope_type=${scope}`
    );
    const [sql, params] = mockAdapter.query.mock.calls[0];
    expect(sql).toContain('deleted_at IS NULL AND scope_type = ?');
    expect(params).toEqual([scope, 50]);
  });

  it('ignores unknown scope types and clamps the limit', async () => {
    await call(
      createApp([P.STORAGE_DESTINATIONS_LIST], { platform: true }),
      'GET',
      '?scope_type=bogus&limit=9999'
    );
    const [sql, params] = mockAdapter.query.mock.calls[0];
    expect(sql).not.toContain('scope_type = ?');
    expect(params).toEqual([200]);
  });

  it('restricts tenant admins to shared, own, or assigned destinations', async () => {
    await call(
      createApp([P.STORAGE_DESTINATIONS_LIST], { tenantId: 'tenant-z' }),
      'GET',
      '?limit=7'
    );
    const [sql, params] = mockAdapter.query.mock.calls[0];
    expect(sql).toContain("scope_type = 'shared'");
    expect(sql).toContain('storage_destination_assignments');
    expect(params).toEqual(['tenant-z', 'tenant-z', 7]);
  });

  it('adds runtime support to every item', async () => {
    mockAdapter.query.mockResolvedValue([
      { id: 'a', provider: 'r2' },
      { id: 'b', provider: 'aws_s3' },
    ]);
    const res = await call(createApp([P.STORAGE_DESTINATIONS_LIST], { platform: true }), 'GET', '');
    expect(res.body.items[0]).toMatchObject({
      runtime_supported: true,
      runtime_status: 'supported',
    });
    expect(res.body.items[0].runtime_unsupported_reason).toBeNull();
    expect(res.body.items[1]).toMatchObject({
      runtime_supported: false,
      runtime_status: 'unsupported',
      runtime_unsupported_reason: 'provider_runtime_not_implemented',
    });
  });
});

describe('provider-preview', () => {
  const app = () => createApp([P.STORAGE_DESTINATIONS_CREATE], { platform: true });

  it('accepts the update permission as an alternative', async () => {
    const res = await call(
      createApp([P.STORAGE_DESTINATIONS_UPDATE], { platform: true }),
      'POST',
      '/provider-preview',
      { provider: 'r2', provider_config: { bindingRef: 'B' } }
    );
    expect(res.status).toBe(200);
  });

  it('denies without either permission and without platform authority', async () => {
    const denied = await call(createApp([], { platform: true }), 'POST', '/provider-preview', {});
    expect(denied.status).toBe(403);
    const tenant = await call(
      createApp([P.STORAGE_DESTINATIONS_CREATE]),
      'POST',
      '/provider-preview',
      { provider: 'r2' }
    );
    expect(tenant.body.details.permission.reason).toBe('platform_authority_required');
  });

  it('rejects an unsupported provider', async () => {
    const res = await call(app(), 'POST', '/provider-preview', { provider: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'provider', code: 'invalid_value', message: 'Provider is not supported.' },
    ]);
  });

  it('flags missing required fields, inline secrets and unsafe http urls', async () => {
    const res = await call(app(), 'POST', '/provider-preview', {
      provider: 'http',
      provider_config: { url: 'http://localhost/x', apiKey: 'abc', nested: [{ password: 'p' }] },
    });
    expect(res.status).toBe(200);
    const item = res.body.item;
    expect(item.provider).toBe('http');
    expect(item.destination_kind).toBe('http_sink');
    expect(item.validation.valid).toBe(false);
    const codes = item.validation.errors.map((e: Body) => `${e.path}:${e.code}`);
    expect(codes).toContain('provider_config.apiKey:secret_not_allowed');
    expect(codes).toContain('provider_config.url:http_sink_url_invalid');
    expect(item.security).toEqual({
      inline_secret_detected: true,
      inline_secret_path: 'provider_config.apiKey',
      credential_ref_required: true,
    });
    expect(item.provider_config.apiKey).toBe('[redacted]');
    expect(item.provider_config.nested[0].password).toBe('[redacted]');
    expect(item.runtime).toEqual({
      supported: true,
      status: 'supported',
      unsupported_reason: null,
    });
    expect(item.schema.required_fields).toEqual(['url']);
  });

  it('reports required-field errors and unsupported runtime for aws_s3', async () => {
    const res = await call(app(), 'POST', '/provider-preview', {
      provider: 'aws_s3',
      provider_config: { bucket: 'b' },
      capabilities: ['archive_write', 'bogus', 'archive_write'],
    });
    const item = res.body.item;
    expect(item.validation.errors).toEqual([
      {
        path: 'provider_config.region',
        code: 'required',
        message: 'Provider config field is required.',
      },
    ]);
    expect(item.runtime).toEqual({
      supported: false,
      status: 'unsupported',
      unsupported_reason: 'provider_runtime_not_implemented',
    });
    expect(item.capabilities).toEqual(['archive_write']);
    expect(item.security.credential_ref_required).toBe(true);
    expect(item.security.inline_secret_path).toBeNull();
  });

  it('is valid for a clean r2 config and falls back to default capabilities', async () => {
    const res = await call(app(), 'POST', '/provider-preview', {
      provider: 'r2',
      provider_config: {
        bindingRef: 'X',
        deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
      },
      capabilities: ['bogus'],
    });
    const item = res.body.item;
    expect(item.validation).toEqual({ valid: true, errors: [] });
    expect(item.security.credential_ref_required).toBe(false);
    expect(item.capabilities).toEqual(item.schema.default_capabilities);
    expect(JSON.stringify(item.provider_config)).toContain('[max-depth-redacted]');
  });

  it('http with https url passes the url check', async () => {
    const res = await call(app(), 'POST', '/provider-preview', {
      provider: 'http',
      provider_config: { url: 'https://logs.example.com/ingest' },
    });
    expect(res.body.item.validation.valid).toBe(true);
  });
});

describe('create validation (readDestinationBody)', () => {
  const app = () => createApp([P.STORAGE_DESTINATIONS_CREATE], { platform: true });
  const fields = async (body: unknown) => {
    const res = await call(app(), 'POST', '', body);
    expect(res.status).toBe(400);
    return res.body.details.fields as Array<{ path: string; code: string }>;
  };

  it('reports every missing basic field', async () => {
    expect(await fields({})).toEqual([
      expect.objectContaining({ path: 'scope_type', code: 'invalid_value' }),
      expect.objectContaining({ path: 'provider', code: 'invalid_value' }),
      expect.objectContaining({ path: 'name', code: 'required' }),
      expect.objectContaining({ path: 'display_name', code: 'required' }),
    ]);
  });

  it('rejects non-positive retention days', async () => {
    for (const retention_days of [0, -3, 'abc', 1.5]) {
      const f = await fields({ ...validCreate, retention_days });
      expect(f).toEqual([
        expect.objectContaining({ path: 'retention_days', code: 'invalid_value' }),
      ]);
    }
  });

  it('rejects secret-looking provider config keys', async () => {
    const f = await fields({
      ...validCreate,
      provider_config: { bindingRef: 'B', client_secret: 'x' },
    });
    expect(f).toEqual([
      {
        path: 'provider_config.client_secret',
        code: 'secret_not_allowed',
        message: expect.any(String),
      },
    ]);
  });

  it('rejects non-https http sinks and missing required config', async () => {
    const f = await fields({
      ...validCreate,
      provider: 'http',
      provider_config: { url: 'http://example.com' },
    });
    expect(f).toEqual([
      expect.objectContaining({ path: 'provider_config.url', code: 'http_sink_url_invalid' }),
    ]);
    const g = await fields({ ...validCreate, provider_config: {} });
    expect(g).toEqual([
      expect.objectContaining({ path: 'provider_config.bindingRef', code: 'required' }),
    ]);
  });

  it('requires scope_id for tenant destinations', async () => {
    const f = await fields({ ...validCreate, scope_type: 'tenant' });
    expect(f).toEqual([
      {
        path: 'scope_id',
        code: 'required',
        message: 'Tenant-scoped destinations require scope_id.',
      },
    ]);
  });

  it('stores normalized values on success', async () => {
    const res = await call(app(), 'POST', '', {
      ...validCreate,
      scope_type: 'tenant',
      scope_id: ' tenant-x ',
      display_name: 'Pretty',
      description: ' desc ',
      region: 'eu',
      allowed_tenant_ids: ['t1', ' t1 ', 't2', 5, ''],
      allowed_log_types: [],
      allowed_planes: 'archive',
      critical_allowed: true,
      default_fallback_eligible: true,
      retention_days: '14',
      encryption_mode: 'external_managed',
      capabilities: ['archive_write', 'export_artifact_write'],
    });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      scope_type: 'tenant',
      scope_id: 'tenant-x',
      destination_kind: 'object_storage',
      provider: 'r2',
      runtime_supported: true,
      display_name: 'Pretty',
      lifecycle_status: 'active',
      version: 1,
    });
    expect(res.body.audit_id).toBe('audit_1');
    const [sql, params] = mockAdapter.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO admin_destinations');
    expect(params.slice(1, 8)).toEqual([
      'tenant',
      'tenant-x',
      'object_storage',
      'r2',
      'archive',
      'Pretty',
      'desc',
    ]);
    expect(params[10]).toBe(JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }));
    expect(params[11]).toBe(JSON.stringify(['t1', 't2']));
    expect(params[12]).toBeNull();
    expect(params[13]).toBeNull();
    expect(params.slice(14, 20)).toEqual(['eu', 1, 1, 14, 'external_managed', 'admin-1']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'storage_destination.create', severity: 'warn' })
    );
  });

  it('defaults display_name to name, scope_id to global, and audits info severity', async () => {
    const res = await call(app(), 'POST', '', { ...validCreate, encryption_mode: 'weird' });
    expect(res.status).toBe(201);
    expect(res.body.item.display_name).toBe('archive');
    expect(res.body.item.scope_id).toBe('global');
    const [, params] = mockAdapter.execute.mock.calls[0];
    expect(params[18]).toBe('platform_managed');
    expect(params[5]).toBe('archive');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
  });

  it('returns the step-up refusal without writing', async () => {
    stepUp.mockResolvedValue(new Response('{"error":"step_up"}', { status: 428 }));
    const res = await call(app(), 'POST', '', validCreate);
    expect(res.status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(stepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        params: expect.objectContaining({ kind: 'destination.create', provider: 'r2' }),
      })
    );
  });
});

describe('update validation (If-Match / expected_version)', () => {
  const app = () => createApp([P.STORAGE_DESTINATIONS_UPDATE], { platform: true });

  it('rejects an invalid expected_version and malformed If-Match', async () => {
    for (const expected_version of [0, -1, 'x']) {
      const res = await call(app(), 'PATCH', '/dest_1', { ...validCreate, expected_version });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        expect.objectContaining({ path: 'expected_version', code: 'invalid_value' }),
      ]);
    }
    const res = await call(app(), 'PATCH', '/dest_1', validCreate, { 'if-match': 'garbage' });
    expect(res.body.details.fields).toEqual([
      expect.objectContaining({ path: 'If-Match', code: 'invalid_value' }),
    ]);
  });

  it('uses a valid If-Match version and reports a conflict against the stored version', async () => {
    mockAdapter.queryOne.mockResolvedValue(destinationRow({ version: 4 }));
    for (const header of ['"v3"', 'W/"v3"', '3']) {
      const res = await call(app(), 'PATCH', '/dest_1', validCreate, { 'if-match': header });
      expect(res.status).toBe(409);
      expect(res.body.details.conflict).toEqual({ expected_version: 3, actual_version: 4 });
    }
    const body = await call(app(), 'PATCH', '/dest_1', { ...validCreate, expected_version: 2 });
    expect(body.body.details.conflict).toEqual({ expected_version: 2, actual_version: 4 });
  });
});
