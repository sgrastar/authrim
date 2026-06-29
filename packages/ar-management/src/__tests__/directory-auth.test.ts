import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectoryAuthMigrationCampaignHandler,
  createDirectoryAuthEvidenceExportHandler,
  createDirectoryAuthSupportBundleHandler,
  downloadDirectoryAuthEvidenceExportHandler,
  downloadDirectoryAuthSupportBundleHandler,
  getDirectoryAuthTenantPolicyHandler,
  listDirectoryAuthConfigHistoryHandler,
  listDirectoryAuthMigrationCampaignsHandler,
  runDirectoryAuthMaintenanceCleanupHandler,
  updateDirectoryAuthTenantPolicyHandler,
  updateDirectoryAuthMigrationCampaignHandler,
} from '../routes/directory-auth';

const mocks = vi.hoisted(() => ({
  cleanupExpiredDirectoryAuthMaintenance: vi.fn(),
  createAuditLogFromContext: vi.fn(),
  ensureDirectoryAuthDefaults: vi.fn(),
  ensureDirectoryAuthTenantPolicy: vi.fn(),
  getDirectoryAuthTenantPolicy: vi.fn(),
  updateDirectoryAuthTenantPolicy: vi.fn(),
  listDirectoryAuthConfigHistory: vi.fn(),
  listDirectoryAuthMigrationCampaigns: vi.fn(),
  createDirectoryAuthMigrationCampaign: vi.fn(),
  updateDirectoryAuthMigrationCampaign: vi.fn(),
  createDirectoryAuthEvidenceExportJob: vi.fn(),
  createDirectoryAuthSupportBundleRequest: vi.fn(),
  getDirectoryAuthEvidenceExport: vi.fn(),
  getDirectoryAuthSupportBundle: vi.fn(),
  getDirectoryAuthRetentionPolicy: vi.fn(),
  listDirectoryAuthEvidenceExportsReadyForHardDelete: vi.fn(),
  listDirectoryAuthSupportBundlesReadyForHardDelete: vi.fn(),
  loadCatalogObjectRepresentation: vi.fn(),
  markDirectoryAuthEvidenceExportDeleted: vi.fn(),
  markDirectoryAuthSupportBundleDeleted: vi.fn(),
  tombstoneObjectCatalogEntryForTenant: vi.fn(),
  materializeEncryptedObjectArtifact: vi.fn(),
  coreAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ADMIN_PERMISSIONS: {
      ...actual.ADMIN_PERMISSIONS,
      DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE: 'admin:directory_auth:evidence_export:create',
      DIRECTORY_AUTH_MIGRATION_WRITE: 'admin:directory_auth:migration:write',
    },
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    cleanupExpiredDirectoryAuthMaintenance: mocks.cleanupExpiredDirectoryAuthMaintenance,
    createAuditLogFromContext: mocks.createAuditLogFromContext,
    ensureDirectoryAuthDefaults: mocks.ensureDirectoryAuthDefaults,
    ensureDirectoryAuthTenantPolicy: mocks.ensureDirectoryAuthTenantPolicy,
    getDirectoryAuthTenantPolicy: mocks.getDirectoryAuthTenantPolicy,
    updateDirectoryAuthTenantPolicy: mocks.updateDirectoryAuthTenantPolicy,
    listDirectoryAuthConfigHistory: mocks.listDirectoryAuthConfigHistory,
    listDirectoryAuthMigrationCampaigns: mocks.listDirectoryAuthMigrationCampaigns,
    createDirectoryAuthMigrationCampaign: mocks.createDirectoryAuthMigrationCampaign,
    updateDirectoryAuthMigrationCampaign: mocks.updateDirectoryAuthMigrationCampaign,
    createDirectoryAuthEvidenceExportJob: mocks.createDirectoryAuthEvidenceExportJob,
    createDirectoryAuthSupportBundleRequest: mocks.createDirectoryAuthSupportBundleRequest,
    getDirectoryAuthEvidenceExport: mocks.getDirectoryAuthEvidenceExport,
    getDirectoryAuthSupportBundle: mocks.getDirectoryAuthSupportBundle,
    getDirectoryAuthRetentionPolicy: mocks.getDirectoryAuthRetentionPolicy,
    listDirectoryAuthEvidenceExportsReadyForHardDelete:
      mocks.listDirectoryAuthEvidenceExportsReadyForHardDelete,
    listDirectoryAuthSupportBundlesReadyForHardDelete:
      mocks.listDirectoryAuthSupportBundlesReadyForHardDelete,
    loadCatalogObjectRepresentation: mocks.loadCatalogObjectRepresentation,
    markDirectoryAuthEvidenceExportDeleted: mocks.markDirectoryAuthEvidenceExportDeleted,
    markDirectoryAuthSupportBundleDeleted: mocks.markDirectoryAuthSupportBundleDeleted,
    tombstoneObjectCatalogEntryForTenant: mocks.tombstoneObjectCatalogEntryForTenant,
    createErrorResponse: vi.fn(async (c, code, details) =>
      c.json(
        {
          error: code,
          ...(details?.variables ?? {}),
        },
        code === actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS ? 403 : 400
      )
    ),
  };
});

