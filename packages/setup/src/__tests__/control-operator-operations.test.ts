import { describe, expect, it, vi } from 'vitest';
import {
  listPendingControlOperatorOperations,
  listPendingPluginControlCleanupOperations,
  listPendingPluginControlOperatorOperations,
  listPendingTenantDisasterRecoveryOperatorOperations,
} from '../core/control-operator-operations.js';

const row = {
  operation_id: 'op_test_1',
  environment_id: 'test',
  operation_kind: 'provision_shard',
  status: 'blocked',
  last_error_code: 'operator_action_required',
  requested_by_type: 'admin',
  attempt_count: 0,
  retry_budget_started_at: 100,
  created_at: 100,
  updated_at: 123,
  current_step: 'create_d1',
  allocation_scope: 'tenant_exclusive',
  owner_tenant_id: 'tenant-1',
  data_role: 'tenant_core/users',
  residency_policy_id: 'builtin:residency:default',
  residency_partition: 'default',
  deterministic_name: 'authrim-test-users-default-1234',
  desired_resource_id: 'desired-1',
  ownership_fingerprint: 'a'.repeat(64),
  shard_id: 'shard-1',
  binding_ref: 'TEST_TDB_USERS_1234_CORE',
  jurisdiction: null,
  location_hint: 'apac',
  read_replication_mode: 'disabled',
  provider_database_id: null,
  migration_stream_id: 'd1-core',
  release_id: '0.4.0-draft.aaaaaaaaaaaa',
  manifest_digest: 'a'.repeat(64),
  manifest_r2_object_key: `releases/0.4.0-draft.aaaaaaaaaaaa/${'a'.repeat(64)}/manifest.json`,
  migration_generation: 1,
} as const;

