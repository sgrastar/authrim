import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const repoMocks = vi.hoisted(() => ({
  storage: {
    createDestination: vi.fn(),
    listByScope: vi.fn(),
    listUsableForTenant: vi.fn(),
    getDestination: vi.fn(),
    getDestinationWithCredential: vi.fn(),
    updateCredential: vi.fn(),
    deleteDestination: vi.fn(),
    listUsage: vi.fn(),
    recordUsage: vi.fn(),
  },
  database: {
    createConnection: vi.fn(),
    listConnections: vi.fn(),
    getConnection: vi.fn(),
    getConnectionWithCredential: vi.fn(),
    updateCredential: vi.fn(),
    deleteConnection: vi.fn(),
    listUsage: vi.fn(),
  },
  encryptValue: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  requireAdminPermissionOrElevationGrant: vi.fn(),
  testStorageDestinationConnectivity: vi.fn(),
  testDatabaseConnectionConnectivity: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };

  class MockStorageDestinationRepository {
    createDestination = repoMocks.storage.createDestination;
    listByScope = repoMocks.storage.listByScope;
    listUsableForTenant = repoMocks.storage.listUsableForTenant;
    getDestination = repoMocks.storage.getDestination;
    getDestinationWithCredential = repoMocks.storage.getDestinationWithCredential;
    updateCredential = repoMocks.storage.updateCredential;
    deleteDestination = repoMocks.storage.deleteDestination;
    listUsage = repoMocks.storage.listUsage;
    recordUsage = repoMocks.storage.recordUsage;
  }

  class MockDatabaseConnectionRepository {
    createConnection = repoMocks.database.createConnection;
    listConnections = repoMocks.database.listConnections;
    getConnection = repoMocks.database.getConnection;
    getConnectionWithCredential = repoMocks.database.getConnectionWithCredential;
    updateCredential = repoMocks.database.updateCredential;
    deleteConnection = repoMocks.database.deleteConnection;
    listUsage = repoMocks.database.listUsage;
  }

  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    AdminStorageDestinationRepository: MockStorageDestinationRepository,
    AdminDatabaseConnectionRepository: MockDatabaseConnectionRepository,
    encryptValue: repoMocks.encryptValue,
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status?: number) => Response }, errorCode: string) =>
        c.json({ error: 'error', error_code: errorCode }, statusByCode[errorCode] ?? 500)
    ),
  };
});

vi.mock('../admin-shared', () => ({
  writeAdminAuditLog: repoMocks.writeAdminAuditLog,
}));

vi.mock('../admin-elevation-access', () => ({
  requireAdminPermissionOrElevationGrant: repoMocks.requireAdminPermissionOrElevationGrant,
}));

vi.mock('../routes/admin-management/connectivity-tests', () => ({
  testStorageDestinationConnectivity: repoMocks.testStorageDestinationConnectivity,
  testDatabaseConnectionConnectivity: repoMocks.testDatabaseConnectionConnectivity,
}));

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { storageDestinationsRouter } from '../routes/admin-management/storage-destinations';
import { databaseConnectionsRouter } from '../routes/admin-management/database-connections';

const env = {
  DB_ADMIN: {},
  ADMIN_CREDENTIAL_ENCRYPTION_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} as unknown as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown; tenantId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', c.req.header('x-test-tenant-id') ?? 'tenant-a');
    c.set('adminAuth', {
      userId: 'admin-1',
      permissions: (c.req.header('x-test-permissions') ?? '').split(',').filter(Boolean),
      roles: (c.req.header('x-test-roles') ?? 'tenant_admin').split(',').filter(Boolean),
    });
    await next();
  });
  app.route('/api/admin/storage-destinations', storageDestinationsRouter);
  app.route('/api/admin/database-connections', databaseConnectionsRouter);
  return app;
}