vi.mock('../object-artifact-materialization', () => ({
  materializeEncryptedObjectArtifact: mocks.materializeEncryptedObjectArtifact,
}));

function createContext(
  tenantId: string,
  body?: unknown,
  permissions: string[] = ['*'],
  roles: string[] = ['system_admin'],
  query: Record<string, string | undefined> = {},
  params: Record<string, string> = {}
) {
  return {
    req: {
      param: vi.fn((name: string) => {
        if (name === 'tenantId') return tenantId;
        return params[name];
      }),
      query: vi.fn((name: string) => query[name]),
      json: vi.fn(async () => body),
    },
    env: {
      EXPORT_ARTIFACTS: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
      OBJECT_ENCRYPTION_ROOT_KEY: 'a'.repeat(64),
      OBJECT_ENCRYPTION_KEY_VERSION: '1',
    },
    get: vi.fn((name: string) => {
      if (name !== 'adminAuth') return undefined;
      return {
        userId: 'admin-1',
        roles,
        permissions,
        tenantScope: [tenantId],
        tenantId,
      };
    }),
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
  };
}

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'damc_1',
    tenant_id: 'tenant-a',
    name: 'Default campaign',
    description: null,
    status: 'draft',
    mode: 'grace_then_require_passkey',
    passkey_prompt_mode: 'campaign_only',
    email_code_fallback_mode: 'migration_recovery',
    grace_period_days: 30,
    transaction_ttl_seconds: 600,
    enforcement_start_mode: 'first_directory_login',
    target_policy_json: '{}',
    is_template: 0,
    created_by: 'admin-1',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe('directory auth admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAuditLogFromContext.mockResolvedValue(undefined);
    mocks.coreAdapter.query.mockResolvedValue([]);
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
    mocks.coreAdapter.transaction.mockImplementation(async (fn) =>
      fn({
        execute: mocks.coreAdapter.execute,
        query: mocks.coreAdapter.query,
        queryOne: mocks.coreAdapter.queryOne,
      })
    );
    mocks.cleanupExpiredDirectoryAuthMaintenance.mockResolvedValue({
      migration_transactions_expired: 1,
      evidence_exports_expired: 2,
      evidence_exports_deleted: 0,
      support_bundles_expired: 3,
      support_bundles_deleted: 0,
    });
    mocks.ensureDirectoryAuthDefaults.mockResolvedValue(undefined);
    mocks.ensureDirectoryAuthTenantPolicy.mockResolvedValue({
      tenant_id: 'tenant-a',
      email_code_fallback_mode: 'migration_recovery',
      updated_by: 'admin-1',
      created_at: 1000,
      updated_at: 1000,
    });
    mocks.getDirectoryAuthTenantPolicy.mockResolvedValue({
      tenant_id: 'tenant-a',
      email_code_fallback_mode: 'migration_recovery',
      updated_by: 'admin-1',
      created_at: 1000,
      updated_at: 1000,
    });
    mocks.updateDirectoryAuthTenantPolicy.mockImplementation(async (_adapter, input) => ({
      tenant_id: input.tenantId,
      email_code_fallback_mode: input.emailCodeFallbackMode,
      updated_by: input.actorId ?? null,
      created_at: 1000,
      updated_at: 2000,
    }));
    mocks.listDirectoryAuthConfigHistory.mockResolvedValue([]);
    mocks.getDirectoryAuthRetentionPolicy.mockResolvedValue({
      tenant_id: 'tenant-a',
      authrim_audit_retention_days: 365,
      wordwarden_local_retention_days: 14,
      artifact_delete_grace_hours: 72,
      updated_by: 'admin-1',
      created_at: 1000,
      updated_at: 1000,
    });
    mocks.getDirectoryAuthEvidenceExport.mockResolvedValue(null);
    mocks.getDirectoryAuthSupportBundle.mockResolvedValue(null);
    mocks.listDirectoryAuthEvidenceExportsReadyForHardDelete.mockResolvedValue([]);
    mocks.listDirectoryAuthSupportBundlesReadyForHardDelete.mockResolvedValue([]);
    mocks.loadCatalogObjectRepresentation.mockResolvedValue(null);
    mocks.markDirectoryAuthEvidenceExportDeleted.mockResolvedValue(true);
    mocks.markDirectoryAuthSupportBundleDeleted.mockResolvedValue(true);
    mocks.tombstoneObjectCatalogEntryForTenant.mockResolvedValue(undefined);
    mocks.materializeEncryptedObjectArtifact.mockResolvedValue({
      catalogId: 'catalog-1',
      publicArtifactId: 'oa_1',
      primaryObjectKey: 'directory-auth/evidence/tenant-a/daex_1.json',
      chunked: false,
      chunkCount: 1,
    });
    mocks.listDirectoryAuthMigrationCampaigns.mockResolvedValue([]);
    mocks.createDirectoryAuthMigrationCampaign.mockImplementation(async (_adapter, input) =>
      campaignRow({
        tenant_id: input.tenantId,
        name: input.name,
        status: input.status ?? 'draft',
        mode: input.mode ?? 'grace_then_require_passkey',
        email_code_fallback_mode: input.emailCodeFallbackMode ?? 'migration_recovery',
      })
    );
    mocks.updateDirectoryAuthMigrationCampaign.mockImplementation(async (_adapter, input) =>
      campaignRow({
        id: input.campaignId,
        tenant_id: input.tenantId,
        name: input.name ?? 'Default campaign',
        status: input.status ?? 'draft',
        mode: input.mode ?? 'grace_then_require_passkey',
        email_code_fallback_mode: input.emailCodeFallbackMode ?? 'migration_recovery',
      })
    );
    mocks.createDirectoryAuthEvidenceExportJob.mockImplementation(async (_adapter, input) => ({
      id: 'daex_1',
      tenant_id: input.tenantId,
      status: 'ready',
      requested_by: input.requestedBy,
      period_start_at: input.periodStartAt,
      period_end_at: input.periodEndAt,
      size_estimate_bytes: input.sizeEstimateBytes ?? null,
      artifact_key: input.artifactKey ?? null,
      artifact_sha256: input.artifactSha256 ?? null,
      artifact_download_url: '/download',
      object_catalog_id: input.objectCatalogId ?? null,
      manifest_signature_key_id: null,
      manifest_signature_alg: null,
      signed_url_expires_at: null,
      retention_expires_at: 1000,
      download_after_delete: input.downloadAfterDelete ? 1 : 0,
      error_code: null,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    }));
    mocks.createDirectoryAuthSupportBundleRequest.mockImplementation(async (_adapter, input) => ({
      id: 'dasb_1',
      tenant_id: input.tenantId,
      requested_by: input.requestedBy,
      redaction_level: input.redactionLevel,
      status: 'ready',
      scope_json: '{}',
      consent_summary_json: '{}',
      artifact_key: input.artifactKey ?? null,
      artifact_sha256: input.artifactSha256 ?? null,
      artifact_download_url: '/download',
      object_catalog_id: input.objectCatalogId ?? null,
      retention_expires_at: 1000,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    }));
  });

  it('seeds defaults before listing migration campaigns', async () => {
    const response = await listDirectoryAuthMigrationCampaignsHandler(
      createContext('tenant-a') as never
    );
    const body = (await response.json()) as { tenantId: string; items: unknown[] };

    expect(response.status).toBe(200);
    expect(body).toEqual({ tenantId: 'tenant-a', items: [] });
    expect(mocks.ensureDirectoryAuthDefaults).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant-a',
      'admin-1'
    );
    expect(mocks.listDirectoryAuthMigrationCampaigns).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant-a'
    );
  });

  it('requires the dedicated migration permission to create campaigns for tenant admins', async () => {
    const denied = await createDirectoryAuthMigrationCampaignHandler(
      createContext(
        'tenant-a',
        {
          name: 'Passkey migration',
          email_code_fallback_mode: 'directory_unavailable_recovery',
        },
        [],
        ['tenant_admin']
      ) as never
    );
    const body = (await denied.json()) as Record<string, unknown>;

    expect(denied.status).toBe(403);
    expect(body.required_permission).toBe('admin:directory_auth:migration:write');
    expect(mocks.createDirectoryAuthMigrationCampaign).not.toHaveBeenCalled();
  });

  it('allows tenant admins with migration permission to create campaigns', async () => {
    const response = await createDirectoryAuthMigrationCampaignHandler(
      createContext(
        'tenant-a',
        {
          name: 'Passkey migration',
          email_code_fallback_mode: 'directory_unavailable_recovery',
        },
        ['admin:directory_auth:migration:write'],
        ['tenant_admin']
      ) as never
    );
    const body = (await response.json()) as { item: { name: string } };

    expect(response.status).toBe(201);
    expect(body.item.name).toBe('Passkey migration');
    expect(mocks.createDirectoryAuthMigrationCampaign).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        emailCodeFallbackMode: 'directory_unavailable_recovery',
      })
    );
  });

  it('requires the dedicated migration permission to update campaigns for tenant admins', async () => {
    const denied = await updateDirectoryAuthMigrationCampaignHandler(
      createContext(
        'tenant-a',
        {
          email_code_fallback_mode: 'login_method',
        },
        [],
        ['tenant_admin'],
        {},
        { campaignId: 'damc_1' }
      ) as never
    );
    const body = (await denied.json()) as Record<string, unknown>;

    expect(denied.status).toBe(403);
    expect(body.required_permission).toBe('admin:directory_auth:migration:write');
    expect(mocks.updateDirectoryAuthMigrationCampaign).not.toHaveBeenCalled();
  });

  it('requires the dedicated permission for evidence exports', async () => {
    const response = await createDirectoryAuthEvidenceExportHandler(
      createContext(
        'tenant-a',
        {
          period_start_at: 1000,
          period_end_at: 2000,
        },
        [],
        ['tenant_admin']
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.required_permission).toBe('admin:directory_auth:evidence_export:create');
    expect(mocks.createDirectoryAuthEvidenceExportJob).not.toHaveBeenCalled();
  });

  it('creates an evidence export job for admins with export permission', async () => {
    const now = Date.now();
    const response = await createDirectoryAuthEvidenceExportHandler(
      createContext(
        'tenant-a',
        {
          period_start_at: now - 2 * 24 * 60 * 60 * 1000,
          period_end_at: now - 24 * 60 * 60 * 1000,
          download_after_delete: true,
        },
        ['admin:directory_auth:evidence_export:create'],
        ['tenant_admin']
      ) as never
    );
    const body = (await response.json()) as {
      item: { status: string; download_after_delete: number; artifact_download_url: string | null };
    };

    expect(response.status).toBe(201);
    expect(body.item.status).toBe('ready');
    expect(body.item.download_after_delete).toBe(1);
    expect(body.item.artifact_download_url).toContain(
      '/directory-auth/compliance/evidence-exports/'
    );
    expect(mocks.materializeEncryptedObjectArtifact).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        objectClass: 'directory_auth_evidence_export',
        representation: 'canonical_json',
      })
    );
    expect(mocks.createDirectoryAuthEvidenceExportJob).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        requestedBy: 'admin-1',
        objectCatalogId: 'catalog-1',
        downloadAfterDelete: true,
      })
    );
    expect(mocks.createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'directory_auth.evidence_export.created',
      'directory_auth_evidence_export',
      expect.any(String),
      expect.objectContaining({ tenant_id: 'tenant-a' })
    );
  });

  it('tombstones materialized artifacts if evidence export metadata creation fails', async () => {
    mocks.createDirectoryAuthEvidenceExportJob.mockRejectedValueOnce(new Error('db failed'));
    const now = Date.now();

    const response = await createDirectoryAuthEvidenceExportHandler(
      createContext(
        'tenant-a',
        {
          period_start_at: now - 2 * 24 * 60 * 60 * 1000,
          period_end_at: now - 24 * 60 * 60 * 1000,
        },
        ['admin:directory_auth:evidence_export:create'],
        ['tenant_admin']
      ) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.tombstoneObjectCatalogEntryForTenant).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant-a',
      'catalog-1'
    );
  });

  it('downloads ready evidence exports through the tenant-scoped proxy', async () => {
    mocks.getDirectoryAuthEvidenceExport.mockResolvedValueOnce({
      id: 'daex_1',
      tenant_id: 'tenant-a',
      status: 'ready',
      requested_by: 'admin-1',
      period_start_at: 1000,
      period_end_at: 2000,
      size_estimate_bytes: 128,
      artifact_key: 'directory-auth/evidence/tenant-a/daex_1.json',
      artifact_sha256: 'f'.repeat(64),
      object_catalog_id: 'catalog-1',
      manifest_signature_key_id: null,
      manifest_signature_alg: 'sha256',
      signed_url_expires_at: null,
      retention_expires_at: 3000,
      download_after_delete: 0,
      error_code: null,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    });
    mocks.loadCatalogObjectRepresentation.mockResolvedValueOnce({
      logical: {},
      physical: [],
      content: '{"ok":true}',
      contentType: 'application/json',
      encrypted: true,
    });

    const response = await downloadDirectoryAuthEvidenceExportHandler(
      createContext(
        'tenant-a',
        undefined,
        ['admin:directory_auth:evidence_export:create'],
        ['tenant_admin'],
        {},
        { exportId: 'daex_1' }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('{"ok":true}');
    expect(mocks.loadCatalogObjectRepresentation).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        objectCatalogId: 'catalog-1',
        expectedClass: 'directory_auth_evidence_export',
      })
    );
    expect(mocks.tombstoneObjectCatalogEntryForTenant).not.toHaveBeenCalled();
  });

  it('tombstones evidence exports after download when requested', async () => {
    mocks.getDirectoryAuthEvidenceExport.mockResolvedValueOnce({
      id: 'daex_1',
      tenant_id: 'tenant-a',
      status: 'ready',
      requested_by: 'admin-1',
      period_start_at: 1000,
      period_end_at: 2000,
      size_estimate_bytes: 128,
      artifact_key: 'directory-auth/evidence/tenant-a/daex_1.json',
      artifact_sha256: 'f'.repeat(64),
      object_catalog_id: 'catalog-1',
      manifest_signature_key_id: null,
      manifest_signature_alg: null,
      signed_url_expires_at: null,
      retention_expires_at: 3000,
      download_after_delete: 1,
      error_code: null,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    });
    mocks.loadCatalogObjectRepresentation.mockResolvedValueOnce({
      logical: {},
      physical: [],
      content: '{"ok":true}',
      contentType: 'application/json',
      encrypted: true,
    });

    const response = await downloadDirectoryAuthEvidenceExportHandler(
      createContext(
        'tenant-a',
        undefined,
        ['admin:directory_auth:evidence_export:create'],
        ['tenant_admin'],
        {},
        { exportId: 'daex_1' }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.tombstoneObjectCatalogEntryForTenant).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant-a',
      'catalog-1',
      expect.any(Number)
    );
    expect(mocks.markDirectoryAuthEvidenceExportDeleted).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant-a',
      'daex_1',
      expect.any(Number)
    );
  });

  it('allows tenant admins with directory write permission to request redacted support bundles', async () => {
    mocks.coreAdapter.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_1',
          instance_id: 'wwi_1',
          deactivation_reason_present: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_1',
          instance_id: 'wwi_1',
          reason_present: 1,
        },
      ]);

    const response = await createDirectoryAuthSupportBundleHandler(
      createContext(
        'tenant-a',
        {
          redaction_level: 'detailed',
          consent_summary: {
            operator_confirmed: true,
            detailed_warning_acknowledged: true,
          },
        },
        ['admin:directory_auth:write'],
        ['tenant_admin']
      ) as never
    );
    const body = (await response.json()) as {
      item: { redaction_level: string; status: string; artifact_download_url: string | null };
    };

    expect(response.status).toBe(201);
    expect(body.item.redaction_level).toBe('detailed');
    expect(body.item.status).toBe('ready');
    expect(body.item.artifact_download_url).toContain('/directory-auth/support/bundles/');
    expect(mocks.materializeEncryptedObjectArtifact).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        objectClass: 'directory_auth_support_bundle',
        representation: 'canonical_json',
      })
    );
    expect(mocks.createDirectoryAuthSupportBundleRequest).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        requestedBy: 'admin-1',
        redactionLevel: 'detailed',
        objectCatalogId: 'catalog-1',
      })
    );
    const artifactContent = mocks.materializeEncryptedObjectArtifact.mock.calls[0]?.[2].content;
    const artifact = JSON.parse(String(artifactContent)) as {
      sections: {
        connector_instances: Array<Record<string, unknown>>;
        connector_status_episodes: Array<Record<string, unknown>>;
      };
    };
    expect(artifact.sections.connector_instances[0]).toHaveProperty(
      'deactivation_reason_present',
      1
    );
    expect(artifact.sections.connector_instances[0]).not.toHaveProperty('deactivation_reason');
    expect(artifact.sections.connector_status_episodes[0]).toHaveProperty('reason_present', 1);
    expect(artifact.sections.connector_status_episodes[0]).not.toHaveProperty('reason');
  });

  it('denies support bundle artifact creation without directory write permission', async () => {
    const response = await createDirectoryAuthSupportBundleHandler(
      createContext(
        'tenant-a',
        {
          redaction_level: 'standard',
          consent_summary: { operator_confirmed: true },
        },
        [],
        ['tenant_admin']
      ) as never
    );

    expect(response.status).toBe(403);
    expect(mocks.materializeEncryptedObjectArtifact).not.toHaveBeenCalled();
    expect(mocks.createDirectoryAuthSupportBundleRequest).not.toHaveBeenCalled();
  });

  it('rejects arbitrary support bundle scope fields before artifact creation', async () => {
    const response = await createDirectoryAuthSupportBundleHandler(
      createContext(
        'tenant-a',
        {
          redaction_level: 'standard',
          scope: { ldap_bind_secret: 'should-not-be-persisted' },
          consent_summary: { operator_confirmed: true },
        },
        ['admin:directory_auth:write'],
        ['tenant_admin']
      ) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.materializeEncryptedObjectArtifact).not.toHaveBeenCalled();
    expect(mocks.createDirectoryAuthSupportBundleRequest).not.toHaveBeenCalled();
  });

  it('rejects arbitrary support bundle consent metadata before artifact creation', async () => {
    const response = await createDirectoryAuthSupportBundleHandler(
      createContext(
        'tenant-a',
        {
          redaction_level: 'standard',
          consent_summary: {
            operator_confirmed: true,
            operator_note: 'contains operational detail',
          },
        },
        ['admin:directory_auth:write'],
        ['tenant_admin']
      ) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.materializeEncryptedObjectArtifact).not.toHaveBeenCalled();
    expect(mocks.createDirectoryAuthSupportBundleRequest).not.toHaveBeenCalled();
  });

  it('downloads ready support bundles through the tenant-scoped proxy', async () => {
    mocks.getDirectoryAuthSupportBundle.mockResolvedValueOnce({
      id: 'dasb_1',
      tenant_id: 'tenant-a',
      requested_by: 'admin-1',
      redaction_level: 'standard',
      status: 'ready',
      scope_json: '{}',
      consent_summary_json: '{}',
      artifact_key: 'directory-auth/support-bundles/tenant-a/dasb_1.json',
      artifact_sha256: 'e'.repeat(64),
      object_catalog_id: 'catalog-1',
      retention_expires_at: 3000,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    });
    mocks.loadCatalogObjectRepresentation.mockResolvedValueOnce({
      logical: {},
      physical: [],
      content: '{"support":true}',
      contentType: 'application/json',
      encrypted: true,
    });

    const response = await downloadDirectoryAuthSupportBundleHandler(
      createContext(
        'tenant-a',
        undefined,
        ['admin:directory_auth:write'],
        ['tenant_admin'],
        {},
        { bundleId: 'dasb_1' }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('{"support":true}');
    expect(mocks.loadCatalogObjectRepresentation).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        objectCatalogId: 'catalog-1',
        expectedClass: 'directory_auth_support_bundle',
      })
    );
  });

  it('runs maintenance cleanup for tenant admins scoped to the tenant', async () => {
    const denied = await runDirectoryAuthMaintenanceCleanupHandler(
      createContext('tenant-a', { reason: 'daily cleanup' }, [], ['support_admin']) as never
    );
    const deniedBody = (await denied.json()) as { required_role?: string };

    expect(denied.status).toBe(403);
    expect(deniedBody.required_role).toBe('tenant_admin');
    expect(mocks.cleanupExpiredDirectoryAuthMaintenance).not.toHaveBeenCalled();

    const response = await runDirectoryAuthMaintenanceCleanupHandler(
      createContext('tenant-a', { reason: 'daily cleanup' }, [], ['tenant_admin']) as never
    );
    const body = (await response.json()) as {
      result: {
        migration_transactions_expired: number;
        evidence_exports_expired: number;
        evidence_exports_deleted: number;
        support_bundles_expired: number;
        support_bundles_deleted: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.result).toEqual({
      migration_transactions_expired: 1,
      evidence_exports_expired: 2,
      evidence_exports_deleted: 0,
      support_bundles_expired: 3,
      support_bundles_deleted: 0,
    });
    expect(mocks.cleanupExpiredDirectoryAuthMaintenance).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant-a',
      expect.any(Number)
    );
    expect(mocks.createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'directory_auth.maintenance.cleanup',
      'directory_auth_maintenance',
      'tenant-a',
      expect.objectContaining({
        tenant_id: 'tenant-a',
        reason: 'daily cleanup',
        migration_transactions_expired: 1,
      })
    );
  });
});
