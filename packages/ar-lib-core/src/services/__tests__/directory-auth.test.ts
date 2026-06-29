import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '../../db';
import {
  cleanupExpiredDirectoryAuthMaintenance,
  cleanupExpiredDirectoryAuthMigrationTransactions,
  completeDirectoryAuthEmailCodeFallback,
  createDirectoryAuthEvidenceExportJob,
  createDirectoryAuthMigrationTransaction,
  createDirectoryAuthSupportBundleRequest,
  ensureDirectoryAuthDefaults,
  markDirectoryAuthEvidenceExportDeleted,
  markDirectoryAuthSupportBundleDeleted,
  matchDirectoryAuthReleaseAdvisories,
  resetDirectoryAuthMigrationUserState,
  resolveDirectoryAuthEmailFallbackRecoveryCampaign,
  resolveDirectoryAuthEffectiveEmailCodeFallbackMode,
  resolveDirectoryAuthMigrationDecision,
  updateDirectoryAuthTenantPolicy,
  type DirectoryAuthMigrationCampaignRow,
  type DirectoryAuthMigrationUserStateRow,
} from '../directory-auth';

function executeResult(rowsAffected = 1): ExecuteResult {
  return { rowsAffected, success: true };
}

function createAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => executeResult()),
    transaction: vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn(async () => []),
        queryOne: vi.fn(async () => null),
        execute: vi.fn(async () => executeResult()),
      })
    ),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async (): Promise<HealthStatus> => ({
      healthy: true,
      latencyMs: 1,
      type: 'mock',
    })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };
}

function activeCampaign(overrides: Partial<DirectoryAuthMigrationCampaignRow> = {}) {
  return {
    id: 'damc_1',
    tenant_id: 'tenant-a',
    name: 'Migration campaign',
    description: null,
    status: 'active',
    mode: 'require_passkey_after_directory',
    passkey_prompt_mode: 'campaign_only',
    email_code_fallback_mode: 'migration_recovery',
    grace_period_days: 30,
    transaction_ttl_seconds: 600,
    enforcement_start_mode: 'first_directory_login',
    target_policy_json: JSON.stringify({ type: 'all' }),
    is_template: 0,
    created_by: 'admin-1',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  } satisfies DirectoryAuthMigrationCampaignRow;
}

