import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as UntypedDatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

// The gate itself is covered in ar-lib-core; here it is observed at its port: which routes call it,
// with which operation and parameters, and that a refusal leaves every store untouched.
const gate = vi.hoisted(() =>
  vi.fn(
    async (_context: unknown, _descriptor: Record<string, unknown>): Promise<Response | null> =>
      null
  )
);
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const auditWrite = vi.hoisted(() =>
  vi.fn(async (_context: unknown, _input: { action: string }) => crypto.randomUUID())
);
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const mockAdapter = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('d1'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return adapter;
});

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
      (c: { json: (body: unknown, status?: number) => Response }, errorCode: string) =>
        c.json({ error: errorCode }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { getDefaultDestinationCapabilities } from '@authrim/ar-lib-logging/destinations';
import {
  adminLoggingRouter,
  destinationsRouter,
  loggingPoliciesRouter,
  notificationsRouter,
} from '../routes/admin-management/logging-control';
import { sha256Hex } from '../admin-step-up-digest';

const hex64: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(): unknown };
  close(): void;
}
const DatabaseSync = UntypedDatabaseSync as unknown as new (path: string) => SqliteDatabase;
const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXPORT_CREATE = 'admin:logging:exports:create';
const SENSITIVE_EXPORT = 'admin:logging:sensitive_detail:export';

const bucket = () => ({
  head: vi.fn().mockResolvedValue({ size: 10 }),
  put: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue(null),
  delete: vi.fn().mockResolvedValue(undefined),
});
let envFixture: Record<string, unknown>;
const env = () => envFixture as unknown as Env;

function createApp(permissions: string[], roles = ['ar_super_admin']) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown; tenantId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    const platform = roles.includes('ar_super_admin');
    c.set('adminAuth', {
      userId: 'admin-1',
      permissions,
      roles,
      globalRoles: platform ? roles : [],
      globalPermissions: platform ? permissions : [],
      tenantScope: platform ? ['*'] : ['tenant-a'],
    });
    await next();
  });
  app.route('/api/admin/destinations', destinationsRouter);
  app.route('/api/admin/logging-policies', loggingPoliciesRouter);
  app.route('/api/admin/admin-logging', adminLoggingRouter);
  app.route('/api/admin/notifications', notificationsRouter);
  return app;
}

function send(
  permissions: string[],
  method: string,
  path: string,
  body: unknown,
  roles?: string[],
  headers: Record<string, string> = {}
) {
  return createApp(permissions, roles).request(
    path,
    {
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    },
    env()
  );
}

function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest_1',
    scope_type: 'platform',
    scope_id: 'global',
    destination_kind: 'object_storage',
    provider: 'r2',
    name: 'archive',
    display_name: 'Archive',
    description: null,
    lifecycle_status: 'active',
    health_status: 'configured',
    rotation_status: 'none',
    provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }),
    credential_ref: null,
    credential_version: 0,
    next_credential_ref: null,
    next_credential_version: null,
    previous_credential_ref: null,
    previous_credential_retire_after: null,
    allowed_tenant_ids: null,
    allowed_log_types: null,
    allowed_planes: null,
    region: null,
    critical_allowed: 0,
    default_fallback_eligible: 0,
    retention_days: 30,
    encryption_mode: 'platform_managed',
    last_health_check_at: null,
    version: 1,
    ...overrides,
  };
}

function tenantDestinationRow(overrides: Record<string, unknown> = {}) {
  return destinationRow({
    id: 'dest_tenant',
    scope_type: 'shared',
    destination_kind: 'http_sink',
    provider: 'http',
    name: 'tenant-webhook',
    provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
    allowed_tenant_ids: JSON.stringify(['tenant-a']),
    allowed_log_types: JSON.stringify(['webhook']),
    allowed_planes: JSON.stringify(['external_sink']),
    ...overrides,
  });
}

function overrideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pol_1',
    tenant_id: 'tenant-a',
    log_type: 'webhook',
    plane: 'external_sink',
    destination_id: 'dest_tenant',
    fallback_policy_id: null,
    enabled: 1,
    managed_by: 'tenant',
    change_protection: 'confirm',
    approval_policy_id: null,
    policy_hash: null,
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: 1000,
    updated_at: 1000,
    version: 2,
    ...overrides,
  };
}

/** Answers queryOne by the table the SQL reads; unmatched queries return the given default. */
function routeQueryOne(
  routes: Array<[string, unknown]>,
  fallback: unknown = { id: 'sda_x', total: 0 }
) {
  mockAdapter.queryOne.mockImplementation(async (sql: string) => {
    for (const [fragment, row] of routes) {
      if (sql.includes(fragment)) return row;
    }
    return fallback;
  });
}

function refuse() {
  gate.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
  );
}

function lastDescriptor() {
  const call = gate.mock.calls.at(-1);
  expect(call).toBeTruthy();
  return call![1] as {
    operation: string;
    targetTenantId: string;
    targetIds?: string[];
    alsoCovers?: string[];
    params: Record<string, unknown>;
  };
}

function untouched(...extra: Array<ReturnType<typeof vi.fn>>) {
  expect(mockAdapter.execute).not.toHaveBeenCalled();
  expect(mockAdapter.batch).not.toHaveBeenCalled();
  expect(auditWrite).not.toHaveBeenCalled();
  for (const fn of extra) expect(fn).not.toHaveBeenCalled();
}

const json = { 'content-type': 'application/json' };
void json;

beforeEach(() => {
  vi.clearAllMocks();
  gate.mockReset();
  gate.mockResolvedValue(null);
  mockAdapter.query.mockReset().mockResolvedValue([]);
  mockAdapter.queryOne.mockReset().mockResolvedValue({ total: 0 });
  mockAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  mockAdapter.batch
    .mockReset()
    .mockImplementation(async (statements: unknown[]) =>
      statements.map(() => ({ rowsAffected: 1, success: true }))
    );
  mockAdapter.transaction
    .mockReset()
    .mockImplementation(async (cb: (a: unknown) => unknown) => cb(mockAdapter));
  envFixture = {
    DB_ADMIN: {},
    OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
    LOGGING_CURSOR_HMAC_SECRET: 'test-secret',
    LOG_ARCHIVE: bucket(),
    AUDIT_ARCHIVE: bucket(),
    SENSITIVE_DETAILS: bucket(),
    EXPORT_ARTIFACTS: bucket(),
    DIAGNOSTIC_LOGS: bucket(),
    AUTHRIM_CONFIG: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    },
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    LOGGING_DELIVERY_CRITICAL_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  };
});

