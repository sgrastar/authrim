import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTenantDatabaseSlotPlan,
  buildTenantDatabaseSlotPlans,
  buildTenantDatabaseProvisioningPlan,
  buildTenantDatabaseAdminJobSql,
  buildTenantDatabaseActivationBatchJobConfig,
  buildTenantDatabaseMigrationPlan,
  buildTenantDatabaseMigrationOperatorActionJobConfig,
  buildTenantDatabaseRegistrySql,
  buildTenantRuntimePackageRoleRequirementManifest,
  buildTenantWorkerShardSplitJobConfig,
  evaluateTenantDatabaseBindingCapacity,
  evaluateTenantDatabaseSizeWarning,
  evaluateTenantDatabaseStatsFreshness,
  getTenantDatabaseRoleFromBinding,
  getLatestMigrationVersionFromDirectory,
  isTenantDatabaseBinding,
  listTenantDatabaseMigrationTargets,
  loadTenantDatabaseRegistrySignatureConfigFromEnv,
  reconcileTenantDatabaseDerivedBindings,
  signTenantDatabaseRegistryResource,
  signTenantDatabaseRegistryResources,
  MAX_TENANT_D1_PREALLOCATED_SLOTS,
  TENANT_DATABASE_PROVISIONING_STATES,
} from '../core/tenant-database.js';

