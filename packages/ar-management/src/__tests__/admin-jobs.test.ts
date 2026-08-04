import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockAuditLog, mockLoggerError, mockGrantRepo, mockWriteAdminAuditLog } =
  vi.hoisted(() => ({
    mockAdapter: {
      queryOne: vi.fn(),
      query: vi.fn(),
      execute: vi.fn(),
    } satisfies Pick<DatabaseAdapter, 'queryOne' | 'query' | 'execute'>,
    mockAuditLog: vi.fn(),
    mockLoggerError: vi.fn(),
    mockGrantRepo: {
      getElevationGrantByPublicId: vi.fn(),
      listActiveElevationGrants: vi.fn(),
    },
    mockWriteAdminAuditLog: vi.fn(),
  }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mockAdapter })),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    createAuditLogFromContext: mockAuditLog,
    getLogger: vi.fn(() => ({
      module: () => ({
        error: mockLoggerError,
      }),
    })),
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mockGrantRepo;
    }),
    loadCatalogObjectArtifact: actual.loadCatalogObjectArtifact,
    decryptObjectArtifact: actual.decryptObjectArtifact,
    getObjectCatalogObjectRecord: actual.getObjectCatalogObjectRecord,
  };
});

vi.mock('@authrim/ar-lib-core/services/object-artifact-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@authrim/ar-lib-core/services/object-artifact-store')>();
  return {
    ...actual,
    loadCatalogObjectArtifact: actual.loadCatalogObjectArtifact,
    loadCatalogObjectRepresentation: actual.loadCatalogObjectRepresentation,
  };
});

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return {
    ...actual,
    writeAdminAuditLog: mockWriteAdminAuditLog,
  };
});

import {
  adminJobResultDownloadHandler,
  adminJobResultHandler,
  adminJobResultArtifactChunkHandler,
  adminJobResultArtifactDownloadHandler,
  adminJobResultArtifactManifestHandler,
  adminJobTypesHandler,
  adminJobGetHandler,
  adminJobsListHandler,
  adminJobsImportUploadHandler,
  adminJobsImportUploadUrlHandler,
  adminJobsUsersImportHandler,
  adminJobsUsersBulkUpdateHandler,
  adminJobsReportsGenerateHandler,
  adminJobsOrgBulkMembersHandler,
} from '../admin-jobs';
import { ADMIN_JOB_TYPE_REGISTRY } from '../admin-job-types';
import { buildUserImportResultKey, buildUserImportUploadKey } from '../user-import-jobs';
import { encryptObjectArtifact } from '@authrim/ar-lib-core';

