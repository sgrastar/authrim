import {
  CloudflareControlApiError,
  calculateControlBootstrapOwnershipFingerprint,
  digestCloudflareWorkerSettings,
  type CloudflareD1Database,
  type CloudflareD1QueryResult,
  type CloudflareWorkerSettings,
  type CloudflareWorkerDeployment,
} from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import {
  BootstrapHandoffVerifier,
  type BootstrapHandoff,
  type BootstrapHandoffApi,
  type BootstrapHandoffRepository,
  type BootstrapResource,
  type BootstrapWorkerEvidence,
} from '../bootstrap-handoff';

const manifestDigest = 'a'.repeat(64);
const migrationFile = { path: '001_initial.sql', checksum: 'b'.repeat(64) };
const roles = ['lookup', 'tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const;
const tenantId = 'default';

function resource(role: (typeof roles)[number], index: number): BootstrapResource {
  const streamId = role === 'lookup' ? 'd1-lookup' : role === 'tenant_pii' ? 'd1-pii' : 'd1-core';
  const releaseId = 'release-v1';
  const tenantResource = role !== 'lookup';
  const desiredSpecJson = JSON.stringify({
    bootstrap: true,
    bootstrap_role: role,
    data_role: role,
    allocation_scope: tenantResource ? 'tenant_exclusive' : undefined,
    owner_tenant_id: tenantResource ? tenantId : undefined,
    migration_stream_id: streamId,
    release_id: releaseId,
    manifest_digest: manifestDigest,
    migration_files: [migrationFile],
  });
  return {
    role,
    desiredResourceId: `d1-bootstrap-${index}`,
    providerDatabaseId: `00000000-0000-4000-8000-00000000000${index}`,
    providerName: `authrim-test-bootstrap-${index}`,
    ownershipFingerprint: `${index}`.repeat(64),
    bindingRef:
      role === 'lookup'
        ? 'LOOKUP_DB'
        : `TDB_${role.replace('tenant_core/', '').replace('tenant_', '').toUpperCase()}_BOOTSTRAP_${role === 'tenant_pii' ? 'PII' : 'CORE'}`,
    manifestDigest,
    desiredResourceScope: tenantResource ? 'tenant' : 'platform',
    desiredTenantId: tenantResource ? tenantId : null,
    provisioningState: 'ready',
    observedState: 'present',
    observedOwnershipFingerprint: `${index}`.repeat(64),
    desiredObservedResourceId: `observed-bootstrap-${index}`,
    observedResourceId: `observed-bootstrap-${index}`,
    desiredSpecJson,
    migrationState: 'ready',
    migrationStreamId: streamId,
    migrationReleaseId: releaseId,
    migrationManifestDigest: manifestDigest,
    migrationExpectedFileCount: 1,
    migrationAppliedFileCount: 1,
    shardStatus: role === 'lookup' ? null : 'active',
    capacityHealthStatus: role === 'lookup' ? null : 'healthy',
    lookupStatus: role === 'lookup' ? 'ready' : null,
    allocationScope: tenantResource ? 'tenant_exclusive' : null,
    ownerTenantId: tenantResource ? tenantId : null,
    assignmentCount: tenantResource ? 1 : 0,
    assignmentTenantId: tenantResource ? tenantId : null,
    assignmentState: tenantResource ? 'active' : null,
    placementIsolationPolicy: tenantResource ? 'tenant_exclusive' : null,
    placementPolicyState: tenantResource ? 'active' : null,
  };
}

function useSharedPool(entry: BootstrapResource): void {
  if (entry.role === 'lookup') throw new Error('bootstrap_test_tenant_resource_required');
  entry.desiredSpecJson = JSON.stringify({
    ...JSON.parse(entry.desiredSpecJson),
    allocation_scope: 'shared_pool',
    owner_tenant_id: undefined,
  });
  entry.desiredResourceScope = 'platform';
  entry.desiredTenantId = null;
  entry.allocationScope = 'shared_pool';
  entry.ownerTenantId = null;
  entry.placementIsolationPolicy = 'shared_pool';
}

async function fixture() {
  const resources = roles.map((role, index) => resource(role, index + 1));
  const settings: CloudflareWorkerSettings = {
    compatibility_date: '2026-07-30',
    bindings: resources.map((entry) => ({
      name: entry.bindingRef,
      type: 'd1',
      database_id: entry.providerDatabaseId,
    })),
  };
  const settingsDigest = await digestCloudflareWorkerSettings(settings);
  const workers: BootstrapWorkerEvidence[] = [
    {
      workerScriptName: 'test-ar-control',
      expectedDeploymentId: 'deployment-control',
      expectedVersionId: 'version-control',
      expectedSettingsDigest: settingsDigest,
      requiredDataRoles: [],
    },
    {
      workerScriptName: 'test-ar-management',
      expectedDeploymentId: 'deployment-management',
      expectedVersionId: 'version-management',
      expectedSettingsDigest: settingsDigest,
      requiredDataRoles: [...roles],
    },
  ];
  const handoff: BootstrapHandoff = {
    environmentId: 'test',
    environmentName: 'test',
    ownershipFingerprint: await calculateControlBootstrapOwnershipFingerprint(resources),
    releaseManifestDigest: manifestDigest,
    observedDeploymentId: 'deployment-control',
    observedVersionId: 'version-control',
  };
  const accepted = vi.fn<BootstrapHandoffRepository['accept']>();
  const blocked = vi.fn<BootstrapHandoffRepository['block']>();
  const repository: BootstrapHandoffRepository = {
    listPending: vi.fn(async () => [handoff]),
    listResources: vi.fn(async () => resources),
    listWorkers: vi.fn(async () => workers),
    listPinnedReleaseStreams: vi.fn(async () => [
      { streamId: 'd1-core', releaseId: 'release-v1', manifestDigest, state: 'active' as const },
      { streamId: 'd1-pii', releaseId: 'release-v1', manifestDigest, state: 'active' as const },
      { streamId: 'd1-lookup', releaseId: 'release-v1', manifestDigest, state: 'active' as const },
    ]),
    accept: accepted,
    block: blocked,
  };
  const byDatabaseId = new Map(resources.map((entry) => [entry.providerDatabaseId, entry]));
  const resourceByDatabaseId = (databaseId: string): BootstrapResource => {
    const entry = byDatabaseId.get(databaseId);
    if (!entry) throw new Error('bootstrap_test_resource_missing');
    return entry;
  };
  const api: BootstrapHandoffApi = {
    getD1Database: vi.fn(
      async (databaseId: string): Promise<CloudflareD1Database> => ({
        uuid: databaseId,
        name: resourceByDatabaseId(databaseId).providerName,
      })
    ),
    queryD1Batch: vi.fn(async (databaseId: string): Promise<CloudflareD1QueryResult[]> => {
      const entry = resourceByDatabaseId(databaseId);
      const history = {
        success: true,
        results: [{ filename: migrationFile.path, checksum: migrationFile.checksum }],
      };
      if (entry.role === 'lookup') return [history];
      return [
        history,
        {
          success: true,
          results: [
            {
              binding_ref: entry.bindingRef,
              data_role: entry.role,
              residency_partition: 'default',
              migration_generation: 1,
              release_id: 'release-v1',
              manifest_digest: manifestDigest,
              expected_file_count: 1,
              last_filename: migrationFile.path,
            },
          ],
        },
      ];
    }),
    getWorkerSettings: vi.fn(
      async (_scriptName: string): Promise<CloudflareWorkerSettings> => settings
    ),
    listWorkerDeployments: vi.fn(
      async (scriptName: string): Promise<CloudflareWorkerDeployment[]> => [
        {
          id: scriptName.endsWith('control') ? 'deployment-control' : 'deployment-management',
          created_on: '2026-07-30T00:00:00.000Z',
          source: 'api',
          strategy: 'percentage',
          versions: [
            {
              percentage: 100,
              version_id: scriptName.endsWith('control') ? 'version-control' : 'version-management',
            },
          ],
        },
      ]
    ),
  };
  return { resources, workers, handoff, repository, accepted, blocked, api, settings };
}

describe('BootstrapHandoffVerifier', () => {
  it('accepts only after all resources, migrations, bindings, settings, and deployments match', async () => {
    const state = await fixture();
    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 1, blocked: 0, retrying: 0 });
    expect(state.accepted).toHaveBeenCalledOnce();
    const observations = state.accepted.mock.calls[0]?.[1];
    expect(observations?.map((entry) => entry.workerScriptName)).toEqual([
      'test-ar-control',
      'test-ar-management',
    ]);
    for (const observation of observations ?? []) {
      expect(observation.settingsDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(state.blocked).not.toHaveBeenCalled();
  });

  it('accepts platform-owned shared-pool shards with one active tenant assignment', async () => {
    const state = await fixture();
    for (const entry of state.resources) {
      if (entry.role !== 'lookup') useSharedPool(entry);
    }

    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 1, blocked: 0, retrying: 0 });
    expect(state.accepted).toHaveBeenCalledOnce();
    expect(state.blocked).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a shared-pool owner',
      mutate: (entry: BootstrapResource) => {
        entry.ownerTenantId = tenantId;
      },
      error: 'control_bootstrap_resource_scope_mismatch',
    },
    {
      name: 'a tenant-scoped shared-pool desired resource',
      mutate: (entry: BootstrapResource) => {
        entry.desiredResourceScope = 'tenant';
        entry.desiredTenantId = tenantId;
      },
      error: 'control_bootstrap_desired_spec_invalid',
    },
    {
      name: 'a mismatched shared-pool placement policy',
      mutate: (entry: BootstrapResource) => {
        entry.placementIsolationPolicy = 'tenant_exclusive';
      },
      error: 'control_bootstrap_resource_scope_mismatch',
    },
  ])('blocks shared-pool bootstrap with $name', async ({ mutate, error }) => {
    const state = await fixture();
    for (const entry of state.resources) {
      if (entry.role !== 'lookup') useSharedPool(entry);
    }
    const entry = state.resources.find((candidate) => candidate.role === 'tenant_core/default');
    if (!entry) throw new Error('bootstrap_test_default_resource_missing');
    mutate(entry);

    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 1, retrying: 0 });
    expect(state.blocked).toHaveBeenCalledWith(state.handoff, error, 1_800_000_000);
    expect(state.api.getD1Database).not.toHaveBeenCalledWith(entry.providerDatabaseId);
  });

  it('blocks instead of adopting a wrong D1 binding', async () => {
    const state = await fixture();
    const wrongSettings = {
      ...state.settings,
      bindings: state.settings.bindings?.map((binding) =>
        binding.name === 'LOOKUP_DB'
          ? { ...binding, database_id: '00000000-0000-4000-8000-wrongdatabase' }
          : binding
      ),
    };
    const managementWorker = state.workers.at(1);
    if (!managementWorker) throw new Error('bootstrap_test_management_worker_missing');
    managementWorker.expectedSettingsDigest = await digestCloudflareWorkerSettings(wrongSettings);
    state.api.getWorkerSettings = vi.fn(
      async (scriptName: string): Promise<CloudflareWorkerSettings> =>
        scriptName.endsWith('management') ? wrongSettings : state.settings
    );

    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();
    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 1, retrying: 0 });
    expect(state.blocked).toHaveBeenCalledWith(
      state.handoff,
      'control_bootstrap_worker_binding_mismatch',
      1_800_000_000
    );
  });

  it('blocks stale deployments and ownership tampering before activation', async () => {
    const stale = await fixture();
    stale.api.listWorkerDeployments = vi.fn(async () => [
      {
        id: 'other-deployment',
        created_on: '2026-07-30T00:00:00.000Z',
        source: 'api',
        strategy: 'percentage' as const,
        versions: [{ percentage: 100, version_id: 'other-version' }],
      },
    ]);
    await new BootstrapHandoffVerifier(stale.repository, stale.api, () => 10).reconcile();
    expect(stale.blocked).toHaveBeenCalledWith(
      stale.handoff,
      'control_bootstrap_worker_deployment_mismatch',
      10
    );

    const tampered = await fixture();
    tampered.handoff.ownershipFingerprint = 'f'.repeat(64);
    await new BootstrapHandoffVerifier(tampered.repository, tampered.api, () => 11).reconcile();
    expect(tampered.blocked).toHaveBeenCalledWith(
      tampered.handoff,
      'control_bootstrap_ownership_fingerprint_mismatch',
      11
    );
    expect(tampered.api.getD1Database).not.toHaveBeenCalled();
  });

  it('keeps the handoff pending when Cloudflare asks the reconciler to retry', async () => {
    const state = await fixture();
    state.api.getD1Database = vi.fn(async () => {
      throw new CloudflareControlApiError('d1.get', 429);
    });
    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();
    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 0, retrying: 1 });
    expect(state.accepted).not.toHaveBeenCalled();
    expect(state.blocked).not.toHaveBeenCalled();
  });

  it('keeps the handoff pending while a newly registered provider token stabilizes', async () => {
    const state = await fixture();
    state.api.getD1Database = vi.fn(async () => {
      throw new CloudflareControlApiError('d1.get', 403);
    });
    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 0, retrying: 1 });
    expect(state.accepted).not.toHaveBeenCalled();
    expect(state.blocked).not.toHaveBeenCalled();
  });

  it('keeps the handoff pending while initial shard binding activation is still running', async () => {
    const state = await fixture();
    const pending = state.resources.find((entry) => entry.role === 'tenant_core/default');
    if (!pending) throw new Error('bootstrap_test_default_resource_missing');
    pending.shardStatus = 'ready';
    pending.capacityHealthStatus = null;

    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 0, retrying: 1 });
    expect(state.accepted).not.toHaveBeenCalled();
    expect(state.blocked).not.toHaveBeenCalled();
    expect(state.api.getWorkerSettings).not.toHaveBeenCalled();
  });

  it('blocks a failed initial shard instead of treating it as ordinary activation delay', async () => {
    const state = await fixture();
    const failed = state.resources.find((entry) => entry.role === 'tenant_core/default');
    if (!failed) throw new Error('bootstrap_test_default_resource_missing');
    failed.shardStatus = 'failed';
    failed.capacityHealthStatus = null;

    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 1, retrying: 0 });
    expect(state.blocked).toHaveBeenCalledWith(
      state.handoff,
      'control_bootstrap_resource_state_mismatch',
      1_800_000_000
    );
  });

  it.each([
    {
      name: 'shared allocation scope',
      mutate: (entry: BootstrapResource) => {
        entry.allocationScope = 'shared_pool';
      },
    },
    {
      name: 'wrong exclusive owner',
      mutate: (entry: BootstrapResource) => {
        entry.ownerTenantId = 'other-tenant';
      },
    },
    {
      name: 'missing active placement policy',
      mutate: (entry: BootstrapResource) => {
        entry.placementPolicyState = null;
      },
    },
    {
      name: 'cross-tenant assignment',
      mutate: (entry: BootstrapResource) => {
        entry.assignmentTenantId = 'other-tenant';
      },
    },
    {
      name: 'multiple shard assignments',
      mutate: (entry: BootstrapResource) => {
        entry.assignmentCount = 2;
      },
    },
  ])('blocks $name before accepting the initial exclusive tenant', async ({ mutate }) => {
    const state = await fixture();
    const entry = state.resources.find((resource) => resource.role === 'tenant_core/default');
    if (!entry) throw new Error('bootstrap_test_default_resource_missing');
    mutate(entry);

    const result = await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 1, accepted: 0, blocked: 1, retrying: 0 });
    expect(state.blocked).toHaveBeenCalledWith(
      state.handoff,
      'control_bootstrap_resource_scope_mismatch',
      1_800_000_000
    );
    expect(state.api.getD1Database).not.toHaveBeenCalledWith(entry.providerDatabaseId);
  });

  it('blocks tenant ownership tampering inside the immutable desired spec', async () => {
    const state = await fixture();
    const entry = state.resources.find((resource) => resource.role === 'tenant_core/default');
    if (!entry) throw new Error('bootstrap_test_default_resource_missing');
    entry.desiredSpecJson = JSON.stringify({
      ...JSON.parse(entry.desiredSpecJson),
      owner_tenant_id: 'other-tenant',
    });

    await new BootstrapHandoffVerifier(
      state.repository,
      state.api,
      () => 1_800_000_000
    ).reconcile();

    expect(state.blocked).toHaveBeenCalledWith(
      state.handoff,
      'control_bootstrap_desired_spec_invalid',
      1_800_000_000
    );
    expect(state.api.getD1Database).not.toHaveBeenCalledWith(entry.providerDatabaseId);
  });
});
