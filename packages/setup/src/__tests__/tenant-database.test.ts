import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTenantDatabaseProvisioningPlan,
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
  getControlGeneratedDatabaseDataRoleFromBinding,
  getLatestMigrationVersionFromDirectory,
  isTenantDatabaseBinding,
  isControlGeneratedDatabaseBinding,
  isLookupDatabaseBinding,
  listTenantDatabaseMigrationTargets,
  loadTenantDatabaseRegistrySignatureConfigFromEnv,
  reconcileTenantDatabaseDerivedBindings,
  signTenantDatabaseRegistryResource,
  signTenantDatabaseRegistryResources,
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
        databaseName: expect.stringMatching(
          /^prod-authrim-tenant-example-university-core-db-[a-f0-9]{8}$/u
        ),
        binding: expect.stringMatching(/^PROD_TDB_EXAMPLE_UNIVERSITY_[A-F0-9]{8}_CORE$/u),
      }),
      expect.objectContaining({
        role: 'tenant_pii',
        databaseName: expect.stringMatching(
          /^prod-authrim-tenant-example-university-pii-db-[a-f0-9]{8}$/u
        ),
        binding: expect.stringMatching(/^PROD_TDB_EXAMPLE_UNIVERSITY_[A-F0-9]{8}_PII$/u),
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

  it('identifies generated assignment bindings', () => {
    expect(isTenantDatabaseBinding('TDB_EXAMPLE_ABC123_CORE')).toBe(false);
    expect(isTenantDatabaseBinding('TDB_EXAMPLE_ABC123_PII')).toBe(false);
    expect(isTenantDatabaseBinding('TEST_UCP_TDB_EXAMPLE_ABC123_CORE')).toBe(true);
    expect(isLookupDatabaseBinding('TEST_UCP_TDB_LOOKUP_ED83F354_LOOKUP')).toBe(true);
    expect(isTenantDatabaseBinding('TEST_TDB_SLOT_0001_CORE')).toBe(true);
    expect(isTenantDatabaseBinding('TEST_TDB_SLOT_0001_PII')).toBe(true);
    expect(isTenantDatabaseBinding('DB')).toBe(false);
    expect(isLookupDatabaseBinding('TEST_TDB_LOOKUP_ED83F354_LOOKUP')).toBe(true);
    expect(isTenantDatabaseBinding('TEST_TDB_LOOKUP_ED83F354_LOOKUP')).toBe(false);
    expect(isControlGeneratedDatabaseBinding('TEST_TDB_LOOKUP_ED83F354_LOOKUP')).toBe(true);
    expect(getControlGeneratedDatabaseDataRoleFromBinding('TEST_TDB_LOOKUP_ED83F354_LOOKUP')).toBe(
      'lookup'
    );
    expect(getTenantDatabaseRoleFromBinding('TEST_TDB_EXAMPLE_ABC123_CORE')).toBe('tenant_core');
    expect(getTenantDatabaseRoleFromBinding('TEST_TDB_EXAMPLE_ABC123_PII')).toBe('tenant_pii');
    expect(getTenantDatabaseRoleFromBinding('TEST_UCP_TDB_EXAMPLE_ABC123_CORE')).toBe(
      'tenant_core'
    );
  });

  it('lists assignment migration targets from the lock file', () => {
    const targets = listTenantDatabaseMigrationTargets({
      d1: {
        DB: { id: 'shared-core-id', name: 'shared-core' },
        TEST_TDB_ALPHA_ABC123_CORE: { id: 'alpha-core-id', name: 'alpha-core' },
        TEST_TDB_ALPHA_ABC123_PII: { id: 'alpha-pii-id', name: 'alpha-pii' },
        TEST_TDB_BETA_DEF456_CORE: { id: 'beta-core-id', name: 'beta-core' },
      },
    });

    expect(targets).toEqual([
      {
        binding: 'TEST_TDB_ALPHA_ABC123_CORE',
        databaseId: 'alpha-core-id',
        databaseName: 'alpha-core',
        role: 'tenant_core',
      },
      {
        binding: 'TEST_TDB_ALPHA_ABC123_PII',
        databaseId: 'alpha-pii-id',
        databaseName: 'alpha-pii',
        role: 'tenant_pii',
      },
      {
        binding: 'TEST_TDB_BETA_DEF456_CORE',
        databaseId: 'beta-core-id',
        databaseName: 'beta-core',
        role: 'tenant_core',
      },
    ]);
  });

  it('builds a fixed-concurrency all-tenant migration plan with canaries', () => {
    const targets = listTenantDatabaseMigrationTargets({
      d1: {
        TEST_TDB_ALPHA_ABC123_CORE: { id: 'alpha-core-id', name: 'alpha-core' },
        TEST_TDB_ALPHA_ABC123_PII: { id: 'alpha-pii-id', name: 'alpha-pii' },
        TEST_TDB_BETA_DEF456_CORE: { id: 'beta-core-id', name: 'beta-core' },
      },
    });

    const plan = buildTenantDatabaseMigrationPlan(targets, {
      concurrency: 3,
      canaryBindings: ['TEST_TDB_BETA_DEF456_CORE'],
      canaryCount: 1,
    });

    expect(plan.concurrency).toBe(3);
    expect(plan.canaryTargets.map((target) => target.binding)).toEqual([
      'TEST_TDB_BETA_DEF456_CORE',
      'TEST_TDB_ALPHA_ABC123_CORE',
    ]);
    expect(plan.remainingTargets.map((target) => target.binding)).toEqual(['TEST_TDB_ALPHA_ABC123_PII']);
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

  it('evaluates generated assignment binding count thresholds', () => {
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

  it('evaluates assignment account and storage warning thresholds', () => {
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
      writeFileSync(join(dir, '001_core_foundation.sql'), '-- foundation');
      writeFileSync(join(dir, '006_core_extended_operations.sql'), '-- migration');
      writeFileSync(join(dir, 'README.md'), '# ignored');

      expect(getLatestMigrationVersionFromDirectory(dir)).toBe(6);
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

  it('can preserve active pointer runtime generation for initial Control Plane bootstrap', () => {
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

  it('reconciles generated assignment bindings against Cloudflare D1 state', () => {
    const result = reconcileTenantDatabaseDerivedBindings({
      lock: {
        d1: {
          TEST_TDB_ALPHA_ABC123_CORE: { id: 'core-id', name: 'alpha-core' },
          TEST_TDB_ALPHA_ABC123_PII: { id: 'pii-id', name: 'alpha-pii' },
          TEST_TDB_BETA_DEF456_CORE: { id: 'stale-id', name: 'beta-core' },
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
          binding: 'TEST_TDB_ALPHA_ABC123_PII',
          databaseName: 'alpha-pii',
          lockDatabaseId: 'pii-id',
        },
        {
          type: 'database_id_mismatch',
          binding: 'TEST_TDB_BETA_DEF456_CORE',
          databaseName: 'beta-core',
          lockDatabaseId: 'stale-id',
          cloudflareDatabaseId: 'fresh-id',
        },
      ],
    });
  });
});