const OBJECT_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface StoredR2Object {
  body: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

function createMockR2Bucket(initial: Record<string, StoredR2Object> = {}) {
  const store = new Map<string, StoredR2Object>(Object.entries(initial));

  return {
    store,
    bucket: {
      put: vi.fn(
        async (
          key: string,
          value: ArrayBuffer | ArrayBufferView | string,
          options?: {
            httpMetadata?: { contentType?: string };
            customMetadata?: Record<string, string>;
          }
        ) => {
          const body =
            typeof value === 'string'
              ? new TextEncoder().encode(value)
              : value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : value instanceof Uint8Array
                  ? value
                  : new Uint8Array(
                      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                    );
          store.set(key, {
            body,
            contentType: options?.httpMetadata?.contentType,
            customMetadata: options?.customMetadata,
          });
        }
      ),
      get: vi.fn(async (key: string) => {
        const object = store.get(key);
        if (!object) {
          return null;
        }
        return {
          body: new Blob([object.body]).stream(),
          arrayBuffer: async () =>
            object.body.buffer.slice(
              object.body.byteOffset,
              object.body.byteOffset + object.body.byteLength
            ),
          text: async () => new TextDecoder().decode(object.body),
          customMetadata: object.customMetadata,
          writeHttpMetadata(headers: Headers) {
            if (object.contentType) {
              headers.set('Content-Type', object.contentType);
            }
          },
        };
      }),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
  };
}

function createTestApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: { adminId?: string; userId?: string; permissions?: string[] } };
  }>();

  app.use('*', async (c, next) => {
    const permissionsHeader = c.req.header('X-Admin-Permissions');
    const permissions =
      permissionsHeader === undefined
        ? ['*']
        : permissionsHeader
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    (c as any).set('adminAuth', {
      adminId: 'admin-1',
      userId: 'admin-1',
      roles: ['system_admin'],
      permissions,
    });
    await next();
  });

  app.post('/api/admin/jobs/users/import/upload-url', adminJobsImportUploadUrlHandler);
  app.put('/api/admin/jobs/users/import/upload/:upload_id', adminJobsImportUploadHandler);
  app.post('/api/admin/jobs/users/import', adminJobsUsersImportHandler);
  app.post('/api/admin/jobs/users/bulk-update', adminJobsUsersBulkUpdateHandler);
  app.post('/api/admin/jobs/reports/generate', adminJobsReportsGenerateHandler);
  app.post('/api/admin/jobs/organizations/:id/bulk-members', adminJobsOrgBulkMembersHandler);
  app.get('/api/admin/jobs', adminJobsListHandler);
  app.get('/api/admin/jobs/types', adminJobTypesHandler);
  app.get('/api/admin/jobs/artifacts/:artifactId', adminJobResultArtifactManifestHandler);
  app.get('/api/admin/jobs/artifacts/:artifactId/download', adminJobResultArtifactDownloadHandler);
  app.get(
    '/api/admin/jobs/artifacts/:artifactId/chunks/:index',
    adminJobResultArtifactChunkHandler
  );
  app.get('/api/admin/jobs/:id/result', adminJobResultHandler);
  app.get('/api/admin/jobs/:id/result/download', adminJobResultDownloadHandler);
  app.get('/api/admin/jobs/:id', adminJobGetHandler);

  const env = {
    ...envOverrides,
  } as Env;

  return { app, env };
}

function buildHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Tenant-Id': 'tenant-a',
    ...extra,
  };
}

function mockRandomUuid(value: string) {
  return vi
    .spyOn((globalThis as unknown as { crypto: Crypto }).crypto, 'randomUUID')
    .mockReturnValue(value);
}