describe('setup pending Control operations', () => {
  it('returns the server-owned target without asking setup to select a tenant', async () => {
    const query = vi.fn(async () => [row]);
    await expect(
      listPendingControlOperatorOperations({ controlDatabaseName: 'test-control', query })
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: 'op_test_1',
        tenantId: 'tenant-1',
        scope: 'tenant_exclusive',
        currentStep: 'create_d1',
      }),
    ]);
    expect(query.mock.calls[0]?.[1]).toContain('operation.attempt_count');
    expect(query.mock.calls[0]?.[1]).toContain("last_error_code = 'operator_action_required'");
    expect(query.mock.calls[0]?.[1]).toContain('control_lookup_physical_shards');
  });

  it('returns a shared Lookup shard operation with the pinned Lookup migration stream', async () => {
    const lookupDigest = 'b'.repeat(64);
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [
        {
          ...row,
          operation_id: 'op_lookup_1',
          allocation_scope: 'shared_pool',
          owner_tenant_id: null,
          data_role: 'lookup',
          shard_id: 'lookup-shard-1',
          binding_ref: 'TEST_TDB_LOOKUP_1234_LOOKUP',
          provider_database_id: 'lookup-database-id',
          migration_stream_id: 'd1-lookup',
          manifest_digest: lookupDigest,
          manifest_r2_object_key: `releases/0.4.0-draft.aaaaaaaaaaaa/${lookupDigest}/manifest.json`,
        },
      ]),
    });

    expect(operation).toMatchObject({
      operationId: 'op_lookup_1',
      scope: 'shared_pool',
      tenantId: null,
      dataRole: 'lookup',
      migration: { streamId: 'd1-lookup' },
    });
  });

  it('rejects a mismatched exclusive owner and duplicate operation', async () => {
    await expect(
      listPendingControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [{ ...row, owner_tenant_id: null }]),
      })
    ).rejects.toThrow('control_operator_operation_invalid');
    await expect(
      listPendingControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [row, row]),
      })
    ).rejects.toThrow('control_operator_operation_duplicate');
  });

  it('projects only the migration release pinned by Control state', async () => {
    const digest = 'b'.repeat(64);
    const migrationRow = {
      ...row,
      current_step: 'apply_migrations',
      provider_database_id: 'database-id',
      migration_stream_id: 'd1-core',
      release_id: '0.4.0',
      manifest_digest: digest,
      manifest_r2_object_key: `releases/0.4.0/${digest}/manifest.json`,
      migration_generation: 2,
    } as const;
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [migrationRow]),
    });
    expect(operation?.migration).toEqual({
      databaseId: 'database-id',
      streamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: digest,
      manifestObjectKey: `releases/0.4.0/${digest}/manifest.json`,
      generation: 2,
    });

    await expect(
      listPendingControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [
          { ...migrationRow, manifest_r2_object_key: 'releases/unpinned/manifest.json' },
        ]),
      })
    ).rejects.toThrow('control_operator_operation_invalid');
    await expect(
      listPendingControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [{ ...migrationRow, migration_stream_id: 'd1-lookup' }]),
      })
    ).rejects.toThrow('control_operator_operation_invalid');
  });

  it('returns a safely retryable rejected Worker settings operation', async () => {
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [
        {
          ...row,
          last_error_code: 'control_worker_settings_request_rejected',
          current_step: 'reconcile_worker_bindings',
          provider_database_id: 'database-id',
        },
      ]),
    });

    expect(operation).toMatchObject({
      currentStep: 'reconcile_worker_bindings',
      lastErrorCode: 'control_worker_settings_request_rejected',
    });
  });

  it('returns a transient Control retry for setup takeover', async () => {
    const query = vi.fn(async () => [
      {
        ...row,
        status: 'waiting_retry',
        last_error_code: 'control_worker_binding_reconciliation_failed',
        current_step: 'reconcile_worker_bindings',
        provider_database_id: 'database-id',
      },
    ]);
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query,
    });

    expect(operation).toMatchObject({
      status: 'waiting_retry',
      currentStep: 'reconcile_worker_bindings',
      lastErrorCode: 'control_worker_binding_reconciliation_failed',
    });
    expect(query.mock.calls[0]?.[1]).toContain("binding.state = 'pending'");
    expect(query.mock.calls[0]?.[1]).toContain(
      'lease.owner_operation_id <> operation.operation_id'
    );
  });

  it('resumes a running Worker binding step after cross-operation lease contention clears', async () => {
    const query = vi.fn(async () => [
      {
        ...row,
        status: 'running',
        last_error_code: null,
        current_step: 'reconcile_worker_bindings',
        provider_database_id: 'database-id',
      },
    ]);
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query,
    });

    expect(operation).toMatchObject({
      status: 'running',
      lastErrorCode: null,
      currentStep: 'reconcile_worker_bindings',
    });
    expect(query.mock.calls[0]?.[1]).toContain("binding_step.status = 'running'");
    expect(query.mock.calls[0]?.[1]).toContain("binding.state = 'pending'");
  });

  it('returns an expired migration commit for response-loss recovery', async () => {
    const query = vi.fn(async () => [
      {
        ...row,
        status: 'running',
        last_error_code: null,
        current_step: 'apply_migrations',
        provider_database_id: 'database-id',
      },
    ]);
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query,
    });

    expect(operation).toMatchObject({
      status: 'running',
      lastErrorCode: null,
      currentStep: 'apply_migrations',
    });
    expect(query.mock.calls[0]?.[1]).toContain('operation.lock_expires_at <= unixepoch()');
    expect(query.mock.calls[0]?.[1]).toContain("migration.state = 'ready'");
  });

  it('filters an explicitly selected operation before strict row parsing', async () => {
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      operationId: row.operation_id,
      query: vi.fn(async () => [
        { ...row, operation_id: 'unrelated-invalid', owner_tenant_id: null },
        row,
      ]),
    });

    expect(operation?.operationId).toBe(row.operation_id);
    await expect(
      listPendingControlOperatorOperations({
        controlDatabaseName: 'test-control',
        operationId: '../invalid',
        query: vi.fn(),
      })
    ).rejects.toThrow('control_operator_operation_id_invalid');
  });

  it('validates the pinned release before D1 creation without exposing a runnable migration', async () => {
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [row]),
    });
    expect(operation?.currentStep).toBe('create_d1');
    expect(operation?.migration).toBeNull();

    await expect(
      listPendingControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [{ ...row, manifest_digest: null }]),
      })
    ).rejects.toThrow('control_operator_operation_invalid');
  });

  it('does not return token material in the operation projection', async () => {
    const operations = await listPendingControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [row]),
    });
    expect(JSON.stringify(operations)).not.toMatch(/api[_-]?token|secret|credential/iu);
  });
});