function storageDestination(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sd_1',
    scope_type: 'tenant',
    scope_id: 'tenant-a',
    name: 'logs',
    display_name: 'Logs',
    description: null,
    provider: 'aws_s3',
    config: { bucket: 'logs' },
    has_credential: false,
    credential_key_version: null,
    credential_updated_at: null,
    credential_updated_by: null,
    status: 'active',
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function databaseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dbc_1',
    name: 'primary',
    display_name: 'Primary',
    description: null,
    provider: 'hyperdrive',
    config: { bindingRef: 'HYPERDRIVE' },
    has_credential: false,
    credential_key_version: null,
    credential_updated_at: null,
    credential_updated_by: null,
    status: 'active',
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('admin infrastructure resource routers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.encryptValue.mockResolvedValue({ encrypted: 'enc:v1:ciphertext', keyVersion: 1 });
    repoMocks.requireAdminPermissionOrElevationGrant.mockResolvedValue({
      grantedBy: 'grant',
      grant: { public_grant_id: 'egr_1' },
    });
    repoMocks.storage.listByScope.mockResolvedValue([storageDestination()]);
    repoMocks.storage.listUsableForTenant.mockResolvedValue([storageDestination()]);
    repoMocks.storage.getDestination.mockResolvedValue(storageDestination());
    repoMocks.storage.getDestinationWithCredential.mockResolvedValue(
      storageDestination({ credential_encrypted: null })
    );
    repoMocks.storage.createDestination.mockImplementation(async (input) =>
      storageDestination({
        name: input.name,
        provider: input.provider,
        has_credential: !!input.credential_encrypted,
        credential_key_version: input.credential_key_version ?? null,
      })
    );
    repoMocks.storage.updateCredential.mockResolvedValue(
      storageDestination({ has_credential: true, credential_key_version: 1 })
    );
    repoMocks.storage.deleteDestination.mockResolvedValue(true);
    repoMocks.storage.listUsage.mockResolvedValue([]);
    repoMocks.storage.recordUsage.mockResolvedValue({
      id: 'sdu_1',
      destination_id: 'sd_1',
      feature: 'diagnostic_logging',
      resource_type: 'tenant',
      resource_id: 'tenant-a',
      tenant_id: 'tenant-a',
      metadata: {},
      created_by: 'admin-1',
      created_at: 1,
      updated_at: 1,
    });

    repoMocks.database.listConnections.mockResolvedValue([databaseConnection()]);
    repoMocks.database.getConnection.mockResolvedValue(databaseConnection());
    repoMocks.database.getConnectionWithCredential.mockResolvedValue(
      databaseConnection({ credential_encrypted: null })
    );
    repoMocks.database.createConnection.mockImplementation(async (input) =>
      databaseConnection({
        name: input.name,
        provider: input.provider,
        has_credential: !!input.credential_encrypted,
        credential_key_version: input.credential_key_version ?? null,
      })
    );
    repoMocks.database.updateCredential.mockResolvedValue(
      databaseConnection({ has_credential: true, credential_key_version: 1 })
    );
    repoMocks.database.deleteConnection.mockResolvedValue(true);
    repoMocks.database.listUsage.mockResolvedValue([]);
    repoMocks.testStorageDestinationConnectivity.mockResolvedValue({
      status: 'ok',
      provider: 'r2',
      message: 'R2 write/head/delete probe succeeded.',
      latency_ms: 1,
    });
    repoMocks.testDatabaseConnectionConnectivity.mockResolvedValue({
      status: 'ok',
      provider: 'd1',
      message: 'D1 SELECT 1 probe succeeded.',
      latency_ms: 1,
    });
  });

  it('creates a tenant storage destination with encrypted write-only credentials', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/storage-destinations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': [
            ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
            ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
          ].join(','),
        },
        body: JSON.stringify({
          name: 'logs',
          provider: 'aws_s3',
          credential: { accessKeyId: 'plain-access-key' },
        }),
      },
      env
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(repoMocks.encryptValue).toHaveBeenCalled();
    expect(repoMocks.storage.createDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_encrypted: 'enc:v1:ciphertext',
        credential_key_version: 1,
      })
    );
    expect(JSON.stringify(body)).not.toContain('plain-access-key');
    expect(JSON.stringify(body)).not.toContain('enc:v1:ciphertext');
    expect(body.has_credential).toBe(true);
  });

  it('rejects storage destination credential creation without credential permission', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/storage-destinations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
        },
        body: JSON.stringify({
          name: 'logs',
          provider: 'aws_s3',
          credential: { secret: 'plain' },
        }),
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.storage.createDestination).not.toHaveBeenCalled();
  });

  it('rejects platform storage destination access without platform authority', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/storage-destinations?scope_type=platform',
      {
        headers: {
          'x-test-permissions': ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
          'x-test-roles': 'tenant_admin',
        },
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  });

  it('requires elevation for storage destination credential rotation', async () => {
    repoMocks.requireAdminPermissionOrElevationGrant.mockResolvedValue(
      new Response(JSON.stringify({ error: 'approval_required' }), { status: 403 })
    );
    const app = createApp();
    const response = await app.request(
      '/api/admin/storage-destinations/sd_1/credentials',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
        },
        body: JSON.stringify({ credential: { secret: 'plain' } }),
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error).toBe('approval_required');
    expect(repoMocks.storage.updateCredential).not.toHaveBeenCalled();
  });

  it('blocks deletion of a storage destination that is still in use', async () => {
    repoMocks.storage.deleteDestination.mockRejectedValue(new Error('storage_destination_in_use'));
    const app = createApp();
    const response = await app.request(
      '/api/admin/storage-destinations/sd_1',
      {
        method: 'DELETE',
        headers: {
          'x-test-permissions': [
            ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
            ADMIN_PERMISSIONS.ALL,
          ].join(','),
        },
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_CONFLICT);
  });

  it('runs storage destination connectivity tests without exposing credentials', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/storage-destinations/sd_1/test',
      {
        method: 'POST',
        headers: {
          'x-test-permissions': ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_TEST,
        },
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(repoMocks.storage.getDestinationWithCredential).toHaveBeenCalledWith('sd_1');
    expect(repoMocks.testStorageDestinationConnectivity).toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('credential_encrypted');
    expect(body.status).toBe('ok');
  });

  it('requires platform authority for database connections', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/database-connections',
      {
        headers: {
          'x-test-permissions': ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_LIST,
          'x-test-roles': 'tenant_admin',
        },
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  });

  it('creates a database connection without exposing credential material', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/database-connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-roles': 'system_admin',
          'x-test-permissions': [
            ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREATE,
            ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREDENTIALS_WRITE,
          ].join(','),
        },
        body: JSON.stringify({
          name: 'external-pg',
          provider: 'postgres',
          credential: { password: 'plain-db-password' },
        }),
      },
      env
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(repoMocks.database.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_encrypted: 'enc:v1:ciphertext',
        credential_key_version: 1,
      })
    );
    expect(JSON.stringify(body)).not.toContain('plain-db-password');
    expect(JSON.stringify(body)).not.toContain('enc:v1:ciphertext');
    expect(body.has_credential).toBe(true);
  });

  it('runs database connection connectivity tests through the platform gate', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/database-connections/dbc_1/test',
      {
        method: 'POST',
        headers: {
          'x-test-roles': 'system_admin',
          'x-test-permissions': ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_TEST,
        },
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(repoMocks.database.getConnectionWithCredential).toHaveBeenCalledWith('dbc_1');
    expect(repoMocks.testDatabaseConnectionConnectivity).toHaveBeenCalled();
    expect(body.status).toBe('ok');
  });

  it('does not expose database routing or switching endpoints from connection management', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/admin/database-connections/dbc_1/switch',
      {
        method: 'POST',
        headers: {
          'x-test-roles': 'system_admin',
          'x-test-permissions': ADMIN_PERMISSIONS.DATABASE_ROUTING_SWITCH,
        },
      },
      env
    );

    expect(response.status).toBe(404);
  });
});