describe('admin-jobs handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRandomUuid('job-123');
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue(undefined);
    mockAuditLog.mockResolvedValue(undefined);
    mockGrantRepo.listActiveElevationGrants.mockResolvedValue([]);
    mockWriteAdminAuditLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts support operation snapshot job progress and config', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'support-ops/cohort-snapshot',
      status: 'processing',
      progress: JSON.stringify({
        total: 13,
        processed: 4,
        succeeded: 4,
        failed: 0,
        stage: 'processing',
      }),
      config: JSON.stringify({
        cohort_id: 'cohort-1',
        resource: 'User',
        intended_action: 'suspend',
        selector_json: JSON.stringify({ field: 'status', op: 'eq', value: 'active' }),
        selector_hash: 'sha256:test',
        matched_count: 13,
        snapshot_cutoff: Date.now(),
        support_case_id: 'CASE-1',
      }),
      error_code: null,
      error_message: null,
      created_by: 'admin-1',
      created_at: Date.now(),
      updated_at: Date.now(),
      started_at: Date.now(),
      completed_at: null,
      estimated_completion: Date.now() + 60_000,
    });

    const { app, env } = createTestApp();
    const res = await app.request(
      '/api/admin/jobs/job-123',
      {
        method: 'GET',
        headers: buildHeaders(),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      progress: Record<string, unknown>;
      parameters: Record<string, unknown>;
    };
    expect(body.progress).toMatchObject({
      total: 10,
      processed: null,
      succeeded: null,
      privacy: { count_exact: false, count_precision: 10 },
    });
    expect(body.parameters).toMatchObject({
      cohort_id: 'cohort-1',
      resource: 'User',
      intended_action: 'suspend',
      selector_hash: 'sha256:test',
      support_case_id: 'CASE-1',
    });
    expect(body.parameters).not.toHaveProperty('selector_json');
    expect(body.parameters).not.toHaveProperty('matched_count');
  });

  it('keeps scheduled job types enabled in the job type registry', () => {
    expect(ADMIN_JOB_TYPE_REGISTRY['users/import']).toMatchObject({
      processorStatus: 'scheduled',
      creatableFromAdminApi: true,
    });
    expect(ADMIN_JOB_TYPE_REGISTRY['users/bulk-update']).toMatchObject({
      processorStatus: 'scheduled',
      creatableFromAdminApi: true,
    });
    expect(ADMIN_JOB_TYPE_REGISTRY['reports/generate']).toMatchObject({
      processorStatus: 'scheduled',
      creatableFromAdminApi: true,
    });
    expect(ADMIN_JOB_TYPE_REGISTRY['organizations/bulk-members']).toMatchObject({
      processorStatus: 'scheduled',
      creatableFromAdminApi: true,
    });
    expect(ADMIN_JOB_TYPE_REGISTRY['tenant-database/export']).toMatchObject({
      processorStatus: 'scheduled',
      creatableFromAdminApi: false,
    });
    expect(ADMIN_JOB_TYPE_REGISTRY['tenant-database/final-purge']).toMatchObject({
      processorStatus: 'disabled',
      creatableFromAdminApi: false,
    });
  });

  it('creates a safe bulk user update job', async () => {
    mockAdapter.queryOne.mockResolvedValue({ count: 2 });
    const { app, env } = createTestApp();

    const res = await app.request(
      '/api/admin/jobs/users/bulk-update',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          fields: ['status'],
          values: { status: 'suspended' },
          filter: { lifecycle_state: 'active' },
          dry_run: true,
        }),
      },
      env
    );

    expect(res.status).toBe(202);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
      expect.arrayContaining(['job-123', 'tenant-a', 'users/bulk-update'])
    );
  });

  it('rejects unsafe bulk user update fields before creating a job', async () => {
    const { app, env } = createTestApp();

    const res = await app.request(
      '/api/admin/jobs/users/bulk-update',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          fields: ['email'],
          values: { email: 'alice@example.com' },
          dry_run: true,
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('creates a report generation job', async () => {
    const { app, env } = createTestApp();

    const res = await app.request(
      '/api/admin/jobs/reports/generate',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          type: 'user_activity',
          format: 'json',
          from_date: '2026-01-01T00:00:00.000Z',
          to_date: '2026-01-31T00:00:00.000Z',
        }),
      },
      env
    );

    expect(res.status).toBe(202);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
      expect.arrayContaining(['job-123', 'tenant-a', 'reports/generate'])
    );
  });

  it('rejects PDF report generation until binary PDF rendering exists', async () => {
    const { app, env } = createTestApp();

    const res = await app.request(
      '/api/admin/jobs/reports/generate',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          type: 'user_activity',
          format: 'pdf',
          from_date: '2026-01-01T00:00:00.000Z',
          to_date: '2026-01-31T00:00:00.000Z',
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('creates an organization bulk members job after tenant-scoped validation', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      tenant_id: 'tenant-a',
      name: 'Example Org',
    });
    mockAdapter.query.mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000002' }]);
    const { app, env } = createTestApp();

    const res = await app.request(
      '/api/admin/jobs/organizations/00000000-0000-4000-8000-000000000001/bulk-members',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          user_ids: ['00000000-0000-4000-8000-000000000002'],
          action: 'add',
          role: 'member',
        }),
      },
      env
    );

    expect(res.status).toBe(202);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
      expect.arrayContaining(['job-123', 'tenant-a', 'organizations/bulk-members'])
    );
  });

  it('returns a tenant-scoped upload URL for CSV imports', async () => {
    const { bucket } = createMockR2Bucket();
    const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });
    mockRandomUuid('upload-123');

    const res = await app.request(
      '/api/admin/jobs/users/import/upload-url',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          filename: 'users.csv',
          content_type: 'text/csv',
          size_bytes: 128,
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upload_url: string;
      file_key: string;
      upload_id: string;
      checksum_sha256?: string;
    };
    expect(body.upload_id).toBe('upload-123');
    expect(body.file_key).toBe(buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv'));
    expect(body.upload_url).toContain('/api/admin/jobs/users/import/upload/upload-123');
    expect(body.checksum_sha256).toBeUndefined();
  });

  it('stores uploaded CSV files in IMPORT_ARTIFACTS', async () => {
    const { bucket, store } = createMockR2Bucket();
    const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });

    const res = await app.request(
      '/api/admin/jobs/users/import/upload/upload-123?filename=users.csv',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/csv',
          'X-Tenant-Id': 'tenant-a',
        },
        body: 'email\nalice@example.com\n',
      },
      env
    );

    expect(res.status).toBe(201);
    const stored = store.get(buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv'));
    expect(stored).toBeTruthy();
    expect((await res.json()) as Record<string, unknown>).toEqual(
      expect.objectContaining({
        uploaded_bytes: 'email\nalice@example.com\n'.length,
        content_type: 'text/csv',
        checksum_sha256: expect.any(String),
      })
    );
    expect(stored?.customMetadata).toEqual(
      expect.objectContaining({
        checksum_sha256: expect.any(String),
        uploaded_bytes: String('email\nalice@example.com\n'.length),
        content_type: 'text/csv',
      })
    );
  });

  it('creates a user import job only when the artifact belongs to the tenant', async () => {
    const uploadKey = buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv');
    const { bucket } = createMockR2Bucket({
      [uploadKey]: {
        body: new TextEncoder().encode('email\nalice@example.com\n'),
        contentType: 'text/csv',
      },
    });
    const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });

    const res = await app.request(
      '/api/admin/jobs/users/import',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          file_key: uploadKey,
          options: {
            validate_only: true,
          },
        }),
      },
      env
    );

    expect(res.status).toBe(202);
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
      expect.arrayContaining([
        'job-123',
        'tenant-a',
        'users/import',
        uploadKey,
        buildUserImportResultKey('tenant-a', 'job-123'),
        'admin-1',
      ])
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      'job.created',
      'job',
      'job-123',
      expect.objectContaining({
        job_type: 'users/import',
        r2_key: uploadKey,
      })
    );
  });

  it('rejects import job creation when the upload receipt checksum mismatches', async () => {
    const uploadKey = buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv');
    const csvBody = 'email\nalice@example.com\n';
    const { bucket } = createMockR2Bucket({
      [uploadKey]: {
        body: new TextEncoder().encode(csvBody),
        contentType: 'text/csv',
        customMetadata: {
          checksum_sha256: 'deadbeef',
          uploaded_bytes: String(csvBody.length),
          content_type: 'text/csv',
        },
      },
    });
    const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });

    const res = await app.request(
      '/api/admin/jobs/users/import',
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          file_key: uploadKey,
          size_bytes: csvBody.length,
          content_type: 'text/csv',
          checksum_sha256: 'deadbeef',
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('downloads full import results from EXPORT_ARTIFACTS', async () => {
    const resultBody = JSON.stringify({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(resultBody),
        contentType: 'application/json',
      },
    });
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'users/import',
      result_r2_key: resultKey,
    });

    const { app, env } = createTestApp({ EXPORT_ARTIFACTS: bucket });
    const res = await app.request(
      '/api/admin/jobs/job-123/result/download',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Content-Disposition')).toContain('users-import-job-123.json');
    expect(await res.text()).toBe(resultBody);
  });

  it('requires approval or artifact permission for job result downloads', async () => {
    const resultBody = JSON.stringify({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(resultBody),
        contentType: 'application/json',
      },
    });
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'users/import',
      result_r2_key: resultKey,
    });

    const { app, env } = createTestApp({ EXPORT_ARTIFACTS: bucket });
    const res = await app.request(
      '/api/admin/jobs/job-123/result/download',
      {
        method: 'GET',
        headers: buildHeaders({
          'X-Admin-Permissions': 'admin:jobs:read',
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: 'approval_required',
      })
    );
  });

  it('allows job result downloads with a matching elevation grant', async () => {
    const resultBody = JSON.stringify({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(resultBody),
        contentType: 'application/json',
      },
    });
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'users/import',
      result_r2_key: resultKey,
    });
    mockGrantRepo.listActiveElevationGrants.mockResolvedValue([
      {
        id: 'grant-1',
        public_grant_id: 'egr_public_1',
        approval_request_id: 'req-1',
        tenant_id: 'tenant-a',
        status: 'active',
        target_audience: 'admin_api',
        resource_class: 'user_import_result',
        redaction_level: 'masked',
        scope_canonical: '{"version":1}',
        scope_json: {
          version: 1,
          surface: 'admin_jobs',
          action: 'artifact_read',
          tenant_id: 'tenant-a',
          resource_class: 'user_import_result',
          resource_ids: ['job-123'],
          detail_classes: ['job_result_artifact'],
        },
        authorization_details_json: null,
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        actor_subject_type: 'admin_user',
        actor_subject_id: 'admin-1',
        issued_at: Date.now(),
        expires_at: Date.now() + 60_000,
        revoked_at: null,
        revoke_reason: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);

    const { app, env } = createTestApp({ EXPORT_ARTIFACTS: bucket });
    const res = await app.request(
      '/api/admin/jobs/job-123/result/download',
      {
        method: 'GET',
        headers: buildHeaders({
          'X-Admin-Permissions': 'admin:jobs:read',
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(resultBody);
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_job.artifact_download',
        resourceType: 'admin_job',
        resourceId: 'job-123',
        metadata: expect.objectContaining({
          access_path: 'grant',
          grant_id: 'egr_public_1',
          route: 'job_result_download',
          format: 'json',
        }),
      })
    );
  });

  it('downloads encrypted import results through object_catalog pointers', async () => {
    const resultBody = JSON.stringify({ summary: { total: 2, succeeded: 2, failed: 0 } });
    const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
    const envelope = await encryptObjectArtifact(resultBody, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: resultKey,
        objectClass: 'user_import_result',
      },
    });
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });
    mockAdapter.query.mockResolvedValue([
      {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      },
    ]);
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_jobs')) {
        return {
          id: 'job-123',
          tenant_id: 'tenant-a',
          job_type: 'users/import',
          result_r2_key: resultKey,
          object_catalog_id: 'catalog-123',
        };
      }
      return {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      };
    });

    const { app, env } = createTestApp({
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    });
    const res = await app.request(
      '/api/admin/jobs/job-123/result/download',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(resultBody);
  });

  it('returns artifact metadata in job result payload when object_catalog is present', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'users/import',
      status: 'partial_failure',
      result: JSON.stringify({
        summary: { total: 2, succeeded: 1, failed: 1, skipped: 0 },
        failures: [{ row: 2, error_code: 'duplicate_email', message: 'Duplicate email' }],
        logs: [],
      }),
      result_r2_key: buildUserImportResultKey('tenant-a', 'job-123'),
      object_catalog_id: 'catalog-123',
      public_artifact_id: 'oa_job123',
    });

    const { app, env } = createTestApp();
    const res = await app.request(
      '/api/admin/jobs/job-123/result',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact_id?: string;
      available_formats?: string[];
      manifest_url?: string;
      download_url?: string;
    };
    expect(body.artifact_id).toBe('oa_job123');
    expect(body.available_formats).toEqual(['json']);
    expect(body.manifest_url).toBe('/api/admin/jobs/artifacts/oa_job123');
    expect(body.download_url).toBe('/api/admin/jobs/job-123/result/download');
  });

  it('returns manifest view for object-backed job results', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'users/import',
      status: 'completed',
      result_r2_key: buildUserImportResultKey('tenant-a', 'job-123'),
      object_catalog_id: 'catalog-123',
      public_artifact_id: 'oa_job123',
    });
    mockAdapter.query.mockResolvedValue([
      {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: 1700000002000,
        catalog_updated_at: 1700000002000,
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: buildUserImportResultKey('tenant-a', 'job-123'),
        key_version: 1,
        checksum_sha256: 'abc123',
        total_bytes: 512,
        physical_created_at: 1700000002000,
        physical_deleted_at: null,
      },
    ]);

    const { app, env } = createTestApp();
    const res = await app.request(
      '/api/admin/jobs/job-123/result/download?view=manifest',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.artifactId).toBe('oa_job123');
    expect(body.jobId).toBe('job-123');
    expect(body.availableFormats).toEqual(['json']);
  });

  it('returns manifest by public artifact id for import results', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'job-123',
      tenant_id: 'tenant-a',
      job_type: 'users/import',
      status: 'completed',
      result_r2_key: buildUserImportResultKey('tenant-a', 'job-123'),
      object_catalog_id: 'catalog-123',
      public_artifact_id: 'oa_job123',
    });
    mockAdapter.query.mockResolvedValue([
      {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: 1700000002000,
        catalog_updated_at: 1700000002000,
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: buildUserImportResultKey('tenant-a', 'job-123'),
        key_version: 1,
        checksum_sha256: 'abc123',
        total_bytes: 512,
        physical_created_at: 1700000002000,
        physical_deleted_at: null,
      },
    ]);

    const { app, env } = createTestApp();
    const res = await app.request(
      '/api/admin/jobs/artifacts/oa_job123',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.artifactId).toBe('oa_job123');
    expect(body.jobId).toBe('job-123');
  });

  it('downloads an import result artifact by public artifact id', async () => {
    const resultBody = JSON.stringify({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
    const envelope = await encryptObjectArtifact(resultBody, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: resultKey,
        objectClass: 'user_import_result',
      },
    });
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });
    mockAdapter.query.mockResolvedValue([
      {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      },
    ]);
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_jobs aj')) {
        return {
          id: 'job-123',
          tenant_id: 'tenant-a',
          job_type: 'users/import',
          status: 'completed',
          result_r2_key: resultKey,
          object_catalog_id: 'catalog-123',
          public_artifact_id: 'oa_job123',
        };
      }
      return {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      };
    });

    const { app, env } = createTestApp({
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    });
    const res = await app.request(
      '/api/admin/jobs/artifacts/oa_job123/download',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(resultBody);
  });

  it('downloads a generic admin job result artifact by public artifact id', async () => {
    const resultBody = JSON.stringify({ summary: { total_rows: 1, report_type: 'user_activity' } });
    const resultKey = 'exports/tenant-a/admin-jobs/reports-generate/job-123/result.json';
    const envelope = await encryptObjectArtifact(resultBody, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: resultKey,
        objectClass: 'admin_job_result',
      },
    });
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });
    mockAdapter.query.mockResolvedValue([
      {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'admin_job_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      },
    ]);
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_jobs aj')) {
        return {
          id: 'job-123',
          tenant_id: 'tenant-a',
          job_type: 'reports/generate',
          status: 'completed',
          result_r2_key: resultKey,
          object_catalog_id: 'catalog-123',
          public_artifact_id: 'oa_job123',
        };
      }
      return {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'admin_job_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      };
    });

    const { app, env } = createTestApp({
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    });
    const res = await app.request(
      '/api/admin/jobs/artifacts/oa_job123/download',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('reports-generate-job-123.json');
    expect(await res.text()).toBe(resultBody);
  });

  it('lists supported job types and result delivery modes', async () => {
    const { app, env } = createTestApp();
    const res = await app.request(
      '/api/admin/jobs/types',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result_delivery_options: Array<{ value: string }>;
      job_types: Array<{ job_type: string; supported_result_delivery: string[] }>;
    };
    expect(body.result_delivery_options.map((option) => option.value)).toEqual([
      'auto',
      'inline',
      'artifact',
    ]);
    expect(body.job_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_type: 'reports/generate',
          supported_result_delivery: ['auto', 'inline', 'artifact'],
        }),
      ])
    );
  });

  it('downloads chunk zero for an import result artifact', async () => {
    const resultBody = JSON.stringify({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
    const envelope = await encryptObjectArtifact(resultBody, {
      rootKeyHex: OBJECT_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: resultKey,
        objectClass: 'user_import_result',
      },
    });
    const { bucket } = createMockR2Bucket({
      [resultKey]: {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        contentType: 'application/vnd.authrim.object-envelope+json',
      },
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_jobs aj')) {
        return {
          id: 'job-123',
          tenant_id: 'tenant-a',
          job_type: 'users/import',
          status: 'completed',
          result_r2_key: resultKey,
          object_catalog_id: 'catalog-123',
          public_artifact_id: 'oa_job123',
        };
      }
      return {
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_job123',
        tenant_id: 'tenant-a',
        object_class: 'user_import_result',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: resultKey,
        key_version: 1,
        checksum_sha256: null,
        total_bytes: new TextEncoder().encode(resultBody).byteLength,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      };
    });

    const { app, env } = createTestApp({
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    });
    const res = await app.request(
      '/api/admin/jobs/artifacts/oa_job123/chunks/0',
      {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(resultBody);
  });
});