describe('setup pending tenant disaster recovery operations', () => {
  const drRow = {
    operation_id: 'tenant-dr:abc123',
    environment_id: 'test',
    status: 'blocked',
    last_error_code: 'operator_action_required',
    requested_by_type: 'admin',
    attempt_count: 1,
    retry_budget_started_at: 100,
    created_at: 100,
    updated_at: 123,
    tenant_id: 'tenant-1',
    worker_script_name: 'test-ar-auth',
    shard_id: 'shard-1',
    binding_ref: 'TEST_TDB_USERS_1234_CORE',
    data_role: 'tenant_core/users',
    residency_partition: 'apac',
    provider_database_id: '11111111-1111-4111-8111-111111111111',
    migration_generation: 7,
  } as const;

  it('groups all server-owned binding targets under one recovery operation', async () => {
    const query = vi.fn(async () => [
      drRow,
      {
        ...drRow,
        worker_script_name: 'test-ar-token',
        shard_id: 'shard-2',
        binding_ref: 'TEST_TDB_PII_1234_CORE',
        data_role: 'tenant_pii',
        provider_database_id: '22222222-2222-4222-8222-222222222222',
        migration_generation: 8,
      },
    ]);
    const operations = await listPendingTenantDisasterRecoveryOperatorOperations({
      controlDatabaseName: 'test-control',
      query,
    });
    expect(operations).toEqual([
      expect.objectContaining({
        operationId: 'tenant-dr:abc123',
        operationKind: 'tenant_disaster_recovery',
        tenantId: 'tenant-1',
        currentStep: 'reconcile_worker_bindings',
        bindingTargets: [
          expect.objectContaining({ workerScriptName: 'test-ar-auth', shardId: 'shard-1' }),
          expect.objectContaining({ workerScriptName: 'test-ar-token', shardId: 'shard-2' }),
        ],
      }),
    ]);
    expect(query.mock.calls[0]?.[1]).toContain("recovery.recovery_state = 'smoke_verifying'");
    expect(JSON.stringify(operations)).not.toMatch(/api[_-]?token|secret|credential/iu);
  });

  it('rejects duplicate and cross-operation binding metadata', async () => {
    await expect(
      listPendingTenantDisasterRecoveryOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [drRow, drRow]),
      })
    ).rejects.toThrow('control_operator_tenant_dr_binding_duplicate');
    await expect(
      listPendingTenantDisasterRecoveryOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [drRow, { ...drRow, environment_id: 'other' }]),
      })
    ).rejects.toThrow('control_operator_tenant_dr_operation_invalid');
  });
});

const pluginFingerprint = 'b'.repeat(64);
const pluginDigest = 'c'.repeat(64);
const pluginRow = {
  operation_id: 'op_plugin_resources_1',
  environment_id: 'test',
  status: 'blocked',
  last_error_code: 'operator_action_required',
  attempt_count: 0,
  created_at: 100,
  updated_at: 123,
  plugin_resource_id: 'plugin-resource-v1-state',
  plugin_installation_id: 'plugin-installation-1',
  tenant_id: 'tenant-1',
  resource_kind: 'd1',
  logical_resource_id: 'state',
  binding_name: 'PLUGIN_STATE',
  lifecycle_mode: 'managed',
  provider_resource_id: null,
  provider_name: null,
  desired_spec_json: JSON.stringify({
    pluginId: 'plugin-a',
    binding: 'PLUGIN_STATE',
    kind: 'd1',
    access: 'read_write',
    ownership: 'authrim_managed',
    deleteProviderResource: true,
    ownershipFingerprint: pluginFingerprint,
    capabilityManifestDigest: pluginDigest,
  }),
  resource_status: 'pending',
  migration_stream_id: 'plugin/plugin-a/state',
  release_id: '0.4.0',
  manifest_digest: pluginDigest,
  manifest_r2_object_key: `releases/0.4.0/${pluginDigest}/manifest.json`,
  migration_state: 'requested',
  migration_provider_database_id: null,
} as const;