describe('tenant database setup helpers', () => {
  it('builds core and PII D1 resource plans for a tenant', () => {
    const plan = buildTenantDatabaseProvisioningPlan({
      env: 'prod',
      tenantId: 'tenant_123',
      tenantSlug: 'Example University',
    });

    expect(plan.resources).toEqual([
      expect.objectContaining({
        role: 'tenant_core',
        databaseName: 'authrim-prod-example-university-core',
        binding: expect.stringMatching(/^TDB_EXAMPLE_UNIVERSITY_[A-Z0-9]{6}_CORE$/),
      }),
      expect.objectContaining({
        role: 'tenant_pii',
        databaseName: 'authrim-prod-example-university-pii',
        binding: expect.stringMatching(/^TDB_EXAMPLE_UNIVERSITY_[A-Z0-9]{6}_PII$/),
      }),
    ]);
  });

  it('allows retry provisioning to create a new tenant database generation', () => {
    const plan = buildTenantDatabaseProvisioningPlan({
      env: 'prod',
      tenantId: 'tenant_123',
      tenantSlug: 'Example University',
      generation: 2,
    });

    expect(plan.generation).toBe(2);
    expect(plan.resources.every((resource) => resource.generation === 2)).toBe(true);
  });

  it('identifies generated tenant D1 bindings', () => {
    expect(isTenantDatabaseBinding('TDB_EXAMPLE_ABC123_CORE')).toBe(true);
    expect(isTenantDatabaseBinding('TDB_EXAMPLE_ABC123_PII')).toBe(true);
    expect(isTenantDatabaseBinding('TDB_SLOT_0001_CORE')).toBe(true);
    expect(isTenantDatabaseBinding('TDB_SLOT_0001_PII')).toBe(true);
    expect(isTenantDatabaseBinding('DB')).toBe(false);
    expect(getTenantDatabaseRoleFromBinding('TDB_EXAMPLE_ABC123_CORE')).toBe('tenant_core');
    expect(getTenantDatabaseRoleFromBinding('TDB_EXAMPLE_ABC123_PII')).toBe('tenant_pii');
  });

  it('builds stable preallocated tenant D1 slot names and bindings', () => {
    expect(buildTenantDatabaseSlotPlan({ env: 'phase9-tenant-d1', slotNumber: 1 })).toEqual({
      slotNumber: 1,
      slotId: 'tdb-slot-0001',
      resources: [
        {
          slotNumber: 1,
          role: 'tenant_core',
          databaseName: 'authrim-phase9-tenant-d1-tdb-slot-0001-core',
          binding: 'TDB_SLOT_0001_CORE',
        },
        {
          slotNumber: 1,
          role: 'tenant_pii',
          databaseName: 'authrim-phase9-tenant-d1-tdb-slot-0001-pii',
          binding: 'TDB_SLOT_0001_PII',
        },
      ],
    });

    expect(buildTenantDatabaseSlotPlans({ env: 'prod', slots: 2, startSlotNumber: 4 })).toEqual([
      expect.objectContaining({ slotNumber: 4, slotId: 'tdb-slot-0004' }),
      expect.objectContaining({ slotNumber: 5, slotId: 'tdb-slot-0005' }),
    ]);
    expect(() =>
      buildTenantDatabaseSlotPlans({
        env: 'prod',
        slots: 1,
        startSlotNumber: MAX_TENANT_D1_PREALLOCATED_SLOTS + 1,
      })
    ).toThrow('tenant_database_slot_number_exceeds_maximum');
  });

  it('lists tenant D1 migration targets from the lock file', () => {
    const targets = listTenantDatabaseMigrationTargets({
      d1: {
        DB: { id: 'shared-core-id', name: 'shared-core' },
        TDB_ALPHA_ABC123_CORE: { id: 'alpha-core-id', name: 'alpha-core' },
        TDB_ALPHA_ABC123_PII: { id: 'alpha-pii-id', name: 'alpha-pii' },
        TDB_BETA_DEF456_CORE: { id: 'beta-core-id', name: 'beta-core' },
      },
    });

    expect(targets).toEqual([
      {
        binding: 'TDB_ALPHA_ABC123_CORE',
        databaseId: 'alpha-core-id',
        databaseName: 'alpha-core',
        role: 'tenant_core',
      },
      {
        binding: 'TDB_ALPHA_ABC123_PII',
        databaseId: 'alpha-pii-id',
        databaseName: 'alpha-pii',
        role: 'tenant_pii',
      },
      {
        binding: 'TDB_BETA_DEF456_CORE',
        databaseId: 'beta-core-id',
        databaseName: 'beta-core',
        role: 'tenant_core',
      },
    ]);
  });

  it('builds a fixed-concurrency all-tenant migration plan with canaries', () => {
    const targets = listTenantDatabaseMigrationTargets({
      d1: {
        TDB_ALPHA_ABC123_CORE: { id: 'alpha-core-id', name: 'alpha-core' },
        TDB_ALPHA_ABC123_PII: { id: 'alpha-pii-id', name: 'alpha-pii' },
        TDB_BETA_DEF456_CORE: { id: 'beta-core-id', name: 'beta-core' },
      },
    });

    const plan = buildTenantDatabaseMigrationPlan(targets, {
      concurrency: 3,
      canaryBindings: ['TDB_BETA_DEF456_CORE'],
      canaryCount: 1,
    });

    expect(plan.concurrency).toBe(3);
    expect(plan.canaryTargets.map((target) => target.binding)).toEqual([
      'TDB_BETA_DEF456_CORE',
      'TDB_ALPHA_ABC123_CORE',
    ]);
    expect(plan.remainingTargets.map((target) => target.binding)).toEqual(['TDB_ALPHA_ABC123_PII']);
  });

  it('defines tenant database provisioning states used by the registry schema', () => {
    expect(TENANT_DATABASE_PROVISIONING_STATES).toEqual([
      'requested',
      'provisioning',
      'ready',
      'active',
      'degraded',
      'degraded_pending_snapshot',
      'restored_pending',
      'failed',
      'disabled',
      'retired',
      'deleting',
      'deleted',
    ]);
  });

  it('evaluates generated tenant D1 binding count thresholds', () => {
    expect(
      evaluateTenantDatabaseBindingCapacity({
        currentBindings: 2998,
        addedBindings: 2,
      }).state
    ).toBe('warning');
    expect(
      evaluateTenantDatabaseBindingCapacity({
        currentBindings: 3998,
        addedBindings: 2,
      }).state
    ).toBe('strong_warning');
  });

  it('evaluates tenant D1 account and storage warning thresholds', () => {
    expect(
      evaluateTenantDatabaseSizeWarning({
        accountCount: 699_999,
        d1FileSizeBytes: 6 * 1024 * 1024 * 1024,
      }).state
    ).toBe('ok');

    const warning = evaluateTenantDatabaseSizeWarning({
      accountCount: 700_000,
    });
    expect(warning.state).toBe('warning');
    expect(warning.reasons).toContain('account_count_warning_threshold');

    const strong = evaluateTenantDatabaseSizeWarning({
      accountCount: 800_000,
      d1FileSizeBytes: 8 * 1024 * 1024 * 1024,
    });
    expect(strong.state).toBe('strong_warning');
    expect(strong.reasons).toContain('account_count_strong_threshold');
    expect(strong.reasons).toContain('storage_ratio_strong_threshold');
  });

  it('evaluates tenant stats freshness with a 36 hour default stale threshold', () => {
    const now = new Date('2026-05-16T12:00:00.000Z');

    expect(evaluateTenantDatabaseStatsFreshness(null, { now }).state).toBe('unknown');
    expect(evaluateTenantDatabaseStatsFreshness('2026-05-15T01:00:00.000Z', { now }).state).toBe(
      'fresh'
    );
    expect(evaluateTenantDatabaseStatsFreshness('2026-05-14T23:59:59.000Z', { now }).state).toBe(
      'stale'
    );
  });

  it('reads the latest numeric migration version from a migrations directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authrim-tenant-migrations-'));
    try {
      writeFileSync(join(dir, '000_fresh_schema.sql'), '-- fresh');
      writeFileSync(join(dir, '087_saml_attribute_presets.sql'), '-- migration');
      writeFileSync(join(dir, 'README.md'), '# ignored');

      expect(getLatestMigrationVersionFromDirectory(dir)).toBe(87);
      expect(getLatestMigrationVersionFromDirectory(join(dir, 'missing'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds idempotent registry SQL and active pointer SQL when activation is requested', () => {
    const sql = buildTenantDatabaseRegistrySql({
      tenantId: 'tenant-a',
      tenantSlug: 'Tenant A',
      activate: true,
      resources: [
        {
          role: 'tenant_core',
          databaseName: 'authrim-prod-tenant-a-core',
          binding: 'TDB_TENANT_A_ABC123_CORE',
          databaseId: 'core-id',
          generation: 1,
          schemaVersion: 87,
        },
      ],
    });

    expect(sql).toContain('INSERT INTO tenant_database_registry');
    expect(sql).toContain("'TDB_TENANT_A_ABC123_CORE', NULL, 87");
    expect(sql).toContain('ON CONFLICT(tenant_id, role, generation, shard_group, shard_index)');
    expect(sql).toContain('schema_version = excluded.schema_version');
    expect(sql).toContain('"creation_slug":"Tenant A"');
    expect(sql).toContain('metadata_json = excluded.metadata_json');
    expect(sql).toContain('INSERT INTO tenant_database_active_pointers');
    expect(sql).toContain(
      'runtime_generation = tenant_database_active_pointers.runtime_generation + 1'
    );
  });

  it('can preserve active pointer runtime generation for initial tenant-d1 bootstrap', () => {
    const sql = buildTenantDatabaseRegistrySql({
      tenantId: 'tenant-a',
      tenantSlug: 'Tenant A',
      activate: true,
      activePointerMode: 'preserve_existing_generation',
      resources: [
        {
          role: 'tenant_core',
          databaseName: 'authrim-prod-tenant-a-core',
          binding: 'TDB_TENANT_A_ABC123_CORE',
          databaseId: 'core-id',
          generation: 1,
          schemaVersion: 87,
        },
      ],
    });

    expect(sql).toContain('WHEN tenant_database_active_pointers.generation = excluded.generation');
    expect(sql).toContain('THEN tenant_database_active_pointers.runtime_generation');
    expect(sql).toContain('ELSE tenant_database_active_pointers.runtime_generation + 1');
  });

  it('signs routing-critical registry fields before activation SQL is emitted', () => {
    const resource = {
      role: 'tenant_core' as const,
      databaseName: 'authrim-prod-tenant-a-core',
      binding: 'TDB_TENANT_A_ABC123_CORE',
      databaseId: 'core-id',
      generation: 2,
      schemaVersion: 87,
    };
    const signatureConfig = { secret: 'test-secret', keyId: 'current' };
    const signed = signTenantDatabaseRegistryResources({
      tenantId: 'tenant-a',
      signatureConfig,
      resources: [resource],
    });
    const directSignature = signTenantDatabaseRegistryResource({
      tenantId: 'tenant-a',
      resource,
      signatureConfig,
    });
    const sql = buildTenantDatabaseRegistrySql({
      tenantId: 'tenant-a',
      activate: true,
      resources: signed,
    });

    expect(signed[0]).toMatchObject({
      signature: directSignature.signature,
      signatureKeyId: 'current',
    });
    expect(sql).toContain(`'${directSignature.signature}', 'current'`);
    expect(sql.indexOf('INSERT INTO tenant_database_registry')).toBeLessThan(
      sql.indexOf('INSERT INTO tenant_database_active_pointers')
    );
  });

  it('loads tenant database registry signature config from env', () => {
    expect(loadTenantDatabaseRegistrySignatureConfigFromEnv({})).toBeNull();
    expect(
      loadTenantDatabaseRegistrySignatureConfigFromEnv({
        TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET: 'secret',
        TENANT_DATABASE_REGISTRY_SIGNATURE_KEY_ID: 'key-1',
      })
    ).toEqual({ secret: 'secret', keyId: 'key-1' });
  });

  it('can preserve failed provisioning attempts as failed registry generations', () => {
    const sql = buildTenantDatabaseRegistrySql({
      tenantId: 'tenant-a',
      tenantSlug: 'Tenant A',
      activate: false,
      resources: [
        {
          role: 'tenant_core',
          databaseName: 'authrim-prod-tenant-a-core',
          binding: 'TDB_TENANT_A_ABC123_CORE',
          databaseId: 'core-id',
          generation: 2,
          schemaVersion: 87,
          status: 'failed',
        },
      ],
    });

    expect(sql).toContain("'tenant_core', 2");
    expect(sql).toContain("'failed', 1, 'none'");
    expect(sql).not.toContain('INSERT INTO tenant_database_active_pointers');
  });

  it('builds idempotent admin job SQL for tenant database provisioning progress', () => {
    const sql = buildTenantDatabaseAdminJobSql({
      jobId: 'tenant-db-provision:tenant-a:1',
      tenantId: 'tenant-a',
      jobType: 'tenant-database/provision',
      status: 'completed',
      createdBy: 'setup',
      createdAt: 1_779_000_000,
      progress: {
        total: 2,
        processed: 2,
        succeeded: 2,
        failed: 0,
        stage: 'ready',
      },
      config: {
        env: 'prod',
        generation: 1,
        activate: false,
      },
      result: {
        resources: [{ role: 'tenant_core', binding: 'TDB_TENANT_A_ABC123_CORE' }],
      },
    });

    expect(sql).toContain('INSERT INTO admin_jobs');
    expect(sql).toContain("'tenant-db-provision:tenant-a:1'");
    expect(sql).toContain("'tenant-database/provision'");
    expect(sql).toContain('"stage":"ready"');
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
  });

  it('builds idempotent admin job SQL for post-activation health checks', () => {
    const sql = buildTenantDatabaseAdminJobSql({
      jobId: 'tenant-db-health:tenant-a:2',
      tenantId: 'tenant-a',
      jobType: 'tenant-database/health-check',
      status: 'pending',
      createdBy: 'setup',
      createdAt: 1_779_000_000,
      progress: { total: 2, processed: 0, succeeded: 0, failed: 0, stage: 'requested' },
      config: {
        reason: 'post_activation',
        generation: 2,
        roles: ['tenant_core', 'tenant_pii'],
      },
    });

    expect(sql).toContain("'tenant-db-health:tenant-a:2'");
    expect(sql).toContain("'tenant-database/health-check'");
    expect(sql).toContain('"reason":"post_activation"');
  });

  it('reserves worker shard split job config and package role requirement manifest contracts', () => {
    expect(
      buildTenantWorkerShardSplitJobConfig({
        sourceDeploymentTarget: 'primary',
        targetDeploymentTarget: 'tenant-shard-2',
        roles: ['tenant_core', 'tenant_pii', 'tenant_core'],
        reason: 'binding threshold exceeded',
      })
    ).toEqual({
      sourceDeploymentTarget: 'primary',
      targetDeploymentTarget: 'tenant-shard-2',
      roles: ['tenant_core', 'tenant_pii'],
      mode: 'plan_only',
      reason: 'binding threshold exceeded',
    });

    const manifest = buildTenantRuntimePackageRoleRequirementManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.packages).toContainEqual({
      packageName: '@authrim/ar-policy',
      roles: ['tenant_core'],
    });
    expect(manifest.packages).toContainEqual({
      packageName: '@authrim/ar-auth',
      roles: ['tenant_core', 'tenant_pii'],
    });
  });

  it('reserves migration operator action job contracts', () => {
    expect(
      buildTenantDatabaseMigrationOperatorActionJobConfig({
        action: 'resume',
        tenantId: 'tenant-a',
        generation: 2,
        bindings: ['TDB_TENANT_A_CORE', 'TDB_TENANT_A_CORE'],
        reason: 'resume after operator validation',
      })
    ).toEqual({
      action: 'resume',
      tenantId: 'tenant-a',
      roles: ['tenant_core', 'tenant_pii'],
      generation: 2,
      bindings: ['TDB_TENANT_A_CORE'],
      mode: 'plan_only',
      reason: 'resume after operator validation',
    });

    expect(
      buildTenantDatabaseMigrationOperatorActionJobConfig({
        action: 'rollback',
        tenantId: 'tenant-a',
        roles: ['tenant_core'],
        mode: 'operator_apply',
        reason: 'operator requested rollback to previous active generation',
      }).roles
    ).toEqual(['tenant_core']);

    expect(
      buildTenantDatabaseMigrationOperatorActionJobConfig({
        action: 'repair',
        tenantId: 'tenant-a',
        reason: 'repair migration metadata drift',
      }).action
    ).toBe('repair');
  });

  it('reserves batch and scheduled activation job contracts', () => {
    expect(
      buildTenantDatabaseActivationBatchJobConfig({
        activationBatchId: 'activate-2026-05-16-nightly',
        targets: [
          { tenantId: 'tenant-a', generation: 2 },
          { tenantId: 'tenant-b', generation: 3, roles: ['tenant_core'] },
        ],
        scheduledFor: '2026-05-16T18:00:00.000Z',
        windowName: 'off-peak',
        reason: 'activate generated bindings after deploy',
      })
    ).toEqual({
      activationBatchId: 'activate-2026-05-16-nightly',
      targets: [
        { tenantId: 'tenant-a', generation: 2, roles: ['tenant_core', 'tenant_pii'] },
        { tenantId: 'tenant-b', generation: 3, roles: ['tenant_core'] },
      ],
      mode: 'plan_only',
      scheduledFor: '2026-05-16T18:00:00.000Z',
      windowName: 'off-peak',
      requireHealthCheck: true,
      requireDeployedBindings: true,
      reason: 'activate generated bindings after deploy',
    });
  });

  it('reconciles generated tenant D1 bindings against Cloudflare D1 state', () => {
    const result = reconcileTenantDatabaseDerivedBindings({
      lock: {
        d1: {
          TDB_ALPHA_ABC123_CORE: { id: 'core-id', name: 'alpha-core' },
          TDB_ALPHA_ABC123_PII: { id: 'pii-id', name: 'alpha-pii' },
          TDB_BETA_DEF456_CORE: { id: 'stale-id', name: 'beta-core' },
        },
      },
      cloudflareD1Databases: [
        { name: 'alpha-core', uuid: 'core-id' },
        { name: 'beta-core', uuid: 'fresh-id' },
      ],
    });

    expect(result).toEqual({
      checkedBindings: 3,
      status: 'drift_detected',
      issues: [
        {
          type: 'missing_cloudflare_database',
          binding: 'TDB_ALPHA_ABC123_PII',
          databaseName: 'alpha-pii',
          lockDatabaseId: 'pii-id',
        },
        {
          type: 'database_id_mismatch',
          binding: 'TDB_BETA_DEF456_CORE',
          databaseName: 'beta-core',
          lockDatabaseId: 'stale-id',
          cloudflareDatabaseId: 'fresh-id',
        },
      ],
    });
  });
});
