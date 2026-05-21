import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mockAdapter = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  adapter.transaction.mockImplementation(async (callback) => callback(adapter));
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
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES, encryptObjectArtifact } from '@authrim/ar-lib-core';
import {
  adminLoggingRouter,
  destinationsRouter,
  loggingPoliciesRouter,
  notificationsRouter,
} from '../routes/admin-management/logging-control';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging';
import { encodeLogRecordBlocks, writeLogChunkToR2 } from '@authrim/ar-lib-logging/chunks';
import { decodeLoggingCursor } from '@authrim/ar-lib-logging/delivery';

const LOGGING_EXPORT_CREATE_PERMISSION = 'admin:logging:exports:create';
const LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION = 'admin:logging:sensitive_detail:export';

function createTextR2Object(text: string): R2ObjectBody {
  const body = new TextEncoder().encode(text);
  return {
    size: body.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  } as R2ObjectBody;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveTestArchiveChunkEncryptionKey(input: {
  rootKeyHex: string;
  tenantKey: string;
  logType: string;
  plane: string;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.rootKeyHex),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-log-chunk-archive-encryption'),
      info: new TextEncoder().encode(
        `${input.tenantKey}:${input.logType}:${input.plane}:v${input.keyVersion}`
      ),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

const env = {
  DB_ADMIN: {},
  OBJECT_ENCRYPTION_ROOT_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  LOGGING_CURSOR_HMAC_SECRET: 'test-logging-cursor-secret',
  AUDIT_QUEUE: {
    send: vi.fn().mockResolvedValue(undefined),
  },
  LOGGING_DELIVERY_CRITICAL_QUEUE: {
    send: vi.fn().mockResolvedValue(undefined),
  },
  AUDIT_ARCHIVE: {
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  AUTHRIM_CONFIG: {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
  DIAGNOSTIC_LOGS: {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  SENSITIVE_DETAILS: {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
} as unknown as Env;

function createApp(permissions: string[] = [], roles: string[] = ['tenant_admin']) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown; tenantId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', c.req.header('x-test-tenant-id') ?? 'tenant-a');
    c.set('adminAuth', {
      userId: 'admin-1',
      permissions,
      roles,
    });
    await next();
  });
  app.route('/api/admin/destinations', destinationsRouter);
  app.route('/api/admin/logging-policies', loggingPoliciesRouter);
  app.route('/api/admin/admin-logging', adminLoggingRouter);
  app.route('/api/admin/notifications', notificationsRouter);
  return app;
}

function createPlatformApp(permissions: string[] = []) {
  return createApp(permissions, ['system_admin']);
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

function messageJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lmj_1',
    kind: 'retry_delivery',
    status: 'queued',
    lane: 'default',
    criticality: 'standard',
    priority: 0,
    tenant_id: null,
    tenant_key: 'tenant-key-1',
    topology_type: 'shared_d1',
    database_binding_ref: null,
    connection_ref: null,
    topology_snapshot_version: null,
    topology_resolved_at: 1000,
    scope_type: 'tenant',
    scope_id: 'tenant-a',
    scope_key: 'tenant:tenant-key-1',
    source_type: 'dlq_item',
    source_id: 'dlq_1',
    root_job_id: null,
    parent_job_id: null,
    depth: 0,
    payload_object_ref: 'message-jobs/retry_delivery/job.json',
    payload_sha256: 'sha256',
    payload_type: 'retry_delivery',
    payload_schema_version: 1,
    redacted_summary_json: JSON.stringify({ payload_type: 'retry_delivery' }),
    validation_summary_json: null,
    idempotency_key: 'retry:dlq_1',
    dedupe_until: 2000,
    not_before: 1000,
    attempt_count: 0,
    max_attempts: 5,
    attempt_policy_json: JSON.stringify({ maxAttempts: 5, leaseTimeoutMs: 300000 }),
    claim_token: null,
    claimed_at: null,
    claimed_until: null,
    requested_by: 'admin-1',
    reason: 'manual retry',
    error_class: null,
    last_error: null,
    blocked_reason: null,
    cancel_requested_at: null,
    cancelled_by: null,
    created_at: 1000,
    updated_at: 1000,
    started_at: null,
    completed_at: null,
    expires_at: null,
    ...overrides,
  };
}

describe('logging control routers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.query.mockReset();
    mockAdapter.queryOne.mockReset();
    mockAdapter.execute.mockReset();
    mockAdapter.transaction.mockReset();
    mockAdapter.transaction.mockImplementation(async (callback) => callback(mockAdapter));
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue({ total: 0, failures: 0, critical: 0 });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockReset().mockResolvedValue(null);
    vi.mocked(env.AUDIT_ARCHIVE!.delete).mockReset().mockResolvedValue(undefined);
    vi.mocked(env.DIAGNOSTIC_LOGS!.get).mockReset().mockResolvedValue(null);
    vi.mocked(env.DIAGNOSTIC_LOGS!.put)
      .mockReset()
      .mockResolvedValue({} as R2Object);
    vi.mocked(env.DIAGNOSTIC_LOGS!.delete).mockReset().mockResolvedValue(undefined);
    vi.mocked(env.SENSITIVE_DETAILS!.get).mockReset().mockResolvedValue(null);
    vi.mocked(env.SENSITIVE_DETAILS!.put)
      .mockReset()
      .mockResolvedValue({} as R2Object);
    vi.mocked(env.AUTHRIM_CONFIG!.get as unknown as (key: string) => Promise<string | null>)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(env.AUTHRIM_CONFIG!.put).mockReset().mockResolvedValue(undefined);
  });

  it('requires storage destination list permission for destination summary', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/destinations',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'dest_1',
        scope_type: 'platform',
        scope_id: 'global',
        name: 'default',
        allowed_tenant_ids: JSON.stringify(['tenant-a', 'tenant-b']),
      },
    ]);
    const allowed = await createApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST]).request(
      '/api/admin/destinations?scope_type=platform',
      {},
      env
    );
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(allowedBody).toMatchObject({ total: 1 });
    expect(allowedBody.items[0]?.allowed_tenant_ids).toBeUndefined();
  });

  it('returns platform destination detail and sanitizes tenant destination detail', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_detail',
        provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' }),
        credential_ref: 'd1secret://admin/credential_secrets/dest_detail/v1#v1',
        credential_version: 1,
      })
    );
    mockAdapter.query.mockResolvedValueOnce([
      { capability: 'archive_write', source: 'provider_default', enabled: 1 },
    ]);

    const platform = await createPlatformApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ]).request(
      '/api/admin/destinations/dest_detail',
      {},
      env
    );
    const platformBody = (await platform.json()) as {
      item: { provider_config: Record<string, unknown>; credential_ref: string };
    };

    expect(platform.status).toBe(200);
    expect(platform.headers.get('etag')).toBe('"v1"');
    expect(platformBody.item.provider_config).toEqual({
      bindingRef: 'AUDIT_ARCHIVE',
      prefix: 'audit',
    });
    expect(platformBody.item.credential_ref).toMatch(/^d1secret:/);

    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_shared',
        scope_type: 'shared',
        allowed_tenant_ids: JSON.stringify(['tenant-a']),
        provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
        credential_ref: 'd1secret://admin/credential_secrets/dest_shared/v1#v1',
      })
    );
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_shared' });
    mockAdapter.query.mockResolvedValueOnce([
      { capability: 'external_sink_write', source: 'provider_default', enabled: 1 },
    ]);

    const tenant = await createApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ]).request(
      '/api/admin/destinations/dest_shared',
      {},
      env
    );
    const tenantBody = (await tenant.json()) as {
      item: { provider_config?: unknown; credential_ref?: unknown; capabilities: unknown[] };
    };

    expect(tenant.status).toBe(200);
    expect(tenantBody.item.provider_config).toBeUndefined();
    expect(tenantBody.item.credential_ref).toBeUndefined();
    expect((tenantBody.item as Record<string, unknown>).allowed_tenant_ids).toBeUndefined();
    expect(tenantBody.item.capabilities).toHaveLength(1);
  });

  it('hides unrelated tenant destinations from tenant admins', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_other',
        scope_type: 'tenant',
        scope_id: 'tenant-b',
      })
    );

    const response = await createApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ]).request(
      '/api/admin/destinations/dest_other',
      {},
      env
    );

    expect(response.status).toBe(404);
    expect(mockAdapter.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM admin_destination_capabilities'),
      expect.anything()
    );
  });

  it('creates storage destinations with sanitized provider config and capabilities', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST]).request(
      '/api/admin/destinations',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          provider: 'r2',
          name: 'archive',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(denied.status).toBe(403);

    const forbiddenTenant = await createApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ]).request(
      '/api/admin/destinations',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          provider: 'r2',
          name: 'archive',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(forbiddenTenant.status).toBe(403);

    const allowed = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ]).request(
      '/api/admin/destinations',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          provider: 'r2',
          name: 'archive',
          display_name: 'Archive',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' },
          allowed_log_types: ['audit', 'admin_audit'],
          allowed_planes: ['archive', 'sensitive_detail'],
          critical_allowed: true,
          default_fallback_eligible: true,
          retention_days: 30,
          capabilities: ['archive_write', 'sensitive_detail_write'],
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await allowed.json()) as { item: { id: string; version: number } };

    expect(allowed.status).toBe(201);
    expect(body.item.id).toMatch(/^dest_/);
    expect(body.item.version).toBe(1);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_destinations'),
      expect.arrayContaining([
        'platform',
        'global',
        'object_storage',
        'r2',
        'archive',
        'Archive',
        'active',
        'configured',
        JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' }),
        JSON.stringify(['audit', 'admin_audit']),
        JSON.stringify(['archive', 'sensitive_detail']),
        1,
        1,
        30,
      ])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_destination_capabilities'),
      expect.arrayContaining(['archive_write'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.create'])
    );
  });

  it('rejects inline secrets in storage destination provider config', async () => {
    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ]).request(
      '/api/admin/destinations',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          provider: 'http',
          name: 'collector',
          provider_config: {
            url: 'https://logs.example.test/ingest',
            headers: [{ Authorization: 'Bearer secret' }],
          },
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({
        path: 'provider_config.headers.0.Authorization',
        code: 'secret_not_allowed',
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects HTTP sink provider URLs that target private networks', async () => {
    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ]).request(
      '/api/admin/destinations',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          provider: 'http',
          name: 'collector',
          provider_config: { url: 'https://127.0.0.1/ingest' },
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({
        path: 'provider_config.url',
        code: 'http_sink_url_invalid',
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('previews destination provider payloads with validation and redaction', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE]).request(
      '/api/admin/destinations/provider-preview',
      {
        method: 'POST',
        body: JSON.stringify({
          provider: 'http',
          provider_config: { url: 'https://logs.example.test/ingest' },
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(denied.status).toBe(403);

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ]).request(
      '/api/admin/destinations/provider-preview',
      {
        method: 'POST',
        body: JSON.stringify({
          provider: 'http',
          provider_config: {
            url: 'https://logs.example.test/ingest',
            auth: { apiKey: 'secret-value' },
          },
          capabilities: ['log_sink_write'],
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      item: {
        provider: string;
        destination_kind: string;
        provider_config: { auth: { apiKey: string } };
        capabilities: string[];
        validation: { valid: boolean; errors: Array<{ path: string; code: string }> };
        security: { inline_secret_detected: boolean; inline_secret_path: string | null };
      };
    };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({
      provider: 'http',
      destination_kind: 'http_sink',
      capabilities: ['log_sink_write'],
      validation: { valid: false },
      security: {
        inline_secret_detected: true,
        inline_secret_path: 'provider_config.auth.apiKey',
      },
    });
    expect(body.item.provider_config.auth.apiKey).toBe('[redacted]');
    expect(body.item.validation.errors).toContainEqual(
      expect.objectContaining({
        path: 'provider_config.auth.apiKey',
        code: 'secret_not_allowed',
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('updates storage destinations with optimistic concurrency and audit', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
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
      provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }),
      allowed_tenant_ids: null,
      allowed_log_types: null,
      allowed_planes: null,
      region: null,
      critical_allowed: 0,
      default_fallback_eligible: 0,
      retention_days: null,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 2,
    });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ]).request(
      '/api/admin/destinations/dest_1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          provider: 'r2',
          name: 'archive',
          display_name: 'Archive Logs',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' },
          expected_version: 2,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as { item: { version: number } };

    expect(response.status).toBe(200);
    expect(body.item.version).toBe(3);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_destinations'),
      expect.arrayContaining([
        'Archive Logs',
        JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' }),
      ])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.update'])
    );
  });

  it('rejects stale storage destination updates before mutating capabilities', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      ...destinationRow({
        id: 'dest_1',
        name: 'archive',
        version: 3,
      }),
    });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ]).request(
      '/api/admin/destinations/dest_1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          provider: 'r2',
          name: 'archive',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
          expected_version: 2,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { conflict: { expected_version: number; actual_version: number } };
    };

    expect(response.status).toBe(409);
    expect(body.details.conflict).toEqual({ expected_version: 2, actual_version: 3 });
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_destinations'),
      expect.anything()
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('admin_destination_capabilities'),
      expect.anything()
    );
  });

  it('soft deletes storage destinations with typed confirmation', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
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
      provider_config: '{}',
      allowed_tenant_ids: null,
      allowed_log_types: null,
      allowed_planes: null,
      region: null,
      critical_allowed: 1,
      default_fallback_eligible: 1,
      retention_days: 30,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 4,
    });

    const rejected = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    ]).request(
      '/api/admin/destinations/dest_1',
      {
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'DELETE' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(rejected.status).toBe(400);

    mockAdapter.queryOne.mockResolvedValueOnce({
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
      provider_config: '{}',
      allowed_tenant_ids: null,
      allowed_log_types: null,
      allowed_planes: null,
      region: null,
      critical_allowed: 1,
      default_fallback_eligible: 1,
      retention_days: 30,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 4,
    });

    const allowed = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    ]).request(
      '/api/admin/destinations/dest_1',
      {
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'DELETE DESTINATION archive' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await allowed.json()) as { item: { lifecycle_status: string; version: number } };

    expect(allowed.status).toBe(200);
    expect(body.item).toMatchObject({ lifecycle_status: 'deleted', version: 5 });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET lifecycle_status = 'deleted'"),
      expect.arrayContaining(['admin-1', 'dest_1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.delete'])
    );
  });

  it('rejects stale storage destination deletes before deleting capability rows', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      ...destinationRow({
        id: 'dest_1',
        name: 'archive',
        version: 7,
      }),
    });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    ]).request(
      '/api/admin/destinations/dest_1',
      {
        method: 'DELETE',
        body: JSON.stringify({
          confirmation: 'DELETE DESTINATION archive',
          expected_version: 6,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { conflict: { expected_version: number; actual_version: number } };
    };

    expect(response.status).toBe(409);
    expect(body.details.conflict).toEqual({ expected_version: 6, actual_version: 7 });
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining("SET lifecycle_status = 'deleted'"),
      expect.anything()
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM admin_destination_capabilities'),
      expect.anything()
    );
  });

  it('force disables and re-enables storage destinations with admin audit', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_critical',
        name: 'critical-archive',
        critical_allowed: 1,
        version: 7,
      })
    );

    const rejected = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ]).request(
      '/api/admin/destinations/dest_critical/disable',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'DISABLE' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(rejected.status).toBe(400);

    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_critical',
        name: 'critical-archive',
        critical_allowed: 1,
        version: 7,
      })
    );
    const disabled = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ]).request(
      '/api/admin/destinations/dest_critical/disable',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'FORCE DISABLE critical-archive' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const disabledBody = (await disabled.json()) as {
      item: { lifecycle_status: string; version: number };
    };

    expect(disabled.status).toBe(200);
    expect(disabledBody.item).toMatchObject({ lifecycle_status: 'disabled', version: 8 });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET lifecycle_status = 'disabled'"),
      expect.arrayContaining(['admin-1', 'dest_critical'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.force_disable'])
    );

    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_critical',
        name: 'critical-archive',
        lifecycle_status: 'disabled',
        version: 8,
      })
    );
    const enabled = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ]).request('/api/admin/destinations/dest_critical/enable', { method: 'POST' }, env);
    const enabledBody = (await enabled.json()) as {
      item: { lifecycle_status: string; version: number };
    };

    expect(enabled.status).toBe(200);
    expect(enabledBody.item).toMatchObject({ lifecycle_status: 'active', version: 9 });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET lifecycle_status = 'active'"),
      expect.arrayContaining(['admin-1', 'dest_critical'])
    );
  });

  it('prepares, marks ready, and activates destination credential rotation', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'dest_1',
        scope_type: 'platform',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'collector',
        display_name: 'Collector',
        description: null,
        lifecycle_status: 'active',
        health_status: 'configured',
        rotation_status: 'none',
        provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
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
      })
      .mockResolvedValueOnce({
        id: 'dest_1',
        scope_type: 'platform',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'collector',
        display_name: 'Collector',
        description: null,
        lifecycle_status: 'active',
        health_status: 'configured',
        rotation_status: 'testing',
        provider_config: '{}',
        credential_ref: null,
        credential_version: 0,
        next_credential_ref: 'd1secret://admin/credential_secrets/dest_1/v1#v1',
        next_credential_version: 1,
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
        version: 2,
      })
      .mockResolvedValueOnce({
        id: 'dest_1',
        scope_type: 'platform',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'collector',
        display_name: 'Collector',
        description: null,
        lifecycle_status: 'active',
        health_status: 'configured',
        rotation_status: 'ready',
        provider_config: '{}',
        credential_ref: null,
        credential_version: 0,
        next_credential_ref: 'd1secret://admin/credential_secrets/dest_1/v1#v1',
        next_credential_version: 1,
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
        version: 3,
      });

    const prepare = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
    ]).request(
      '/api/admin/destinations/dest_1/credentials/prepare',
      {
        method: 'POST',
        body: JSON.stringify({
          backend: 'd1_encrypted_table',
          secret_value: 'super-secret-token',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const prepareBody = (await prepare.json()) as {
      item: { rotation_status: string; next_credential_ref: string };
    };
    expect(prepare.status).toBe(200);
    expect(prepareBody.item.rotation_status).toBe('testing');
    expect(prepareBody.item.next_credential_ref).toMatch(/^d1secret:/);

    const ready = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
    ]).request('/api/admin/destinations/dest_1/credentials/ready', { method: 'POST' }, env);
    const readyBody = (await ready.json()) as { item: { rotation_status: string } };
    expect(ready.status).toBe(200);
    expect(readyBody.item.rotation_status).toBe('ready');

    const activate = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
    ]).request(
      '/api/admin/destinations/dest_1/credentials/activate',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'ACTIVATE CREDENTIAL collector' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const activateBody = (await activate.json()) as {
      item: { credential_version: number; rotation_status: string };
    };

    expect(activate.status).toBe(200);
    expect(activateBody.item.credential_version).toBe(1);
    expect(activateBody.item.rotation_status).toBe('active');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO credential_secret_bodies'),
      expect.arrayContaining(['dest_1', 1])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.credentials.prepare'])
    );
    const executedText = JSON.stringify(mockAdapter.execute.mock.calls);
    expect(executedText).not.toContain('super-secret-token');
  });

  it('requires typed confirmation before activating destination credentials', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_1',
      scope_type: 'platform',
      scope_id: 'global',
      destination_kind: 'http_sink',
      provider: 'http',
      name: 'collector',
      display_name: 'Collector',
      description: null,
      lifecycle_status: 'active',
      health_status: 'configured',
      rotation_status: 'ready',
      provider_config: '{}',
      credential_ref: null,
      credential_version: 0,
      next_credential_ref: 'd1secret://admin/credential_secrets/dest_1/v1#v1',
      next_credential_version: 1,
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
      version: 3,
    });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
    ]).request(
      '/api/admin/destinations/dest_1/credentials/activate',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'ACTIVATE' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(response.status).toBe(400);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('retires previous destination credentials after overlap', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_1',
      scope_type: 'platform',
      scope_id: 'global',
      destination_kind: 'http_sink',
      provider: 'http',
      name: 'collector',
      display_name: 'Collector',
      description: null,
      lifecycle_status: 'active',
      health_status: 'configured',
      rotation_status: 'retiring',
      provider_config: '{}',
      credential_ref: 'd1secret://admin/credential_secrets/dest_1/v2#v2',
      credential_version: 2,
      next_credential_ref: null,
      next_credential_version: null,
      previous_credential_ref: 'd1secret://admin/credential_secrets/dest_1/v1#v1',
      previous_credential_retire_after: 1000,
      allowed_tenant_ids: null,
      allowed_log_types: null,
      allowed_planes: null,
      region: null,
      critical_allowed: 0,
      default_fallback_eligible: 0,
      retention_days: 30,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 4,
    });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
    ]).request(
      '/api/admin/destinations/dest_1/credentials/retire-previous',
      { method: 'POST' },
      env
    );
    const body = (await response.json()) as {
      item: { previous_credential_ref: string | null; rotation_status: string };
    };

    expect(response.status).toBe(200);
    expect(body.item.previous_credential_ref).toBeNull();
    expect(body.item.rotation_status).toBe('none');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'retired'"),
      expect.arrayContaining(['d1secret://admin/credential_secrets/dest_1/v1#v1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.credentials.retire_previous'])
    );
  });

  it('runs destination health checks and records health state', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ]).request(
      '/api/admin/destinations/dest_1/health-check',
      { method: 'POST' },
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_1',
      scope_type: 'platform',
      scope_id: 'global',
      destination_kind: 'object_storage',
      provider: 'r2',
      name: 'archive',
      display_name: 'Archive',
      lifecycle_status: 'active',
      health_status: 'unknown',
      provider_config: JSON.stringify({ bindingRef: 'DIAGNOSTIC_LOGS' }),
      last_health_check_at: null,
    });

    const allowed = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_HEALTH_CHECK,
    ]).request(
      '/api/admin/destinations/dest_1/health-check',
      {
        method: 'POST',
        body: JSON.stringify({ check_type: 'quick' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await allowed.json()) as {
      item: { destination_id: string; next_health_status: string; result: string };
    };

    expect(allowed.status).toBe(200);
    expect(body.item).toMatchObject({
      destination_id: 'dest_1',
      next_health_status: 'healthy',
      result: 'success',
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_destination_health_events'),
      expect.arrayContaining(['dest_1', 'quick', 'unknown', 'healthy', 'success'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_destinations'),
      expect.arrayContaining(['healthy', 'dest_1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['storage_destination.health_check'])
    );
  });

  it('enqueues logging destination health notifications on failures', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_2',
      scope_type: 'platform',
      scope_id: 'global',
      destination_kind: 'object_storage',
      provider: 'r2',
      name: 'missing',
      display_name: 'Missing',
      lifecycle_status: 'active',
      health_status: 'healthy',
      provider_config: JSON.stringify({ bindingRef: 'MISSING_BUCKET' }),
      last_health_check_at: 1000,
    });
    mockAdapter.queryOne.mockResolvedValueOnce(null);
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'notification-1',
      tenant_id: 'global',
      category: 'logging_destination_health',
      event_type: 'logging.destination.health.unreachable',
      severity: 'high',
      status: 'pending',
      deduplication_key:
        'logging_destination_health:dest_2:quick:unreachable:r2_binding_unavailable',
      payload_json: '{}',
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
    });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_HEALTH_CHECK,
    ]).request('/api/admin/destinations/dest_2/health-check', { method: 'POST' }, env);
    const body = (await response.json()) as {
      item: { next_health_status: string; error_class: string };
    };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({
      next_health_status: 'unreachable',
      error_class: 'r2_binding_unavailable',
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        'global',
        'logging_destination_health',
        'logging.destination.health.unreachable',
        'high',
      ])
    );
  });

  it('uses logging overview permissions for policy matrix reads', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_AUDIT_READ]).request(
      '/api/admin/logging-policies',
      {},
      env
    );
    expect(denied.status).toBe(403);

    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies',
      {},
      env
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { item: { tenant_id: string } };
    expect(body.item.tenant_id).toBe('tenant-a');
    expect(mockAdapter.query).toHaveBeenCalledTimes(3);
  });

  it('serves policy matrix through the spec alias', async () => {
    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/matrix',
      {},
      env
    );
    const body = (await response.json()) as { item: { tenant_id: string } };

    expect(response.status).toBe(200);
    expect(body.item.tenant_id).toBe('tenant-a');
    expect(mockAdapter.query).toHaveBeenCalledTimes(3);
  });

  it('creates tenant logging policy assignments for tenant-configurable log types', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_tenant',
      scope_type: 'shared',
      scope_id: 'global',
      destination_kind: 'http_sink',
      provider: 'http',
      name: 'tenant-webhook',
      display_name: 'Tenant Webhook',
      description: null,
      lifecycle_status: 'active',
      health_status: 'configured',
      provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
      allowed_tenant_ids: JSON.stringify(['tenant-a']),
      allowed_log_types: JSON.stringify(['webhook']),
      allowed_planes: JSON.stringify(['external_sink']),
      region: null,
      critical_allowed: 0,
      default_fallback_eligible: 0,
      retention_days: 30,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 1,
    });
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_tenant' });

    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_tenant',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await allowed.json()) as { item: { id: string; managed_by: string } };

    expect(allowed.status).toBe(201);
    expect(body.item.id).toMatch(/^pol_/);
    expect(body.item.managed_by).toBe('tenant');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_destination_overrides'),
      expect.arrayContaining(['tenant-a', 'webhook', 'external_sink', 'dest_tenant'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_destination_override.create'])
    );

    const rejected = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'audit',
          plane: 'archive',
          destination_id: 'dest_tenant',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(rejected.status).toBe(403);

    const crossTenant = await createApp([
      ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE,
    ]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: 'tenant-b',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_tenant',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(crossTenant.status).toBe(403);
  });

  it('rejects tenant assignment to destinations not approved for the current tenant', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_tenant_b_only',
        scope_type: 'shared',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'tenant-b-webhook',
        display_name: 'Tenant B Webhook',
        provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
        allowed_tenant_ids: JSON.stringify(['tenant-b']),
        allowed_log_types: JSON.stringify(['webhook']),
        allowed_planes: JSON.stringify(['external_sink']),
      })
    );

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_tenant_b_only',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({
        path: 'destination_id',
        code: 'tenant_not_allowed',
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_destination_overrides'),
      expect.anything()
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_destination_override.create'])
    );
  });

  it('rejects tenant assignment to destinations outside tenant residency', async () => {
    vi.mocked(
      env.AUTHRIM_CONFIG!.get as unknown as (key: string) => Promise<string | null>
    ).mockImplementation(async (key: string) => {
      if (key === 'settings:tenant:tenant-a:tenant') {
        return JSON.stringify({ 'tenant.residency_profile_id': 'builtin:residency:eu' });
      }
      return null;
    });
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_enam',
        scope_type: 'shared',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'enam-webhook',
        display_name: 'ENAM Webhook',
        provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
        allowed_log_types: JSON.stringify(['webhook']),
        allowed_planes: JSON.stringify(['external_sink']),
        region: 'enam',
      })
    );

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_enam',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({
        path: 'destination_id',
        code: 'region_mismatch',
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_destination_overrides'),
      expect.anything()
    );
  });

  it('requires critical permission and confirmation for critical logging assignments', async () => {
    const noCriticalPermission = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          log_type: 'audit',
          plane: 'archive',
          destination_id: 'dest_archive',
          confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(noCriticalPermission.status).toBe(403);

    const noConfirmation = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
    ]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          log_type: 'audit',
          plane: 'archive',
          destination_id: 'dest_archive',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(noConfirmation.status).toBe(400);

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_archive',
      scope_type: 'platform',
      scope_id: 'global',
      destination_kind: 'object_storage',
      provider: 'r2',
      name: 'archive',
      display_name: 'Archive',
      description: null,
      lifecycle_status: 'active',
      health_status: 'healthy',
      provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }),
      allowed_tenant_ids: null,
      allowed_log_types: JSON.stringify(['audit']),
      allowed_planes: JSON.stringify(['archive']),
      region: null,
      critical_allowed: 1,
      default_fallback_eligible: 1,
      retention_days: 30,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 1,
    });
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_archive' });
    const allowed = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
    ]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          log_type: 'audit',
          plane: 'archive',
          destination_id: 'dest_archive',
          confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await allowed.json()) as { item: { managed_by: string } };

    expect(allowed.status).toBe(201);
    expect(body.item.managed_by).toBe('platform');
  });

  it('rejects tenant-scoped destinations for platform defaults', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_tenant_only',
        scope_type: 'tenant',
        scope_id: 'tenant-a',
        health_status: 'healthy',
        allowed_log_types: JSON.stringify(['diagnostic']),
        allowed_planes: JSON.stringify(['archive']),
      })
    );

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          log_type: 'diagnostic',
          plane: 'archive',
          destination_id: 'dest_tenant_only',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { fields: Array<{ code: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({ code: 'tenant_destination_for_platform_policy' })
    );
  });

  it('patches logging policy assignments with optimistic concurrency', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'pol_1',
        tenant_id: 'tenant-a',
        log_type: 'webhook',
        plane: 'external_sink',
        destination_id: 'dest_old',
        enabled: 1,
        managed_by: 'tenant',
        created_by: 'admin-1',
        updated_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
        version: 2,
      })
      .mockResolvedValueOnce({
        id: 'dest_new',
        scope_type: 'shared',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'webhook-new',
        display_name: 'Webhook New',
        description: null,
        lifecycle_status: 'active',
        health_status: 'configured',
        provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
        allowed_tenant_ids: JSON.stringify(['tenant-a']),
        allowed_log_types: JSON.stringify(['webhook']),
        allowed_planes: JSON.stringify(['external_sink']),
        region: null,
        critical_allowed: 0,
        default_fallback_eligible: 0,
        retention_days: 30,
        encryption_mode: 'platform_managed',
        last_health_check_at: null,
        version: 1,
      });
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_new' });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/pol_1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_new',
        }),
        headers: { 'content-type': 'application/json', 'if-match': '"v2"' },
      },
      env
    );
    const body = (await response.json()) as { item: { version: number } };

    expect(response.status).toBe(200);
    expect(body.item.version).toBe(3);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_destination_overrides'),
      expect.arrayContaining(['tenant-a', 'webhook', 'external_sink', 'dest_new'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_destination_override.update'])
    );
  });

  it('rejects tenant assignment patch attempts outside the current tenant scope', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'pol_tenant_b',
      tenant_id: 'tenant-b',
      log_type: 'webhook',
      plane: 'external_sink',
      destination_id: 'dest_old',
      enabled: 1,
      managed_by: 'tenant',
      created_at: 1000,
      updated_at: 1000,
      version: 1,
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/rows/pol_tenant_b',
      {
        method: 'PATCH',
        body: JSON.stringify({
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_new',
          expected_version: 1,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_destination_overrides'),
      expect.anything()
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_destination_override.update'])
    );
  });

  it('rejects tenant assignment patch attempts against platform default rows', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'pol_platform',
      tenant_id: null,
      log_type: 'webhook',
      plane: 'external_sink',
      destination_id: 'dest_old',
      enabled: 1,
      managed_by: 'platform',
      created_at: 1000,
      updated_at: 1000,
      version: 1,
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/rows/pol_platform',
      {
        method: 'PATCH',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_new',
          expected_version: 1,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_destination_overrides'),
      expect.anything()
    );
  });

  it('patches logging policy assignments through the spec row alias', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'pol_1',
        tenant_id: 'tenant-a',
        log_type: 'webhook',
        plane: 'external_sink',
        destination_id: 'dest_old',
        enabled: 1,
        managed_by: 'tenant',
        created_by: 'admin-1',
        updated_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
        version: 2,
      })
      .mockResolvedValueOnce({
        id: 'dest_new',
        scope_type: 'shared',
        scope_id: 'global',
        destination_kind: 'http_sink',
        provider: 'http',
        name: 'webhook-new',
        display_name: 'Webhook New',
        description: null,
        lifecycle_status: 'active',
        health_status: 'configured',
        provider_config: JSON.stringify({ url: 'https://logs.example.test/ingest' }),
        allowed_tenant_ids: JSON.stringify(['tenant-a']),
        allowed_log_types: JSON.stringify(['webhook']),
        allowed_planes: JSON.stringify(['external_sink']),
        region: null,
        critical_allowed: 0,
        default_fallback_eligible: 0,
        retention_days: 30,
        encryption_mode: 'platform_managed',
        last_health_check_at: null,
        version: 1,
      });
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_new' });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/rows/pol_1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          tenant_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          destination_id: 'dest_new',
          expected_version: 2,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as { item: { id: string; version: number } };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({ id: 'pol_1', version: 3 });
  });

  it('creates platform fallback policies with fallback-eligible destinations', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dest_fallback',
      scope_type: 'platform',
      scope_id: 'global',
      destination_kind: 'object_storage',
      provider: 'r2',
      name: 'platform-fallback',
      display_name: 'Platform Fallback',
      description: null,
      lifecycle_status: 'active',
      health_status: 'healthy',
      provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }),
      allowed_tenant_ids: null,
      allowed_log_types: JSON.stringify(['audit']),
      allowed_planes: JSON.stringify(['archive']),
      region: null,
      critical_allowed: 1,
      default_fallback_eligible: 1,
      retention_days: 30,
      encryption_mode: 'platform_managed',
      last_health_check_at: null,
      version: 1,
    });
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_fallback' });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
    ]).request(
      '/api/admin/logging-policies/fallbacks',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          log_type: 'audit',
          plane: 'archive',
          fallback_destination_id: 'dest_fallback',
          failure_mode: 'platform_default',
          confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as { item: { id: string; version: number } };

    expect(response.status).toBe(201);
    expect(body.item.id).toMatch(/^pol_/);
    expect(body.item.version).toBe(1);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_fallback_policies'),
      expect.arrayContaining(['platform', 'global', 'audit', 'archive', 'dest_fallback'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_fallback_policy.create'])
    );
  });

  it('rejects fallback policies that target non-fallback destinations', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: 'dest_not_fallback',
        health_status: 'healthy',
        allowed_log_types: JSON.stringify(['diagnostic']),
        allowed_planes: JSON.stringify(['archive']),
        default_fallback_eligible: 0,
      })
    );
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_dest_not_fallback' });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/fallbacks',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          log_type: 'diagnostic',
          plane: 'archive',
          fallback_destination_id: 'dest_not_fallback',
          failure_mode: 'retry_then_dlq',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({
        path: 'fallback_destination_id',
        code: 'fallback_not_allowed',
      })
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_fallback_policies'),
      expect.anything()
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_fallback_policy.create'])
    );
  });

  it('uses runtime-compatible fallback failure modes', async () => {
    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/fallbacks',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          log_type: 'webhook',
          plane: 'external_sink',
          fallback_destination_id: null,
          failure_mode: 'retry_then_platform_default',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(response.status).toBe(201);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_fallback_policies'),
      expect.arrayContaining(['retry_then_platform_default'])
    );

    const rejected = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/fallbacks',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          log_type: 'webhook',
          plane: 'external_sink',
          fallback_destination_id: null,
          failure_mode: 'dlq_only',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await rejected.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(rejected.status).toBe(400);
    expect(body.details.fields).toContainEqual(
      expect.objectContaining({
        path: 'failure_mode',
        code: 'invalid_value',
      })
    );
  });

  it('rejects tenant fallback patch attempts against platform fallback rows', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'pol_fallback_platform',
      scope_type: 'platform',
      scope_id: 'global',
      log_type: 'webhook',
      plane: 'external_sink',
      fallback_destination_id: 'dest_fallback',
      failure_mode: 'retry_then_dlq',
      created_at: 1000,
      updated_at: 1000,
      version: 1,
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE]).request(
      '/api/admin/logging-policies/fallbacks/pol_fallback_platform',
      {
        method: 'PATCH',
        body: JSON.stringify({
          scope_type: 'tenant',
          scope_id: 'tenant-a',
          log_type: 'webhook',
          plane: 'external_sink',
          fallback_destination_id: 'dest_fallback',
          failure_mode: 'retry_then_dlq',
          expected_version: 1,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_fallback_policies'),
      expect.anything()
    );
  });

  it('uses delivery event permission for delivery event reads', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/delivery-events',
      {},
      env
    );
    expect(denied.status).toBe(403);

    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/delivery-events?status=failed&lane=critical',
      {},
      env
    );
    expect(allowed.status).toBe(200);
  });

  it('uses logging overview permission for delivery aggregate summary reads', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_AUDIT_READ]).request(
      '/api/admin/logging-policies/delivery-summary',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query.mockResolvedValueOnce([
      {
        lane: 'critical',
        status: 'retrying',
        log_type: 'audit',
        plane: 'external_sink',
        batch_count: 2,
        record_count: 20,
        byte_count: 1024,
      },
    ]);
    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/delivery-summary?filter[lane]=critical&time_start=100',
      {},
      env
    );
    const body = (await allowed.json()) as { item: { items: Array<{ lane: string }> } };

    expect(allowed.status).toBe(200);
    expect(body.item.items).toEqual([
      expect.objectContaining({
        lane: 'critical',
        status: 'retrying',
        log_type: 'audit',
      }),
    ]);
    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM logging_delivery_event_aggregates'),
      expect.arrayContaining([100, tenantKey, 'critical'])
    );
  });

  it('scopes tenant delivery reads with registry tenant keys when available', async () => {
    const tenantRegistryAdapter = {
      query: vi.fn(),
      queryOne: vi.fn().mockResolvedValueOnce({ tenant_key: 't_registry_scope' }),
      execute: vi.fn(),
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn(),
      getType: vi.fn().mockReturnValue('test'),
      close: vi.fn(),
    };
    mockAdapter.query.mockResolvedValueOnce([]);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/delivery-summary?time_start=100',
      {},
      { ...env, DB: tenantRegistryAdapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    expect(tenantRegistryAdapter.queryOne).toHaveBeenCalledWith(
      'SELECT tenant_key FROM tenants WHERE id = ?',
      ['tenant-a']
    );
    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM logging_delivery_event_aggregates'),
      expect.arrayContaining([100, 't_registry_scope'])
    );
  });

  it('lists unresolved logging notifications through overview permissions', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_AUDIT_READ]).request(
      '/api/admin/logging-policies/notifications',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'notif_1',
        tenant_id: 'tenant-a',
        category: 'logging_delivery_failure',
        event_type: 'logging.delivery.retrying',
        severity: 'critical',
        status: 'pending',
        payload_json: '{}',
        created_at: '2026-05-19T00:00:00.000Z',
      },
    ]);
    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/notifications?severity=critical&time_start=1779148800000',
      {},
      env
    );
    const body = (await allowed.json()) as {
      items: Array<{ id: string }>;
      page: { next_cursor: string | null; has_more: boolean; limit: number };
    };

    expect(allowed.status).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        id: 'notif_1',
        category: 'logging_delivery_failure',
      }),
    ]);
    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM internal_notification_events'),
      expect.arrayContaining(['tenant-a', 'critical', '2026-05-19T00:00:00.000Z'])
    );
  });

  it('resolves logging notifications and audits the action', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'notif_1',
      tenant_id: 'tenant-a',
      category: 'logging_dlq_backlog',
      event_type: 'logging.delivery.dlq',
      severity: 'high',
      status: 'pending',
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/notifications/notif_1/resolve',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        id: 'notif_1',
        status: 'suppressed',
      },
      audit_id: expect.any(String),
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'suppressed'"),
      expect.arrayContaining(['notif_1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_notification.resolve'])
    );
  });

  it('lists notification center events across logging and storage categories', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_AUDIT_READ]).request(
      '/api/admin/notifications',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'notif_storage',
          tenant_id: 'tenant-a',
          category: 'storage_registry_health',
          event_type: 'tenant_database.reconciliation.missing_binding',
          severity: 'critical',
          status: 'pending',
          payload_json: '{}',
          attempts: 0,
          created_at: '2026-05-19T00:00:00.000Z',
          updated_at: '2026-05-19T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          category: 'storage_registry_health',
          severity: 'critical',
          status: 'pending',
          count: 1,
        },
      ]);
    mockAdapter.queryOne.mockResolvedValueOnce({ total: 1 });

    const allowed = await createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]).request(
      '/api/admin/notifications?category=storage_registry_health&status=unresolved',
      {},
      env
    );
    const body = (await allowed.json()) as {
      items: Array<{ id: string; category: string }>;
      total: number;
      page: { summary: Array<{ category: string; count: number }> };
    };

    expect(allowed.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: 'notif_storage',
      category: 'storage_registry_health',
    });
    expect(body.page.summary[0]).toMatchObject({
      category: 'storage_registry_health',
      count: 1,
    });
    expect(mockAdapter.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM internal_notification_events'),
      expect.arrayContaining(['storage_registry_health', 'tenant-a', 'pending', 'failed'])
    );
  });

  it('resolves notification center events with tenant scoping', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'notif_1',
      tenant_id: 'tenant-a',
      category: 'tenant_database_health',
      event_type: 'tenant_database.health.failed',
      severity: 'high',
      status: 'failed',
    });

    const response = await createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]).request(
      '/api/admin/notifications/notif_1/resolve',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        id: 'notif_1',
        status: 'suppressed',
      },
      audit_id: expect.any(String),
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'suppressed'"),
      expect.arrayContaining(['notif_1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['internal_notification.resolve'])
    );
  });

  it('automates the manual logging smoke path from destination setup to payload export', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const app = createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH,
      LOGGING_EXPORT_CREATE_PERMISSION,
    ]);

    const destinationResponse = await app.request(
      '/api/admin/destinations',
      {
        method: 'POST',
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          provider: 'r2',
          name: 'manual-smoke-archive',
          display_name: 'Manual Smoke Archive',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' },
          allowed_log_types: ['audit'],
          allowed_planes: ['archive'],
          critical_allowed: true,
          default_fallback_eligible: true,
          retention_days: 30,
          capabilities: ['archive_write'],
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const destinationBody = (await destinationResponse.json()) as { item: { id: string } };
    const destinationId = destinationBody.item.id;

    expect(destinationResponse.status).toBe(201);
    expect(destinationId).toMatch(/^dest_/);

    mockAdapter.queryOne.mockResolvedValueOnce(
      destinationRow({
        id: destinationId,
        health_status: 'healthy',
        provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' }),
        allowed_log_types: JSON.stringify(['audit']),
        allowed_planes: JSON.stringify(['archive']),
        critical_allowed: 1,
        default_fallback_eligible: 1,
      })
    );
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'sda_manual_smoke' });
    const assignmentResponse = await app.request(
      '/api/admin/logging-policies/assignments',
      {
        method: 'POST',
        body: JSON.stringify({
          log_type: 'audit',
          plane: 'archive',
          destination_id: destinationId,
          confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const assignmentBody = (await assignmentResponse.json()) as { item: { id: string } };

    expect(assignmentResponse.status).toBe(201);
    expect(assignmentBody.item.id).toMatch(/^pol_/);

    mockAdapter.queryOne.mockResolvedValueOnce({ next_version: 1 });
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: assignmentBody.item.id,
          tenant_id: null,
          log_type: 'audit',
          plane: 'archive',
          destination_id: destinationId,
          updated_at: 1779148800000,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        destinationRow({
          id: destinationId,
          provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' }),
          allowed_log_types: JSON.stringify(['audit']),
          allowed_planes: JSON.stringify(['archive']),
          critical_allowed: 1,
          default_fallback_eligible: 1,
          updated_at: 1779148800000,
        }),
      ]);
    const snapshotResponse = await app.request(
      '/api/admin/logging-policies/snapshots',
      {
        method: 'POST',
        body: JSON.stringify({ scope_type: 'platform', scope_id: 'global' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const snapshotBody = (await snapshotResponse.json()) as {
      item: { status: string; object_ref: string | null };
    };

    expect(snapshotResponse.status).toBe(200);
    expect(snapshotBody.item.status).toBe('published');
    expect(snapshotBody.item.object_ref).toMatch(
      /^logging-policy-snapshots\/v1\/snapshots\/platform\/global\/v1-snap_/
    );
    expect(env.AUTHRIM_CONFIG?.put).toHaveBeenCalledWith(
      'logging-policy-snapshots/v1/current/platform/global.json',
      expect.stringContaining('"schemaVersion":1'),
      undefined
    );

    const payload = {
      id: 'evt_manual_smoke',
      eventType: 'auth.login',
      result: 'success',
    };
    let storedChunkBody: Uint8Array | undefined;
    const objectRows: Array<Record<string, unknown>> = [];
    const indexRows: Array<Record<string, unknown>> = [];
    const chunkResult = await writeLogChunkToR2({
      bucket: {
        put: vi.fn(async (_key: string, body: Uint8Array) => {
          storedChunkBody = body;
        }),
      } as unknown as R2Bucket,
      tenantKey,
      logType: 'audit',
      plane: 'archive',
      records: [{ id: 'evt_manual_smoke', eventAt: 1779148800000, payload }],
      compression: 'none',
      now: 1779148800000,
      catalogStore: {
        createPendingObject: vi.fn(async (row) => {
          objectRows.push(row as unknown as Record<string, unknown>);
        }),
        createPendingRecordIndexes: vi.fn(async (rows) => {
          indexRows.push(...(rows as unknown as Array<Record<string, unknown>>));
        }),
        commitObject: vi.fn(),
        commitRecordIndexes: vi.fn(),
        markObjectOrphanCandidate: vi.fn(),
      },
    });
    const recordIndex = indexRows[0]!;

    expect(objectRows).toHaveLength(1);
    expect(recordIndex.recordId).toBe('evt_manual_smoke');

    mockAdapter.query.mockResolvedValueOnce([
      {
        record_id: recordIndex.recordId,
        tenant_key: tenantKey,
        log_type: 'audit',
        plane: 'archive',
        surface: 'admin',
        object_catalog_id: chunkResult.objectCatalogId,
        chunk_id: chunkResult.chunkId,
        object_key: chunkResult.objectKey,
        object_kind: 'chunk',
        compression: chunkResult.compression,
        encryption_scope: null,
        key_version: null,
        line_number: recordIndex.lineNumber,
        block_offset: recordIndex.blockOffset,
        block_length: recordIndex.blockLength,
        record_offset: recordIndex.recordOffset,
        record_length: recordIndex.recordLength,
        event_at: 1779148800000,
        index_profile: 'audit',
        indexed_fields: '{}',
        status: 'committed',
        created_at: 1779148800000,
      },
    ]);
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      arrayBuffer: vi.fn().mockResolvedValue(storedChunkBody!.slice().buffer),
    } as unknown as R2ObjectBody);

    const exportResponse = await app.request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({
          format: 'jsonl',
          source: 'record_index',
          include_payload: true,
          tenant_key: tenantKey,
          log_type: 'audit',
          plane: 'archive',
          limit: 10,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const exportBody = (await exportResponse.json()) as {
      result: { id: string; status: string; message_job_id: string; queued: boolean };
      audit_id: string;
    };

    expect(exportResponse.status).toBe(202);
    expect(exportBody.audit_id).toEqual(expect.any(String));
    expect(exportBody.result).toMatchObject({
      id: expect.stringMatching(/^lexp_/),
      status: 'queued',
      message_job_id: expect.stringMatching(/^lmj_/),
    });
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/'),
      expect.stringContaining('"payload_type":"export_build"'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_export.create'])
    );
  });

  it('creates logging export artifacts with manifest and audit trail', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'chk_1',
        tenant_key: tenantKey,
        log_type: 'audit',
        plane: 'archive',
        surface: 'admin',
        object_key: `logs/v1/tenant_key=${tenantKey}/audit.jsonl`,
        object_kind: 'chunk',
        status: 'committed',
        record_count: 2,
        byte_count: 256,
        checksum_sha256: 'sha256:chunk',
        created_at: 1000,
        committed_at: 1100,
      },
    ]);

    const response = await createApp([LOGGING_EXPORT_CREATE_PERMISSION]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({
          format: 'jsonl',
          tenant_key: tenantKey,
          log_type: 'audit',
          plane: 'archive',
          time_start: 100,
          limit: 10,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      item: {
        id: string;
        status: string;
        message_job_id: string;
        queued: boolean;
      };
    };

    expect(response.status).toBe(202);
    const result = (
      body as unknown as {
        result: { id: string; status: string; message_job_id: string };
      }
    ).result;
    expect(result.id).toMatch(/^lexp_/);
    expect(result.status).toBe('queued');
    expect(result.message_job_id).toMatch(/^lmj_/);
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/'),
      expect.stringContaining('"payload_type":"export_build"'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_export_jobs'),
      expect.arrayContaining([result.id, tenantKey, 'audit', 'archive', 'jsonl', 'queued'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_export.create'])
    );
  });

  it('requires explicit export and sensitive-detail export permissions', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const baseBody = {
      format: 'jsonl',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      limit: 10,
    };

    const deliveryReadOnly = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify(baseBody),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(deliveryReadOnly.status).toBe(403);
    await expect(deliveryReadOnly.json()).resolves.toMatchObject({
      details: {
        permission: {
          required_permission: LOGGING_EXPORT_CREATE_PERMISSION,
          reason: 'export_create_permission_required',
        },
      },
    });

    const sensitiveWithoutGrant = await createApp([LOGGING_EXPORT_CREATE_PERMISSION]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({ ...baseBody, plane: 'sensitive_detail' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(sensitiveWithoutGrant.status).toBe(403);
    await expect(sensitiveWithoutGrant.json()).resolves.toMatchObject({
      details: {
        permission: {
          required_permission: 'admin:logging:sensitive_detail:export',
          reason: 'sensitive_detail_export_permission_required',
        },
      },
    });
  });

  it('creates record index based export artifacts when requested', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.query.mockResolvedValueOnce([
      {
        record_id: 'evt_1',
        tenant_key: tenantKey,
        log_type: 'audit',
        plane: 'archive',
        surface: 'admin',
        object_catalog_id: 'chk_1',
        chunk_id: 'chk_1',
        object_key: `logs/v1/tenant_key=${tenantKey}/audit.jsonl`,
        line_number: 0,
        record_offset: 0,
        record_length: 120,
        event_at: 1000,
        index_profile: 'audit_default',
        indexed_fields: '{"eventType":"auth.login"}',
        status: 'committed',
        created_at: 1000,
      },
    ]);

    const response = await createApp([LOGGING_EXPORT_CREATE_PERMISSION]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({
          format: 'csv',
          source: 'record_index',
          tenant_key: tenantKey,
          log_type: 'audit',
          plane: 'archive',
          time_start: 100,
          limit: 10,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      result: { status: string; message_job_id: string };
    };

    expect(response.status).toBe(202);
    expect(body.result.status).toBe('queued');
    expect(body.result.message_job_id).toMatch(/^lmj_/);
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/'),
      expect.stringContaining('"source":"record_index"'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
  });

  it('expands record index export artifacts with chunk payloads when requested', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payload = {
      id: 'evt_1',
      eventType: 'auth.login',
      result: 'success',
    };
    const encoded = await encodeLogRecordBlocks(
      [
        {
          id: 'evt_1',
          eventAt: 1000,
          payload,
        },
      ],
      { compression: 'none' }
    );
    const recordLocation = encoded.records[0];
    const block = encoded.blocks[0];
    const objectKey = `logs/v1/tenant_key=${tenantKey}/audit/chk_1.jsonl`;

    mockAdapter.query.mockResolvedValueOnce([
      {
        record_id: 'evt_1',
        tenant_key: tenantKey,
        log_type: 'audit',
        plane: 'archive',
        surface: 'admin',
        object_catalog_id: 'chk_1',
        chunk_id: 'chk_1',
        object_key: objectKey,
        object_kind: 'chunk',
        compression: 'none',
        encryption_scope: null,
        key_version: null,
        line_number: recordLocation.lineNumber,
        block_offset: block.compressedOffset,
        block_length: block.compressedLength,
        record_offset: recordLocation.recordOffset,
        record_length: recordLocation.recordLength,
        event_at: 1000,
        index_profile: 'audit_default',
        indexed_fields: '{"eventType":"auth.login"}',
        status: 'committed',
        created_at: 1000,
      },
    ]);
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      arrayBuffer: vi.fn().mockResolvedValue(encoded.body.buffer),
    } as unknown as R2ObjectBody);

    const response = await createApp([LOGGING_EXPORT_CREATE_PERMISSION]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({
          format: 'jsonl',
          source: 'record_index',
          include_payload: true,
          tenant_key: tenantKey,
          log_type: 'audit',
          plane: 'archive',
          limit: 10,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      result: { status: string; message_job_id: string };
    };

    expect(response.status).toBe(202);
    expect(body.result.status).toBe('queued');
    expect(body.result.message_job_id).toMatch(/^lmj_/);
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/'),
      expect.stringContaining('"include_payload":true'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
  });

  it('decrypts encrypted archive chunks for record index payload exports', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payload = {
      id: 'evt_encrypted',
      eventType: 'admin.destination.update',
      result: 'success',
    };
    const keyVersion = 1;
    let storedBody: Uint8Array | undefined;
    const objectRows: Array<Record<string, unknown>> = [];
    const indexRows: Array<Record<string, unknown>> = [];

    const result = await writeLogChunkToR2({
      bucket: {
        put: vi.fn(async (_key: string, body: Uint8Array) => {
          storedBody = body;
        }),
      } as unknown as R2Bucket,
      tenantKey,
      logType: 'audit',
      plane: 'archive',
      records: [{ id: 'evt_encrypted', eventAt: 1000, payload }],
      compression: 'none',
      now: 1000,
      encryption: {
        keyBytes: await deriveTestArchiveChunkEncryptionKey({
          rootKeyHex: String(env.OBJECT_ENCRYPTION_ROOT_KEY),
          tenantKey,
          logType: 'audit',
          plane: 'archive',
          keyVersion,
        }),
        encryptionScope: `tenant:${tenantKey}:audit:archive`,
        keyVersion,
      },
      catalogStore: {
        createPendingObject: vi.fn(async (row) => {
          objectRows.push(row as unknown as Record<string, unknown>);
        }),
        createPendingRecordIndexes: vi.fn(async (rows) => {
          indexRows.push(...(rows as unknown as Array<Record<string, unknown>>));
        }),
        commitObject: vi.fn(),
        commitRecordIndexes: vi.fn(),
        markObjectOrphanCandidate: vi.fn(),
      },
    });
    const recordIndex = indexRows[0]!;

    mockAdapter.query.mockResolvedValueOnce([
      {
        record_id: recordIndex.recordId,
        tenant_key: tenantKey,
        log_type: 'audit',
        plane: 'archive',
        surface: null,
        object_catalog_id: result.objectCatalogId,
        chunk_id: result.chunkId,
        object_key: result.objectKey,
        object_kind: 'chunk',
        compression: result.compression,
        encryption_scope: result.encryptionScope,
        key_version: result.keyVersion,
        line_number: recordIndex.lineNumber,
        block_offset: recordIndex.blockOffset,
        block_length: recordIndex.blockLength,
        record_offset: recordIndex.recordOffset,
        record_length: recordIndex.recordLength,
        event_at: 1000,
        index_profile: 'audit',
        indexed_fields: '{}',
        status: 'committed',
        created_at: 1000,
      },
    ]);
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      arrayBuffer: vi.fn().mockResolvedValue(storedBody!.slice().buffer),
    } as unknown as R2ObjectBody);

    const response = await createApp([LOGGING_EXPORT_CREATE_PERMISSION]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({
          format: 'jsonl',
          source: 'record_index',
          include_payload: true,
          tenant_key: tenantKey,
          log_type: 'audit',
          plane: 'archive',
          limit: 10,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      result: { status: string; message_job_id: string };
    };

    expect(objectRows).toHaveLength(1);
    expect(response.status).toBe(202);
    expect(body.result.status).toBe('queued');
    expect(body.result.message_job_id).toMatch(/^lmj_/);
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/'),
      expect.stringContaining('"include_payload":true'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
  });

  it('exports decrypted sensitive detail chunk payloads with explicit permission', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const objectKey = `sensitive-details/${tenantKey}/sensitive_detail/admin_audit/2026/05/20/chk_sensitive.jsonl`;
    const payload = {
      metadata: {
        action: 'admin.destination.update',
        secretPreview: 'redacted-by-policy',
      },
    };
    const envelope = await encryptObjectArtifact(JSON.stringify(payload), {
      rootKeyHex: String(env.OBJECT_ENCRYPTION_ROOT_KEY),
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey,
        objectClass: 'admin_audit_detail',
      },
    });
    const chunkRow = {
      record_id: 'oa_sensitive',
      tenant_id: 'tenant-a',
      tenant_key: tenantKey,
      object_catalog_id: 'catalog_sensitive',
      object_class: 'admin_audit_detail',
      object_key: objectKey,
      object_kind: 'chunk',
      bucket_binding: 'SENSITIVE_DETAILS',
      content_encoding: 'none',
      line_number: 0,
      key_version: 1,
      checksum_sha256: 'abc123',
      created_at: 1000,
      deleted_at: null,
    };
    mockAdapter.query.mockResolvedValueOnce([chunkRow]);
    mockAdapter.queryOne.mockResolvedValueOnce({
      catalog_id: 'catalog_sensitive',
      tenant_id: 'tenant-a',
      object_class: 'admin_audit_detail',
      bucket_binding: 'SENSITIVE_DETAILS',
      object_key: objectKey,
      content_encoding: 'none',
      line_number: 0,
      key_version: 1,
      checksum_sha256: 'abc123',
      created_at: 1000,
      deleted_at: null,
    });
    vi.mocked(env.SENSITIVE_DETAILS!.get).mockResolvedValueOnce(
      createTextR2Object(`${JSON.stringify(envelope)}\n`)
    );

    const response = await createApp([
      LOGGING_EXPORT_CREATE_PERMISSION,
      LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
    ]).request(
      '/api/admin/logging-policies/exports',
      {
        method: 'POST',
        body: JSON.stringify({
          format: 'jsonl',
          tenant_key: tenantKey,
          log_type: 'admin_audit',
          plane: 'sensitive_detail',
          include_payload: true,
          limit: 10,
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      result: { status: string; message_job_id: string };
    };

    expect(response.status).toBe(202);
    expect(body.result.status).toBe('queued');
    expect(body.result.message_job_id).toMatch(/^lmj_/);
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/criticality=critical/'),
      expect.stringContaining('"plane":"sensitive_detail"'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
  });

  it('reads logging export status and artifact payloads', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_1',
      tenant_key: tenantKey,
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
    });
    const statusResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_1', {}, env);
    const statusBody = (await statusResponse.json()) as {
      item: { id: string; artifact_object_ref: string };
    };

    expect(statusResponse.status).toBe(200);
    expect(statusBody.item).toMatchObject({
      id: 'lexp_1',
      artifact_object_ref: 'logging-exports/v1/lexp_1/records.csv',
    });

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_1',
      tenant_key: tenantKey,
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
    });
    vi.mocked(env.DIAGNOSTIC_LOGS!.get).mockResolvedValueOnce({
      text: vi.fn().mockResolvedValue(`id,tenant_key\nchk_1,${tenantKey}\n`),
    } as unknown as R2ObjectBody);

    const artifactResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_1/artifact', {}, env);

    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get('content-type')).toContain('text/csv');
    expect(await artifactResponse.text()).toBe(`id,tenant_key\nchk_1,${tenantKey}\n`);
    expect(env.DIAGNOSTIC_LOGS?.get).toHaveBeenCalledWith('logging-exports/v1/lexp_1/records.csv');

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_2',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      format: 'csv',
      status: 'completed',
      artifact_object_ref: null,
      manifest_object_ref: 'logging-exports/v1/lexp_2/manifest.json',
      checksum_sha256: 'def456',
      record_count: 2,
      byte_count: 84,
      requested_by: 'admin-1',
      error_class: null,
      filter_json: '{}',
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      expires_at: 2000,
    });
    vi.mocked(env.DIAGNOSTIC_LOGS!.get)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            parts: [
              { object_ref: 'logging-exports/v1/lexp_2/parts/part-00000.csv' },
              { object_ref: 'logging-exports/v1/lexp_2/parts/part-00001.csv' },
            ],
          })
        ),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(`id,tenant_key\nchk_1,${tenantKey}\n`),
      } as unknown as R2ObjectBody)
      .mockResolvedValueOnce({
        text: vi.fn().mockResolvedValue(`id,tenant_key\nchk_2,${tenantKey}\n`),
      } as unknown as R2ObjectBody);

    const multipartArtifactResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_2/artifact', {}, env);

    expect(multipartArtifactResponse.status).toBe(200);
    expect(await multipartArtifactResponse.text()).toBe(
      `id,tenant_key\nchk_1,${tenantKey}\n\nchk_2,${tenantKey}\n`
    );
  });

  it('requires sensitive-detail permission to read sensitive export status and artifacts', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const sensitiveExport = {
      id: 'lexp_sensitive',
      tenant_key: tenantKey,
      log_type: 'admin_audit',
      plane: 'sensitive_detail',
      format: 'jsonl',
      status: 'completed',
      artifact_object_ref: 'logging-exports/v1/lexp_sensitive/records.jsonl',
      manifest_object_ref: null,
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
    };

    mockAdapter.queryOne.mockResolvedValueOnce(sensitiveExport);
    const statusResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_sensitive', {}, env);

    expect(statusResponse.status).toBe(403);
    await expect(statusResponse.json()).resolves.toMatchObject({
      details: {
        permission: {
          required_permission: LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
          reason: 'sensitive_detail_export_permission_required',
        },
      },
    });

    vi.mocked(env.DIAGNOSTIC_LOGS!.get).mockClear();
    mockAdapter.queryOne.mockResolvedValueOnce(sensitiveExport);
    const artifactResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_sensitive/artifact', {}, env);

    expect(artifactResponse.status).toBe(403);
    await expect(artifactResponse.json()).resolves.toMatchObject({
      details: {
        permission: {
          required_permission: LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION,
          reason: 'sensitive_detail_export_permission_required',
        },
      },
    });
    expect(env.DIAGNOSTIC_LOGS?.get).not.toHaveBeenCalled();
  });

  it('rejects unsafe or oversized logging export artifact downloads before reading R2 objects', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_large',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      format: 'jsonl',
      status: 'completed',
      artifact_object_ref: 'logging-exports/v1/lexp_large/records.jsonl',
      manifest_object_ref: null,
      checksum_sha256: 'abc123',
      record_count: 1,
      byte_count: 65 * 1024 * 1024,
      requested_by: 'admin-1',
      error_class: null,
      filter_json: '{}',
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      expires_at: 2000,
    });

    const oversizedResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_large/artifact', {}, env);

    expect(oversizedResponse.status).toBe(400);
    expect(env.DIAGNOSTIC_LOGS?.get).not.toHaveBeenCalled();

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_unsafe',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      format: 'jsonl',
      status: 'completed',
      artifact_object_ref: 'logging-exports/v1/other_export/records.jsonl',
      manifest_object_ref: null,
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
    });

    const unsafeResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_unsafe/artifact', {}, env);

    expect(unsafeResponse.status).toBe(400);
    expect(env.DIAGNOSTIC_LOGS?.get).not.toHaveBeenCalled();

    const oversizedText = vi.fn().mockResolvedValue('should not be read');
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_object_large',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      format: 'jsonl',
      status: 'completed',
      artifact_object_ref: 'logging-exports/v1/lexp_object_large/records.jsonl',
      manifest_object_ref: null,
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
    });
    vi.mocked(env.DIAGNOSTIC_LOGS!.get).mockResolvedValueOnce({
      size: 65 * 1024 * 1024,
      text: oversizedText,
    } as unknown as R2ObjectBody);

    const oversizedObjectResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_object_large/artifact', {}, env);

    expect(oversizedObjectResponse.status).toBe(400);
    expect(oversizedText).not.toHaveBeenCalled();

    const oversizedManifestText = vi.fn().mockResolvedValue('should not be read');
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lexp_manifest_large',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      format: 'jsonl',
      status: 'completed',
      artifact_object_ref: null,
      manifest_object_ref: 'logging-exports/v1/lexp_manifest_large/manifest.json',
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
    });
    vi.mocked(env.DIAGNOSTIC_LOGS!.get).mockResolvedValueOnce({
      size: 2 * 1024 * 1024,
      text: oversizedManifestText,
    } as unknown as R2ObjectBody);

    const oversizedManifestResponse = await createApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/exports/lexp_manifest_large/artifact', {}, env);

    expect(oversizedManifestResponse.status).toBe(400);
    expect(oversizedManifestText).not.toHaveBeenCalled();
  });

  it('uses delivery event permission for DLQ item reads', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const denied = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/dlq',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'dlq_1',
        tenant_key: tenantKey,
        payload_type: 'audit_queue_message',
        schema_version: 1,
        lane: 'critical',
        status: 'open',
        created_at: 2000,
      },
    ]);
    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/dlq?status=open&lane=critical',
      {},
      env
    );
    const body = (await allowed.json()) as {
      items: Array<{ id: string }>;
      page: { next_cursor: string | null; has_more: boolean; limit: number };
    };

    expect(allowed.status).toBe(200);
    expect(body.items).toEqual([
      {
        id: 'dlq_1',
        tenant_key: tenantKey,
        payload_type: 'audit_queue_message',
        schema_version: 1,
        lane: 'critical',
        status: 'open',
        created_at: 2000,
      },
    ]);
    expect(body.page).toMatchObject({
      next_cursor: null,
      has_more: false,
      limit: 50,
    });
    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM logging_dlq_items'),
      expect.arrayContaining([tenantKey, 'critical', 'open'])
    );
  });

  it('previews bulk DLQ replay candidates with tenant scoping', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'dlq_bulk_1',
        tenant_key: tenantKey,
        payload_type: 'delivery_fanout',
        schema_version: 1,
        lane: 'default',
        destination_id: 'dest_1',
        payload_object_ref: `dlq/tenant_key=${tenantKey}/bulk.json`,
        error_class: 'delivery_failed',
        attempt_count: 3,
        status: 'open',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/dlq/bulk-replay/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lane: 'default', limit: 10 }),
      },
      env
    );
    const body = (await response.json()) as { item: { item_count: number } };

    expect(response.status).toBe(200);
    expect(body.item.item_count).toBe(1);
    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM logging_dlq_items'),
      expect.arrayContaining(['open', tenantKey, 'default', 10])
    );
  });

  it('summarizes logging usage across catalog, delivery, DLQ, and sensitive detail indexes', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.query
      .mockResolvedValueOnce([{ tenant_key: tenantKey, status: 'delivered', batch_count: 2 }])
      .mockResolvedValueOnce([{ tenant_key: tenantKey, object_kind: 'chunk', object_count: 1 }])
      .mockResolvedValueOnce([{ tenant_key: tenantKey, status: 'open', item_count: 1 }])
      .mockResolvedValueOnce([{ tenant_id: 'tenant-a', object_class: 'event_log_detail' }]);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/usage-summary?time_start=1000&limit=25',
      {},
      env
    );
    const body = (await response.json()) as {
      item: {
        tenant_key: string;
        tenant_id: string;
        delivery: unknown[];
        catalog: unknown[];
        dlq: unknown[];
        sensitive_detail: unknown[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({
      tenant_key: tenantKey,
      tenant_id: 'tenant-a',
    });
    expect(body.item.delivery).toHaveLength(1);
    expect(body.item.catalog).toHaveLength(1);
    expect(body.item.dlq).toHaveLength(1);
    expect(body.item.sensitive_detail).toHaveLength(1);
  });

  it('verifies runtime snapshot pointer, object, and database metadata', async () => {
    const objectRef = 'logging-policy-snapshots/v1/snapshots/tenant/tenant-a/v1-snap_runtime.json';
    vi.mocked(
      env.AUTHRIM_CONFIG!.get as unknown as (key: string) => Promise<string | null>
    ).mockResolvedValueOnce(
      JSON.stringify({
        schemaVersion: 1,
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        version: 1,
        policyHash: 'hash_1',
        snapshotId: 'snap_runtime',
        objectRef,
        publishedAt: 1000,
        expiresAt: null,
      })
    );
    vi.mocked(env.DIAGNOSTIC_LOGS!.get).mockResolvedValueOnce(
      createTextR2Object(
        JSON.stringify({
          snapshotId: 'snap_runtime',
          scopeType: 'tenant',
          scopeId: 'tenant-a',
          version: 1,
          policyHash: 'hash_1',
          synchronizedAt: 1000,
          sourceUpdatedAt: 900,
          policies: [],
        })
      )
    );
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'snap_runtime',
      version: 1,
      policy_hash: 'hash_1',
      object_ref: objectRef,
      published_at: 1000,
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/runtime/verify?scope_type=tenant',
      {},
      env
    );
    const body = (await response.json()) as {
      item: { checks: Record<string, boolean>; pointer_status: string; object_status: string };
    };

    expect(response.status).toBe(200);
    expect(body.item.pointer_status).toBe('readable');
    expect(body.item.object_status).toBe('readable');
    expect(body.item.checks).toMatchObject({
      pointer_matches_snapshot: true,
      pointer_matches_database: true,
    });
  });

  it('returns tenant database runtime health dry-run state', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        shard_group: 'default',
        generation: 1,
        shard_count: 1,
        shard_key_strategy: 'default',
        runtime_generation: 1,
        pointer_status: 'active',
        pointer_updated_at: '2026-05-19T00:00:00.000Z',
        pointer_metadata_json: null,
        provider: 'd1',
        database_id: 'db-1',
        database_name: 'tenant-a-core',
        binding_ref: 'TENANT_DB_A',
        connection_ref: null,
        schema_version: 89,
        registry_status: 'active',
        region_hint: 'wnam',
        jurisdiction: null,
        registry_updated_at: '2026-05-19T00:00:00.000Z',
        registry_metadata_json: JSON.stringify({ last_health_error: null }),
      },
    ]);

    const response = await createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]).request(
      '/api/admin/logging-policies/runtime/tenant-db-health?role=tenant_core',
      {},
      { ...env, TENANT_DB_A: {} } as unknown as Env
    );
    const body = (await response.json()) as {
      item: {
        summary: Record<string, number>;
        items: Array<{ binding_configured: boolean; health_state: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.item.summary.healthy).toBe(1);
    expect(body.item.items[0]).toMatchObject({
      binding_configured: true,
      health_state: 'healthy',
    });
  });

  it('previews DLQ payload objects without requiring replay permission', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/item.json`;
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dlq_1',
      tenant_key: tenantKey,
      payload_type: 'audit_queue_message',
      schema_version: 1,
      lane: 'critical',
      destination_id: null,
      payload_object_ref: payloadObjectRef,
      error_class: 'audit_message_failed_permanently',
      attempt_count: 5,
      status: 'open',
      created_at: 1000,
      updated_at: 1000,
    });
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      size: 52,
      httpMetadata: { contentType: 'application/json' },
      text: vi.fn().mockResolvedValue('{"body":{"type":"event_log","entries":[{"id":"evt_1"}]}}'),
    } as unknown as R2ObjectBody);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/dlq-items/dlq_1/payload?preview_bytes=20',
      {},
      env
    );
    const body = (await response.json()) as {
      item: {
        id: string;
        payload: {
          content_type: string;
          byte_count: number;
          text_preview: string;
          truncated: boolean;
          parsed: {
            json_parse: { ok: boolean };
            queue_payload_parse: Array<{ source: string; ok: boolean; reason?: string }>;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.item.id).toBe('dlq_1');
    expect(body.item.payload).toMatchObject({
      content_type: 'application/json',
      byte_count: 52,
      text_preview: '{"body":{"type":"eve',
      truncated: true,
      parsed: {
        json_parse: { ok: true },
        queue_payload_parse: expect.arrayContaining([
          expect.objectContaining({
            source: 'body',
            ok: false,
            reason: 'malformed',
          }),
        ]),
      },
    });
    expect(env.AUDIT_ARCHIVE?.get).toHaveBeenCalledWith(payloadObjectRef);
  });

  it('rejects oversized DLQ payload previews before reading object text', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/large.json`;
    const text = vi.fn();
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dlq_large',
      tenant_key: tenantKey,
      payload_type: 'audit_queue_message',
      schema_version: 1,
      lane: 'critical',
      destination_id: null,
      payload_object_ref: payloadObjectRef,
      error_class: 'audit_message_failed_permanently',
      attempt_count: 5,
      status: 'open',
      created_at: 1000,
      updated_at: 1000,
    });
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      size: 1024 * 1024 + 1,
      httpMetadata: { contentType: 'application/json' },
      text,
    } as unknown as R2ObjectBody);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/dlq-items/dlq_large/payload?preview_bytes=4096',
      {},
      env
    );
    const body = (await response.json()) as { details?: { fields?: Array<{ code: string }> } };

    expect(response.status).toBe(400);
    expect(body.details?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'payload_object_too_large' })])
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('redacts sensitive fields while parsing DLQ payload details', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/item.json`;
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dlq_1',
      tenant_key: tenantKey,
      payload_type: 'http_sink_batch',
      schema_version: 1,
      lane: 'critical',
      destination_id: 'dest_1',
      payload_object_ref: payloadObjectRef,
      error_class: 'logging_delivery_payload_unsupported_schema',
      attempt_count: 2,
      status: 'open',
      created_at: 1000,
      updated_at: 1000,
    });
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      size: 512,
      httpMetadata: { contentType: 'application/json' },
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          body: {
            payload_type: 'http_sink_batch',
            schema_version: 1,
            payload_id: 'payload_1',
            tenant_key: tenantKey,
            lane: 'critical',
            created_at: 1000,
            destination_id: 'dest_1',
            endpoint_url: 'https://collector.example/logs',
            log_type: 'operational',
            plane: 'external_sink',
            batch_id: 'batch_1',
            record_count: 1,
            Authorization: 'Bearer secret-token',
            credential_value: 'secret-credential',
          },
        })
      ),
    } as unknown as R2ObjectBody);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/dlq-items/dlq_1/payload?preview_bytes=4096',
      {},
      env
    );
    const body = (await response.json()) as {
      item: {
        payload: {
          text_preview: string;
          parsed: {
            redacted_json: { body: { Authorization: string; credential_value: string } };
            queue_payload_parse: Array<{ source: string; ok: boolean; payload_type?: string }>;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.item.payload.text_preview).not.toContain('secret-token');
    expect(body.item.payload.parsed.redacted_json.body.Authorization).toBe('[redacted]');
    expect(body.item.payload.parsed.redacted_json.body.credential_value).toBe('[redacted]');
    expect(body.item.payload.parsed.queue_payload_parse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'body',
          ok: true,
          payload_type: 'http_sink_batch',
        }),
      ])
    );
  });

  it('queues open DLQ item replay through retry_delivery message jobs and audits the action', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/item.json`;
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'dlq_1',
        tenant_key: tenantKey,
        payload_type: 'delivery_fanout',
        schema_version: 1,
        lane: 'critical',
        destination_id: 'dest_1',
        payload_object_ref: payloadObjectRef,
        error_class: 'audit_message_failed_permanently',
        attempt_count: 5,
        status: 'open',
        created_at: 1000,
        updated_at: 1000,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lmj_replay',
        kind: 'retry_delivery',
        status: 'queued',
        lane: 'critical',
        criticality: 'critical',
        priority: 100,
        tenant_id: null,
        tenant_key: tenantKey,
        topology_type: 'unknown',
        database_binding_ref: null,
        connection_ref: null,
        topology_snapshot_version: null,
        topology_resolved_at: 1000,
        scope_type: 'tenant',
        scope_id: tenantKey,
        scope_key: `tenant:${tenantKey}`,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        root_job_id: null,
        parent_job_id: null,
        depth: 0,
        payload_object_ref: 'message-jobs/retry_delivery/job.json',
        payload_sha256: 'hash',
        payload_type: 'retry_delivery',
        payload_schema_version: 1,
        redacted_summary_json: null,
        validation_summary_json: null,
        idempotency_key: 'retry',
        dedupe_until: 2000,
        not_before: 1000,
        attempt_count: 0,
        max_attempts: 5,
        attempt_policy_json: null,
        claim_token: null,
        claimed_at: null,
        claimed_until: null,
        requested_by: 'admin-1',
        reason: null,
        error_class: null,
        last_error: null,
        blocked_reason: null,
        cancel_requested_at: null,
        cancelled_by: null,
        created_at: 1000,
        updated_at: 1000,
        started_at: null,
        completed_at: null,
        expires_at: null,
      });
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const bucketGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'delivery_fanout',
          schema_version: 1,
          payload_id: 'qpl_original',
          tenant_key: tenantKey,
          lane: 'critical',
          created_at: 1000,
          catalog_id: 'obj_1',
          object_key: 'logs/chunk.jsonl',
          destination_id: 'dest_1',
          log_type: 'audit',
          plane: 'archive',
          record_count: 1,
        })
      ),
    });
    const messagePut = vi.fn().mockResolvedValue(undefined);

    const response = await createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/dlq/dlq_1/replay',
      { method: 'POST' },
      {
        ...env,
        LOGGING_MESSAGE_CRITICAL_QUEUE: { send: queueSend },
        AUDIT_ARCHIVE: { get: bucketGet, delete: vi.fn() },
        DIAGNOSTIC_LOGS: { get: vi.fn(), put: messagePut, delete: vi.fn() },
      } as unknown as Env
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        id: expect.stringMatching(/^lmj_/),
        kind: 'retry_delivery',
        status: 'queued',
        queue_payload_id: expect.any(String),
        queue_binding: 'LOGGING_MESSAGE_CRITICAL_QUEUE',
      },
      audit_id: expect.any(String),
    });
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'retry_delivery',
        schema_version: 1,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        lane: 'critical',
        replay_payload: expect.objectContaining({ payload_type: 'delivery_fanout' }),
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging.delivery.retry'])
    );
  });

  it('rejects oversized DLQ replay payload objects before reading object text', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/large.json`;
    const text = vi.fn();
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dlq_large',
      tenant_key: tenantKey,
      payload_type: 'delivery_fanout',
      schema_version: 1,
      lane: 'critical',
      destination_id: 'dest_1',
      payload_object_ref: payloadObjectRef,
      error_class: 'audit_message_failed_permanently',
      attempt_count: 5,
      status: 'open',
      created_at: 1000,
      updated_at: 1000,
    });
    vi.mocked(env.AUDIT_ARCHIVE!.get).mockResolvedValueOnce({
      size: 1024 * 1024 + 1,
      text,
    } as unknown as R2ObjectBody);

    const response = await createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/dlq/dlq_large/replay',
      { method: 'POST' },
      env
    );
    const body = (await response.json()) as { details?: { fields?: Array<{ code: string }> } };

    expect(response.status).toBe(400);
    expect(body.details?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'payload_object_too_large' })])
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('keeps DLQ replay message jobs queued when no logging message queue binding is configured', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'dlq_1',
        tenant_key: tenantKey,
        payload_type: 'delivery_fanout',
        schema_version: 1,
        lane: 'default',
        destination_id: 'dest_1',
        payload_object_ref: `dlq/tenant_key=${tenantKey}/item.json`,
        error_class: 'audit_message_failed_permanently',
        attempt_count: 5,
        status: 'open',
        created_at: 1000,
        updated_at: 1000,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lmj_replay_unqueued',
        kind: 'retry_delivery',
        status: 'queued',
        lane: 'default',
        criticality: 'standard',
        priority: 10,
        tenant_id: null,
        tenant_key: tenantKey,
        topology_type: 'unknown',
        database_binding_ref: null,
        connection_ref: null,
        topology_snapshot_version: null,
        topology_resolved_at: 1000,
        scope_type: 'tenant',
        scope_id: tenantKey,
        scope_key: `tenant:${tenantKey}`,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        root_job_id: null,
        parent_job_id: null,
        depth: 0,
        payload_object_ref: 'message-jobs/retry_delivery/job.json',
        payload_sha256: 'hash',
        payload_type: 'retry_delivery',
        payload_schema_version: 1,
        redacted_summary_json: null,
        validation_summary_json: null,
        idempotency_key: 'retry',
        dedupe_until: 2000,
        not_before: 1000,
        attempt_count: 0,
        max_attempts: 5,
        attempt_policy_json: null,
        claim_token: null,
        claimed_at: null,
        claimed_until: null,
        requested_by: 'admin-1',
        reason: null,
        error_class: null,
        last_error: null,
        blocked_reason: null,
        cancel_requested_at: null,
        cancelled_by: null,
        created_at: 1000,
        updated_at: 1000,
        started_at: null,
        completed_at: null,
        expires_at: null,
      });
    const bucketGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'delivery_fanout',
          schema_version: 1,
          payload_id: 'qpl_original',
          tenant_key: tenantKey,
          lane: 'default',
          created_at: 1000,
          catalog_id: 'obj_1',
          object_key: 'logs/chunk.jsonl',
          destination_id: 'dest_1',
          log_type: 'audit',
          plane: 'archive',
          record_count: 1,
        })
      ),
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/dlq/dlq_1/replay',
      { method: 'POST' },
      {
        ...env,
        AUDIT_ARCHIVE: { get: bucketGet, delete: vi.fn() },
        DIAGNOSTIC_LOGS: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
        LOGGING_MESSAGE_CRITICAL_QUEUE: undefined,
        LOGGING_MESSAGE_QUEUE: undefined,
        LOGGING_MESSAGE_BULK_QUEUE: undefined,
      } as unknown as Env
    );
    const body = (await response.json()) as {
      result: { queued: boolean; queue_binding: string | null };
    };

    expect(response.status).toBe(202);
    expect(body.result.queued).toBe(false);
    expect(body.result.queue_binding).toBeNull();
    expect(env.AUDIT_QUEUE?.send).not.toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging.delivery.retry'])
    );
  });

  it('requires confirmation before purging open DLQ payloads', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/item.json`;
    const rejected = await createApp([ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE]).request(
      '/api/admin/logging-policies/dlq-items/dlq_1/purge',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'PURGE' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const rejectedBody = (await rejected.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(rejected.status).toBe(400);
    expect(rejectedBody.details.fields[0]).toMatchObject({
      path: 'confirmation',
      code: 'confirmation_mismatch',
    });

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dlq_1',
      tenant_key: tenantKey,
      payload_type: 'audit_queue_message',
      schema_version: 1,
      lane: 'critical',
      destination_id: null,
      payload_object_ref: payloadObjectRef,
      error_class: 'audit_message_failed_permanently',
      attempt_count: 5,
      status: 'open',
      created_at: 1000,
      updated_at: 1000,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    const allowed = await createApp([ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE]).request(
      '/api/admin/logging-policies/dlq-items/dlq_1/purge',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'PURGE DLQ dlq_1' }),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...env,
        AUDIT_ARCHIVE: { get: vi.fn(), delete: bucketDelete },
      } as unknown as Env
    );

    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      result: { id: 'dlq_1', status: 'purged' },
      audit_id: expect.any(String),
    });
    expect(bucketDelete).toHaveBeenCalledWith(payloadObjectRef);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'purged'"),
      expect.arrayContaining(['dlq_1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging.dlq.purge'])
    );
  });

  it('uses signed cursor pagination for delivery event reads', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'lde_2',
        created_at: 2000,
        lane: 'critical',
        status: 'failed',
      },
      {
        id: 'lde_1',
        created_at: 1000,
        lane: 'critical',
        status: 'failed',
      },
    ]);

    const first = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/delivery-events?filter[status]=failed&filter[lane]=critical&time_start=100&limit=1',
      {},
      env
    );
    const firstBody = (await first.json()) as {
      items: Array<{ id: string; created_at: number }>;
      page?: { next_cursor?: string; has_more: boolean; limit: number; time_start: number };
    };

    expect(first.status).toBe(200);
    expect(firstBody.items).toEqual([
      { id: 'lde_2', created_at: 2000, lane: 'critical', status: 'failed' },
    ]);
    expect(firstBody.page?.next_cursor).toBeTruthy();
    expect(firstBody.page).toMatchObject({
      has_more: true,
      limit: 1,
      time_start: 100,
    });

    const decoded = await decodeLoggingCursor(
      firstBody.page?.next_cursor ?? '',
      'test-logging-cursor-secret',
      Date.now()
    );
    expect(decoded.valid).toBe(true);
    expect(decoded.payload?.sort).toEqual({ created_at: 2000, id: 'lde_2' });

    mockAdapter.query.mockResolvedValueOnce([]);
    const second = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      `/api/admin/logging-policies/delivery-events?filter[status]=failed&filter[lane]=critical&time_start=100&limit=1&cursor=${encodeURIComponent(firstBody.page?.next_cursor ?? '')}`,
      {},
      env
    );

    expect(second.status).toBe(200);
    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('(created_at < ? OR (created_at = ? AND id < ?))'),
      expect.arrayContaining([2000, 2000, 'lde_2', 2])
    );
  });

  it('rejects delivery event cursors when filters change', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'lde_2',
        created_at: 2000,
        lane: 'critical',
        status: 'failed',
      },
      {
        id: 'lde_1',
        created_at: 1000,
        lane: 'critical',
        status: 'failed',
      },
    ]);

    const first = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      '/api/admin/logging-policies/delivery-events?filter[status]=failed&filter[lane]=critical&limit=1',
      {},
      env
    );
    const firstBody = (await first.json()) as { page?: { next_cursor?: string } };

    const changed = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]).request(
      `/api/admin/logging-policies/delivery-events?filter[status]=delivered&filter[lane]=critical&limit=1&cursor=${encodeURIComponent(firstBody.page?.next_cursor ?? '')}`,
      {},
      env
    );
    const changedBody = (await changed.json()) as {
      details: { fields: Array<{ path: string; code: string }> };
    };

    expect(changed.status).toBe(400);
    expect(changedBody.details.fields).toEqual([
      {
        path: 'cursor',
        code: 'filter_mismatch',
        message: 'Cursor does not match the current filters.',
      },
    ]);
  });

  it('uses admin logging overview permission for admin logging overview', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_AUDIT_READ]).request(
      '/api/admin/admin-logging',
      {},
      env
    );
    expect(denied.status).toBe(403);

    const allowed = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ]).request(
      '/api/admin/admin-logging',
      {},
      env
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      item: {
        coverage: { covered: number; gap_detected: number };
        audit: { total: number; failures: number; critical: number };
      };
    };
    expect(body.item.coverage.covered).toBeGreaterThan(0);
    expect(body.item.coverage.gap_detected).toBe(0);
    expect(body.item.audit).toEqual({ total: 0, failures: 0, critical: 0 });
  });

  it('lists and checks admin audit coverage with admin logging coverage permissions', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ]).request(
      '/api/admin/admin-logging/coverage',
      {},
      env
    );
    expect(denied.status).toBe(403);

    const listed = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ]).request(
      '/api/admin/admin-logging/coverage',
      {},
      env
    );
    const listBody = (await listed.json()) as {
      items: Array<{ operation_id: string; status: string }>;
      total: number;
    };
    expect(listed.status).toBe(200);
    expect(listBody.total).toBeGreaterThan(0);
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_id: 'admin_logging.coverage.check',
          status: 'covered',
        }),
      ])
    );

    mockAdapter.queryOne.mockResolvedValue(null);
    const checked = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_UPDATE]).request(
      '/api/admin/admin-logging/coverage/check',
      { method: 'POST' },
      env
    );
    const checkBody = (await checked.json()) as {
      result: { updated_count: number; summary: { covered: number; gap_detected: number } };
      audit_id: string;
    };
    expect(checked.status).toBe(200);
    expect(checkBody.result.updated_count).toBeGreaterThan(0);
    expect(checkBody.result.summary.gap_detected).toBe(0);
    expect(checkBody.audit_id).toEqual(expect.any(String));
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_coverage_status'),
      expect.arrayContaining(['admin_logging.coverage.check'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.coverage.check'])
    );
  });

  it('creates retry_delivery message jobs for DLQ items', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const payloadObjectRef = `dlq/tenant_key=${tenantKey}/item.json`;
    const replayPayload = {
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: 'qpl_original',
      tenant_key: tenantKey,
      lane: 'default',
      created_at: now - 1000,
      catalog_id: 'obj_1',
      object_key: 'logs/chunk.jsonl',
      destination_id: 'dest_1',
      log_type: 'audit',
      plane: 'archive',
      record_count: 1,
    };
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'dlq_1',
        tenant_key: tenantKey,
        payload_type: 'delivery_fanout',
        schema_version: 1,
        lane: 'default',
        destination_id: 'dest_1',
        payload_object_ref: payloadObjectRef,
        error_class: 'transient',
        attempt_count: 2,
        status: 'open',
        created_at: now - 1000,
        updated_at: now - 1000,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lmj_test',
        kind: 'retry_delivery',
        status: 'queued',
        lane: 'default',
        criticality: 'standard',
        priority: 10,
        tenant_id: null,
        tenant_key: tenantKey,
        topology_type: 'unknown',
        database_binding_ref: null,
        connection_ref: null,
        topology_snapshot_version: null,
        topology_resolved_at: now,
        scope_type: 'tenant',
        scope_id: tenantKey,
        scope_key: `tenant:${tenantKey}`,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        root_job_id: null,
        parent_job_id: null,
        depth: 0,
        payload_object_ref: 'message-jobs/retry_delivery/job.json',
        payload_sha256: 'hash',
        payload_type: 'retry_delivery',
        payload_schema_version: 1,
        redacted_summary_json: null,
        validation_summary_json: null,
        idempotency_key: 'idem-retry',
        dedupe_until: now + 1000,
        not_before: now,
        attempt_count: 0,
        max_attempts: 5,
        attempt_policy_json: JSON.stringify({ maxAttempts: 5, leaseTimeoutMs: 300000 }),
        claim_token: null,
        claimed_at: null,
        claimed_until: null,
        requested_by: 'admin-1',
        reason: 'manual retry',
        error_class: null,
        last_error: null,
        blocked_reason: null,
        cancel_requested_at: null,
        cancelled_by: null,
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null,
        expires_at: null,
      });
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const bucketGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(JSON.stringify(replayPayload)),
    });
    const messagePut = vi.fn().mockResolvedValue(undefined);

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/retries',
      {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'dlq_item',
          source_id: 'dlq_1',
          idempotency_key: 'idem-retry',
          reason: 'manual retry',
        }),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...env,
        AUDIT_ARCHIVE: { get: bucketGet, delete: vi.fn() },
        DIAGNOSTIC_LOGS: { get: vi.fn(), put: messagePut, delete: vi.fn() },
        LOGGING_MESSAGE_QUEUE: { send: queueSend },
      } as unknown as Env
    );
    const body = (await response.json()) as { result: { kind: string; queued: boolean } };

    expect(response.status).toBe(202);
    expect(body.result).toMatchObject({
      kind: 'retry_delivery',
      queued: true,
    });
    expect(messagePut).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/retry_delivery/criticality=standard/lane=default'),
      expect.stringContaining('"payload_type":"retry_delivery"'),
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          payload_type: 'retry_delivery',
          schema_version: '1',
        }),
      })
    );
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'retry_delivery',
        schema_version: 1,
        source_type: 'dlq_item',
        source_id: 'dlq_1',
        replay_payload: expect.objectContaining({ payload_type: 'delivery_fanout' }),
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_message_jobs'),
      expect.arrayContaining(['retry_delivery', 'queued', 'default'])
    );
    vi.useRealTimers();
  });

  it('requires platform authority before reading arbitrary retry payload objects', async () => {
    const bucketGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'delivery_fanout',
          schema_version: 1,
          payload_id: 'qpl_payload_object',
          tenant_key: await deriveTenantKeyFromTenantId('tenant-a'),
          lane: 'default',
          created_at: 1000,
          catalog_id: 'obj_1',
          object_key: 'logs/chunk.jsonl',
          destination_id: 'dest_1',
          log_type: 'webhook',
          plane: 'external_sink',
          record_count: 1,
        })
      ),
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/retries',
      {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'payload_object',
          source_id: 'message-jobs/retry_delivery/other-tenant.json',
        }),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...env,
        DIAGNOSTIC_LOGS: { get: bucketGet, put: vi.fn(), delete: vi.fn() },
      } as unknown as Env
    );

    expect(response.status).toBe(403);
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it('requires platform authority for critical retry_delivery jobs', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'dlq_critical',
      tenant_key: tenantKey,
      payload_type: 'delivery_fanout',
      schema_version: 1,
      lane: 'critical',
      destination_id: 'dest_1',
      payload_object_ref: `dlq/tenant_key=${tenantKey}/critical.json`,
      error_class: 'critical_failed',
      attempt_count: 2,
      status: 'open',
      created_at: 1000,
      updated_at: 1000,
    });
    const bucketGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'delivery_fanout',
          schema_version: 1,
          payload_id: 'qpl_critical',
          tenant_key: tenantKey,
          lane: 'critical',
          created_at: 1000,
          catalog_id: 'obj_1',
          object_key: 'logs/chunk.jsonl',
          destination_id: 'dest_1',
          log_type: 'audit',
          plane: 'archive',
          record_count: 1,
        })
      ),
    });

    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/retries',
      {
        method: 'POST',
        body: JSON.stringify({ source_type: 'dlq_item', source_id: 'dlq_critical' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...env, AUDIT_ARCHIVE: { get: bucketGet, delete: vi.fn() } } as unknown as Env
    );

    expect(response.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_message_jobs'),
      expect.anything()
    );
  });

  it('lists and reads logging message jobs without exposing claim tokens', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      messageJobRow({
        id: 'lmj_list',
        status: 'retrying',
        claim_token: 'internal-claim-token',
      }),
    ]);
    const listed = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request(
      '/api/admin/logging-policies/message-jobs?kind=retry_delivery&status=retrying&lane=default&tenant_key=tenant-key-1&root_job_id=lmj_root&parent_job_id=lmj_parent',
      {},
      env
    );
    const listedBody = (await listed.json()) as {
      items: Array<{ id: string; has_claim_token: boolean; claim_token?: string }>;
      page: { has_more: boolean };
    };

    expect(listed.status).toBe(200);
    expect(listedBody.items[0]).toMatchObject({
      id: 'lmj_list',
      has_claim_token: true,
    });
    expect(listedBody.items[0].claim_token).toBeUndefined();
    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM logging_message_jobs'),
      expect.arrayContaining([
        'tenant-key-1',
        'retry_delivery',
        'retrying',
        'default',
        'lmj_root',
        'lmj_parent',
      ])
    );

    mockAdapter.queryOne.mockResolvedValueOnce(
      messageJobRow({ id: 'lmj_detail', claim_token: 'internal-claim-token' })
    );
    const detail = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request('/api/admin/logging-policies/message-jobs/lmj_detail', {}, env);
    const detailBody = (await detail.json()) as {
      item: { id: string; has_claim_token: boolean; claim_token?: string };
    };
    expect(detail.status).toBe(200);
    expect(detailBody.item).toMatchObject({ id: 'lmj_detail', has_claim_token: true });
    expect(detailBody.item.claim_token).toBeUndefined();
  });

  it('lists logging message repair findings with tenant and severity filters', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'rw_1',
        message_job_id: 'lmj_1',
        finding_type: 'missing_export_part',
        severity: 'error',
        status: 'open',
        safe_action: 'rebuild_export_partition',
        dangerous_action: 'mark_export_failed_and_cleanup_manifest',
        impact_json: JSON.stringify({
          export_job_id: 'lexp_1',
          part_object_ref: 'logging-exports/v1/lexp_1/parts/part-00000.jsonl',
        }),
        detected_at: 1779321600000,
        updated_at: 1779321600000,
        resolved_at: null,
        applied_at: null,
        applied_by: null,
        tenant_key: 'tenant-key-1',
        job_kind: 'export_build',
        job_status: 'completed',
      },
    ]);

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ]).request(
      '/api/admin/logging-policies/message-job-repair-findings?tenant_key=tenant-key-1&status=open&severity=error&finding_type=missing_export_part',
      {},
      env
    );
    const body = (await response.json()) as {
      items: Array<{ id: string; impact: { export_job_id: string } }>;
      total: number;
    };

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: 'rw_1',
      impact: { export_job_id: 'lexp_1' },
    });
    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM logging_message_repair_findings'),
      expect.arrayContaining(['tenant-key-1', 'open', 'error', 'missing_export_part'])
    );
  });

  it('applies safe message repair by creating a replacement export_build job', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_repair_findings')) {
        return {
          id: 'rw_safe',
          message_job_id: 'lmj_old',
          finding_type: 'missing_export_part',
          severity: 'error',
          status: 'open',
          safe_action: 'rebuild_export_partition',
          dangerous_action: 'mark_export_failed_and_cleanup_manifest',
          impact_json: JSON.stringify({
            export_job_id: 'lexp_repair',
            part_object_ref: 'logging-exports/v1/lexp_repair/parts/part-00000.jsonl',
          }),
          detected_at: now - 1000,
          updated_at: now - 1000,
          resolved_at: null,
          applied_at: null,
          applied_by: null,
          tenant_key: 'tenant-key-1',
          job_kind: 'export_build',
          job_status: 'completed',
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_repair',
          tenant_key: 'tenant-key-1',
          log_type: 'audit',
          plane: 'archive',
          format: 'jsonl',
          status: 'retrying',
          artifact_object_ref: 'logging-exports/v1/lexp_repair/parts/part-00000.jsonl',
          manifest_object_ref: 'logging-exports/v1/lexp_repair/manifest.json',
          checksum_sha256: 'old',
          record_count: 1,
          byte_count: 100,
          requested_by: 'admin-1',
          error_class: 'missing_export_part',
          filter_json: JSON.stringify({
            tenant_key: 'tenant-key-1',
            log_type: 'audit',
            plane: 'archive',
            source: 'catalog',
            limit: 100,
            include_payload: false,
          }),
          created_at: now - 5000,
          updated_at: now - 1000,
          completed_at: now - 1000,
          expires_at: now + 1000,
        };
      }
      if (sql.includes('FROM logging_message_idempotency_keys')) {
        return null;
      }
      return null;
    });
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const messagePut = vi.fn().mockResolvedValue(undefined);

    const response = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/logging-policies/message-job-repair-findings/apply-safe',
      {
        method: 'POST',
        body: JSON.stringify({ finding_id: 'rw_safe' }),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...env,
        DIAGNOSTIC_LOGS: { get: vi.fn(), put: messagePut, delete: vi.fn() },
        LOGGING_MESSAGE_QUEUE: { send: queueSend },
      } as unknown as Env
    );
    const body = (await response.json()) as {
      result: { applied_count: number; applied: Array<{ message_job_id: string }> };
      audit_id: string;
    };

    expect(response.status).toBe(200);
    expect(body.audit_id).toEqual(expect.any(String));
    expect(body.result.applied_count).toBe(1);
    expect(body.result.applied[0].message_job_id).toMatch(/^lmj_/);
    expect(messagePut).toHaveBeenCalledWith(
      expect.stringContaining('message-jobs/export_build/criticality=standard/lane=default'),
      expect.stringContaining('"export_job_id":"lexp_repair"'),
      expect.any(Object)
    );
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'export_build',
        export_job_id: 'lexp_repair',
        phase: 'plan',
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_message_jobs'),
      expect.arrayContaining(['export_build', 'queued'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_message_repair_findings'),
      expect.arrayContaining(['safe_repaired', now, now, now, 'admin-1', 'rw_safe', 'open'])
    );
    vi.useRealTimers();
  });

  it('previews and applies dangerous message repair with typed confirmation', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_repair_findings')) {
        return {
          id: 'rw_danger',
          message_job_id: 'lmj_old',
          finding_type: 'missing_export_part',
          severity: 'error',
          status: 'open',
          safe_action: 'rebuild_export_partition',
          dangerous_action: 'mark_export_failed_and_cleanup_manifest',
          impact_json: JSON.stringify({
            export_job_id: 'lexp_danger',
            part_object_ref: 'logging-exports/v1/lexp_danger/parts/part-00000.jsonl',
          }),
          detected_at: now - 1000,
          updated_at: now - 1000,
          resolved_at: null,
          applied_at: null,
          applied_by: null,
          tenant_key: 'tenant-key-1',
          job_kind: 'export_build',
          job_status: 'completed',
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_danger',
          tenant_key: 'tenant-key-1',
          log_type: 'audit',
          plane: 'archive',
          format: 'jsonl',
          status: 'retrying',
          artifact_object_ref: 'logging-exports/v1/lexp_danger/parts/part-00000.jsonl',
          manifest_object_ref: 'logging-exports/v1/lexp_danger/manifest.json',
          checksum_sha256: 'old',
          record_count: 1,
          byte_count: 100,
          requested_by: 'admin-1',
          error_class: 'missing_export_part',
          filter_json: '{}',
          created_at: now - 5000,
          updated_at: now - 1000,
          completed_at: now - 1000,
          expires_at: now + 1000,
        };
      }
      return null;
    });

    const preview = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ]).request(
      '/api/admin/logging-policies/message-job-repair-findings/rw_danger/dangerous/preview',
      { method: 'POST' },
      env
    );
    const previewBody = (await preview.json()) as {
      item: { confirmation: string; impact: { deletes_objects: string[] } };
    };
    expect(preview.status).toBe(200);
    expect(previewBody.item.confirmation).toBe('APPLY MESSAGE REPAIR rw_danger');
    expect(previewBody.item.impact.deletes_objects).toEqual([
      'logging-exports/v1/lexp_danger/parts/part-00000.jsonl',
      'logging-exports/v1/lexp_danger/manifest.json',
    ]);

    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const applied = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/logging-policies/message-job-repair-findings/rw_danger/dangerous/apply',
      {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'APPLY MESSAGE REPAIR rw_danger' }),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...env,
        EXPORT_ARTIFACTS: { delete: deleteObject },
      } as unknown as Env
    );
    const appliedBody = (await applied.json()) as { audit_id: string };
    expect(applied.status).toBe(200);
    expect(appliedBody.audit_id).toEqual(expect.any(String));
    expect(deleteObject).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_danger/parts/part-00000.jsonl'
    );
    expect(deleteObject).toHaveBeenCalledWith('logging-exports/v1/lexp_danger/manifest.json');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_export_jobs'),
      expect.arrayContaining(['failed', 'dangerous_repair_applied', now, now, 'lexp_danger'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_message_repair_findings'),
      expect.arrayContaining(['dangerous_applied', now, now, now, 'admin-1', 'rw_danger', 'open'])
    );
    vi.useRealTimers();
  });

  it('cancels queued logging message jobs and writes admin audit', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce(messageJobRow({ id: 'lmj_cancel', status: 'queued' }))
      .mockResolvedValueOnce(
        messageJobRow({
          id: 'lmj_cancel',
          status: 'cancelled',
          cancel_requested_at: 1779321600000,
          cancelled_by: 'admin-1',
          completed_at: 1779321600000,
        })
      );

    const response = await createPlatformApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY]).request(
      '/api/admin/logging-policies/message-jobs/lmj_cancel/cancel',
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'operator requested cancellation' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      result: { id: string; status: string };
      audit_id: string;
    };

    expect(response.status).toBe(200);
    expect(body.audit_id).toEqual(expect.any(String));
    expect(body.result).toMatchObject({ id: 'lmj_cancel', status: 'cancelled' });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET cancel_requested_at = ?'),
      expect.arrayContaining(['lmj_cancel', 'queued', 'retrying', 'claimed', 'running'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET status = ?, completed_at = ?'),
      expect.arrayContaining(['cancelled', expect.any(Number), expect.any(Number), 'lmj_cancel'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging.message_job.cancel'])
    );
  });

  it('lists key registry metadata and rewrap jobs for platform admin logging operations', async () => {
    const tenantDenied = await createApp([
      ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ,
    ]).request('/api/admin/admin-logging/key-registry', {}, env);
    expect(tenantDenied.status).toBe(403);

    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'lkr_1',
        tenant_key: 't_key_1',
        surface: null,
        log_type: 'admin_audit',
        plane: 'archive',
        active_version: 2,
        registry_status: 'active',
        last_rotated_at: 1779148800000,
        registry_created_at: 1779148700000,
        registry_updated_at: 1779148800000,
        version: 1,
        backend_ref: 'd1:lkm_1:v1',
        version_status: 'rewrap_required',
        usage_count: 10,
        stale_count: 3,
        version_created_at: 1779148700000,
        retired_at: null,
      },
    ]);
    const keyRegistry = await createPlatformApp([
      ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ,
    ]).request('/api/admin/admin-logging/key-registry', {}, env);
    const keyRegistryBody = (await keyRegistry.json()) as {
      items: Array<{ id: string; version_status: string; stale_count: number }>;
      total: number;
    };
    expect(keyRegistry.status).toBe(200);
    expect(keyRegistryBody.total).toBe(1);
    expect(keyRegistryBody.items[0]).toMatchObject({
      id: 'lkr_1',
      version_status: 'rewrap_required',
      stale_count: 3,
    });

    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'lrw_1',
        key_registry_id: 'lkr_1',
        from_version: 1,
        to_version: 2,
        priority: 20,
        status: 'running',
        created_at: 1779148810000,
        started_at: 1779148820000,
        completed_at: null,
        metadata: JSON.stringify({
          object_catalog_id: 'loc_1',
          object_key: 'logs/v1/t_key_1/archive/admin_audit/chunk-1.jsonl',
          tenant_key: 't_key_1',
          log_type: 'admin_audit',
          plane: 'archive',
          reason: 'critical_archive',
        }),
      },
    ]);
    const rewrapJobs = await createPlatformApp([
      ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ,
    ]).request('/api/admin/admin-logging/rewrap-jobs', {}, env);
    const rewrapBody = (await rewrapJobs.json()) as {
      items: Array<{ id: string; object_catalog_id: string; reason: string }>;
      total: number;
    };
    expect(rewrapJobs.status).toBe(200);
    expect(rewrapBody.total).toBe(1);
    expect(rewrapBody.items[0]).toMatchObject({
      id: 'lrw_1',
      object_catalog_id: 'loc_1',
      reason: 'critical_archive',
    });
  });

  it('loads key registry impact and queues scoped rewrap jobs', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lkr_1',
      tenant_key: 't_key_1',
      surface: null,
      log_type: 'admin_audit',
      plane: 'archive',
      active_version: 2,
      status: 'active',
      last_rotated_at: null,
      created_at: 1000,
      updated_at: 1000,
    });
    mockAdapter.query
      .mockResolvedValueOnce([{ version: 1, status: 'rewrap_required', object_count: 1 }])
      .mockResolvedValueOnce([{ status: 'queued', total: 1 }]);

    const impact = await createPlatformApp([
      ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ,
    ]).request('/api/admin/admin-logging/key-registry/lkr_1/impact', {}, env);
    const impactBody = (await impact.json()) as {
      item: { registry: { id: string }; versions: unknown[]; rewrap_jobs: unknown[] };
    };
    expect(impact.status).toBe(200);
    expect(impactBody.item.registry.id).toBe('lkr_1');
    expect(impactBody.item.versions).toHaveLength(1);
    expect(impactBody.item.rewrap_jobs).toHaveLength(1);

    mockAdapter.query.mockResolvedValueOnce([
      {
        key_registry_id: 'lkr_1',
        tenant_key: 't_key_1',
        surface: null,
        log_type: 'admin_audit',
        plane: 'archive',
        active_version: 2,
        from_version: 1,
        key_version_status: 'rewrap_required',
        object_catalog_id: 'loc_1',
        object_key: 'logs/t_key_1/archive/admin_audit/chunk-1.jsonl',
        record_count: 5,
        byte_count: 500,
        committed_at: 1000,
      },
    ]);
    mockAdapter.queryOne.mockResolvedValueOnce(null);

    const queued = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/rewrap-jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key_registry_id: 'lkr_1', from_version: 1, limit: 10 }),
      },
      env
    );
    const queuedBody = (await queued.json()) as {
      result: { created_count: number; skipped_count: number };
      audit_id: string;
    };

    expect(queued.status).toBe(202);
    expect(queuedBody.result).toMatchObject({ created_count: 1, skipped_count: 0 });
    expect(queuedBody.audit_id).toEqual(expect.any(String));
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_rewrap_jobs'),
      expect.arrayContaining(['lkr_1', 1, 2])
    );
  });

  it('retries, cancels, and reprioritizes rewrap jobs with audit events', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lrw_failed',
      key_registry_id: 'lkr_1',
      from_version: 1,
      to_version: 2,
      priority: 20,
      status: 'failed',
      created_at: 1000,
      started_at: 1100,
      completed_at: 1200,
      metadata: JSON.stringify({ object_catalog_id: 'loc_1' }),
    });
    const retried = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/rewrap-jobs/lrw_failed/retry',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'retry after key backend restored' }),
      },
      env
    );
    expect(retried.status).toBe(200);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'queued'"),
      expect.arrayContaining(['lrw_failed', 'failed'])
    );

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lrw_queued',
      key_registry_id: 'lkr_1',
      from_version: 1,
      to_version: 2,
      priority: 20,
      status: 'queued',
      created_at: 1000,
      started_at: null,
      completed_at: null,
      metadata: JSON.stringify({ object_catalog_id: 'loc_2' }),
    });
    const priority = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/rewrap-jobs/lrw_queued/priority',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ priority: 5 }),
      },
      env
    );
    expect(priority.status).toBe(200);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET priority = ?'),
      expect.arrayContaining([5, expect.any(String), 'lrw_queued'])
    );

    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'lrw_running',
      key_registry_id: 'lkr_1',
      from_version: 1,
      to_version: 2,
      priority: 10,
      status: 'running',
      created_at: 1000,
      started_at: 1100,
      completed_at: null,
      metadata: JSON.stringify({ object_catalog_id: 'loc_3' }),
    });
    const cancelled = await createPlatformApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/rewrap-jobs/lrw_running/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'operator stopped incident action' }),
      },
      env
    );
    expect(cancelled.status).toBe(200);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'skipped'"),
      expect.arrayContaining(['lrw_running', 'running'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.rewrap_jobs.cancel'])
    );
  });

  it('detects and applies safe admin logging catalog repairs with repair permissions', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ]).request(
      '/api/admin/admin-logging/catalog-repairs',
      {},
      env
    );
    expect(denied.status).toBe(403);

    const pendingObject = {
      id: 'obj_pending',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      object_key: `logs/${tenantKey}/archive/audit/old.jsonl.gz`,
      status: 'pending',
      record_count: 1,
      byte_count: 100,
      checksum_sha256: null,
      created_at: 0,
      committed_at: null,
    };

    mockAdapter.query.mockResolvedValueOnce([pendingObject]).mockResolvedValueOnce([]);
    const listed = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ]).request(
      '/api/admin/admin-logging/catalog-repairs?pending_ttl_ms=60000',
      {},
      env
    );
    const listBody = (await listed.json()) as {
      items: Array<{ action: string; objectCatalogId?: string }>;
      total: number;
    };
    expect(listed.status).toBe(200);
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]).toMatchObject({
      action: 'mark_orphan_candidate',
      objectCatalogId: 'obj_pending',
    });

    mockAdapter.query.mockResolvedValueOnce([pendingObject]).mockResolvedValueOnce([]);
    const applied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/catalog-repairs/apply-safe',
      {
        method: 'POST',
        body: JSON.stringify({ limit: 10 }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const applyBody = (await applied.json()) as {
      result: { applied_count: number; skipped_count: number };
      audit_id: string;
    };
    expect(applied.status).toBe(200);
    expect(applyBody.result).toMatchObject({ applied_count: 1, skipped_count: 0 });
    expect(applyBody.audit_id).toEqual(expect.any(String));
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'orphan_candidate'"),
      ['obj_pending']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.catalog_repair.apply_safe'])
    );
  });

  it('previews and applies dangerous catalog repairs with typed confirmation', async () => {
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
    const object = {
      id: 'obj_danger',
      tenant_key: tenantKey,
      log_type: 'audit',
      plane: 'archive',
      object_key: `logs/${tenantKey}/archive/audit/bad.jsonl.gz`,
      object_kind: 'chunk',
      status: 'committed',
      record_count: 3,
      byte_count: 300,
    };

    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ]).request(
      '/api/admin/admin-logging/catalog-repairs/dangerous/apply',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'delete_object', object_catalog_id: object.id }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.queryOne.mockResolvedValueOnce(object);
    const preview = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ]).request(
      '/api/admin/admin-logging/catalog-repairs/dangerous/preview',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'delete_object', object_catalog_id: object.id }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const previewBody = (await preview.json()) as {
      item: { confirmation: string; impact: { affectedRecordCount: number } };
    };
    expect(preview.status).toBe(200);
    expect(previewBody.item.confirmation).toBe('CONFIRM DELETE_OBJECT obj_danger');
    expect(previewBody.item.impact.affectedRecordCount).toBe(3);

    mockAdapter.queryOne.mockResolvedValueOnce(object);
    const rejected = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/catalog-repairs/dangerous/apply',
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete_object',
          object_catalog_id: object.id,
          confirmation: 'CONFIRM DELETE_OBJECT wrong',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    expect(rejected.status).toBe(400);

    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    mockAdapter.queryOne.mockResolvedValueOnce(object);
    const applied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN]).request(
      '/api/admin/admin-logging/catalog-repairs/dangerous/apply',
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete_object',
          object_catalog_id: object.id,
          confirmation: 'CONFIRM DELETE_OBJECT obj_danger',
        }),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...env,
        AUDIT_ARCHIVE: { delete: bucketDelete },
      } as unknown as Env
    );
    const appliedBody = (await applied.json()) as {
      result: { action: string };
      audit_id: string;
    };

    expect(applied.status).toBe(200);
    expect(appliedBody.result.action).toBe('delete_object');
    expect(appliedBody.audit_id).toEqual(expect.any(String));
    expect(bucketDelete).toHaveBeenCalledWith(object.object_key);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'deleted'"),
      expect.arrayContaining([object.id])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([tenantKey, 'audit', 'archive', object.id])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.catalog_repair.apply_dangerous'])
    );
  });

  it('reads and updates admin logging critical policy with critical permission', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ]).request(
      '/api/admin/admin-logging/critical-policy',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query
      .mockResolvedValueOnce([
        destinationRow({
          id: 'dest_critical',
          name: 'critical-archive',
          critical_allowed: 1,
          default_fallback_eligible: 1,
        }),
      ])
      .mockResolvedValueOnce([]);
    const read = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ]).request(
      '/api/admin/admin-logging/critical-policy',
      {},
      env
    );
    const readBody = (await read.json()) as {
      item: { summary: { critical_destination_count: number; failing_destination_count: number } };
    };
    expect(read.status).toBe(200);
    expect(readBody.item.summary.critical_destination_count).toBe(1);

    mockAdapter.queryOne
      .mockResolvedValueOnce(
        destinationRow({
          id: 'dest_critical',
          name: 'critical-archive',
          critical_allowed: 0,
          default_fallback_eligible: 0,
        })
      )
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce(null);
    const updated = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_CRITICAL_UPDATE]).request(
      '/api/admin/admin-logging/critical-policy',
      {
        method: 'PATCH',
        body: JSON.stringify({
          destination_id: 'dest_critical',
          critical_allowed: true,
          default_fallback_eligible: true,
          confirmation: 'UPDATE CRITICAL LOGGING critical-archive',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const updateBody = (await updated.json()) as {
      item: { critical_allowed: number; default_fallback_eligible: number };
      audit_id: string;
    };
    expect(updated.status).toBe(200);
    expect(updateBody.item).toMatchObject({
      critical_allowed: 1,
      default_fallback_eligible: 1,
    });
    expect(updateBody.audit_id).toEqual(expect.any(String));
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_destinations'),
      expect.arrayContaining([1, 1, 'admin-1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_logging_critical_policies'),
      expect.arrayContaining(['destination:dest_critical'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.critical_policy.update'])
    );
  });

  it('reads and updates admin logging sensitive detail policy with sensitive permissions', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ]).request(
      '/api/admin/admin-logging/sensitive-detail-policy',
      {},
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ object_class: 'webhook_payload', total: 2, last_created_at: 123 }])
      .mockResolvedValueOnce([{ status: 'active', total: 1 }]);
    const read = await createApp([
      ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ,
    ]).request('/api/admin/admin-logging/sensitive-detail-policy', {}, env);
    const readBody = (await read.json()) as {
      item: {
        summary: { chunked: boolean; encrypted: boolean; indexed_object_class_count: number };
      };
    };
    expect(read.status).toBe(200);
    expect(readBody.item.summary).toMatchObject({
      chunked: true,
      encrypted: true,
      indexed_object_class_count: 1,
    });

    mockAdapter.queryOne
      .mockResolvedValueOnce(
        destinationRow({
          id: 'dest_sensitive',
          name: 'sensitive',
          critical_allowed: 1,
          allowed_planes: JSON.stringify(['sensitive_detail']),
          allowed_log_types: JSON.stringify(['webhook']),
        })
      )
      .mockResolvedValueOnce({ id: 'sda_dest_sensitive' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const updated = await createApp([
      ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE,
    ]).request(
      '/api/admin/admin-logging/sensitive-detail-policy',
      {
        method: 'PATCH',
        body: JSON.stringify({
          log_type: 'webhook',
          destination_id: 'dest_sensitive',
          confirmation: 'CHANGE SENSITIVE DETAIL webhook',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const updateBody = (await updated.json()) as {
      item: { log_type: string; plane: string; destination_id: string };
      audit_id: string;
    };
    expect(updated.status).toBe(200);
    expect(updateBody.item).toMatchObject({
      log_type: 'webhook',
      plane: 'sensitive_detail',
      destination_id: 'dest_sensitive',
    });
    expect(updateBody.audit_id).toEqual(expect.any(String));
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_destination_overrides'),
      expect.arrayContaining(['webhook', 'dest_sensitive'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_logging_sensitive_detail_policies'),
      expect.arrayContaining(['webhook', 'dest_sensitive'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.sensitive_detail_policy.update'])
    );
  });

  it('probes sensitive detail chunk index records without returning payload content', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({
      catalog_id: 'obj_sensitive_1',
      tenant_id: 'tenant-a',
      object_class: 'event_log_detail',
      bucket_binding: 'SENSITIVE_DETAILS',
      object_key: 'sensitive/tenant-a/event-log-detail.jsonl.gz',
      content_encoding: 'gzip',
      line_number: 0,
      byte_offset: 0,
      byte_length: 512,
      key_version: 1,
      checksum_sha256: 'sha256',
      created_at: 1000,
      deleted_at: null,
      public_artifact_id: 'art_sensitive_1',
    });

    const response = await createApp([LOGGING_SENSITIVE_DETAIL_EXPORT_PERMISSION]).request(
      '/api/admin/admin-logging/sensitive-detail/probe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          catalog_id: 'obj_sensitive_1',
          object_class: 'event_log_detail',
          read_payload: false,
        }),
      },
      env
    );
    const body = (await response.json()) as {
      item: { catalog_id: string; read_status: string; payload_shape: string | null };
      audit_id: string;
    };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({
      catalog_id: 'obj_sensitive_1',
      read_status: 'not_requested',
      payload_shape: null,
    });
    expect(body.audit_id).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('sensitive payload');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['admin_logging.sensitive_detail.probe'])
    );
  });

  it('publishes policy snapshots with the snapshot publish permission', async () => {
    const denied = await createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]).request(
      '/api/admin/logging-policies/snapshots',
      { method: 'POST' },
      env
    );
    expect(denied.status).toBe(403);

    mockAdapter.queryOne.mockResolvedValueOnce({ next_version: 3 });
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'assign_1',
          tenant_id: null,
          log_type: 'audit',
          plane: 'archive',
          destination_id: 'dest_1',
          updated_at: 1714550400000,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'dest_1',
          scope_type: 'platform',
          scope_id: 'global',
          provider: 'r2',
          updated_at: 1714550400000,
        },
      ]);

    const allowed = await createPlatformApp([ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH]).request(
      '/api/admin/logging-policies/snapshots',
      {
        method: 'POST',
        body: JSON.stringify({ scope_type: 'platform', scope_id: 'global' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );

    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      item: {
        id: string;
        version: number;
        status: string;
        policy_hash: string;
        object_ref: string | null;
      };
    };
    expect(body.item.id).toMatch(/^snap_/);
    expect(body.item.version).toBe(3);
    expect(body.item.status).toBe('published');
    expect(body.item.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.item.object_ref).toMatch(
      /^logging-policy-snapshots\/v1\/snapshots\/platform\/global\/v3-snap_/
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_policy_snapshots'),
      expect.arrayContaining(['platform', 'global', 3, 'published'])
    );
    expect(env.DIAGNOSTIC_LOGS?.put).toHaveBeenCalledWith(
      expect.stringMatching(/^logging-policy-snapshots\/v1\/snapshots\/platform\/global\/v3-snap_/),
      expect.stringContaining('"scopeType":"platform"'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
    expect(env.AUTHRIM_CONFIG?.put).toHaveBeenCalledWith(
      'logging-policy-snapshots/v1/current/platform/global.json',
      expect.stringContaining('"schemaVersion":1'),
      undefined
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_policy_snapshot.publish'])
    );
  });

  it('creates policy snapshot drafts with diff preview', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ next_version: 4 }).mockResolvedValueOnce({
      id: 'snap_prev',
      version: 3,
      snapshot_json: JSON.stringify({
        policies: {
          assignments: [],
          fallbacks: [],
          destinations: [],
        },
      }),
    });
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'assign_1',
          tenant_id: null,
          log_type: 'audit',
          plane: 'archive',
          destination_id: 'dest_1',
          updated_at: 1714550400000,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const response = await createPlatformApp([ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH]).request(
      '/api/admin/logging-policies/drafts',
      {
        method: 'POST',
        body: JSON.stringify({ scope_type: 'platform', scope_id: 'global' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      item: {
        id: string;
        status: string;
        version: number;
        diff: { assignment_added: number; compared_to_snapshot_id: string };
        confirmation: string;
      };
    };

    expect(response.status).toBe(201);
    expect(body.item.status).toBe('draft');
    expect(body.item.version).toBe(4);
    expect(body.item.diff).toMatchObject({
      compared_to_snapshot_id: 'snap_prev',
      assignment_added: 1,
    });
    expect(body.item.confirmation).toBe('PUBLISH LOGGING POLICY platform:global');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_policy_snapshots'),
      expect.arrayContaining(['platform', 'global', 4, 'draft'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_policy_snapshot.draft_create'])
    );
  });

  it('publishes policy snapshot drafts with confirmation and version checks', async () => {
    const draftSnapshot = {
      schemaVersion: 1,
      snapshotId: 'snap_draft',
      scopeType: 'platform',
      scopeId: 'global',
      version: 5,
      policyHash: 'a'.repeat(64),
      synchronizedAt: 1714550400000,
      sourceUpdatedAt: 1714550300000,
      expiresAt: null,
      policies: {
        assignments: [],
        fallbacks: [],
        destinations: [],
      },
    };
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'snap_draft',
      scope_type: 'platform',
      scope_id: 'global',
      version: 5,
      status: 'draft',
      policy_hash: draftSnapshot.policyHash,
      snapshot_json: JSON.stringify(draftSnapshot),
    });

    const response = await createPlatformApp([ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH]).request(
      '/api/admin/logging-policies/drafts/snap_draft/publish',
      {
        method: 'POST',
        body: JSON.stringify({
          expected_version: 5,
          confirmation: 'PUBLISH LOGGING POLICY platform:global',
        }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      item: { id: string; status: string; version: number; object_ref: string };
    };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({ id: 'snap_draft', status: 'published', version: 5 });
    expect(body.item.object_ref).toMatch(
      /^logging-policy-snapshots\/v1\/snapshots\/platform\/global\/v5-snap_draft/
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'published'"),
      expect.arrayContaining(['snap_draft'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['logging_policy_snapshot.publish'])
    );
  });

  it('returns field details for invalid snapshot publish input', async () => {
    const response = await createApp([ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH]).request(
      '/api/admin/logging-policies/snapshots',
      {
        method: 'POST',
        body: JSON.stringify({ scope_type: 'organization', expires_at: 'tomorrow' }),
        headers: { 'content-type': 'application/json' },
      },
      env
    );
    const body = (await response.json()) as {
      error: string;
      details: { fields: Array<{ path: string; code: string; message: string }> };
    };

    expect(response.status).toBe(400);
    expect(body.error).toBe(AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    expect(body.details.fields).toEqual([
      {
        path: 'scope_type',
        code: 'invalid_value',
        message: 'Scope type must be platform or tenant.',
      },
      {
        path: 'expires_at',
        code: 'invalid_type',
        message: 'Expires at must be a timestamp number.',
      },
    ]);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('previews storage destination diffs with affected assignment counts', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce(destinationRow({ critical_allowed: 1, default_fallback_eligible: 1 }))
      .mockResolvedValueOnce({
        assignment_count: 2,
        logging_override_count: 1,
        fallback_policy_count: 1,
        critical_policy_count: 1,
        sensitive_detail_policy_count: 0,
      });
    mockAdapter.query.mockResolvedValueOnce([{ capability: 'archive_write' }]);

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ]).request(
      '/api/admin/destinations/dest_1/diff-preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          provider: 'r2',
          name: 'archive',
          display_name: 'Archive',
          provider_config: { bindingRef: 'AUDIT_ARCHIVE' },
          critical_allowed: false,
          default_fallback_eligible: false,
          retention_days: 7,
          encryption_mode: 'platform_managed',
          capabilities: ['archive_write'],
          expected_version: 1,
        }),
      },
      env
    );
    const body = (await response.json()) as {
      item: {
        dangerous_classification: string;
        confirmation: string;
        affected_assignments: Record<string, number>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.item.dangerous_classification).toBe('dangerous');
    expect(body.item.confirmation).toBe('CONFIRM DESTINATION CHANGE archive');
    expect(body.item.affected_assignments.logging_destination_overrides).toBe(1);
  });

  it('creates logging quota policies for platform defaults', async () => {
    mockAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/quota-policies',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope_type: 'platform',
          scope_id: 'global',
          metric_name: 'delivery_bytes',
          window_kind: 'day',
          soft_limit: 1000,
          hard_limit: 2000,
          enforcement_mode: 'hard_non_critical',
        }),
      },
      env
    );
    const body = (await response.json()) as { item: { id: string; version: number } };

    expect(response.status).toBe(201);
    expect(body.item.id).toMatch(/^lqp_/);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_quota_policies'),
      expect.arrayContaining(['platform', 'global', 'delivery_bytes', 'day'])
    );
  });

  it('refreshes usage aggregates from delivery source tables', async () => {
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          tenant_key: 'tk_1',
          log_type: 'audit',
          plane: 'archive',
          lane: 'critical',
          record_count: 2,
          byte_count: 200,
          batch_count: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/logging-policies/usage-aggregates/refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ window_kind: 'hour', window_start_at: 1000 }),
      },
      env
    );
    const body = (await response.json()) as { result: { refreshed: number } };

    expect(response.status).toBe(200);
    expect(body.result.refreshed).toBe(3);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_usage_aggregates'),
      expect.arrayContaining(['delivery_records'])
    );
  });

  it('creates notification delivery routes for external alert providers', async () => {
    mockAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });

    const response = await createPlatformApp([
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ]).request(
      '/api/admin/notifications/delivery-routes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Ops webhook',
          scope_type: 'platform',
          provider: 'webhook',
          destination_id: 'dest_ops',
          categories: ['logging_quota_warning'],
          min_severity: 'medium',
        }),
      },
      env
    );
    const body = (await response.json()) as { item: { id: string } };

    expect(response.status).toBe(201);
    expect(body.item.id).toMatch(/^indr_/);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_delivery_routes'),
      expect.arrayContaining(['Ops webhook', 'platform', 'global', 'webhook'])
    );
  });
});
