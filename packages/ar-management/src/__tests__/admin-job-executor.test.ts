import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const {
  mockAdapter,
  mockTenantCoreAdapter,
  mockTenantPiiAdapter,
  mockResolveAuthCorePersistenceAdapterFromEnv,
  mockResolveUserStoreRuntimeSourcesFromEnv,
  mockEmitRuntimeLogRecords,
} = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
  const createRuntimeAdapter = () =>
    ({
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn(),
      getType: vi.fn(() => 'mock'),
      close: vi.fn(),
    }) satisfies DatabaseAdapter;
  const tenantCoreAdapter = createRuntimeAdapter();
  const tenantPiiAdapter = createRuntimeAdapter();
  return {
    mockAdapter: adapter,
    mockTenantCoreAdapter: tenantCoreAdapter,
    mockTenantPiiAdapter: tenantPiiAdapter,
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue(adapter),
    mockEmitRuntimeLogRecords: vi
      .fn()
      .mockResolvedValue({ tenantKey: 'tk_test', targetResults: [] }),
    mockResolveUserStoreRuntimeSourcesFromEnv: vi.fn().mockResolvedValue({
      storageProfile: { id: 'builtin:storage:shared-d1' },
      coreDb: tenantCoreAdapter,
      piiDb: tenantPiiAdapter,
      policyDb: tenantCoreAdapter,
      userCacheScope: {
        storageProfileId: 'builtin:storage:shared-d1',
        sourceGeneration: 'core:0:pii:0',
        schemaVersion: 'core:1:pii:1',
      },
      piiCacheMode: 'encrypted_short_ttl',
    }),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
    resolveUserStoreRuntimeSourcesFromEnv: mockResolveUserStoreRuntimeSourcesFromEnv,
    emitRuntimeLogRecords: mockEmitRuntimeLogRecords,
  };
});

import { encryptObjectArtifact } from '@authrim/ar-lib-core';
import { processPendingGenericAdminJobs } from '../admin-job-executor';