describe('setup pending plugin resource operations', () => {
  it('projects the server-owned resource plan and derives each stage', async () => {
    const query = vi.fn(async () => [pluginRow]);
    const [provider] = await listPendingPluginControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query,
    });
    expect(provider).toMatchObject({
      operationKind: 'provision_plugin_resources',
      tenantId: 'tenant-1',
      pluginId: 'plugin-a',
      currentStep: 'provider',
      resources: [
        {
          logicalResourceId: 'state',
          deterministicName: `authrim-test-${pluginFingerprint.slice(0, 32)}-d1`,
          hostBindingRef: `PRES_D1_${pluginFingerprint.slice(0, 24).toUpperCase()}`,
        },
      ],
    });
    expect(query.mock.calls[0]?.[1]).toContain("operation_kind = 'provision_plugin_resources'");

    const [migration] = await listPendingPluginControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [
        {
          ...pluginRow,
          provider_resource_id: 'database-1',
          provider_name: 'managed-state',
          resource_status: 'ready',
          migration_provider_database_id: 'database-1',
        },
      ]),
    });
    expect(migration?.currentStep).toBe('migration');

    const [binding] = await listPendingPluginControlOperatorOperations({
      controlDatabaseName: 'test-control',
      query: vi.fn(async () => [
        {
          ...pluginRow,
          provider_resource_id: 'database-1',
          provider_name: 'managed-state',
          resource_status: 'ready',
          migration_state: 'ready',
          migration_provider_database_id: 'database-1',
        },
      ]),
    });
    expect(binding?.currentStep).toBe('binding');
  });

  it('rejects cross-installation rows and altered ownership metadata', async () => {
    await expect(
      listPendingPluginControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [
          pluginRow,
          {
            ...pluginRow,
            plugin_resource_id: 'plugin-resource-v1-other',
            logical_resource_id: 'other',
            binding_name: 'PLUGIN_OTHER',
            plugin_installation_id: 'other-installation',
          },
        ]),
      })
    ).rejects.toThrow('control_plugin_operator_operation_invalid');
    await expect(
      listPendingPluginControlOperatorOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [
          {
            ...pluginRow,
            desired_spec_json: JSON.stringify({
              ...JSON.parse(pluginRow.desired_spec_json),
              ownershipFingerprint: 'd'.repeat(64),
              deleteProviderResource: false,
            }),
          },
        ]),
      })
    ).rejects.toThrow('control_plugin_operator_operation_invalid');
  });

  it('keeps provider identities secret-free and out of the query URL surface', async () => {
    const query = vi.fn(async () => [pluginRow]);
    const operations = await listPendingPluginControlOperatorOperations({
      controlDatabaseName: 'test-control',
      operationId: pluginRow.operation_id,
      query,
    });
    expect(JSON.stringify(operations)).not.toMatch(/token|secret|credential/iu);
    expect(query.mock.calls[0]?.[1]).not.toContain(pluginRow.operation_id);
  });
});

describe('setup pending plugin cleanup operations', () => {
  const cleanupRow = {
    operation_id: 'cleanup-operation-1',
    environment_id: 'test',
    status: 'blocked',
    last_error_code: 'operator_action_required',
    attempt_count: 1,
    created_at: 10,
    updated_at: 20,
    plugin_installation_id: 'plugin-installation-1',
    tenant_id: 'tenant-1',
    plugin_id: 'plugin-a',
    source_operation_id: 'plugin-source-operation-1',
    lifecycle_generation: 2,
    reason: 'uninstall',
    cleanup_state: 'quarantined',
    worker_script_name: 'authrim-test-plugin-runner',
    binding_names_json: JSON.stringify(['PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA']),
    binding_presence_required: 1,
    drain_not_before: 1_800,
    plugin_resource_id: 'plugin-resource-1',
    resource_kind: 'd1',
    lifecycle_mode: 'managed',
    provider_resource_id: 'provider-resource-1',
    provider_name: 'provider-resource-name',
    ownership_fingerprint: 'a'.repeat(64),
    delete_provider_resource: 1,
    item_state: 'quarantined',
  } as const;

  it('projects the fenced quarantine and managed deletion plan', async () => {
    const query = vi.fn(async () => [cleanupRow]);
    const [operation] = await listPendingPluginControlCleanupOperations({
      controlDatabaseName: 'test-control',
      query,
    });
    expect(operation).toMatchObject({
      operationKind: 'cleanup_plugin_resources',
      currentStep: 'quarantine',
      lifecycleGeneration: 2,
      bindingPresenceRequired: true,
      resources: [
        {
          lifecycleMode: 'managed',
          deleteProviderResource: true,
          providerResourceId: 'provider-resource-1',
        },
      ],
    });
    expect(query.mock.calls[0]?.[1]).toContain("operation_kind = 'cleanup_plugin_resources'");
    expect(query.mock.calls[0]?.[1]).toContain('control_destructive_operations_disabled');
  });

  it('adopts a Control cleanup blocked by the runtime destructive gate', async () => {
    const [operation] = await listPendingPluginControlCleanupOperations({
      controlDatabaseName: 'test-control-id',
      query: vi.fn(async () => [
        { ...cleanupRow, last_error_code: 'control_destructive_operations_disabled' },
      ]),
    });
    expect(operation?.lastErrorCode).toBe('control_destructive_operations_disabled');
  });

  it('rejects cross-tenant rows and managed resources without a delete bit', async () => {
    await expect(
      listPendingPluginControlCleanupOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [
          cleanupRow,
          {
            ...cleanupRow,
            plugin_resource_id: 'plugin-resource-2',
            tenant_id: 'tenant-2',
          },
        ]),
      })
    ).rejects.toThrow('control_plugin_cleanup_operator_operation_invalid');
    await expect(
      listPendingPluginControlCleanupOperations({
        controlDatabaseName: 'test-control',
        query: vi.fn(async () => [{ ...cleanupRow, delete_provider_resource: 0 }]),
      })
    ).rejects.toThrow('control_plugin_cleanup_operator_operation_invalid');
  });
});