describe('directory auth service', () => {
  it('seeds a disabled migration template and retention policy', async () => {
    const adapter = createAdapter();

    await ensureDirectoryAuthDefaults(adapter, 'tenant-a', 'admin-1', 1000);

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_tenant_policies'),
      expect.arrayContaining(['tenant-a', 'migration_recovery', 'admin-1', 1000, 1000])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_retention_policies'),
      expect.arrayContaining(['tenant-a', 365, 14, 72, 'admin-1', 1000, 1000])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_campaigns'),
      expect.arrayContaining(['tenant-a', 'Default passwordless migration template', expect.any(String), 'disabled'])
    );
  });

  it('updates tenant fallback policy with config history', async () => {
    const adapter = createAdapter();

    const policy = await updateDirectoryAuthTenantPolicy(adapter, {
      tenantId: 'tenant-a',
      emailCodeFallbackMode: 'admin_invitation_only',
      actorId: 'admin-1',
      now: 1000,
    });

    expect(policy.email_code_fallback_mode).toBe('admin_invitation_only');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_tenant_policies'),
      expect.arrayContaining(['tenant-a', 'admin_invitation_only', 'admin-1', 1000, 1000])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_config_history'),
      expect.arrayContaining(['tenant-a', 'admin-1', 'policy', 'tenant_policy.updated'])
    );
  });

  it('stores only a migration transaction token hash and expires it with a non-secret tombstone', async () => {
    const adapter = createAdapter();

    const transaction = await createDirectoryAuthMigrationTransaction(adapter, {
      tenantId: 'tenant-a',
      tokenHash: 'sha256:token-hash',
      scope: 'passkey_enrollment',
      ttlSeconds: 600,
      campaignId: 'damc_1',
      userId: 'user-1',
      requestId: 'req-1',
      now: 1000,
    });

    expect(transaction.token_hash).toBe('sha256:token-hash');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.arrayContaining(['tenant-a', 'damc_1', 'user-1', null, null, 'sha256:token-hash'])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transaction_events'),
      expect.arrayContaining(['tenant-a', transaction.id, 'damc_1', 'user-1', 'created'])
    );

    await cleanupExpiredDirectoryAuthMigrationTransactions(adapter, 'tenant-a', 700000);

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("token_hash = 'expired:' || id"),
      [700000, 'tenant-a', 700000]
    );
  });

  it('resets a user migration state with an audit-ready config history row', async () => {
    const adapter = createAdapter();
    const existing: DirectoryAuthMigrationUserStateRow = {
      id: 'damus_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user-1',
      connector_id: null,
      directory_subject: null,
      state: 'blocked',
      first_directory_login_at: 900,
      prompted_at: null,
      deferred_until: null,
      passkey_required_at: null,
      enrolled_at: null,
      blocked_reason: 'operator_review',
      recovery_reason: null,
      reset_count: 0,
      last_reset_at: null,
      last_reset_by: null,
      last_reset_reason: null,
      created_at: 900,
      updated_at: 900,
    };
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(existing);

    const next = await resetDirectoryAuthMigrationUserState(adapter, {
      tenantId: 'tenant-a',
      stateId: 'damus_1',
      actorId: 'admin-1',
      reason: 'support reset',
      now: 1000,
    });

    expect(next?.state).toBe('eligible');
    expect(next?.reset_count).toBe(1);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_auth_migration_user_states'),
      expect.arrayContaining(['eligible', 1000, 'admin-1', 'support reset'])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_config_history'),
      expect.arrayContaining(['tenant-a', 'admin-1', 'migration', 'migration_state.reset'])
    );
  });

  it('does not trigger migration when an active campaign has no explicit target', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      activeCampaign({ target_policy_json: JSON.stringify({ assignments: [] }) }),
    ]);

    const decision = await resolveDirectoryAuthMigrationDecision(adapter, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      directorySubject: 'uid=alice,ou=People,dc=example,dc=com',
      now: 1000,
    });

    expect(decision.action).toBe('none');
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('requires passkey enrollment and creates a migration user state for targeted users', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      activeCampaign({
        target_policy_json: JSON.stringify({
          assignments: [{ type: 'user', user_id: 'user-1' }],
        }),
      }),
    ]);
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(null);

    const decision = await resolveDirectoryAuthMigrationDecision(adapter, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      directorySubject: 'uid=alice,ou=People,dc=example,dc=com',
      now: 1000,
    });

    expect(decision.action).toBe('require_passkey');
    expect(decision.campaign?.id).toBe('damc_1');
    expect(decision.userState?.state).toBe('passkey_required');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_user_states'),
      expect.arrayContaining(['tenant-a', 'damc_1', 'user-1', 'wwcon_8K4M2Q9F7D3H6P1X'])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_auth_migration_user_states'),
      expect.arrayContaining(['passkey_required', null, 1000, 1000])
    );
  });

  it('targets migration campaigns by directory cohort facts and records the cohort key', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      activeCampaign({
        target_policy_json: JSON.stringify({
          cohorts: [{ id: 'staff', source: 'directory_group', value: 'Staff Directory Group' }],
        }),
      }),
    ]);
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(null);

    const decision = await resolveDirectoryAuthMigrationDecision(adapter, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      directorySubject: 'uid=alice,ou=People,dc=example,dc=com',
      directoryFacts: {
        groups: [{ id: 'staff', display: 'Staff Directory Group' }],
        attributes: {},
      },
      now: 1000,
    });

    expect(decision.action).toBe('require_passkey');
    expect(decision.userState?.cohort_key).toBe('staff');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_user_states'),
      expect.arrayContaining(['staff'])
    );
  });

  it('creates short-retention evidence export and support bundle jobs', async () => {
    const adapter = createAdapter();

    const exportJob = await createDirectoryAuthEvidenceExportJob(adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      periodStartAt: 1000,
      periodEndAt: 2000,
      objectCatalogId: 'catalog-1',
      downloadAfterDelete: true,
      now: 3000,
    });
    const bundle = await createDirectoryAuthSupportBundleRequest(adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      redactionLevel: 'standard',
      objectCatalogId: 'catalog-support-1',
      consentSummary: { operator_confirmed: true },
      now: 3000,
    });

    expect(exportJob.status).toBe('ready');
    expect(exportJob.download_after_delete).toBe(1);
    expect(exportJob.artifact_key).toMatch(
      /^directory-auth\/evidence\/tenant-a\/daex_[0-9a-f-]+\.json$/
    );
    expect(exportJob.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exportJob.object_catalog_id).toBe('catalog-1');
    expect(exportJob.manifest_signature_alg).toBeNull();
    expect(exportJob.completed_at).toBe(3000);
    expect(exportJob.retention_expires_at).toBe(3000 + 7 * 24 * 60 * 60 * 1000);
    expect(bundle.status).toBe('ready');
    expect(bundle.redaction_level).toBe('standard');
    expect(bundle.artifact_key).toMatch(
      /^directory-auth\/support-bundles\/tenant-a\/dasb_[0-9a-f-]+\.json$/
    );
    expect(bundle.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.object_catalog_id).toBe('catalog-support-1');
    expect(bundle.completed_at).toBe(3000);
    expect(bundle.retention_expires_at).toBe(3000 + 7 * 24 * 60 * 60 * 1000);
  });

  it('expires directory auth maintenance artifacts without exposing old transaction tokens', async () => {
    const adapter = createAdapter();

    const result = await cleanupExpiredDirectoryAuthMaintenance(adapter, 'tenant-a', 700000);

    expect(result).toEqual({
      migration_transactions_expired: 1,
      evidence_exports_expired: 1,
      evidence_exports_deleted: 0,
      support_bundles_expired: 1,
      support_bundles_deleted: 0,
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("token_hash = 'expired:' || id"),
      [700000, 'tenant-a', 700000]
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_auth_evidence_exports'),
      [700000, 700000, 'tenant-a', 700000]
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_auth_support_bundles'),
      [700000, 700000, 'tenant-a', 700000]
    );
  });

  it('marks ready evidence exports deleted after download without leaving an artifact key', async () => {
    const adapter = createAdapter();

    const deleted = await markDirectoryAuthEvidenceExportDeleted(adapter, 'tenant-a', 'daex_1', 9000);

    expect(deleted).toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('expired', 'ready')"),
      [9000, 9000, 'tenant-a', 'daex_1']
    );
  });

  it('marks ready support bundles deleted without leaving an artifact key', async () => {
    const adapter = createAdapter();

    const deleted = await markDirectoryAuthSupportBundleDeleted(adapter, 'tenant-a', 'dasb_1', 9000);

    expect(deleted).toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('expired', 'ready')"),
      [9000, 9000, 'tenant-a', 'dasb_1']
    );
  });

  it('completes email-code fallback transactions and marks the migration state recovered', async () => {
    const adapter = createAdapter();

    const completed = await completeDirectoryAuthEmailCodeFallback(adapter, {
      tenantId: 'tenant-a',
      transactionId: 'damt_email_1',
      campaignId: 'damc_1',
      userId: 'user_1',
      requestId: 'wwreq_1',
      now: 9000,
    });

    expect(completed).toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('AND scope = ?'),
      [9000, 9000, 'tenant-a', 'damt_email_1', 'email_code_fallback', 9000]
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("state = 'recovered'"),
      [9000, 'tenant-a', 'damc_1', 'user_1']
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transaction_events'),
      expect.arrayContaining([
        'tenant-a',
        'damt_email_1',
        'damc_1',
        'user_1',
        'email_code_fallback.completed',
      ])
    );
  });

  it('resolves directory unavailable recovery campaigns by tenant, mode, and user target', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      tenant_id: 'tenant-a',
      email_code_fallback_mode: 'directory_unavailable_recovery',
      updated_by: 'admin-1',
      created_at: 9000,
      updated_at: 9000,
    });
    vi.mocked(adapter.query).mockResolvedValueOnce([
      activeCampaign({
        id: 'damc_recovery',
        email_code_fallback_mode: 'tenant_default',
        target_policy_json: JSON.stringify({ type: 'user_ids', user_ids: ['user_1'] }),
      }),
    ]);

    const campaign = await resolveDirectoryAuthEmailFallbackRecoveryCampaign(adapter, {
      tenantId: 'tenant-a',
      userId: 'user_1',
      connectorId: 'conn_1',
      mode: 'directory_unavailable_recovery',
      now: 9000,
    });

    expect(campaign?.id).toBe('damc_recovery');
    expect(adapter.query).toHaveBeenCalledWith(
      expect.stringContaining("email_code_fallback_mode IN (?, 'tenant_default')"),
      ['tenant-a', 'directory_unavailable_recovery']
    );
  });

  it('resolves effective fallback mode from tenant policy for tenant default campaigns', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      tenant_id: 'tenant-a',
      email_code_fallback_mode: 'admin_invitation_only',
      updated_by: 'admin-1',
      created_at: 1000,
      updated_at: 1000,
    });

    const mode = await resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
      adapter,
      'tenant-a',
      activeCampaign({ email_code_fallback_mode: 'tenant_default' }),
      1000
    );

    expect(mode).toBe('admin_invitation_only');
  });

  it('completes directory unavailable recovery transactions with a distinct event type', async () => {
    const adapter = createAdapter();

    const completed = await completeDirectoryAuthEmailCodeFallback(adapter, {
      tenantId: 'tenant-a',
      transactionId: 'damt_recovery_1',
      campaignId: 'damc_1',
      userId: 'user_1',
      requestId: 'wwreq_1',
      scope: 'recovery',
      now: 9000,
    });

    expect(completed).toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('AND scope = ?'),
      [9000, 9000, 'tenant-a', 'damt_recovery_1', 'recovery', 9000]
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transaction_events'),
      expect.arrayContaining([
        'tenant-a',
        'damt_recovery_1',
        'damc_1',
        'user_1',
        'directory_unavailable_recovery.completed',
      ])
    );
  });

  it('matches release advisories against reported Wordwarden versions', () => {
    const matches = matchDirectoryAuthReleaseAdvisories('v0.1.0-beta.1', [
      {
        id: 'ww-1',
        channel: 'stable',
        severity: 'high',
        affected_versions_json: JSON.stringify(['<0.2.0']),
        fixed_version: '0.1.0-beta.2',
        summary: 'test advisory',
        published_at: 1000,
        updated_at: 1000,
        release_url: null,
        created_at: 1000,
      },
    ]);

    expect(matches).toEqual([
      expect.objectContaining({
        affected: true,
        reason: 'version_affected',
      }),
    ]);
  });
});