function createMockR2Bucket() {
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => {
    objects.set(key, value);
  });
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key);
    if (value === undefined) return null;
    return {
      text: async () => value,
      writeHttpMetadata: (_headers: Headers) => {},
    } as unknown as R2ObjectBody;
  });
  return {
    objects,
    put,
    bucket: {
      put,
      get,
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
  };
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveTenantBackupRootKeyHex(
  deploymentRootKeyHex: string,
  tenantId: string,
  keyVersion: number
): Promise<string> {
  const rootBytes = new Uint8Array(
    deploymentRootKeyHex.match(/.{1,2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []
  );
  const material = await crypto.subtle.importKey('raw', rootBytes, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-tenant-backup-root'),
      info: new TextEncoder().encode(`tenant:${tenantId}:backup:v${keyVersion}`),
    },
    material,
    256
  );
  return Array.from(new Uint8Array(derived))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('generic admin job executor', () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(mockAdapter);
    mockAdapter.query.mockReset();
    mockAdapter.queryOne.mockReset();
    mockAdapter.execute.mockReset();
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    mockEmitRuntimeLogRecords.mockReset();
    mockEmitRuntimeLogRecords.mockResolvedValue({ tenantKey: 'tk_test', targetResults: [] });
    mockTenantCoreAdapter.query.mockReset();
    mockTenantCoreAdapter.queryOne.mockReset();
    mockTenantCoreAdapter.execute.mockReset();
    mockTenantCoreAdapter.queryOne.mockResolvedValue(null);
    mockTenantCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    mockTenantPiiAdapter.query.mockReset();
    mockTenantCoreAdapter.query.mockResolvedValue([]);
    mockTenantPiiAdapter.query.mockResolvedValue([]);
    mockResolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: { id: 'builtin:storage:shared-d1' },
      coreDb: mockTenantCoreAdapter,
      piiDb: mockTenantPiiAdapter,
      policyDb: mockTenantCoreAdapter,
      userCacheScope: {
        storageProfileId: 'builtin:storage:shared-d1',
        sourceGeneration: 'core:0:pii:0',
        schemaVersion: 'core:1:pii:1',
      },
      piiCacheMode: 'encrypted_short_ttl',
    });
  });

  it('generates tenant database provisioning binding and deployment plans', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-tenant-db',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/provision',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          tenant_slug: 'tenant-a',
          generation: 2,
          activate: false,
          execution_mode: 'plan_only',
        }),
        created_at: 1,
      },
    ]);

    await processPendingGenericAdminJobs({ DEPLOY_ENV: 'dev' } as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(
      expect.stringContaining('SET status = ?, progress = ?, result = ?')
    );
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining(['completed', expect.any(String), expect.any(String)])
    );
    const resultJson = (finalUpdate?.[1] as unknown[])[2] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      summary: { execution_mode: 'plan_only', succeeded: 2 },
      tenant_database_provisioning: {
        tenant_id: 'tenant-a',
        generation: 2,
        impact: {
          added_bindings: 2,
          capacity: { state: 'ok' },
        },
        generated_config: {
          wrangler_toml: expect.stringContaining('[[d1_databases]]'),
        },
        operator_cli: {
          command: expect.stringContaining('authrim-setup tenant-db'),
        },
      },
    });
    expect(mockEmitRuntimeLogRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        logType: 'job',
        surface: 'admin_job',
        records: [
          expect.objectContaining({
            payload: expect.objectContaining({
              job_id: 'job-tenant-db',
              job_type: 'tenant-database/provision',
              status: 'processing',
            }),
          }),
        ],
      })
    );
    expect(mockEmitRuntimeLogRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        logType: 'job',
        surface: 'admin_job',
        records: [
          expect.objectContaining({
            payload: expect.objectContaining({
              job_id: 'job-tenant-db',
              job_type: 'tenant-database/provision',
              status: 'completed',
            }),
          }),
        ],
      })
    );
  });

  it('completes lifecycle restore validation only after real storage and protocol probes', async () => {
    const r2 = createMockR2Bucket();
    const tenantSettings = JSON.stringify({
      'tenant.allowed_identifiers': 'https://tenant-a.auth.example.com',
    });
    const kv = {
      get: vi.fn(async () => tenantSettings),
      delete: vi.fn(async () => undefined),
    };
    const tokenKv = {
      list: vi.fn(async () => ({ keys: [] })),
      get: vi.fn(async () => null),
    };
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-lifecycle-restore',
        tenant_id: 'tenant-a',
        job_type: 'tenants/lifecycle-validation',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          command: 'restore-validate',
          validation_kind: 'restore',
          source_state: 'restore_pending',
          target_state: 'active',
          reason: 'restore completed',
          idempotency_key: 'restore-key',
          actor_id: 'admin-1',
        }),
        created_at: 1,
        tenant_lifecycle_state: 'restore_validating',
      },
    ]);
    mockAdapter.queryOne
      .mockResolvedValueOnce({ id: 'tenant-a', lifecycle_state: 'restore_validating' })
      .mockResolvedValueOnce({ ok: 1 })
      .mockResolvedValueOnce({ id: 'lifecycle:job-lifecycle-restore', tenant_id: 'tenant-a' })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ id: 'audit-1' })
      .mockResolvedValueOnce({ updated_at: 10 });

    await processPendingGenericAdminJobs(
      {
        BASE_DOMAIN: 'auth.example.com',
        AUTHRIM_CONFIG: kv,
        INITIAL_ACCESS_TOKENS: tokenKv,
        EXPORT_ARTIFACTS: r2.bucket,
        DB_ADMIN: mockTenantCoreAdapter,
      } as never,
      logger
    );

    expect(r2.put).toHaveBeenCalledOnce();
    expect(kv.get).toHaveBeenCalledWith('settings:tenant:tenant-a:tenant');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenants SET lifecycle_state = ?'),
      expect.arrayContaining(['active', 'tenant-a', 'restore_validating'])
    );
    expect(mockTenantCoreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['tenant.lifecycle.validation_completed'])
    );
  });

  it('keeps the safe lifecycle state and audits retry when a required probe fails', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-lifecycle-failure',
        tenant_id: 'tenant-a',
        job_type: 'tenants/lifecycle-validation',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          command: 'unfreeze',
          validation_kind: 'unfreeze',
          source_state: 'frozen',
          target_state: 'active',
          reason: 'incident resolved',
          idempotency_key: 'unfreeze-key',
          actor_id: 'admin-1',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
        tenant_lifecycle_state: 'frozen',
      },
    ]);
    mockAdapter.queryOne
      .mockResolvedValueOnce({ id: 'tenant-a', lifecycle_state: 'frozen' })
      .mockResolvedValueOnce({ ok: 1 })
      .mockResolvedValueOnce({ id: 'lifecycle:job-lifecycle-failure', tenant_id: 'tenant-a' });

    await processPendingGenericAdminJobs(
      { BASE_DOMAIN: 'auth.example.com', DB_ADMIN: mockTenantCoreAdapter } as never,
      logger
    );

    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenants SET lifecycle_state = ?'),
      expect.anything()
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending'"),
      expect.arrayContaining([expect.stringContaining('kv_binding_missing'), 1, 3])
    );
    expect(mockTenantCoreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining(['tenant.lifecycle.validation_retry_scheduled'])
    );
  });

  it('exports tenant core and PII tables to encrypted backup artifacts', async () => {
    const { bucket, put } = createMockR2Bucket();
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-backup',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/export',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          policy: 'deletion_before_purge',
          tables: { core: ['identity_accounts'], pii: ['identity_sensitive_values'] },
          reason: 'tenant deletion pre-purge backup',
        }),
        created_at: 1,
      },
    ]);
    mockTenantCoreAdapter.query.mockResolvedValueOnce([
      { tenant_id: 'tenant-a', id: 'user-1', status: 'active' },
    ]);
    mockTenantPiiAdapter.query.mockResolvedValueOnce([
      { tenant_id: 'tenant-a', user_id: 'user-1', email: 'user@example.test' },
    ]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(
      expect.any(Object),
      'tenant-a',
      { requestPath: '/internal/admin-jobs/tenant-database/export' }
    );
    expect(mockTenantCoreAdapter.query).toHaveBeenCalledWith(
      'SELECT * FROM identity_accounts WHERE tenant_id = ? LIMIT ?',
      ['tenant-a', 50001]
    );
    expect(mockTenantPiiAdapter.query).toHaveBeenCalledWith(
      'SELECT * FROM identity_sensitive_values WHERE tenant_id = ? LIMIT ?',
      ['tenant-a', 50001]
    );
    expect(put).toHaveBeenCalledWith(
      'exports/tenant-a/tenant-backup/job-backup/core/identity_accounts.jsonl',
      expect.any(String),
      expect.any(Object)
    );
    expect(put).toHaveBeenCalledWith(
      'exports/tenant-a/tenant-backup/job-backup/pii/identity_sensitive_values.jsonl',
      expect.any(String),
      expect.any(Object)
    );
    expect(put).toHaveBeenCalledWith(
      'exports/tenant-a/tenant-backup/job-backup/manifest.json',
      expect.any(String),
      expect.any(Object)
    );
    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    const resultJson = (finalUpdate?.[1] as unknown[])[2] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      summary: {
        total_tables: 2,
        total_rows: 2,
        policy: 'deletion_before_purge',
        consistency: 'maintenance_read_only',
      },
      manifest: {
        object_key: 'exports/tenant-a/tenant-backup/job-backup/manifest.json',
      },
      table_artifacts: [
        expect.objectContaining({ plane: 'core', table: 'identity_accounts', row_count: 1 }),
        expect.objectContaining({ plane: 'pii', table: 'identity_sensitive_values', row_count: 1 }),
      ],
    });
  });

  it('validates tenant backup manifests and table checksums in restore dry-run jobs', async () => {
    const { bucket, objects } = createMockR2Bucket();
    const deploymentRootKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tenantRootKey = await deriveTenantBackupRootKeyHex(deploymentRootKey, 'tenant-a', 1);
    const tableContent = JSON.stringify({
      tenant_id: 'tenant-a',
      id: 'user-1',
      status: 'active',
    });
    const tableObjectKey = 'exports/tenant-a/tenant-backup/job-backup/core/identity_accounts.jsonl';
    const tableEnvelope = await encryptObjectArtifact(tableContent, {
      rootKeyHex: tenantRootKey,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/x-ndjson',
      context: {
        tenantId: 'tenant-a',
        objectKey: tableObjectKey,
        objectClass: 'dr_bundle',
      },
    });
    const tablePayload = JSON.stringify(tableEnvelope);
    objects.set(tableObjectKey, tablePayload);

    const tableChecksum = await sha256Hex(tableContent);
    const manifest = {
      version: 1,
      tenant_id: 'tenant-a',
      job_id: 'job-backup',
      profile: 'builtin:storage:tenant-d1',
      schema_version: 'core:1:pii:1',
      export_format: 'jsonl_per_table',
      consistency: 'maintenance_read_only',
      policy: 'manual',
      started_at: '2026-05-16T00:00:00.000Z',
      completed_at: '2026-05-16T00:00:01.000Z',
      retention_days: 30,
      restore_order: [{ plane: 'core', table: 'identity_accounts' }],
      tables: [
        {
          plane: 'core',
          table: 'identity_accounts',
          row_count: 1,
          plaintext_bytes: new TextEncoder().encode(tableContent).byteLength,
          plaintext_sha256: tableChecksum,
          object_catalog_id: 'catalog-table',
          public_artifact_id: 'oa_table',
          object_key: tableObjectKey,
          chunked: false,
          chunk_count: 1,
        },
      ],
      checksums: {
        whole_export_sha256: await sha256Hex(tableChecksum),
      },
      encryption: {
        envelope: 'application-level',
        plane: 'EXPORT_ARTIFACTS',
        key_version: 1,
        kms: 'deployment_master_secret_hkdf',
        key_scope: 'tenant_backup',
        raw_keys_stored: false,
      },
    };
    const manifestObjectKey = 'exports/tenant-a/tenant-backup/job-backup/manifest.json';
    const manifestContent = JSON.stringify(manifest, null, 2);
    const manifestEnvelope = await encryptObjectArtifact(manifestContent, {
      rootKeyHex: tenantRootKey,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: manifestObjectKey,
        objectClass: 'dr_bundle',
      },
    });
    const manifestPayload = JSON.stringify(manifestEnvelope);
    objects.set(manifestObjectKey, manifestPayload);

    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-restore-dry-run',
          tenant_id: 'tenant-a',
          job_type: 'tenant-database/restore-dry-run',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            manifest_object_catalog_id: 'catalog-manifest',
            actor_roles: ['system_admin'],
            break_glass_confirmation: 'VALIDATE_TENANT_DATABASE_RESTORE_DRY_RUN',
            reason: 'validate backup before restore planning',
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          catalog_id: 'catalog-manifest',
          public_artifact_id: 'oa_manifest',
          tenant_id: 'tenant-a',
          object_class: 'dr_bundle',
          representation: 'canonical_json',
          object_kind: 'single',
          object_index: 0,
          bucket_binding: 'EXPORT_ARTIFACTS',
          object_key: manifestObjectKey,
          key_version: 1,
          checksum_sha256: await sha256Hex(manifestPayload),
        },
      ])
      .mockResolvedValueOnce([
        {
          catalog_id: 'catalog-table',
          public_artifact_id: 'oa_table',
          tenant_id: 'tenant-a',
          object_class: 'dr_bundle',
          representation: 'ndjson_projection',
          object_kind: 'single',
          object_index: 0,
          bucket_binding: 'EXPORT_ARTIFACTS',
          object_key: tableObjectKey,
          key_version: 1,
          checksum_sha256: await sha256Hex(tablePayload),
        },
      ]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: deploymentRootKey,
        OBJECT_ENCRYPTION_KEY_VERSION: '2',
      } as never,
      logger
    );

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    const resultJson = (finalUpdate?.[1] as unknown[])[2] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      summary: {
        dry_run: true,
        manifest_valid: true,
        total_tables: 1,
        total_rows: 1,
        import_performed: false,
      },
      manifest: {
        object_catalog_id: 'catalog-manifest',
        public_artifact_id: 'oa_manifest',
        source_job_id: 'job-backup',
      },
      table_validations: [
        {
          plane: 'core',
          table: 'identity_accounts',
          row_count: 1,
          checksum_sha256: tableChecksum,
          status: 'valid',
        },
      ],
    });
  });

  it('requires break-glass approval for tenant database restore dry-run jobs', async () => {
    const { bucket } = createMockR2Bucket();
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-restore-dry-run',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/restore-dry-run',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          manifest_object_catalog_id: 'catalog-manifest',
          actor_roles: ['tenant_admin'],
          break_glass_confirmation: 'VALIDATE_TENANT_DATABASE_RESTORE_DRY_RUN',
          reason: 'validate backup',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect((finalUpdate?.[1] as unknown[])[0]).toContain(
      'tenant_database_restore_dry_run_requires_system_admin'
    );
  });

  it('rejects tenant backup retention outside the configured safety range', async () => {
    const { bucket } = createMockR2Bucket();
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-backup-invalid-retention',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/export',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          retention_days: 0,
          tables: { core: ['identity_accounts'], pii: [] },
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect((finalUpdate?.[1] as unknown[])[0]).toContain('Invalid tenant backup retention_days');
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).not.toHaveBeenCalled();
  });

  it('reserves future tenant backup export formats as fail-closed config values', async () => {
    const { bucket } = createMockR2Bucket();
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-backup-parquet',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/export',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          export_format: 'parquet',
          tables: { core: ['identity_accounts'], pii: [] },
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect((finalUpdate?.[1] as unknown[])[0]).toContain(
      'tenant_database_export_format_not_implemented:parquet'
    );
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).not.toHaveBeenCalled();
  });

  it('reserves temporary database restore validation as a fail-closed dry-run mode', async () => {
    const { bucket } = createMockR2Bucket();
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-restore-temp-db',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/restore-dry-run',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          manifest_object_catalog_id: 'catalog-manifest',
          validation_mode: 'temporary_database_schema_import',
          actor_roles: ['system_admin'],
          break_glass_confirmation: 'VALIDATE_TENANT_DATABASE_RESTORE_DRY_RUN',
          reason: 'validate future import path',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect((finalUpdate?.[1] as unknown[])[0]).toContain(
      'tenant_database_restore_dry_run_temp_database_import_not_implemented'
    );
  });

  it('tombstones tenant backup artifacts after retention and break-glass approval', async () => {
    const completedAt = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60;
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-purge-backup',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/purge-backup',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          source_export_job_id: 'job-backup',
          actor_roles: ['system_admin'],
          break_glass_confirmation: 'PURGE_TENANT_DATABASE_BACKUP',
          reason: 'retention elapsed',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'job-backup',
      completed_at: completedAt,
      result: JSON.stringify({
        summary: { retention_days: 30 },
        manifest: {
          object_catalog_id: 'catalog-manifest',
          public_artifact_id: 'oa_manifest',
        },
        table_artifacts: [
          { object_catalog_id: 'catalog-core' },
          { object_catalog_id: 'catalog-pii' },
        ],
      }),
    });

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE object_catalog'),
      expect.arrayContaining(['catalog-manifest', 'tenant-a'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE object_catalog'),
      expect.arrayContaining(['catalog-core', 'tenant-a'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE object_catalog'),
      expect.arrayContaining(['catalog-pii', 'tenant-a'])
    );
    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    const resultJson = (finalUpdate?.[1] as unknown[])[2] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      summary: {
        tombstoned_catalogs: 3,
        source_export_job_id: 'job-backup',
        retention_days: 30,
        physical_purge_deferred_to_object_artifact_cleanup: true,
      },
    });
  });

  it('rejects tenant backup purge before retention has elapsed', async () => {
    const completedAt = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-purge-backup',
        tenant_id: 'tenant-a',
        job_type: 'tenant-database/purge-backup',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          source_export_job_id: 'job-backup',
          actor_roles: ['system_admin'],
          break_glass_confirmation: 'PURGE_TENANT_DATABASE_BACKUP',
          reason: 'too early',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);
    mockAdapter.queryOne.mockResolvedValueOnce({
      id: 'job-backup',
      completed_at: completedAt,
      result: JSON.stringify({
        summary: { retention_days: 30 },
        manifest: { object_catalog_id: 'catalog-manifest' },
        table_artifacts: [{ object_catalog_id: 'catalog-core' }],
      }),
    });

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect((finalUpdate?.[1] as unknown[])[0]).toContain(
      'tenant_database_backup_purge_retention_not_elapsed'
    );
  });

  it('claims and completes a tenant-scoped bulk user update job', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-1',
        tenant_id: 'tenant-a',
        job_type: 'users/bulk-update',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          fields: ['status'],
          values: { status: 'suspended' },
          filter: { lifecycle_state: 'active' },
          dry_run: false,
        }),
        created_at: 1,
      },
    ]);
    mockAdapter.query.mockResolvedValueOnce([{ id: 'user-1' }]);
    mockAdapter.queryOne.mockResolvedValue({ count: 1 });

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET status = 'processing'"),
      expect.arrayContaining(['job-1', 'tenant-a'])
    );
    expect(mockAdapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "UPDATE identity_accounts SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.status', ?), updated_at = ? WHERE tenant_id = ? AND legacy_user_id IN (?)"
      ),
      expect.arrayContaining(['suspended', expect.any(Number), 'tenant-a', 'user-1'])
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET status = ?, progress = ?, result = ?'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        'job-1',
        'tenant-a',
      ])
    );
  });

  it('keeps bulk user update jobs processing across chunks', async () => {
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-1',
          tenant_id: 'tenant-a',
          job_type: 'users/bulk-update',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            fields: ['status'],
            values: { status: 'suspended' },
            filter: { lifecycle_state: 'active' },
            batch_size: 2,
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
    mockAdapter.queryOne.mockResolvedValue({ count: 3 });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 2 });

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'processing'"));
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"processed":2'),
        expect.any(Number),
        expect.any(Number),
        'job-1',
        'tenant-a',
      ])
    );
  });

  it('generates a tenant-scoped report result', async () => {
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-2',
          tenant_id: 'tenant-a',
          job_type: 'reports/generate',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            type: 'user_activity',
            from_date: '2026-01-01T00:00:00.000Z',
            to_date: '2026-01-31T00:00:00.000Z',
            format: 'json',
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([{ status: 'active', count: 7 }]);

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM identity_accounts'),
      ['tenant-a', expect.any(Number), expect.any(Number)]
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET status = ?, progress = ?, result = ?'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        'job-2',
        'tenant-a',
      ])
    );
  });

  it('materializes generic job results when artifact delivery is requested', async () => {
    const { bucket, put } = createMockR2Bucket();
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-2',
          tenant_id: 'tenant-a',
          job_type: 'reports/generate',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            type: 'user_activity',
            from_date: '2026-01-01T00:00:00.000Z',
            to_date: '2026-01-31T00:00:00.000Z',
            format: 'json',
            result_delivery: 'artifact',
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([{ status: 'active', count: 7 }]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    expect(put).toHaveBeenCalledWith(
      'exports/tenant-a/admin-jobs/reports-generate/job-2/result.json',
      expect.any(String),
      expect.any(Object)
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO object_catalog'),
      expect.arrayContaining(['tenant-a', 'admin_job_result'])
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('object_catalog_id = COALESCE'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ])
    );
  });

  it('adds organization memberships with tenant-scoped checks', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-3',
        tenant_id: 'tenant-a',
        job_type: 'organizations/bulk-members',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          organization_id: 'org-1',
          organization_name: 'Example Org',
          action: 'add',
          role: 'admin',
          user_ids: ['user-1'],
        }),
        created_at: 1,
      },
    ]);
    mockAdapter.queryOne
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce({ id: 'user-1' })
      .mockResolvedValueOnce(null);

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.queryOne).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
      ['org-1', 'tenant-a']
    );
    expect(mockAdapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO subject_org_membership'),
      expect.arrayContaining(['tenant-a', 'user-1', 'org-1', 'admin'])
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET status = ?, progress = ?, result = ?'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        'job-3',
        'tenant-a',
      ])
    );
  });

  it('records existing organization memberships as job result errors', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-4',
        tenant_id: 'tenant-a',
        job_type: 'organizations/bulk-members',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          organization_id: 'org-1',
          organization_name: 'Example Org',
          action: 'add',
          role: 'admin',
          user_ids: ['user-1'],
        }),
        created_at: 1,
      },
    ]);
    mockAdapter.queryOne
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce({ id: 'user-1' })
      .mockResolvedValueOnce({ id: 'membership-1' });

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(
      expect.stringContaining('SET status = ?, progress = ?, result = ?')
    );
    expect(finalUpdate?.[1]).toEqual(expect.arrayContaining(['partial_failure']));
    const resultJson = (finalUpdate?.[1] as unknown[])[2] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      failures: [{ user_id: 'user-1', error: 'membership_already_exists' }],
    });
  });

  it('schedules retry with backoff when a generic job fails before max attempts', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-5',
        tenant_id: 'tenant-a',
        job_type: 'reports/generate',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          type: 'user_activity',
          from_date: 'not-a-date',
          to_date: '2026-01-31T00:00:00.000Z',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining([expect.stringContaining('Invalid report date'), 1, 3])
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Generic admin job retry scheduled',
      expect.objectContaining({
        attempt_count: 1,
        max_attempts: 3,
        next_run_at: expect.any(Number),
      }),
      expect.any(Error)
    );
  });

  it('dead-letters generic jobs when max attempts are exhausted', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-6',
        tenant_id: 'tenant-a',
        job_type: 'reports/generate',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          type: 'user_activity',
          from_date: 'not-a-date',
          to_date: '2026-01-31T00:00:00.000Z',
        }),
        created_at: 1,
        attempt_count: 2,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'failed'"));
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid report date'),
        expect.any(String),
        3,
        3,
      ])
    );
    const resultJson = (finalUpdate?.[1] as unknown[])[1] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      summary: { failed: 1, attempts: 3 },
      logs: [{ level: 'error', code: 'job_processor_error' }],
    });
  });
});