describe('destinations: create and update', () => {
  const createBody = {
    scope_type: 'platform',
    scope_id: 'global',
    provider: 'r2',
    name: 'archive',
    display_name: 'Archive',
    provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' },
    allowed_log_types: ['audit', 'admin_audit'],
    critical_allowed: true,
    retention_days: 30,
  };
  const create = () =>
    send(
      [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE],
      'POST',
      '/api/admin/destinations',
      createBody
    );

  it('writes nothing when the gate refuses', async () => {
    refuse();
    expect((await create()).status).toBe(403);
    untouched();
  });

  it('binds the resulting destination state with digests, stable on repeat', async () => {
    expect((await create()).status).toBe(201);
    const first = lastDescriptor();
    expect(first).toMatchObject({
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
    });
    expect(first.params).toMatchObject({
      kind: 'destination.create',
      provider: 'r2',
      critical_allowed: true,
      retention_days: 30,
      allowed_log_types: ['admin_audit', 'audit'],
      provider_config_sha256: hex64,
    });
    expect(JSON.stringify(first.params)).not.toContain('AUDIT_ARCHIVE');
    expect(gate).toHaveBeenCalledTimes(1);

    await create();
    expect(lastDescriptor().params).toEqual(first.params);

    await send([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE], 'POST', '/api/admin/destinations', {
      ...createBody,
      provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: 'other' },
    });
    expect(lastDescriptor().params.provider_config_sha256).not.toBe(
      first.params.provider_config_sha256
    );
  });

  it('inserts a health_status the admin_destinations CHECK accepts (real SQL against the migration)', async () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql', import.meta.url)
      ),
      'utf8'
    );
    const start = migration.indexOf('CREATE TABLE admin_destinations (');
    const createTable = migration.slice(start, migration.indexOf(');', start) + 2);
    expect(createTable).toContain('CHECK (health_status IN');
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(createTable);
      expect((await create()).status).toBe(201);
      const insert = mockAdapter.execute.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO admin_destinations')
      );
      expect(insert).toBeTruthy();
      const params = (insert?.[1] as unknown[]).map((value) => value ?? null);
      // the statement itself is accepted by the real schema, CHECK constraints included
      database.prepare(String(insert?.[0])).run(...params);
      const row = database.prepare('SELECT health_status FROM admin_destinations').get() as {
        health_status: string;
      };
      expect(['unknown', 'healthy', 'degraded', 'failing', 'unreachable']).toContain(
        row.health_status
      );
    } finally {
      database.close();
    }
  });

  it('does not reach the gate for an invalid request', async () => {
    const response = await send(
      [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE],
      'POST',
      '/api/admin/destinations',
      { ...createBody, name: '' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  describe('PATCH /:id', () => {
    const patchBody = {
      scope_type: 'platform',
      scope_id: 'global',
      provider: 'r2',
      name: 'archive',
      display_name: 'Archive',
      provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
      retention_days: 30,
    };
    const patch = (body: Record<string, unknown>) =>
      send(
        [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE],
        'PATCH',
        '/api/admin/destinations/dest_1',
        {
          ...patchBody,
          ...body,
        }
      );

    beforeEach(() => {
      routeQueryOne([['FROM admin_destinations', destinationRow()]]);
      mockAdapter.query.mockResolvedValue(
        getDefaultDestinationCapabilities('r2').map((capability) => ({ capability }))
      );
    });

    it('does not gate a change that leaves delivery and retention alone', async () => {
      const response = await patch({ display_name: 'Renamed', description: 'new text' });
      expect(response.status).toBe(200);
      expect(gate).not.toHaveBeenCalled();
      const [statements] = mockAdapter.batch.mock.calls[0] as [Array<{ sql: string }>];
      expect(statements[0].sql).toContain('UPDATE admin_destinations');
    });

    it('does not gate a retention increase', async () => {
      expect((await patch({ retention_days: 90 })).status).toBe(200);
      expect(gate).not.toHaveBeenCalled();
    });

    it('gates a provider config change as webhook.destination.update and writes nothing on refusal', async () => {
      refuse();
      const response = await patch({ provider_config: { bindingRef: 'DIAGNOSTIC_LOGS' } });
      expect(response.status).toBe(403);
      untouched();
      expect(lastDescriptor()).toMatchObject({
        operation: 'webhook.destination.update',
        targetIds: ['dest_1'],
        params: { kind: 'destination.update', provider: 'r2' },
      });
    });

    it('gates allowlist and critical changes', async () => {
      await patch({ allowed_log_types: ['audit'] });
      expect(gate).toHaveBeenCalledTimes(1);
      await patch({ critical_allowed: true });
      expect(gate).toHaveBeenCalledTimes(2);
      expect(lastDescriptor().params.critical_allowed).toBe(true);
    });

    it('gates a retention decrease alone as audit.retention.shorten', async () => {
      expect((await patch({ retention_days: 7 })).status).toBe(200);
      expect(lastDescriptor()).toMatchObject({
        operation: 'audit.retention.shorten',
        params: { kind: 'destination.retention', retention_days: 7 },
      });
    });

    it('gates a combined change as webhook.destination.update with the retention bound', async () => {
      await patch({ retention_days: 7, provider_config: { bindingRef: 'DIAGNOSTIC_LOGS' } });
      expect(lastDescriptor().operation).toBe('webhook.destination.update');
      expect(lastDescriptor().params.retention_days).toBe(7);
      // The request also shortens retention, so the gate must cover that operation as well.
      expect(lastDescriptor().alsoCovers).toEqual(['audit.retention.shorten']);
    });

    it('carries alsoCovers only for the compound case', async () => {
      await patch({ provider_config: { bindingRef: 'DIAGNOSTIC_LOGS' } });
      expect(lastDescriptor().operation).toBe('webhook.destination.update');
      expect(lastDescriptor().alsoCovers).toBeUndefined();
      await patch({ provider_config: { bindingRef: 'DIAGNOSTIC_LOGS' }, retention_days: 90 });
      expect(lastDescriptor().alsoCovers).toBeUndefined();
      await patch({ retention_days: 7 });
      expect(lastDescriptor().operation).toBe('audit.retention.shorten');
      expect(lastDescriptor().alsoCovers).toBeUndefined();
    });

    it('checks the version before the gate', async () => {
      const response = await patch({ expected_version: 9, retention_days: 7 });
      expect(response.status).toBe(409);
      expect(gate).not.toHaveBeenCalled();
    });
  });
});

describe('destinations: enable and credentials', () => {
  it('enable: refused leaves the destination untouched; allowed binds the resulting state', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow({ lifecycle_status: 'disabled' })]]);
    refuse();
    const path = '/api/admin/destinations/dest_1/enable';
    const permissions = [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE];
    expect((await send(permissions, 'POST', path, {})).status).toBe(403);
    untouched();

    expect((await send(permissions, 'POST', path, {})).status).toBe(200);
    expect(lastDescriptor()).toMatchObject({
      operation: 'webhook.destination.update',
      targetIds: ['dest_1'],
      params: { kind: 'destination.enable', lifecycle_status: 'active' },
    });
  });

  it('disable is not gated', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow()]]);
    const response = await send(
      [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE],
      'POST',
      '/api/admin/destinations/dest_1/disable',
      { confirmation: 'FORCE DISABLE archive' }
    );
    expect(response.status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
  });

  it('delete is not gated', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow()]]);
    const response = await send(
      [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE],
      'DELETE',
      '/api/admin/destinations/dest_1',
      { confirmation: 'DELETE DESTINATION archive' }
    );
    expect(response.status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
  });

  describe('credentials/prepare', () => {
    const path = '/api/admin/destinations/dest_1/credentials/prepare';
    const permissions = [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE];
    const body = { secret_value: 'super-secret-token', backend: 'd1_encrypted_table' };

    beforeEach(() => {
      routeQueryOne([
        [
          'FROM admin_destinations',
          destinationRow({ provider: 'http', destination_kind: 'http_sink' }),
        ],
      ]);
    });

    it('does not write the secret backend when refused', async () => {
      refuse();
      expect((await send(permissions, 'POST', path, body)).status).toBe(403);
      untouched();
    });

    it('binds only the SHA-256 of the secret', async () => {
      await send(permissions, 'POST', path, body);
      const descriptor = lastDescriptor();
      expect(descriptor.operation).toBe('webhook.destination.update');
      expect(descriptor.params.secret_sha256).toBe(await sha256Hex('super-secret-token'));
      expect(JSON.stringify(descriptor)).not.toContain('super-secret-token');
    });

    it('does not reach the gate without a secret', async () => {
      expect(
        (await send(permissions, 'POST', path, { backend: 'd1_encrypted_table' })).status
      ).toBe(400);
      expect(gate).not.toHaveBeenCalled();
    });
  });

  describe('credentials/activate', () => {
    const path = '/api/admin/destinations/dest_1/credentials/activate';
    const permissions = [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE];
    const body = { confirmation: 'ACTIVATE CREDENTIAL archive' };

    it('gates a real switch and writes nothing when refused', async () => {
      routeQueryOne([
        [
          'FROM admin_destinations',
          destinationRow({
            rotation_status: 'ready',
            next_credential_ref: 'd1secret://x#v1',
            next_credential_version: 1,
          }),
        ],
      ]);
      refuse();
      expect((await send(permissions, 'POST', path, body)).status).toBe(403);
      untouched();

      expect((await send(permissions, 'POST', path, body)).status).toBe(200);
      expect(lastDescriptor()).toMatchObject({
        operation: 'webhook.destination.update',
        params: { kind: 'destination.credential.activate', credential_ref: 'd1secret://x#v1' },
      });
    });

    it('does not gate the no-credential path that only records a failure', async () => {
      routeQueryOne([['FROM admin_destinations', destinationRow()]]);
      await send(permissions, 'POST', path, body);
      expect(gate).not.toHaveBeenCalled();
    });

    it('does not reach the gate on a wrong confirmation', async () => {
      routeQueryOne([['FROM admin_destinations', destinationRow()]]);
      expect((await send(permissions, 'POST', path, { confirmation: 'no' })).status).toBe(400);
      expect(gate).not.toHaveBeenCalled();
    });
  });
});

describe('logging policy assignments and fallbacks', () => {
  const permissions = [ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE];
  const assignBody = {
    tenant_id: 'tenant-a',
    log_type: 'webhook',
    plane: 'external_sink',
    destination_id: 'dest_tenant',
  };

  beforeEach(() => {
    routeQueryOne([
      ['FROM logging_destination_overrides', overrideRow()],
      ['FROM admin_destinations', tenantDestinationRow()],
    ]);
  });

  it('POST /assignments: refused writes nothing; allowed binds the resulting assignment', async () => {
    const base = '/api/admin/logging-policies/assignments';
    refuse();
    expect((await send(permissions, 'POST', base, assignBody, ['ar_tenant_admin'])).status).toBe(
      403
    );
    untouched();

    expect((await send(permissions, 'POST', base, assignBody, ['ar_tenant_admin'])).status).toBe(
      201
    );
    expect(lastDescriptor()).toMatchObject({
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      params: {
        kind: 'logging.assignment.create',
        destination_id: 'dest_tenant',
        enabled: true,
        log_type: 'webhook',
      },
    });
  });

  it('POST /assignments: a request refused for permission never reaches the gate', async () => {
    const response = await send(
      permissions,
      'POST',
      '/api/admin/logging-policies/assignments',
      { ...assignBody, tenant_id: 'tenant-b' },
      ['ar_tenant_admin']
    );
    expect(response.status).toBe(403);
    expect(gate).not.toHaveBeenCalled();
  });

  it('PATCH /rows/:id and /:id: gated when the destination changes', async () => {
    routeQueryOne([
      ['FROM logging_destination_overrides', overrideRow({ destination_id: 'dest_old' })],
      ['FROM admin_destinations', tenantDestinationRow()],
    ]);
    refuse();
    const body = { ...assignBody, expected_version: 2 };
    expect(
      (
        await send(permissions, 'PATCH', '/api/admin/logging-policies/rows/pol_1', body, [
          'ar_tenant_admin',
        ])
      ).status
    ).toBe(403);
    untouched();

    expect(
      (
        await send(permissions, 'PATCH', '/api/admin/logging-policies/pol_1', body, [
          'ar_tenant_admin',
        ])
      ).status
    ).toBe(200);
    expect(lastDescriptor()).toMatchObject({
      operation: 'webhook.destination.update',
      targetIds: ['pol_1'],
      params: { kind: 'logging.assignment.update', destination_id: 'dest_tenant' },
    });
  });

  it('PATCH: a change that leaves delivery alone is not gated', async () => {
    const response = await send(
      permissions,
      'PATCH',
      '/api/admin/logging-policies/pol_1',
      { ...assignBody, expected_version: 2 },
      ['ar_tenant_admin']
    );
    expect(response.status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
  });

  it('PATCH: a version conflict never reaches the gate', async () => {
    const response = await send(
      permissions,
      'PATCH',
      '/api/admin/logging-policies/pol_1',
      { ...assignBody, destination_id: 'dest_other', expected_version: 1 },
      ['ar_tenant_admin']
    );
    expect(response.status).toBe(409);
    expect(gate).not.toHaveBeenCalled();
  });

  describe('rollback', () => {
    const history = {
      previous_destination_id: 'dest_old',
      previous_fallback_policy_id: null,
      previous_enabled: 1,
      previous_change_protection: 'confirm',
      previous_approval_policy_id: null,
      previous_policy_hash: null,
      previous_version: 1,
    };

    it('is gated on both routes and writes nothing when refused', async () => {
      routeQueryOne([
        ['logging_destination_override_history', history],
        ['FROM logging_destination_overrides', overrideRow()],
      ]);
      for (const base of ['rows', 'overrides']) {
        gate.mockClear();
        mockAdapter.execute.mockClear();
        refuse();
        const path = `/api/admin/logging-policies/${base}/pol_1/rollback`;
        expect((await send(permissions, 'POST', path, {}, ['ar_tenant_admin'])).status).toBe(403);
        untouched();
        expect((await send(permissions, 'POST', path, {}, ['ar_tenant_admin'])).status).toBe(200);
        expect(lastDescriptor()).toMatchObject({
          operation: 'webhook.destination.update',
          params: { kind: 'logging.assignment.rollback', destination_id: 'dest_old' },
        });
        auditWrite.mockClear();
      }
    });

    it('is not gated when the rollback restores the same delivery state', async () => {
      routeQueryOne([
        [
          'logging_destination_override_history',
          { ...history, previous_destination_id: 'dest_tenant' },
        ],
        ['FROM logging_destination_overrides', overrideRow()],
      ]);
      const response = await send(
        permissions,
        'POST',
        '/api/admin/logging-policies/rows/pol_1/rollback',
        {},
        ['ar_tenant_admin']
      );
      expect(response.status).toBe(200);
      expect(gate).not.toHaveBeenCalled();
    });
  });

  describe('fallbacks', () => {
    const fallbackBody = {
      scope_type: 'platform',
      scope_id: 'global',
      log_type: 'audit',
      plane: 'archive',
      fallback_destination_id: 'dest_fb',
      failure_mode: 'platform_default',
      confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
    };
    const fbPermissions = [
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
    ];
    const fbDestination = destinationRow({
      id: 'dest_fb',
      critical_allowed: 1,
      default_fallback_eligible: 1,
      allowed_log_types: JSON.stringify(['audit']),
      allowed_planes: JSON.stringify(['archive']),
    });

    it('POST /fallbacks: refused writes nothing; allowed binds the fallback', async () => {
      routeQueryOne([
        ['SELECT id FROM logging_fallback_policies', null],
        ['FROM admin_destinations', fbDestination],
      ]);
      refuse();
      const path = '/api/admin/logging-policies/fallbacks';
      expect((await send(fbPermissions, 'POST', path, fallbackBody)).status).toBe(403);
      untouched();
      expect((await send(fbPermissions, 'POST', path, fallbackBody)).status).toBe(201);
      expect(lastDescriptor()).toMatchObject({
        operation: 'webhook.destination.update',
        params: {
          kind: 'logging.fallback.create',
          fallback_destination_id: 'dest_fb',
          failure_mode: 'platform_default',
        },
      });
    });

    it('POST /fallbacks: a taken scope/log_type/plane is a 409 before the gate', async () => {
      routeQueryOne([
        ['SELECT id FROM logging_fallback_policies', { id: 'fb_existing' }],
        ['FROM admin_destinations', fbDestination],
      ]);
      const response = await send(
        fbPermissions,
        'POST',
        '/api/admin/logging-policies/fallbacks',
        fallbackBody
      );
      expect(response.status).toBe(409);
      expect(gate).not.toHaveBeenCalled();
      untouched();
    });

    it('PATCH /fallbacks/:id: moving onto a taken key is a 409 before the gate', async () => {
      routeQueryOne([
        ['SELECT id FROM logging_fallback_policies', { id: 'fb_other' }],
        [
          'FROM logging_fallback_policies',
          {
            id: 'fb_1',
            scope_type: 'platform',
            scope_id: 'global',
            log_type: 'webhook',
            plane: 'external_sink',
            fallback_destination_id: 'dest_fb',
            failure_mode: 'platform_default',
            created_at: 1,
            updated_at: 1,
            version: 1,
          },
        ],
        ['FROM admin_destinations', fbDestination],
      ]);
      const response = await send(
        fbPermissions,
        'PATCH',
        '/api/admin/logging-policies/fallbacks/fb_1',
        fallbackBody
      );
      expect(response.status).toBe(409);
      expect(gate).not.toHaveBeenCalled();
      untouched();
    });

    it('POST /fallbacks: a non-fallback destination never reaches the gate', async () => {
      routeQueryOne([
        ['FROM admin_destinations', { ...fbDestination, default_fallback_eligible: 0 }],
      ]);
      const response = await send(
        fbPermissions,
        'POST',
        '/api/admin/logging-policies/fallbacks',
        fallbackBody
      );
      expect(response.status).toBe(400);
      expect(gate).not.toHaveBeenCalled();
    });

    it('PATCH /fallbacks/:id: gated only when the fallback changes', async () => {
      const current = {
        id: 'fb_1',
        scope_type: 'platform',
        scope_id: 'global',
        log_type: 'audit',
        plane: 'archive',
        fallback_destination_id: 'dest_old',
        failure_mode: 'platform_default',
        created_at: 1,
        updated_at: 1,
        version: 1,
      };
      routeQueryOne([
        ['FROM logging_fallback_policies', current],
        ['FROM admin_destinations', fbDestination],
      ]);
      const path = '/api/admin/logging-policies/fallbacks/fb_1';
      refuse();
      expect((await send(fbPermissions, 'PATCH', path, fallbackBody)).status).toBe(403);
      untouched();
      expect(lastDescriptor()).toMatchObject({
        params: { kind: 'logging.fallback.update', fallback_destination_id: 'dest_fb' },
        targetIds: ['fb_1'],
      });

      gate.mockClear();
      routeQueryOne([
        ['FROM logging_fallback_policies', { ...current, fallback_destination_id: 'dest_fb' }],
        ['FROM admin_destinations', fbDestination],
      ]);
      expect((await send(fbPermissions, 'PATCH', path, fallbackBody)).status).toBe(200);
      expect(gate).not.toHaveBeenCalled();
    });
  });
});

describe('notification delivery routes', () => {
  const path = '/api/admin/notifications/delivery-routes';
  const permissions = [ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE];
  const body = (provider: string) => ({
    name: 'Ops',
    scope_type: 'platform',
    provider,
    destination_id: 'dest_ops',
    categories: ['b', 'a'],
  });

  beforeEach(() => {
    routeQueryOne([
      [
        'SELECT provider_config FROM admin_destinations',
        { provider_config: JSON.stringify({ url: 'https://hooks.example.test/x' }) },
      ],
    ]);
  });

  it('refused writes nothing', async () => {
    refuse();
    expect((await send(permissions, 'POST', path, body('webhook'))).status).toBe(403);
    untouched();
  });

  it('gates every provider and binds the destination URL as a digest', async () => {
    for (const provider of ['webhook', 'slack', 'custom', 'email']) {
      expect((await send(permissions, 'POST', path, body(provider))).status).toBe(201);
      expect(lastDescriptor()).toMatchObject({
        operation: 'webhook.destination.update',
        params: {
          kind: 'notification.delivery_route.create',
          provider,
          destination_id: 'dest_ops',
          categories: ['a', 'b'],
          destination_url_sha256: await sha256Hex('https://hooks.example.test/x'),
        },
      });
    }
    expect(JSON.stringify(gate.mock.calls)).not.toContain('hooks.example.test');
  });

  it('does not reach the gate for an invalid request', async () => {
    expect(
      (await send(permissions, 'POST', path, { ...body('webhook'), provider: 'sms' })).status
    ).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('admin-logging policies', () => {
  it('critical-policy: gated when it changes, refused writes nothing', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow({ name: 'crit' })]]);
    const path = '/api/admin/admin-logging/critical-policy';
    const permissions = [ADMIN_PERMISSIONS.ADMIN_LOGGING_CRITICAL_UPDATE];
    const body = {
      destination_id: 'dest_1',
      critical_allowed: true,
      confirmation: 'UPDATE CRITICAL LOGGING crit',
    };
    refuse();
    expect((await send(permissions, 'PATCH', path, body)).status).toBe(403);
    untouched();

    await send(permissions, 'PATCH', path, body);
    expect(lastDescriptor()).toMatchObject({
      operation: 'webhook.destination.update',
      targetIds: ['dest_1'],
      params: { kind: 'logging.critical_policy.update', critical_allowed: true },
    });

    // Always gated, even when the values equal the stored ones: the repository writes them
    // unconditionally, so a no-op-looking request could otherwise undo a concurrent change.
    gate.mockClear();
    await send(permissions, 'PATCH', path, { ...body, critical_allowed: false });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('critical-policy: a wrong confirmation never reaches the gate', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow({ name: 'crit' })]]);
    const response = await send(
      [ADMIN_PERMISSIONS.ADMIN_LOGGING_CRITICAL_UPDATE],
      'PATCH',
      '/api/admin/admin-logging/critical-policy',
      { destination_id: 'dest_1', confirmation: 'no' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('sensitive-detail-policy: gated before the write, refused writes nothing', async () => {
    routeQueryOne([
      [
        'FROM admin_destinations',
        destinationRow({
          id: 'dest_s',
          critical_allowed: 1,
          allowed_planes: JSON.stringify(['sensitive_detail']),
          allowed_log_types: JSON.stringify(['webhook']),
        }),
      ],
    ]);
    const path = '/api/admin/admin-logging/sensitive-detail-policy';
    const permissions = [ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE];
    const body = {
      log_type: 'webhook',
      destination_id: 'dest_s',
      confirmation: 'CHANGE SENSITIVE DETAIL webhook',
    };
    refuse();
    expect((await send(permissions, 'PATCH', path, body)).status).toBe(403);
    untouched();
    expect(mockAdapter.transaction).not.toHaveBeenCalled();

    await send(permissions, 'PATCH', path, body);
    expect(lastDescriptor()).toMatchObject({
      operation: 'webhook.destination.update',
      params: {
        kind: 'logging.sensitive_detail_policy.update',
        destination_id: 'dest_s',
        enabled: true,
      },
    });
  });

  it('sensitive-detail-policy: missing destination never reaches the gate', async () => {
    const response = await send(
      [ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE],
      'PATCH',
      '/api/admin/admin-logging/sensitive-detail-policy',
      { log_type: 'webhook' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  describe('dangerous catalog repair apply', () => {
    const object = {
      id: 'obj_1',
      tenant_key: 'tk',
      log_type: 'audit',
      plane: 'archive',
      object_key: 'logs/tk/a.jsonl',
      object_kind: 'chunk',
      status: 'committed',
      record_count: 3,
      byte_count: 300,
    };
    const path = '/api/admin/admin-logging/catalog-repairs/dangerous/apply';
    const permissions = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];
    const body = {
      action: 'purge_record_indexes',
      object_catalog_id: 'obj_1',
      confirmation: 'CONFIRM PURGE_RECORD_INDEXES obj_1',
    };

    it('refused changes nothing; allowed is audit.retention.shorten', async () => {
      routeQueryOne([['log_object_catalog', object]], object);
      refuse();
      expect((await send(permissions, 'POST', path, body)).status).toBe(403);
      untouched();

      expect((await send(permissions, 'POST', path, body)).status).toBe(200);
      expect(lastDescriptor()).toMatchObject({
        operation: 'audit.retention.shorten',
        params: {
          kind: 'logging.catalog_repair.dangerous_apply',
          action: 'purge_record_indexes',
          object_catalog_id: 'obj_1',
        },
      });
    });

    it('a confirmation mismatch never reaches the gate', async () => {
      routeQueryOne([['log_object_catalog', object]], object);
      const response = await send(permissions, 'POST', path, { ...body, confirmation: 'wrong' });
      expect(response.status).toBe(400);
      expect(gate).not.toHaveBeenCalled();
    });
  });
});

describe('DLQ delete and purge', () => {
  const item = {
    id: 'dlq_1',
    tenant_key: 'tk',
    payload_type: 'audit_queue_message',
    schema_version: 1,
    lane: 'critical',
    destination_id: null,
    payload_object_ref: 'dlq/tenant_key=tk/item.json',
    error_class: 'x',
    attempt_count: 5,
    status: 'open',
    created_at: 1000,
    updated_at: 1000,
  };

  beforeEach(() => {
    // tenant-key access resolves through the (mocked) context; any tenant works for a platform role.
    routeQueryOne([
      ['FROM logging_dlq_items', item],
      ['tenant_backup_snapshots', null],
    ]);
  });

  it('delete: refused leaves the item open', async () => {
    const path = '/api/admin/logging-policies/dlq-items/dlq_1/delete';
    refuse();
    expect((await send([ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE], 'POST', path, {})).status).toBe(403);
    untouched();

    expect((await send([ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE], 'POST', path, {})).status).toBe(200);
    expect(lastDescriptor()).toMatchObject({
      operation: 'audit.retention.shorten',
      targetIds: ['dlq_1'],
      params: { kind: 'logging.dlq.delete', next_status: 'deleted' },
    });
  });

  it('purge: refused deletes no R2 payload', async () => {
    const path = '/api/admin/logging-policies/dlq-items/dlq_1/purge';
    const body = { confirmation: 'PURGE DLQ dlq_1' };
    const auditBucket = envFixture.AUDIT_ARCHIVE as ReturnType<typeof bucket>;
    refuse();
    expect((await send([ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE], 'POST', path, body)).status).toBe(
      403
    );
    untouched(auditBucket.delete);

    expect((await send([ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE], 'POST', path, body)).status).toBe(
      200
    );
    expect(auditBucket.delete).toHaveBeenCalledWith(item.payload_object_ref);
    expect(lastDescriptor()).toMatchObject({
      operation: 'audit.retention.shorten',
      params: { kind: 'logging.dlq.purge', payload_object_ref: item.payload_object_ref },
    });
  });

  it('purge: a wrong confirmation never reaches the gate', async () => {
    const response = await send(
      [ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE],
      'POST',
      '/api/admin/logging-policies/dlq-items/dlq_1/purge',
      { confirmation: 'PURGE' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('purge: a capturing backup snapshot refuses before the gate', async () => {
    routeQueryOne([
      ['FROM logging_dlq_items', item],
      ['tenant_backup_snapshots', { id: 'snap' }],
    ]);
    const response = await send(
      [ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE],
      'POST',
      '/api/admin/logging-policies/dlq-items/dlq_1/purge',
      { confirmation: 'PURGE DLQ dlq_1' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();

    // The same request with no backup capturing reaches the gate: the 400 above was the snapshot.
    routeQueryOne([
      ['FROM logging_dlq_items', item],
      ['tenant_backup_snapshots', null],
    ]);
    await send(
      [ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE],
      'POST',
      '/api/admin/logging-policies/dlq-items/dlq_1/purge',
      { confirmation: 'PURGE DLQ dlq_1' }
    );
    expect(gate).toHaveBeenCalledTimes(1);
  });
});

describe('policy snapshot publishing', () => {
  const draft = {
    schemaVersion: 1,
    snapshotId: 'snap_draft',
    scopeType: 'platform',
    scopeId: 'global',
    version: 5,
    policyHash: 'a'.repeat(64),
    synchronizedAt: 1714550400000,
    sourceUpdatedAt: 1714550300000,
    expiresAt: null,
    policies: { assignments: [], fallbacks: [], destinations: [] },
  };
  const permissions = [ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH];

  it('drafts/:id/publish: refused writes no KV, R2 or row', async () => {
    routeQueryOne([
      [
        'FROM logging_policy_snapshots',
        {
          id: 'snap_draft',
          scope_type: 'platform',
          scope_id: 'global',
          version: 5,
          status: 'draft',
          policy_hash: draft.policyHash,
          snapshot_json: JSON.stringify(draft),
        },
      ],
    ]);
    const path = '/api/admin/logging-policies/drafts/snap_draft/publish';
    const body = { expected_version: 5, confirmation: 'PUBLISH LOGGING POLICY platform:global' };
    const kv = (envFixture.AUTHRIM_CONFIG as { put: ReturnType<typeof vi.fn> }).put;
    const r2 = (envFixture.LOG_ARCHIVE as ReturnType<typeof bucket>).put;
    refuse();
    expect((await send(permissions, 'POST', path, body)).status).toBe(403);
    untouched(kv, r2);

    expect((await send(permissions, 'POST', path, body)).status).toBe(200);
    expect(lastDescriptor()).toMatchObject({
      operation: 'logging.policy.publish',
      targetIds: ['snap_draft'],
      params: {
        kind: 'logging.policy.publish_draft',
        scope_type: 'platform',
        scope_id: 'global',
        version: 5,
        policy_hash: draft.policyHash,
        policies_sha256: hex64,
      },
    });
    // The generated snapshot id and timestamps are not part of the bound parameters.
    expect(JSON.stringify(lastDescriptor().params)).not.toContain('1714550400000');

    // A confirmation mismatch is refused before the gate.
    gate.mockClear();
    const mismatch = await send(permissions, 'POST', path, { ...body, confirmation: 'no' });
    expect(mismatch.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('snapshots: refused publishes nothing; parameters are stable on repeat', async () => {
    mockAdapter.queryOne.mockResolvedValue({ next_version: 3 });
    mockAdapter.query.mockResolvedValue([]);
    const path = '/api/admin/logging-policies/snapshots';
    const body = { scope_type: 'platform', scope_id: 'global' };
    const kv = (envFixture.AUTHRIM_CONFIG as { put: ReturnType<typeof vi.fn> }).put;
    const r2 = (envFixture.LOG_ARCHIVE as ReturnType<typeof bucket>).put;
    refuse();
    expect((await send(permissions, 'POST', path, body)).status).toBe(403);
    untouched(kv, r2);

    expect((await send(permissions, 'POST', path, body)).status).toBe(200);
    const first = lastDescriptor();
    expect(first.operation).toBe('logging.policy.publish');
    expect(first.params).toMatchObject({
      kind: 'logging.policy.publish_snapshot',
      version: 3,
      policy_hash: hex64,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(permissions, 'POST', path, body);
    expect(lastDescriptor().params).toEqual(first.params);
  });

  it('snapshots: an invalid body never reaches the gate', async () => {
    const response = await send(permissions, 'POST', '/api/admin/logging-policies/snapshots', {
      scope_type: 'bogus',
    });
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('exports', () => {
  const path = '/api/admin/logging-policies/exports';
  const permissions = [EXPORT_CREATE, SENSITIVE_EXPORT];
  const base = { format: 'jsonl', tenant_id: 'tenant-a', log_type: 'audit', limit: 10 };

  it('plain catalog exports are not gated', async () => {
    const response = await send(permissions, 'POST', path, { ...base, plane: 'archive' });
    expect(response.status).toBe(202);
    expect(gate).not.toHaveBeenCalled();
  });

  it.each([
    ['sensitive_detail plane', { plane: 'sensitive_detail' }],
    [
      'include_payload on a record index',
      { plane: 'archive', include_records: true, include_payload: true },
    ],
    ['detail_scope full', { plane: 'archive', detail_scope: 'full' }],
  ])('%s is gated as log.sensitive.export and refusal writes nothing', async (_name, extra) => {
    const bucketPut = (envFixture.AUDIT_ARCHIVE as ReturnType<typeof bucket>).put;
    refuse();
    expect((await send(permissions, 'POST', path, { ...base, ...extra })).status).toBe(403);
    untouched(bucketPut);

    expect((await send(permissions, 'POST', path, { ...base, ...extra })).status).toBe(202);
    const descriptor = lastDescriptor();
    expect(descriptor.operation).toBe('log.sensitive.export');
    expect(descriptor.targetTenantId).toBe('tenant-a');
    expect(descriptor.params).toMatchObject({
      kind: 'logging.export.create',
      format: 'jsonl',
      log_type: 'audit',
      limit: 10,
    });
    expect(['plane', 'include_payload', 'detail_scope'].every((k) => k in descriptor.params)).toBe(
      true
    );
  });

  it('a request refused for the missing sensitive permission never reaches the gate', async () => {
    const response = await send([EXPORT_CREATE], 'POST', path, {
      ...base,
      plane: 'sensitive_detail',
    });
    expect(response.status).toBe(403);
    expect(gate).not.toHaveBeenCalled();
  });
});

/** Makes the UPDATE whose SQL contains `fragment` lose the race: no row matches the version. */
function loseRaceOn(fragment: string) {
  mockAdapter.execute.mockImplementation(async (sql: string) =>
    sql.includes(fragment) ? { rowsAffected: 0 } : { rowsAffected: 1 }
  );
}

function executedSql(): string[] {
  return mockAdapter.execute.mock.calls.map((call) => String(call[0]));
}

describe('compare-then-write races', () => {
  describe('destination PATCH is one guarded batch', () => {
    const patchBody = (overrides: Record<string, unknown>) => ({
      scope_type: 'platform',
      scope_id: 'global',
      provider: 'r2',
      name: 'archive',
      display_name: 'Renamed',
      provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
      retention_days: 30,
      ...overrides,
    });
    const patch = (body: Record<string, unknown>) =>
      send(
        [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE],
        'PATCH',
        '/api/admin/destinations/dest_1',
        patchBody(body)
      );
    type Statement = { sql: string; params: unknown[] };

    beforeEach(() => {
      routeQueryOne([['FROM admin_destinations', destinationRow({ version: 4 })]]);
      mockAdapter.query.mockResolvedValue(
        getDefaultDestinationCapabilities('r2').map((capability) => ({ capability }))
      );
    });

    it('puts the version CAS and every guarded child statement in one batch, with no separate writes', async () => {
      expect((await patch({ allowed_log_types: ['audit'] })).status).toBe(200);
      expect(mockAdapter.execute).not.toHaveBeenCalled();
      expect(mockAdapter.batch).toHaveBeenCalledTimes(1);
      const statements = mockAdapter.batch.mock.calls[0][0] as Statement[];
      expect(statements[0].sql).toContain('UPDATE admin_destinations');
      expect(statements[0].sql).toContain('version = ?');
      expect(statements[0].params.at(-1)).toBe(4);
      const children = statements.slice(1);
      expect(children.length).toBeGreaterThan(2);
      for (const child of children) {
        expect(child.sql).toContain('EXISTS (SELECT 1 FROM admin_destinations');
        // the guard asks for the version this request writes (4 + 1) and its own actor
        expect(child.params.slice(-7)).toEqual([
          'dest_1',
          5,
          expect.any(Number),
          'admin-1',
          '',
          JSON.stringify(['audit']),
          '',
        ]);
      }
    });

    it('a lost CAS answers 409 and writes nothing else', async () => {
      mockAdapter.batch.mockImplementation(async (statements: unknown[]) =>
        statements.map((_, index) => ({ rowsAffected: index === 0 ? 0 : 0, success: true }))
      );
      const response = await patch({});
      expect(response.status).toBe(409);
      expect(gate).not.toHaveBeenCalled();
      expect(auditWrite).not.toHaveBeenCalled();
    });

    it('interleaving: a second request that read the same version changes none of the children', async () => {
      // A minimal store that applies each statement the way SQL would: the CAS on the parent, and
      // child statements only when their guard matches the parent as it is at that moment.
      const parent = { version: 4, updated_at: 1, updated_by: 'someone', allowed_log_types: '' };
      const children: string[] = [];
      mockAdapter.batch.mockImplementation(async (statements: Statement[]) => {
        const results: Array<{ rowsAffected: number }> = [];
        for (const { sql, params } of statements) {
          if (sql.startsWith('UPDATE admin_destinations')) {
            const expected = params.at(-1);
            if (parent.version === expected) {
              parent.version += 1;
              parent.updated_at = params[params.length - 3] as number;
              parent.updated_by = String(params[params.length - 4]);
              parent.allowed_log_types = (params[9] as string | null) ?? '';
              results.push({ rowsAffected: 1 });
            } else results.push({ rowsAffected: 0 });
            continue;
          }
          const [, guardVersion, guardUpdatedAt, guardActor, , guardLogTypes] = params.slice(-7);
          const holds =
            parent.version === guardVersion &&
            parent.updated_at === guardUpdatedAt &&
            parent.updated_by === guardActor &&
            parent.allowed_log_types === guardLogTypes;
          if (holds) children.push(sql.split(' ')[0]);
          results.push({ rowsAffected: holds ? 1 : 0 });
        }
        return results;
      });
      const first = await patch({ allowed_log_types: ['audit'] });
      const childrenAfterFirst = children.length;
      const second = await patch({ allowed_log_types: ['audit', 'webhook'] });
      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(children.length).toBe(childrenAfterFirst);
    });
  });

  it('credentials/activate: the failure-recording write is conditional too', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow({ version: 2 })]]);
    loseRaceOn('UPDATE admin_destinations');
    const response = await send(
      [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE],
      'POST',
      '/api/admin/destinations/dest_1/credentials/activate',
      { confirmation: 'ACTIVATE CREDENTIAL archive' }
    );
    expect(response.status).toBe(409);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  const tenantPermissions = [ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE];

  it('assignment PATCH: 409 and no history row on a lost race', async () => {
    routeQueryOne([
      ['FROM logging_destination_overrides', overrideRow({ destination_id: 'dest_old' })],
      ['FROM admin_destinations', tenantDestinationRow()],
    ]);
    loseRaceOn('UPDATE logging_destination_overrides');
    const response = await send(
      tenantPermissions,
      'PATCH',
      '/api/admin/logging-policies/pol_1',
      {
        tenant_id: 'tenant-a',
        log_type: 'webhook',
        plane: 'external_sink',
        destination_id: 'dest_tenant',
        expected_version: 2,
      },
      ['ar_tenant_admin']
    );
    expect(response.status).toBe(409);
    const update = mockAdapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE logging_destination_overrides')
    );
    expect((update?.[1] as unknown[]).at(-1)).toBe(2);
    expect(executedSql().some((sql) => sql.includes('logging_destination_override_history'))).toBe(
      false
    );
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('assignment rollback: 409 and no history row on a lost race', async () => {
    routeQueryOne([
      [
        'logging_destination_override_history',
        {
          previous_destination_id: 'dest_old',
          previous_fallback_policy_id: null,
          previous_enabled: 1,
          previous_change_protection: 'confirm',
          previous_approval_policy_id: null,
          previous_policy_hash: null,
          previous_version: 1,
        },
      ],
      ['FROM logging_destination_overrides', overrideRow()],
    ]);
    loseRaceOn('UPDATE logging_destination_overrides');
    const response = await send(
      tenantPermissions,
      'POST',
      '/api/admin/logging-policies/rows/pol_1/rollback',
      {},
      ['ar_tenant_admin']
    );
    expect(response.status).toBe(409);
    expect(
      executedSql().some((sql) => sql.includes('INSERT INTO logging_destination_override_history'))
    ).toBe(false);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('fallback PATCH: 409 on a lost race', async () => {
    const current = {
      id: 'fb_1',
      scope_type: 'platform',
      scope_id: 'global',
      log_type: 'audit',
      plane: 'archive',
      fallback_destination_id: 'dest_fb',
      failure_mode: 'platform_default',
      created_at: 1,
      updated_at: 1,
      version: 3,
    };
    routeQueryOne([
      ['FROM logging_fallback_policies', current],
      [
        'FROM admin_destinations',
        destinationRow({
          id: 'dest_fb',
          critical_allowed: 1,
          default_fallback_eligible: 1,
          allowed_log_types: JSON.stringify(['audit']),
          allowed_planes: JSON.stringify(['archive']),
        }),
      ],
    ]);
    loseRaceOn('UPDATE logging_fallback_policies');
    const response = await send(
      [
        ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
        ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
      ],
      'PATCH',
      '/api/admin/logging-policies/fallbacks/fb_1',
      {
        scope_type: 'platform',
        scope_id: 'global',
        log_type: 'audit',
        plane: 'archive',
        fallback_destination_id: 'dest_fb',
        failure_mode: 'platform_default',
        confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
      }
    );
    expect(response.status).toBe(409);
    const update = mockAdapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE logging_fallback_policies')
    );
    expect((update?.[1] as unknown[]).at(-1)).toBe(3);
    expect(auditWrite).not.toHaveBeenCalled();
  });
});

describe('sensitive export download', () => {
  const exportRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'lexp_1',
    tenant_key: 'tk',
    log_type: 'audit',
    plane: 'archive',
    format: 'csv',
    status: 'completed',
    artifact_object_ref: 'logging-exports/v1/lexp_1/records.csv',
    manifest_object_ref: 'logging-exports/v1/lexp_1/manifest.json',
    checksum_sha256: 'abc123',
    record_count: 1,
    byte_count: 42,
    requested_by: 'admin-1',
    error_class: null,
    filter_json: '{}',
    created_at: 1000,
    updated_at: 1000,
    completed_at: 1000,
    expires_at: 2000,
    ...overrides,
  });
  const path = '/api/admin/logging-policies/exports/lexp_1/artifact';
  const permissions = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ, SENSITIVE_EXPORT];
  const download = () => createApp(permissions).request(path, {}, env());
  const exportsBucket = () => envFixture.EXPORT_ARTIFACTS as ReturnType<typeof bucket>;

  beforeEach(() => {
    exportsBucket().get.mockResolvedValue({
      text: vi.fn().mockResolvedValue('a,b\n'),
    });
  });

  it('a plain export downloads without the gate', async () => {
    routeQueryOne([['FROM logging_export_jobs', exportRow()]]);
    expect((await download()).status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
  });

  it.each([
    ['sensitive_detail plane', { plane: 'sensitive_detail' }],
    ['include_payload', { filter_json: JSON.stringify({ include_payload: true }) }],
    ['detail_scope full', { filter_json: JSON.stringify({ detail_scope: 'full' }) }],
    ['unreadable filter', { filter_json: '{not json' }],
  ])('%s: gated as log.sensitive.export, refusal reads nothing', async (_name, overrides) => {
    routeQueryOne([['FROM logging_export_jobs', exportRow(overrides)]]);
    refuse();
    expect((await download()).status).toBe(403);
    expect(exportsBucket().get).not.toHaveBeenCalled();

    expect((await download()).status).toBe(200);
    expect(lastDescriptor()).toMatchObject({
      operation: 'log.sensitive.export',
      targetTenantId: 'tenant-a',
      targetIds: ['lexp_1'],
      params: {
        kind: 'logging.export.download',
        export_id: 'lexp_1',
        tenant_key: 'tk',
        checksum_sha256: 'abc123',
        manifest_object_ref: 'logging-exports/v1/lexp_1/manifest.json',
      },
    });
  });

  it('a missing artifact object is a 404 before the gate', async () => {
    routeQueryOne([['FROM logging_export_jobs', exportRow({ plane: 'sensitive_detail' })]]);
    exportsBucket().head.mockResolvedValue(null);
    expect((await download()).status).toBe(404);
    expect(gate).not.toHaveBeenCalled();
    expect(exportsBucket().get).not.toHaveBeenCalled();
  });

  it('an oversized artifact object is refused before the gate', async () => {
    routeQueryOne([['FROM logging_export_jobs', exportRow({ plane: 'sensitive_detail' })]]);
    exportsBucket().head.mockResolvedValue({ size: 1024 * 1024 * 1024 });
    expect((await download()).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('an invalid object ref is refused before the gate', async () => {
    routeQueryOne([
      [
        'FROM logging_export_jobs',
        exportRow({ plane: 'sensitive_detail', artifact_object_ref: 'elsewhere/x.csv' }),
      ],
    ]);
    expect((await download()).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('receipt is not spent on a request that then fails', () => {
  const snapshotPermissions = [ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH];

  it('snapshots: an expires_at under 60 s is refused before the gate', async () => {
    const response = await send(
      snapshotPermissions,
      'POST',
      '/api/admin/logging-policies/snapshots',
      { scope_type: 'platform', scope_id: 'global', expires_at: Date.now() + 30_000 }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
    untouched();
  });

  it('snapshots: an expires_at of at least 60 s reaches the gate', async () => {
    mockAdapter.queryOne.mockResolvedValue({ next_version: 1 });
    const response = await send(
      snapshotPermissions,
      'POST',
      '/api/admin/logging-policies/snapshots',
      { scope_type: 'platform', scope_id: 'global', expires_at: Date.now() + 120_000 }
    );
    expect(response.status).toBe(200);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('drafts/:id/publish: a stored draft expiring within 60 s is refused before the gate', async () => {
    const synchronizedAt = Date.now() - 10_000;
    const draft = {
      schemaVersion: 1,
      snapshotId: 'snap_d',
      scopeType: 'platform',
      scopeId: 'global',
      version: 1,
      policyHash: 'b'.repeat(64),
      synchronizedAt,
      sourceUpdatedAt: synchronizedAt,
      expiresAt: Date.now() + 30_000,
      policies: { assignments: [], fallbacks: [], destinations: [] },
    };
    routeQueryOne([
      [
        'FROM logging_policy_snapshots',
        {
          id: 'snap_d',
          scope_type: 'platform',
          scope_id: 'global',
          version: 1,
          status: 'draft',
          policy_hash: draft.policyHash,
          snapshot_json: JSON.stringify(draft),
        },
      ],
    ]);
    const response = await send(
      snapshotPermissions,
      'POST',
      '/api/admin/logging-policies/drafts/snap_d/publish',
      { confirmation: 'PUBLISH LOGGING POLICY platform:global' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
    untouched();
  });

  it('sensitive export: a missing payload encryption key is refused before the gate', async () => {
    delete envFixture.OBJECT_ENCRYPTION_ROOT_KEY;
    const response = await send(
      [EXPORT_CREATE, SENSITIVE_EXPORT],
      'POST',
      '/api/admin/logging-policies/exports',
      { format: 'jsonl', tenant_id: 'tenant-a', log_type: 'audit', plane: 'sensitive_detail' }
    );
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
    untouched();
  });
});

describe('credential prepare, enable and late validation races', () => {
  const prepPath = '/api/admin/destinations/dest_1/credentials/prepare';
  const prepPermissions = [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE];
  const prepBody = { secret_value: 'secret-1', backend: 'd1_encrypted_table' };
  const httpDestination = () =>
    destinationRow({
      provider: 'http',
      destination_kind: 'http_sink',
      credential_version: 1,
      next_credential_version: 2,
      version: 7,
    });

  it('prepare reserves the version on the row before the secret is written', async () => {
    routeQueryOne([['FROM admin_destinations', httpDestination()]]);
    expect((await send(prepPermissions, 'POST', prepPath, prepBody)).status).toBe(200);
    const sql = executedSql();
    const reserve = sql.findIndex((text) => text.includes('UPDATE admin_destinations'));
    const secretWrite = sql.findIndex((text) => text.includes('credential_secret'));
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(secretWrite).toBeGreaterThan(reserve);
    const reservation = mockAdapter.execute.mock.calls[reserve];
    expect(String(reservation[0])).toContain('version = ?');
    // reserved next version = max(1, 2) + 1, compared against the version that was read
    expect(reservation[1]).toEqual([3, 'admin-1', expect.any(Number), 'dest_1', 7]);
  });

  it('a prepare that lost the reservation answers 409 and never writes the secret', async () => {
    routeQueryOne([['FROM admin_destinations', httpDestination()]]);
    loseRaceOn('UPDATE admin_destinations');
    const response = await send(prepPermissions, 'POST', prepPath, prepBody);
    expect(response.status).toBe(409);
    expect(executedSql().some((text) => text.includes('credential_secret'))).toBe(false);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('a prepare whose reservation was taken over answers 409 on the final write', async () => {
    routeQueryOne([['FROM admin_destinations', httpDestination()]]);
    let updates = 0;
    mockAdapter.execute.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE admin_destinations') && ++updates === 2
        ? { rowsAffected: 0 }
        : { rowsAffected: 1 }
    );
    const response = await send(prepPermissions, 'POST', prepPath, prepBody);
    expect(response.status).toBe(409);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('enable: the write is conditional on the version that was read', async () => {
    routeQueryOne([['FROM admin_destinations', destinationRow({ version: 6 })]]);
    loseRaceOn('UPDATE admin_destinations');
    const response = await send(
      [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE],
      'POST',
      '/api/admin/destinations/dest_1/enable',
      {}
    );
    expect(response.status).toBe(409);
    const update = mockAdapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE admin_destinations')
    );
    expect(String(update?.[0])).toContain('version = ?');
    expect((update?.[1] as unknown[]).at(-1)).toBe(6);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('snapshots: an expiry that drops under 60 s while the snapshot is built is refused before the gate', async () => {
    const start = Date.now();
    let clock = start;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      mockAdapter.queryOne.mockImplementation(async () => {
        clock += 10_000; // the database reads take 10 s
        return { next_version: 1 };
      });
      const response = await send(
        [ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH],
        'POST',
        '/api/admin/logging-policies/snapshots',
        { scope_type: 'platform', scope_id: 'global', expires_at: start + 65_000 }
      );
      expect(response.status).toBe(400);
      expect(gate).not.toHaveBeenCalled();
      untouched();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('manifest download validates before the gate', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'lexp_1',
    tenant_key: 'tk',
    log_type: 'audit',
    plane: 'sensitive_detail',
    format: 'jsonl',
    status: 'completed',
    artifact_object_ref: null,
    manifest_object_ref: 'logging-exports/v1/lexp_1/manifest.json',
    checksum_sha256: 'abc',
    record_count: 1,
    byte_count: 42,
    requested_by: 'admin-1',
    error_class: null,
    filter_json: '{}',
    created_at: 1,
    updated_at: 1,
    completed_at: 1,
    expires_at: 2,
    ...overrides,
  });
  const path = '/api/admin/logging-policies/exports/lexp_1/artifact';
  const permissions = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ, SENSITIVE_EXPORT];
  const exportsBucket = () => envFixture.EXPORT_ARTIFACTS as ReturnType<typeof bucket>;
  const objectOf = (text: string) => ({ text: vi.fn().mockResolvedValue(text) });
  const download = () => createApp(permissions).request(path, {}, env());
  const serveManifest = (manifest: string, partText = 'part\n') =>
    exportsBucket().get.mockImplementation(async (key: string) =>
      key.endsWith('manifest.json') ? objectOf(manifest) : objectOf(partText)
    );

  it('a malformed manifest is refused without spending a receipt', async () => {
    routeQueryOne([['FROM logging_export_jobs', row()]]);
    serveManifest('{not json');
    expect((await download()).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('a manifest with no parts, a foreign part ref, or a multi-part ZIP is refused first', async () => {
    routeQueryOne([['FROM logging_export_jobs', row()]]);
    serveManifest(JSON.stringify({ parts: [] }));
    expect((await download()).status).toBe(404);
    serveManifest(JSON.stringify({ parts: [{ object_ref: 'elsewhere/p.jsonl' }] }));
    expect((await download()).status).toBe(400);
    routeQueryOne([['FROM logging_export_jobs', row({ format: 'zip' })]]);
    serveManifest(
      JSON.stringify({
        parts: [
          { object_ref: 'logging-exports/v1/lexp_1/p1.zip' },
          { object_ref: 'logging-exports/v1/lexp_1/p2.zip' },
        ],
      })
    );
    expect((await download()).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('a part that is missing is a 404 before the gate', async () => {
    routeQueryOne([['FROM logging_export_jobs', row()]]);
    serveManifest(
      JSON.stringify({
        parts: [
          { object_ref: 'logging-exports/v1/lexp_1/p1.jsonl' },
          { object_ref: 'logging-exports/v1/lexp_1/p2.jsonl' },
        ],
      })
    );
    exportsBucket().head.mockImplementation(async (key: string) =>
      key.endsWith('p2.jsonl') ? null : { size: 10 }
    );
    expect((await download()).status).toBe(404);
    expect(gate).not.toHaveBeenCalled();
    expect(exportsBucket().get).not.toHaveBeenCalledWith('logging-exports/v1/lexp_1/p1.jsonl');
  });

  it('a valid manifest is gated before any part is read; refusal reads no part', async () => {
    routeQueryOne([['FROM logging_export_jobs', row()]]);
    serveManifest(
      JSON.stringify({ parts: [{ object_ref: 'logging-exports/v1/lexp_1/p1.jsonl' }] })
    );
    refuse();
    expect((await download()).status).toBe(403);
    expect(exportsBucket().get).toHaveBeenCalledTimes(1); // only the manifest
    expect(exportsBucket().get).not.toHaveBeenCalledWith('logging-exports/v1/lexp_1/p1.jsonl');

    expect((await download()).status).toBe(200);
    expect(lastDescriptor().operation).toBe('log.sensitive.export');
  });
});

describe('credential numbers are never reused', () => {
  const permissions = [ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE];
  const prepare = (secret: string) =>
    send(permissions, 'POST', '/api/admin/destinations/dest_1/credentials/prepare', {
      secret_value: secret,
      backend: 'd1_encrypted_table',
    });
  const activate = () =>
    send(permissions, 'POST', '/api/admin/destinations/dest_1/credentials/activate', {
      confirmation: 'ACTIVATE CREDENTIAL archive',
    });

  it('a failed activate keeps the reservation, so a stalled prepare cannot collide with a later one', async () => {
    // A minimal row that applies the three credential UPDATEs the way their SQL says.
    const row = {
      version: 7,
      credential_ref: 'd1secret://x#v1',
      credential_version: 1,
      next_credential_ref: null as string | null,
      next_credential_version: null as number | null,
      rotation_status: 'active',
    };
    mockAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM admin_destinations')
        ? destinationRow({ provider: 'http', destination_kind: 'http_sink', ...row })
        : { total: 0 }
    );
    const reserved: number[] = [];
    const secretWrites: string[] = [];
    let stallFirstSecretWrite: Promise<void> | null = null;
    let releaseStall: () => void = () => undefined;
    let stalledAt: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => (stalledAt = resolve));
    stallFirstSecretWrite = new Promise<void>((resolve) => (releaseStall = resolve));
    let firstSecretWrite = true;

    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('credential_secret')) {
        const ref = JSON.stringify(params);
        secretWrites.push(ref);
        if (firstSecretWrite) {
          firstSecretWrite = false;
          stalledAt();
          await stallFirstSecretWrite; // prepare A stalls before its secret is stored
        }
        return { rowsAffected: 1 };
      }
      if (!sql.includes('UPDATE admin_destinations')) return { rowsAffected: 1 };
      const expectedVersion = params.at(-1);
      if (sql.includes('SET next_credential_ref = NULL, next_credential_version = ?')) {
        if (row.version !== expectedVersion) return { rowsAffected: 0 };
        row.next_credential_ref = null;
        row.next_credential_version = params[0] as number;
        row.version += 1;
        reserved.push(params[0] as number);
        return { rowsAffected: 1 };
      }
      if (sql.includes('next_credential_ref IS NULL')) {
        // final write of a prepare: only if its reservation still stands
        if (row.next_credential_version !== params.at(-1) || row.next_credential_ref !== null) {
          return { rowsAffected: 0 };
        }
        row.next_credential_ref = params[0] as string;
        row.next_credential_version = params[1] as number;
        row.rotation_status = params[2] as string;
        row.version += 1;
        return { rowsAffected: 1 };
      }
      if (sql.includes('SET credential_ref = ?')) {
        if (row.version !== expectedVersion) return { rowsAffected: 0 };
        row.credential_ref = params[0] as string;
        row.credential_version = params[1] as number;
        row.next_credential_ref = params[2] as string | null;
        row.next_credential_version = params[3] as number | null;
        row.rotation_status = params[6] as string;
        row.version += 1;
        return { rowsAffected: 1 };
      }
      return { rowsAffected: 1 };
    });

    const prepareA = prepare('secret-a'); // reserves 2, then stalls before storing its secret
    await stalled;
    expect(reserved).toEqual([2]);

    // An activate with nothing to switch to fails; it must not release the reserved number.
    await activate();
    expect(row.next_credential_version).toBe(2);

    // Prepare C reads the state after that and must take the next number, not 2 again, and
    // finishes (and could be activated) while A is still stalled.
    const c = await prepare('secret-c');
    expect(c.status).toBe(200);
    expect(reserved).toEqual([2, 3]);
    expect(row.next_credential_version).toBe(3);
    const cSecret = secretWrites.at(-1);

    // A resumes: its reservation no longer stands, so it is refused; and the object it wrote is
    // its own (number 2), never the one C wrote.
    releaseStall();
    expect((await prepareA).status).toBe(409);
    expect(secretWrites[0]).toMatch(/v2/);
    expect(cSecret).toMatch(/v3/);
    expect(secretWrites[0]).not.toBe(cSecret);
    expect(row.next_credential_version).toBe(3);
  });
});
