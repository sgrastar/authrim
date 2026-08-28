import {
  CloudflareControlApiError,
  type CloudflareControlApiClient,
  type ControlCapacityPlannerInput,
  type ControlTenantDeletionFinalization,
  type ControlTenantDeletionLookupShardTarget,
  type ControlTenantDeletionShardTarget,
  type ControlTenantPlacementPolicy,
  type ControlTenantShardCapacityTarget,
} from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type {
  ControlRepository,
  EnvironmentRow,
  ProvisioningAuthorityRow,
  ProvisioningLease,
  ResidencyPartitionRow,
  ResourcePolicyRow,
  TenantActiveResidencyRow,
} from '../repository';
import { ControlService, writeMigrationMetadata } from '../service';
import type {
  ControlEnv,
  ControlOperationView,
  ControlRpcProps,
  LowWatermarkRequest,
  PendingMigrationPlan,
  TenantShardPlan,
} from '../types';

const NOW = 1_800_000_000;

function operation(plan: TenantShardPlan): ControlOperationView {
  return {
    operationId: plan.operationId,
    environmentId: plan.environmentId,
    operationKind: 'provision_shard',
    status: 'queued',
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class FakeRepository implements ControlRepository {
  environment: EnvironmentRow | null = {
    environment_id: 'env-test',
    environment_name: 'test',
    lifecycle_state: 'active',
  };
  partition: ResidencyPartitionRow | null = {
    residency_policy_id: 'residency-default',
    residency_partition: 'jp',
    lookup_capacity_domain_id: 'lookup:residency-default:jp',
    jurisdiction: null,
    location_hint: 'apac',
  };
  policy: ResourcePolicyRow | null = {
    max_concurrent_provisioning: 2,
    max_ready_spares: 2,
    max_d1_resources: 1000,
    daily_d1_create_budget: 20,
    target_account_count: 100000,
  };
  replicationPolicy: {
    desired_mode: 'enabled' | 'disabled';
    consistency_policy_version: number;
  } | null = null;
  plans = new Map<string, TenantShardPlan>();
  operations = new Map<string, ControlOperationView>();
  pending: TenantShardPlan[] = [];
  lowWatermark: LowWatermarkRequest[] = [];
  capacityPlannerInput: Omit<ControlCapacityPlannerInput, 'profile'> = {
    scope: 'shared_pool',
    tenantId: null,
    currentEnvironmentD1Count: 0,
    environmentD1Limit: 1000,
    targets: [],
  };
  pendingMigrations: PendingMigrationPlan[] = [];
  allowLease = true;
  allowBudget = true;
  budgetReservations = 0;
  eligibleShard: ControlTenantShardCapacityTarget | null = null;
  runtimeRouteTargets: ControlTenantShardCapacityTarget[] = [];
  activeResidencies: TenantActiveResidencyRow[] = [];
  deletionLookupShards: ControlTenantDeletionLookupShardTarget[] = [];
  deletionTenantShards: ControlTenantDeletionShardTarget[] = [];
  deletionFinalization: ControlTenantDeletionFinalization | null = null;
  deletionFinalizationCalls = 0;
  assignableShard: Omit<ControlTenantShardCapacityTarget, 'assignmentGeneration'> | null = null;
  hasAssignment = false;
  capacityOperation: ControlOperationView | null = null;
  activeTenantShardSupplyCount = 0;
  tenantPlacementPolicy: ControlTenantPlacementPolicy | null = {
    tenantId: 'tenant-test',
    isolationPolicy: 'shared_pool',
    policyGeneration: 1,
    state: 'active',
    pendingIsolationPolicy: null,
    pendingPolicyGeneration: null,
    migrationOperationId: null,
    sourceOperationId: 'tenant-create-test',
    createdAt: NOW,
    updatedAt: NOW,
  };
  provisioningAuthority: ProvisioningAuthorityRow = {
    automaticProvisioningEnabled: true,
    tokenOwnership: 'account',
    capabilityState: 'ready',
  };

  async getEnvironment(): Promise<EnvironmentRow | null> {
    return this.environment;
  }

  async getProvisioningAuthority(): Promise<ProvisioningAuthorityRow> {
    return this.provisioningAuthority;
  }

  async markOperationAwaitingOperator(operationId: string): Promise<ControlOperationView> {
    const current = this.operations.get(operationId);
    if (!current) throw new Error('missing_fake_operation');
    const blocked = {
      ...current,
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
    };
    this.operations.set(operationId, blocked);
    return blocked;
  }

  async getResidencyPartition(): Promise<ResidencyPartitionRow | null> {
    return this.partition;
  }

  async listTenantActiveResidencies(): Promise<TenantActiveResidencyRow[]> {
    return this.activeResidencies;
  }

  async getResourcePolicy(): Promise<ResourcePolicyRow | null> {
    return this.policy;
  }

  async getTenantPlacementPolicy(): Promise<ControlTenantPlacementPolicy | null> {
    return this.tenantPlacementPolicy;
  }

  async registerTenantPlacementPolicy(
    input: {
      tenantId: string;
      isolationPolicy: 'shared_pool' | 'tenant_exclusive';
      sourceOperationId: string;
    },
    now: number
  ): Promise<ControlTenantPlacementPolicy> {
    this.tenantPlacementPolicy = {
      tenantId: input.tenantId,
      isolationPolicy: input.isolationPolicy,
      policyGeneration: 1,
      state: 'provisioning',
      pendingIsolationPolicy: null,
      pendingPolicyGeneration: null,
      migrationOperationId: null,
      sourceOperationId: input.sourceOperationId,
      createdAt: now,
      updatedAt: now,
    };
    return this.tenantPlacementPolicy;
  }

  async activateTenantPlacementPolicy(): Promise<ControlTenantPlacementPolicy> {
    if (!this.tenantPlacementPolicy) throw new Error('control_tenant_placement_policy_missing');
    this.tenantPlacementPolicy = {
      ...this.tenantPlacementPolicy,
      state: 'active',
      updatedAt: NOW,
    };
    return this.tenantPlacementPolicy;
  }

  async getReadReplicationPolicy() {
    return this.replicationPolicy;
  }

  async getActiveDesiredWorker() {
    return null;
  }

  async createShardPlan(plan: TenantShardPlan): Promise<ControlOperationView> {
    const existing = this.operations.get(plan.operationId);
    if (existing) return existing;
    this.plans.set(plan.operationId, plan);
    const created = operation(plan);
    this.operations.set(plan.operationId, created);
    return created;
  }

  async retryProvisioningOperationStep(): Promise<never> {
    throw new Error('not_implemented');
  }

  async cancelProvisioningOperation(): Promise<never> {
    throw new Error('not_implemented');
  }

  async restoreProvisioningOperationPreviousSettings(): Promise<never> {
    throw new Error('not_implemented');
  }

  async getOperation(
    operationId: string,
    environmentId?: string
  ): Promise<ControlOperationView | null> {
    const result = this.operations.get(operationId) ?? null;
    return result && (!environmentId || result.environmentId === environmentId) ? result : null;
  }

  async findEligibleTenantShard(): Promise<ControlTenantShardCapacityTarget | null> {
    return this.eligibleShard;
  }

  async listActiveTenantShardTargets(): Promise<ControlTenantShardCapacityTarget[]> {
    return this.runtimeRouteTargets;
  }

  async listTenantDeletionLookupShards(): Promise<ControlTenantDeletionLookupShardTarget[]> {
    return this.deletionLookupShards;
  }

  async listTenantDeletionShards(): Promise<ControlTenantDeletionShardTarget[]> {
    return this.deletionTenantShards;
  }

  async getTenantDeletionFinalization(): Promise<ControlTenantDeletionFinalization | null> {
    return this.deletionFinalization;
  }

  async finalizeTenantDeletionControlState(
    input: { environmentId: string; tenantId: string; operationId: string },
    now: number
  ): Promise<ControlTenantDeletionFinalization> {
    this.deletionFinalizationCalls += 1;
    this.deletionFinalization = {
      ...input,
      state: 'finalized',
      finalizedAt: now,
    };
    return this.deletionFinalization;
  }

  async findAssignableTenantShard() {
    return this.assignableShard;
  }

  async assignTenantShard(): Promise<ControlTenantShardCapacityTarget> {
    if (!this.assignableShard) throw new Error('control_tenant_shard_assignment_failed');
    this.hasAssignment = true;
    this.eligibleShard = { ...this.assignableShard, assignmentGeneration: 1 };
    return this.eligibleShard;
  }

  async hasTenantShardAssignment(): Promise<boolean> {
    return this.hasAssignment;
  }

  async findCapacityProvisioningOperation(): Promise<ControlOperationView | null> {
    return this.capacityOperation;
  }

  async getActiveTenantShardSupplyCount(): Promise<number> {
    return this.activeTenantShardSupplyCount;
  }

  async listPendingShardPlans(): Promise<TenantShardPlan[]> {
    return this.pending;
  }

  async listPendingMigrationPlans(): Promise<PendingMigrationPlan[]> {
    return this.pendingMigrations;
  }

  async listLowWatermarkRequests(
    _limit?: number,
    environmentId?: string
  ): Promise<LowWatermarkRequest[]> {
    return this.lowWatermark.filter(
      (request) => environmentId === undefined || request.environmentId === environmentId
    );
  }

  async getCapacityPlannerInput(): Promise<Omit<ControlCapacityPlannerInput, 'profile'>> {
    return this.capacityPlannerInput;
  }

  async tryStartProvisioning(
    operationId: string,
    ownerId: string
  ): Promise<ProvisioningLease | null> {
    if (!this.allowLease) return null;
    const current = this.operations.get(operationId);
    if (!current) return null;
    const running = { ...current, status: 'running', attemptCount: current.attemptCount + 1 };
    this.operations.set(operationId, running);
    return { operation: running, ownerId, fencingToken: running.attemptCount };
  }

  async reserveD1CreateBudget(): Promise<boolean> {
    this.budgetReservations += 1;
    return this.allowBudget;
  }

  async markDatabaseCreated(
    _lease: ProvisioningLease,
    plan: TenantShardPlan
  ): Promise<ControlOperationView> {
    const current = this.operations.get(plan.operationId);
    if (!current) throw new Error('missing_fake_operation');
    const waiting = { ...current, status: 'waiting_retry', lastErrorCode: null };
    this.operations.set(plan.operationId, waiting);
    return waiting;
  }

  async tryStartMigration(operationId: string, ownerId: string): Promise<ProvisioningLease | null> {
    return this.tryStartProvisioning(operationId, ownerId);
  }

  async markMigrationReady(
    lease: ProvisioningLease,
    plan: PendingMigrationPlan
  ): Promise<ControlOperationView> {
    const current = this.operations.get(plan.operationId);
    if (!current) throw new Error('missing_fake_operation');
    const succeeded = { ...current, status: 'succeeded', lastErrorCode: null };
    this.operations.set(lease.operation.operationId, succeeded);
    return succeeded;
  }

  async markMigrationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number
  ): Promise<void> {
    return this.markOperationRetry(lease, errorCode, nextAttemptAt);
  }

  async markMigrationBlocked(lease: ProvisioningLease, errorCode: string): Promise<void> {
    return this.markOperationBlocked(lease, errorCode);
  }

  async markOperationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number
  ): Promise<void> {
    const current = this.operations.get(lease.operation.operationId);
    if (!current) return;
    this.operations.set(lease.operation.operationId, {
      ...current,
      status: 'waiting_retry',
      lastErrorCode: errorCode,
      nextAttemptAt,
    });
  }

  async markOperationDeferredIfRunnable(
    operationId: string,
    errorCode: string,
    nextAttemptAt: number
  ): Promise<void> {
    const current = this.operations.get(operationId);
    if (!current || current.status === 'running') return;
    this.operations.set(operationId, {
      ...current,
      status: 'waiting_retry',
      lastErrorCode: errorCode,
      nextAttemptAt,
    });
  }

  async markOperationBlocked(lease: ProvisioningLease, errorCode: string): Promise<void> {
    const current = this.operations.get(lease.operation.operationId);
    if (!current) return;
    this.operations.set(lease.operation.operationId, {
      ...current,
      status: 'blocked',
      lastErrorCode: errorCode,
      nextAttemptAt: null,
    });
    if (errorCode === 'cloudflare_d1_capability_rejected') {
      this.provisioningAuthority = {
        ...this.provisioningAuthority,
        capabilityState: 'blocked',
      };
    }
  }
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('required_test_value_missing');
  return value;
}

function env(): ControlEnv {
  return {
    CONTROL_DB: {} as D1Database,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
  };
}

function worker(props?: Partial<ControlRpcProps>): ControlWorker {
  return new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        environmentId: 'env-test',
        audience: 'authrim-control-v1',
        ...props,
      },
    } as ConstructorParameters<typeof ControlWorker>[0],
    env()
  );
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: 'env-test',
    tenantId: 'tenant-test',
    dataRole: 'tenant_core/users',
    residencyPolicyId: 'residency-default',
    residencyPartition: 'jp',
    idempotencyKey: 'tenant-capacity-1',
    ...overrides,
  };
}

function capacityRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const input = request(overrides);
  Reflect.deleteProperty(input, 'environmentId');
  return input;
}

function controlApi(
  input: Pick<CloudflareControlApiClient, 'listD1Databases' | 'createD1Database'>
): Pick<
  CloudflareControlApiClient,
  'listD1Databases' | 'getD1Database' | 'createD1Database' | 'updateD1Database'
> {
  const modes = new Map<string, 'auto' | 'disabled'>();
  return {
    listD1Databases: async () => {
      const databases = await input.listD1Databases();
      for (const database of databases) {
        if (database.uuid && database.read_replication?.mode) {
          modes.set(database.uuid, database.read_replication.mode);
        }
      }
      return databases;
    },
    createD1Database: async (request) => {
      const database = await input.createD1Database(request);
      if (database.uuid && database.read_replication?.mode) {
        modes.set(database.uuid, database.read_replication.mode);
      }
      return database;
    },
    getD1Database: vi.fn(async (databaseId: string) => ({
      uuid: databaseId,
      name: 'database',
      read_replication: { mode: modes.get(databaseId) ?? 'disabled' },
    })),
    updateD1Database: vi.fn(
      async (databaseId: string, update: { read_replication: { mode: 'auto' | 'disabled' } }) => {
        modes.set(databaseId, update.read_replication.mode);
        return {
          uuid: databaseId,
          name: 'database',
          read_replication: update.read_replication,
        };
      }
    ),
  };
}

describe('Control Worker boundary', () => {
  it('keeps the default HTTP surface closed', async () => {
    const response = await worker().fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects unauthenticated bootstrap acceleration before touching storage', async () => {
    const response = await worker().fetch(
      new Request('https://control.internal/api/internal/control/bootstrap/advance', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('masks storage implementation errors at the RPC boundary', async () => {
    await expect(
      worker().previewCapacityProvisioning({
        profile: 'recommended',
        scope: 'shared_pool',
        tenantId: null,
      })
    ).rejects.toThrow('control_internal_error');
    await expect(worker().getOperationStatus('operation-id')).rejects.toThrow(
      'control_internal_error'
    );
    await expect(worker().getProvisioningOperation('operation-id')).rejects.toThrow(
      'control_internal_error'
    );
  });

  it('rejects malformed provisioning operation identifiers before reading storage', async () => {
    await expect(worker().getProvisioningOperation('../operation')).rejects.toThrow(
      'invalid_operation_id'
    );
    await expect(
      worker().retryProvisioningOperationStep({
        operationId: 'operation-id',
        stepKey: 'smoke_bindings',
        requestedById: 'admin-1',
        reasonCode: 'operator_retry',
        idempotencyKey: 'retry-1',
      })
    ).rejects.toThrow('invalid_operation_retry_request');
    await expect(
      worker().restoreProvisioningOperationPreviousSettings({
        operationId: 'operation-id',
        requestedById: 'admin-1',
        reasonCode: 'operator_retry',
        idempotencyKey: 'restore-1',
      })
    ).rejects.toThrow('invalid_operation_restore_request');
  });

  it('rejects missing caller identity and cross-environment inputs before persistence', async () => {
    const missingCaller = new ControlWorker(
      { props: {} } as ConstructorParameters<typeof ControlWorker>[0],
      env()
    );
    await expect(
      missingCaller.previewCapacityProvisioning({
        profile: 'recommended',
        scope: 'shared_pool',
        tenantId: null,
      })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(missingCaller.getRuntimeRegistrySignerMetadata()).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    await expect(
      missingCaller.signRuntimeRegistryPayload({ payload: new Uint8Array([1]) })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(
      worker({ environmentId: '../invalid' }).previewCapacityProvisioning({
        profile: 'recommended',
        scope: 'shared_pool',
        tenantId: null,
      })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(
      worker().acknowledgeWorkerInventoryDriftNotifications([
        'drift:env-test:actual_only:test-unmanaged',
        'drift:env-test:actual_only:test-unmanaged',
      ])
    ).rejects.toThrow('invalid_worker_inventory_drift_finding_ids');
    await expect(
      worker().reviewWorkerInventoryDriftFinding({
        findingId: 'drift:env-other:actual_only:test-unmanaged',
        disposition: 'reviewed',
        reviewedBy: 'admin-1',
        idempotencyKey: 'review-request-1',
      })
    ).rejects.toThrow('invalid_worker_inventory_drift_review');
    await expect(
      worker().reviewWorkerInventoryDriftFinding({
        findingId: 'drift:env-test:actual_only:test-unmanaged',
        disposition: 'delete',
        reviewedBy: 'admin-1',
        idempotencyKey: 'review-request-1',
      })
    ).rejects.toThrow('invalid_worker_inventory_drift_review');
    await expect(
      worker().planNextLookupBucketMigration({
        ownerId: 'management-planner',
        observedAt: NOW,
        buckets: [
          {
            virtualBucket: 7,
            lookupShardId: 'lookup-a',
            assignmentGeneration: 1,
            activeIdentifierCount: 10,
            activeAliasCount: 0,
            counterUpdatedAt: NOW,
            rawIdentifier: 'must-not-cross-the-boundary',
          },
        ],
      })
    ).rejects.toThrow('invalid_lookup_bucket_load_observation');
  });
});

describe('ControlService tenant shard provisioning', () => {
  it('returns a deterministic dry-run plan without writes or provider calls', async () => {
    const repository = new FakeRepository();
    const listD1Databases = vi.fn();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases, createD1Database: vi.fn() }),
    });

    const first = await service.requestTenantShard(
      request({ dryRun: true, jurisdiction: 'fedramp', locationHint: 'wnam' })
    );
    const second = await service.requestTenantShard(request({ dryRun: true }));

    expect(first.plan).toEqual(second.plan);
    expect(first.plan.locationHint).toBe('apac');
    expect(first.plan.jurisdiction).toBeUndefined();
    expect(repository.operations).toHaveLength(0);
    expect(listD1Databases).not.toHaveBeenCalled();
  });

  it('hands the canonical operation to setup without calling Cloudflare when Automatic provisioning is off', async () => {
    const repository = new FakeRepository();
    repository.provisioningAuthority = {
      automaticProvisioningEnabled: false,
      tokenOwnership: 'none',
      capabilityState: 'disabled',
    };
    const listD1Databases = vi.fn();
    const controlEnv = env();
    controlEnv.AUTHRIM_AUTOMATIC_PROVISIONING = 'false';
    delete controlEnv.CLOUDFLARE_D1_API_TOKEN;
    delete controlEnv.CLOUDFLARE_WORKERS_API_TOKEN;
    const service = new ControlService({
      repository,
      env: controlEnv,
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases, createD1Database: vi.fn() }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation).toMatchObject({
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
    });
    expect(listD1Databases).not.toHaveBeenCalled();
  });

  it('reports only secret-free effective provisioning authority', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    await expect(service.getProvisioningAuthorityStatus('env-test')).resolves.toEqual({
      automaticProvisioningEnabled: true,
      tokenOwnership: 'account',
      capabilityState: 'ready',
      automaticExecutionAvailable: true,
      activeExecutor: 'control',
    });

    const controlEnv = env();
    delete controlEnv.CLOUDFLARE_WORKERS_API_TOKEN;
    const unavailable = new ControlService({ repository, env: controlEnv, now: () => NOW });
    await expect(unavailable.getProvisioningAuthorityStatus('env-test')).resolves.toEqual({
      automaticProvisioningEnabled: true,
      tokenOwnership: 'account',
      capabilityState: 'blocked',
      automaticExecutionAvailable: false,
      activeExecutor: 'setup_operator',
    });
  });

  it('previews canonical resources from the server-owned capacity plan', async () => {
    const repository = new FakeRepository();
    repository.capacityPlannerInput = {
      scope: 'shared_pool',
      tenantId: null,
      currentEnvironmentD1Count: 10,
      environmentD1Limit: 1000,
      targets: [
        {
          unitKey: 'residency-default:jp:tenant_core/users',
          priority: 20,
          readyUnits: 0,
          inFlightUnits: 0,
          minimumRequiredUnits: 1,
          recommendedTargetUnits: 1,
          hardMaximumUnits: 10,
          resources: [
            {
              resourceClass: 'd1',
              dataRole: 'tenant_core/users',
              residencyPolicyId: 'residency-default',
              residencyPartition: 'jp',
              workerScripts: ['test-ar-auth'],
              d1Count: 1,
            },
          ],
        },
      ],
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    const result = await service.previewCapacityProvisioning(
      { profile: 'recommended', scope: 'shared_pool', tenantId: null },
      'env-test'
    );

    expect(result).toMatchObject({
      dryRun: true,
      profile: 'recommended',
      scope: 'shared_pool',
      capacityUnitsAdded: 1,
      d1DatabasesAdded: 1,
      targets: [
        {
          environmentId: 'env-test',
          dataRole: 'tenant_core/users',
          residencyPartition: 'jp',
          workerScripts: ['test-ar-auth'],
        },
      ],
    });
    expect(result.targets[0]?.databaseName).toMatch(
      /^test-authrim-tenant-core-users-jp-db-[a-f0-9]{8}$/u
    );
    expect(result.targets[0]?.bindingRef).toMatch(/^TEST_TDB_USERS_[A-F0-9]{8}_CORE$/u);
    expect(repository.operations.size).toBe(0);
  });

  it('rejects a client-selected tenant for shared-pool capacity', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    await expect(
      service.previewCapacityProvisioning(
        { profile: 'minimum', scope: 'shared_pool', tenantId: 'tenant-test' },
        'env-test'
      )
    ).rejects.toThrow('control_capacity_profile_request_invalid');
  });

  it('creates the canonical profile operations and hands them to setup when automatic execution is off', async () => {
    const repository = new FakeRepository();
    repository.provisioningAuthority = {
      automaticProvisioningEnabled: false,
      tokenOwnership: 'none',
      capabilityState: 'disabled',
    };
    repository.capacityPlannerInput = {
      scope: 'shared_pool',
      tenantId: null,
      currentEnvironmentD1Count: 10,
      environmentD1Limit: 1000,
      targets: [
        {
          unitKey: 'residency-default:jp:tenant_core/users',
          priority: 20,
          readyUnits: 0,
          inFlightUnits: 0,
          minimumRequiredUnits: 1,
          recommendedTargetUnits: 1,
          hardMaximumUnits: 10,
          resources: [
            {
              resourceClass: 'd1',
              dataRole: 'tenant_core/users',
              residencyPolicyId: 'residency-default',
              residencyPartition: 'jp',
              workerScripts: ['test-ar-auth'],
              d1Count: 1,
            },
          ],
        },
      ],
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    const request = {
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
      requestedById: 'admin-1',
      idempotencyKey: 'capacity-request-1',
    } as const;

    const first = await service.requestCapacityProvisioning(request, 'env-test');
    const [plannedTarget] = repository.capacityPlannerInput.targets;
    if (!plannedTarget) throw new Error('expected_capacity_target');
    repository.capacityPlannerInput = {
      ...repository.capacityPlannerInput,
      targets: [{ ...plannedTarget, inFlightUnits: 1 }],
    };
    const second = await service.requestCapacityProvisioning(request, 'env-test');

    expect(first.preview.targets).toHaveLength(1);
    expect(first.operations).toEqual([
      expect.objectContaining({ status: 'blocked', lastErrorCode: 'operator_action_required' }),
    ]);
    expect(second.operations).toEqual([]);
    expect(repository.operations.size).toBe(1);
  });

  it('uses distinct deterministic operation identities for every capacity data role', async () => {
    const repository = new FakeRepository();
    repository.provisioningAuthority = {
      automaticProvisioningEnabled: false,
      tokenOwnership: 'none',
      capabilityState: 'disabled',
    };
    repository.capacityPlannerInput = {
      scope: 'shared_pool',
      tenantId: null,
      currentEnvironmentD1Count: 10,
      environmentD1Limit: 1000,
      targets: (['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'] as const).map(
        (dataRole, index) => ({
          unitKey: `builtin:residency:default:default:${dataRole}`,
          priority: 30 - index * 10,
          readyUnits: 0,
          inFlightUnits: 0,
          minimumRequiredUnits: 1,
          recommendedTargetUnits: 1,
          hardMaximumUnits: 10,
          resources: [
            {
              resourceClass: 'd1' as const,
              dataRole,
              residencyPolicyId: 'residency-default',
              residencyPartition: 'jp',
              workerScripts: ['test-ar-auth'],
              d1Count: 1,
            },
          ],
        })
      ),
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    const result = await service.requestCapacityProvisioning(
      {
        profile: 'recommended',
        scope: 'shared_pool',
        tenantId: null,
        requestedById: 'admin-1',
        idempotencyKey: 'capacity-request-multi-role',
      },
      'env-test'
    );

    expect(result.operations).toHaveLength(4);
    expect(new Set(result.operations.map((operation) => operation.operationId)).size).toBe(4);
    expect(new Set([...repository.plans.values()].map((plan) => plan.idempotencyKey)).size).toBe(4);
    expect([...repository.plans.values()].find((plan) => plan.dataRole === 'lookup')).toMatchObject(
      {
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        migrationStreamId: 'd1-lookup',
      }
    );
  });

  it('converges concurrent capacity requests on one deterministic operation', async () => {
    const repository = new FakeRepository();
    repository.provisioningAuthority = {
      automaticProvisioningEnabled: false,
      tokenOwnership: 'none',
      capabilityState: 'disabled',
    };
    repository.capacityPlannerInput = {
      scope: 'tenant_exclusive',
      tenantId: 'tenant-test',
      currentEnvironmentD1Count: 0,
      environmentD1Limit: 1000,
      targets: [
        {
          unitKey: 'residency-default:jp:tenant_core/default',
          priority: 30,
          readyUnits: 0,
          inFlightUnits: 0,
          minimumRequiredUnits: 1,
          recommendedTargetUnits: 1,
          hardMaximumUnits: 10,
          resources: [
            {
              resourceClass: 'd1',
              dataRole: 'tenant_core/default',
              residencyPolicyId: 'residency-default',
              residencyPartition: 'jp',
              workerScripts: ['test-ar-management'],
              d1Count: 1,
            },
          ],
        },
      ],
    };
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      isolationPolicy: 'tenant_exclusive',
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    const request = {
      profile: 'minimum',
      scope: 'tenant_exclusive',
      tenantId: 'tenant-test',
      requestedById: 'admin-1',
      idempotencyKey: 'capacity-request-concurrent',
    } as const;

    const [first, second] = await Promise.all([
      service.requestCapacityProvisioning(request, 'env-test'),
      service.requestCapacityProvisioning(request, 'env-test'),
    ]);

    expect(first.operations).toHaveLength(1);
    expect(second.operations).toHaveLength(1);
    expect(second.operations[0]?.operationId).toBe(first.operations[0]?.operationId);
    expect(repository.operations.size).toBe(1);
  });

  it('returns every server-owned runtime route target for a scaled-out tenant', async () => {
    const repository = new FakeRepository();
    repository.runtimeRouteTargets = (
      ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const
    ).map((dataRole, index) => ({
      shardId: `shard-${index}`,
      dataRole,
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      routeGeneration: 1,
      bindingRef: `TDB_ROUTE_${index}_CORE`,
      databaseId: `database-${index}`,
      databaseName: `database-name-${index}`,
      allocationScope: 'shared_pool' as const,
      ownerTenantId: null,
      assignmentGeneration: 1,
    }));
    repository.runtimeRouteTargets.push(
      {
        ...repository.runtimeRouteTargets[1]!,
        shardId: 'shard-users-2',
        bindingRef: 'TDB_ROUTE_USERS_2_CORE',
        databaseId: 'database-users-2',
        databaseName: 'database-name-users-2',
        assignmentGeneration: 2,
      },
      {
        ...repository.runtimeRouteTargets[2]!,
        shardId: 'shard-pii-2',
        bindingRef: 'TDB_ROUTE_PII_2_CORE',
        databaseId: 'database-pii-2',
        databaseName: 'database-name-pii-2',
        assignmentGeneration: 2,
      }
    );
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    await expect(
      service.getTenantRuntimeRouteTargets(
        {
          tenantId: 'tenant-test',
          residencyPolicyId: 'residency-default',
          residencyPartition: 'jp',
        },
        'env-test'
      )
    ).resolves.toEqual(repository.runtimeRouteTargets);
  });

  it('exposes provisioning assignments only through the provisioning route method', async () => {
    const repository = new FakeRepository();
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      state: 'provisioning',
    };
    repository.runtimeRouteTargets = (
      ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const
    ).map((dataRole, index) => ({
      shardId: `provisioning-shard-${index}`,
      dataRole,
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      routeGeneration: 1,
      bindingRef: `TDB_PROVISIONING_${index}`,
      databaseId: `provisioning-database-${index}`,
      databaseName: `provisioning-database-name-${index}`,
      allocationScope: 'shared_pool' as const,
      ownerTenantId: null,
      assignmentGeneration: 1,
    }));
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    const request = {
      tenantId: 'tenant-test',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
    };

    await expect(service.getTenantRuntimeRouteTargets(request, 'env-test')).rejects.toThrow(
      'control_tenant_shard_assignment_policy_missing'
    );
    await expect(service.getTenantProvisioningRouteTargets(request, 'env-test')).resolves.toEqual(
      repository.runtimeRouteTargets
    );
    await expect(
      service.getTenantProvisioningRegionShardPolicy(request, 'env-test')
    ).resolves.toEqual({
      tenantId: 'tenant-test',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      policyGeneration: 1,
      allowedRegions: ['apac'],
      jurisdiction: null,
      locationHint: 'apac',
    });
  });

  it('projects the active tenant residency into an allowed DO region policy', async () => {
    const repository = new FakeRepository();
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      isolationPolicy: 'tenant_exclusive',
    };
    repository.activeResidencies = [
      {
        residency_policy_id: 'residency-eu',
        residency_partition: 'eu-primary',
        jurisdiction: 'eu',
        location_hint: null,
        policy_generation: 4,
      },
    ];
    repository.runtimeRouteTargets = (
      ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const
    ).map((dataRole, index) => ({
      shardId: `shard-eu-${index}`,
      dataRole,
      residencyPolicyId: 'residency-eu',
      residencyPartition: 'eu-primary',
      routeGeneration: 1,
      bindingRef: `TDB_EU_${index}`,
      databaseId: `database-eu-${index}`,
      databaseName: `database-eu-name-${index}`,
      allocationScope: 'tenant_exclusive' as const,
      ownerTenantId: 'tenant-test',
      assignmentGeneration: 1,
    }));
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    await expect(
      service.getTenantRegionShardPolicy({ tenantId: 'tenant-test' }, 'env-test')
    ).resolves.toEqual({
      tenantId: 'tenant-test',
      residencyPolicyId: 'residency-eu',
      residencyPartition: 'eu-primary',
      policyGeneration: 4,
      allowedRegions: ['weur', 'eeur'],
      jurisdiction: 'eu',
      locationHint: null,
    });
  });

  it('fails closed when the tenant residency or its complete route set is missing', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    await expect(
      service.getTenantRegionShardPolicy({ tenantId: 'tenant-test' }, 'env-test')
    ).rejects.toThrow('control_tenant_region_shard_residency_missing');

    repository.activeResidencies = [
      {
        residency_policy_id: 'residency-default',
        residency_partition: 'jp',
        jurisdiction: null,
        location_hint: 'apac',
        policy_generation: 1,
      },
    ];
    await expect(
      service.getTenantRegionShardPolicy({ tenantId: 'tenant-test' }, 'env-test')
    ).rejects.toThrow('control_tenant_shard_assignment_incomplete');
  });

  it('fails closed for incomplete or wrong-owner runtime route targets', async () => {
    const repository = new FakeRepository();
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      isolationPolicy: 'tenant_exclusive',
    };
    repository.runtimeRouteTargets = [
      {
        shardId: 'shard-default',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'residency-default',
        residencyPartition: 'jp',
        routeGeneration: 1,
        bindingRef: 'TDB_DEFAULT_CORE',
        databaseId: 'database-default',
        databaseName: 'database-default',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'other-tenant',
        assignmentGeneration: 1,
      },
    ];
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    const request = {
      tenantId: 'tenant-test',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
    };

    await expect(service.getTenantRuntimeRouteTargets(request, 'env-test')).rejects.toThrow(
      'control_tenant_shard_assignment_incomplete'
    );

    repository.runtimeRouteTargets = (
      ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const
    ).map((dataRole, index) => ({
      shardId: `shard-${index}`,
      dataRole,
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      routeGeneration: 1,
      bindingRef: `TDB_ROUTE_${index}_CORE`,
      databaseId: `database-${index}`,
      databaseName: `database-name-${index}`,
      allocationScope: 'tenant_exclusive' as const,
      ownerTenantId: index === 2 ? 'other-tenant' : 'tenant-test',
      assignmentGeneration: 1,
    }));
    await expect(service.getTenantRuntimeRouteTargets(request, 'env-test')).rejects.toThrow(
      'control_tenant_shard_assignment_owner_mismatch'
    );

    repository.runtimeRouteTargets = repository.runtimeRouteTargets.map((target) => ({
      ...target,
      ownerTenantId: 'tenant-test',
    }));
    repository.runtimeRouteTargets.push({
      ...repository.runtimeRouteTargets[1]!,
      shardId: 'shard-users-duplicate-binding',
    });
    await expect(service.getTenantRuntimeRouteTargets(request, 'env-test')).rejects.toThrow(
      'control_tenant_shard_assignment_incomplete'
    );
  });

  it('returns assignment-owned deletion inventory without account allocation dependency', async () => {
    const repository = new FakeRepository();
    repository.deletionLookupShards = [
      { lookupShardId: 'lookup-1', bindingRef: 'LOOKUP_1', status: 'active' },
    ];
    repository.deletionTenantShards = (
      ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const
    ).map((dataRole, index) => ({
      shardId: `delete-shard-${index}`,
      dataRole,
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      bindingRef: `TDB_DELETE_${index}`,
      status: 'active' as const,
      allocationScope: 'shared_pool' as const,
      ownerTenantId: null,
    }));
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    await expect(
      service.getTenantDeletionInventory(
        { tenantId: 'tenant-test', operationId: 'delete-operation-1' },
        'env-test'
      )
    ).resolves.toEqual({
      environmentId: 'env-test',
      tenantId: 'tenant-test',
      operationId: 'delete-operation-1',
      state: 'ready',
      lookupShards: repository.deletionLookupShards,
      tenantShards: repository.deletionTenantShards,
    });
  });

  it('fails closed for incomplete or wrong-owner deletion inventory', async () => {
    const repository = new FakeRepository();
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      isolationPolicy: 'tenant_exclusive',
    };
    repository.deletionLookupShards = [
      { lookupShardId: 'lookup-1', bindingRef: 'LOOKUP_1', status: 'active' },
    ];
    repository.deletionTenantShards = [
      {
        shardId: 'delete-default',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'residency-default',
        residencyPartition: 'jp',
        bindingRef: 'TDB_DELETE_DEFAULT',
        status: 'active',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'other-tenant',
      },
    ];
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    await expect(
      service.getTenantDeletionInventory(
        { tenantId: 'tenant-test', operationId: 'delete-operation-2' },
        'env-test'
      )
    ).rejects.toThrow('control_tenant_deletion_inventory_invalid');
  });

  it('finalizes tenant Control state once and reconciles a response loss by operation id', async () => {
    const repository = new FakeRepository();
    repository.deletionLookupShards = [
      { lookupShardId: 'lookup-1', bindingRef: 'LOOKUP_1', status: 'active' },
    ];
    repository.deletionTenantShards = (
      ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const
    ).map((dataRole, index) => ({
      shardId: `delete-shard-${index}`,
      dataRole,
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      bindingRef: `TDB_DELETE_${index}`,
      status: 'active' as const,
      allocationScope: 'shared_pool' as const,
      ownerTenantId: null,
    }));
    const service = new ControlService({ repository, env: env(), now: () => NOW });
    const request = { tenantId: 'tenant-test', operationId: 'delete-operation-3' };

    const first = await service.finalizeTenantDeletionControlState(request, 'env-test');
    const second = await service.finalizeTenantDeletionControlState(request, 'env-test');

    expect(first).toEqual(second);
    expect(repository.deletionFinalizationCalls).toBe(1);
    await expect(service.getTenantDeletionInventory(request, 'env-test')).resolves.toEqual({
      environmentId: 'env-test',
      ...request,
      state: 'finalized',
      lookupShards: [],
      tenantShards: [],
    });
  });

  it('reuses healthy capacity without creating a Control operation', async () => {
    const repository = new FakeRepository();
    repository.eligibleShard = {
      shardId: 'shard-ready',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      routeGeneration: 2,
      bindingRef: 'TDB_USERS_READY_CORE',
      databaseId: 'database-ready',
      databaseName: 'authrim-test-users-jp-ready',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      assignmentGeneration: 1,
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    const result = await service.ensureTenantShardCapacity(capacityRequest(), 'env-test');

    expect(result).toEqual({ state: 'ready', target: repository.eligibleShard, operation: null });
    expect(repository.operations.size).toBe(0);
  });

  it('assigns an active shared spare when a tenant reaches the low watermark', async () => {
    const repository = new FakeRepository();
    repository.lowWatermark = [
      {
        environmentId: 'env-test',
        tenantId: 'tenant-test',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'residency-default',
        residencyPartition: 'jp',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        activeSupplyCount: 2,
      },
    ];
    repository.assignableShard = {
      shardId: 'shard-shared-spare',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      routeGeneration: 3,
      bindingRef: 'TDB_USERS_SHARED_SPARE',
      databaseId: 'database-shared-spare',
      databaseName: 'authrim-test-users-jp-shared-spare',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    await expect(service.replenishLowWatermark()).resolves.toEqual({ planned: 1, failed: 0 });
    expect(repository.hasAssignment).toBe(true);
    expect(repository.operations.size).toBe(0);
  });

  it('converges simultaneous shared-pool low-watermark requests on one operation', async () => {
    const repository = new FakeRepository();
    repository.lowWatermark = ['tenant-a', 'tenant-b'].map((tenantId) => ({
      environmentId: 'env-test',
      tenantId,
      dataRole: 'tenant_core/users' as const,
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      allocationScope: 'shared_pool' as const,
      ownerTenantId: null,
      activeSupplyCount: 2,
    }));
    const createD1Database = vi.fn(async ({ name }: { name: string }) => ({
      uuid: 'database-shared-new',
      name,
    }));
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => [],
          createD1Database,
        }),
    });

    await expect(service.replenishLowWatermark()).resolves.toEqual({ planned: 2, failed: 0 });
    expect(repository.operations.size).toBe(1);
    expect(createD1Database).toHaveBeenCalledOnce();
  });

  it('provisions exclusive low-watermark capacity with a generation-safe key', async () => {
    const repository = new FakeRepository();
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      tenantId: 'tenant-exclusive',
      isolationPolicy: 'tenant_exclusive',
    };
    repository.lowWatermark = [
      {
        environmentId: 'env-test',
        tenantId: 'tenant-exclusive',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'residency-default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-exclusive',
        activeSupplyCount: 4,
      },
    ];
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => [],
          createD1Database: async ({ name }) => ({ uuid: 'database-exclusive-new', name }),
        }),
    });

    await expect(service.replenishLowWatermark()).resolves.toEqual({ planned: 1, failed: 0 });
    const created = [...repository.plans.values()];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'tenant-exclusive',
    });
    expect(created[0]?.idempotencyKey).toMatch(
      /^low-water:tenant_exclusive:tenant-core-users:4:[a-f0-9]{24}$/u
    );
  });

  it('converges concurrent exclusive low-watermark reconciliations on the active generation', async () => {
    const repository = new FakeRepository();
    repository.tenantPlacementPolicy = {
      ...required(repository.tenantPlacementPolicy),
      tenantId: 'tenant-exclusive',
      isolationPolicy: 'tenant_exclusive',
    };
    repository.lowWatermark = [
      {
        environmentId: 'env-test',
        tenantId: 'tenant-exclusive',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'residency-default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-exclusive',
        activeSupplyCount: 3,
      },
    ];
    const createD1Database = vi.fn(async ({ name }: { name: string }) => ({
      uuid: 'database-exclusive-new',
      name,
    }));
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => [],
          createD1Database,
        }),
    });

    await expect(
      Promise.all([service.replenishLowWatermark(), service.replenishLowWatermark()])
    ).resolves.toEqual([
      { planned: 1, failed: 0 },
      { planned: 1, failed: 0 },
    ]);
    expect(repository.operations.size).toBe(1);
    expect(repository.plans.size).toBe(1);
    expect(createD1Database).toHaveBeenCalledOnce();
  });

  it('reuses an in-flight capacity operation instead of creating a duplicate shard', async () => {
    const repository = new FakeRepository();
    const plan = await new ControlService({
      repository,
      env: env(),
      now: () => NOW,
    }).requestTenantShard(request({ dryRun: true }));
    repository.capacityOperation = {
      ...operation(plan.plan),
      status: 'waiting_retry',
      attemptCount: 2,
      nextAttemptAt: NOW + 30,
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    const result = await service.ensureTenantShardCapacity(capacityRequest(), 'env-test');

    expect(result).toMatchObject({
      state: 'provisioning',
      target: null,
      operation: { operationId: repository.capacityOperation.operationId, attemptCount: 2 },
    });
    expect(repository.operations.size).toBe(0);
  });

  it('starts one capacity operation when no eligible or in-flight shard exists', async () => {
    const repository = new FakeRepository();
    const createD1Database = vi.fn(async ({ name }: { name: string }) => ({
      uuid: 'database-new',
      name,
    }));
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => [],
          createD1Database,
        }),
    });

    const result = await service.ensureTenantShardCapacity(capacityRequest(), 'env-test');

    expect(result).toMatchObject({
      state: 'provisioning',
      target: null,
      operation: { status: 'queued' },
    });
    expect(repository.operations.size).toBe(1);
    expect(createD1Database).not.toHaveBeenCalled();
  });

  it('converges simultaneous account-capacity requests with distinct caller keys', async () => {
    const repository = new FakeRepository();
    repository.activeTenantShardSupplyCount = 7;
    repository.provisioningAuthority = {
      automaticProvisioningEnabled: false,
      tokenOwnership: 'none',
      capabilityState: 'disabled',
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    const [first, second] = await Promise.all([
      service.ensureTenantShardCapacity(
        capacityRequest({ idempotencyKey: 'account-capacity:account-a:tenant-core-users' }),
        'env-test'
      ),
      service.ensureTenantShardCapacity(
        capacityRequest({ idempotencyKey: 'account-capacity:account-b:tenant-core-users' }),
        'env-test'
      ),
    ]);

    expect(first.operation?.operationId).toBe(second.operation?.operationId);
    expect(first.state).toBe('blocked');
    expect(second.state).toBe('blocked');
    expect(repository.operations.size).toBe(1);
    expect(repository.plans.size).toBe(1);
    expect([...repository.plans.values()][0]?.idempotencyKey).toMatch(
      /^low-water:shared_pool:tenant-core-users:7:[a-f0-9]{24}$/u
    );
  });

  it('keeps a blocked capacity operation terminal until an authorized retry', async () => {
    const repository = new FakeRepository();
    const plan = await new ControlService({
      repository,
      env: env(),
      now: () => NOW,
    }).requestTenantShard(request({ dryRun: true }));
    repository.capacityOperation = {
      ...operation(plan.plan),
      status: 'blocked',
      lastErrorCode: 'control_d1_resource_limit',
    };
    const service = new ControlService({ repository, env: env(), now: () => NOW });

    await expect(
      service.ensureTenantShardCapacity(capacityRequest(), 'env-test')
    ).resolves.toMatchObject({
      state: 'blocked',
      reasonCode: 'control_d1_resource_limit',
      operation: { operationId: repository.capacityOperation.operationId },
    });
    expect(repository.operations.size).toBe(0);
  });

  it('creates once and reuses the deterministic provider database on retry', async () => {
    const repository = new FakeRepository();
    let providerDatabase: { uuid: string; name: string } | undefined;
    const createD1Database = vi.fn(async ({ name }: { name: string }) => {
      providerDatabase = { uuid: 'database-1', name };
      return providerDatabase;
    });
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => (providerDatabase ? [providerDatabase] : []),
          createD1Database,
        }),
    });

    const first = await service.requestTenantShard(request());
    const second = await service.requestTenantShard(request());

    expect(first.operation?.status).toBe('waiting_retry');
    expect(second.operation?.status).toBe('waiting_retry');
    expect(createD1Database).toHaveBeenCalledTimes(1);
    expect(repository.budgetReservations).toBe(1);
  });

  it('defers before create when the daily D1 budget is exhausted', async () => {
    const repository = new FakeRepository();
    repository.allowBudget = false;
    const createD1Database = vi.fn();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases: async () => [], createD1Database }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.lastErrorCode).toBe('control_daily_d1_budget_exhausted');
    expect(result.operation?.nextAttemptAt).toBe((Math.floor(NOW / 86_400) + 1) * 86_400);
    expect(createD1Database).not.toHaveBeenCalled();
  });

  it('does not call Cloudflare when another reconciler owns the operation lease', async () => {
    const repository = new FakeRepository();
    repository.allowLease = false;
    const listD1Databases = vi.fn();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases, createD1Database: vi.fn() }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.lastErrorCode).toBe('control_concurrency_limited');
    expect(listD1Databases).not.toHaveBeenCalled();
  });

  it('redacts transient provider errors and schedules exponential retry', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => {
            throw new Error('network failure containing provider detail');
          },
          createD1Database: vi.fn(),
        }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.status).toBe('waiting_retry');
    expect(result.operation?.lastErrorCode).toBe('cloudflare_d1_request_failed');
    expect(JSON.stringify(result)).not.toContain('provider detail');
    expect(result.operation?.nextAttemptAt).toBeGreaterThanOrEqual(NOW + 30);
  });

  it('normalizes client construction failures after leasing into a retrying operation', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => {
        throw new Error('transient client construction failure');
      },
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation).toMatchObject({
      status: 'waiting_retry',
      lastErrorCode: 'cloudflare_d1_request_failed',
    });
    expect(result.operation?.nextAttemptAt).toBeGreaterThanOrEqual(NOW + 30);
  });

  it('uses the latest manual retry window instead of the original operation age', async () => {
    const repository = new FakeRepository();
    const planningService = new ControlService({ repository, env: env(), now: () => NOW });
    const planned = await planningService.requestTenantShard(request({ dryRun: true }));
    repository.operations.set(planned.plan.operationId, {
      ...operation(planned.plan),
      createdAt: NOW - 3 * 60 * 60,
      retryBudgetStartedAt: NOW - 60,
      status: 'running',
    });
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => {
            throw new Error('transient provider failure');
          },
          createD1Database: vi.fn(),
        }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.status).toBe('waiting_retry');
    expect(result.operation?.lastErrorCode).toBe('cloudflare_d1_request_failed');
  });

  it('blocks permanent capability failures without exposing provider messages', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => {
            throw new CloudflareControlApiError('d1.list', 403, [10000]);
          },
          createD1Database: vi.fn(),
        }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.status).toBe('blocked');
    expect(result.operation?.lastErrorCode).toBe('cloudflare_d1_capability_rejected');
    expect(repository.provisioningAuthority.capabilityState).toBe('blocked');
  });

  it('derives enabled read replication from Control DB and verifies provider state', async () => {
    const repository = new FakeRepository();
    repository.replicationPolicy = { desired_mode: 'enabled', consistency_policy_version: 1 };
    const updateD1Database = vi.fn(
      async (databaseId: string, update: { read_replication: { mode: 'auto' | 'disabled' } }) => ({
        uuid: databaseId,
        name: 'database',
        read_replication: update.read_replication,
      })
    );
    let reflectedMode: 'auto' | 'disabled' = 'disabled';
    const getD1Database = vi.fn(async (databaseId: string) => ({
      uuid: databaseId,
      name: 'database',
      read_replication: { mode: reflectedMode },
    }));
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => ({
        listD1Databases: async () => [],
        createD1Database: async ({ name }) => ({
          uuid: 'database-1',
          name,
          read_replication: { mode: 'disabled' },
        }),
        updateD1Database: async (databaseId, update) => {
          reflectedMode = update.read_replication.mode;
          return updateD1Database(databaseId, update);
        },
        getD1Database,
      }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.plan.readReplicationMode).toBe('enabled');
    expect(updateD1Database).toHaveBeenCalledWith('database-1', {
      read_replication: { mode: 'auto' },
    });
    expect(getD1Database).toHaveBeenCalledWith('database-1');
    expect(result.operation?.lastErrorCode).toBeNull();
  });

  it('writes Lookup migration metadata through the existing Lookup metadata table', async () => {
    const plan: PendingMigrationPlan = {
      operationId: 'lookup-operation',
      desiredResourceId: 'lookup-resource',
      shardId: 'lookup-shard',
      environmentId: 'env-test',
      databaseId: 'lookup-database',
      streamId: 'd1-lookup',
      releaseId: '0.4.0',
      manifestDigest: 'a'.repeat(64),
      manifestObjectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
      bindingRef: 'TDB_LOOKUP_1234_LOOKUP',
      dataRole: 'lookup',
      residencyPartition: 'default',
      migrationGeneration: 1,
    };
    const queryD1Batch = vi.fn(
      async (_databaseId: string, batch: Array<{ params?: unknown[] }>) => {
        const metadata = JSON.parse(String(batch[0]?.params?.[1])) as Record<string, unknown>;
        return [
          { success: true, results: [] },
          { success: true, results: [{ metadata_value: JSON.stringify(metadata) }] },
        ];
      }
    );

    await writeMigrationMetadata(env(), plan, { totalFiles: 2, lastFilename: '002.sql' }, NOW, {
      queryD1Batch,
    } as unknown as Pick<CloudflareControlApiClient, 'queryD1Batch'>);

    expect(queryD1Batch).toHaveBeenCalledTimes(1);
    const [, batch] = queryD1Batch.mock.calls[0] ?? [];
    expect(JSON.stringify(batch)).toContain('lookup_schema_metadata');
    expect(JSON.stringify(batch)).not.toContain('authrim_control_plane_shard_metadata');
    expect(batch?.[0]?.params?.[0]).toBe('authrim.control_plane.shard');
  });

  it('applies the server-pinned release and completes a pending migration', async () => {
    const repository = new FakeRepository();
    const apply = vi.fn().mockResolvedValue({
      streamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: 'a'.repeat(64),
      totalFiles: 2,
      appliedFiles: 2,
      skippedFiles: 0,
      responseLossRecoveries: 0,
      lastFilename: '002_index.sql',
    });
    const planningService = new ControlService({ repository, env: env(), now: () => NOW });
    const planned = await planningService.requestTenantShard(request({ dryRun: true }));
    repository.operations.set(planned.plan.operationId, {
      ...operation(planned.plan),
      status: 'waiting_retry',
    });
    repository.pendingMigrations = [
      {
        operationId: planned.plan.operationId,
        desiredResourceId: planned.plan.desiredResourceId,
        shardId: planned.plan.shardId,
        environmentId: planned.plan.environmentId,
        databaseId: 'database-id',
        streamId: planned.plan.migrationStreamId,
        releaseId: '0.4.0',
        manifestDigest: 'a'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        bindingRef: planned.plan.bindingRef,
        dataRole: planned.plan.dataRole,
        residencyPartition: planned.plan.residencyPartition,
        migrationGeneration: 1,
      },
    ];
    const writeMigrationMetadata = vi.fn().mockResolvedValue(undefined);
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createMigrationEngine: () => ({ apply }),
      writeMigrationMetadata,
    });

    await expect(service.reconcilePending()).resolves.toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(apply).toHaveBeenCalledWith({
      databaseId: 'database-id',
      pin: {
        environmentId: 'env-test',
        streamId: 'd1-core',
        releaseId: '0.4.0',
        manifestDigest: 'a'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
      },
    });
    expect(repository.operations.get(planned.plan.operationId)?.status).toBe('succeeded');
    expect(writeMigrationMetadata).toHaveBeenCalledWith(
      expect.anything(),
      repository.pendingMigrations[0],
      expect.objectContaining({ totalFiles: 2, lastFilename: '002_index.sql' }),
      NOW
    );
  });

  it('blocks a permanently invalid pinned migration artifact without retrying it', async () => {
    const repository = new FakeRepository();
    const planningService = new ControlService({ repository, env: env(), now: () => NOW });
    const planned = await planningService.requestTenantShard(request({ dryRun: true }));
    repository.operations.set(planned.plan.operationId, {
      ...operation(planned.plan),
      status: 'waiting_retry',
    });
    repository.pendingMigrations = [
      {
        operationId: planned.plan.operationId,
        desiredResourceId: planned.plan.desiredResourceId,
        shardId: planned.plan.shardId,
        environmentId: planned.plan.environmentId,
        databaseId: 'database-id',
        streamId: 'd1-core',
        releaseId: '0.4.0',
        manifestDigest: 'a'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        bindingRef: planned.plan.bindingRef,
        dataRole: planned.plan.dataRole,
        residencyPartition: planned.plan.residencyPartition,
        migrationGeneration: 1,
      },
    ];
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createMigrationEngine: () => ({
        apply: vi.fn().mockRejectedValue(new Error('migration_release_manifest_digest_mismatch')),
      }),
    });

    await expect(service.reconcilePending()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(repository.operations.get(planned.plan.operationId)).toMatchObject({
      status: 'blocked',
      lastErrorCode: 'migration_release_manifest_digest_mismatch',
      nextAttemptAt: null,
    });
  });

  it('hands an in-flight migration to setup when automatic execution becomes unavailable', async () => {
    const repository = new FakeRepository();
    const planningService = new ControlService({ repository, env: env(), now: () => NOW });
    const planned = await planningService.requestTenantShard(request({ dryRun: true }));
    repository.operations.set(planned.plan.operationId, {
      ...operation(planned.plan),
      status: 'waiting_retry',
    });
    repository.pendingMigrations = [
      {
        operationId: planned.plan.operationId,
        desiredResourceId: planned.plan.desiredResourceId,
        shardId: planned.plan.shardId,
        environmentId: planned.plan.environmentId,
        databaseId: 'database-id',
        streamId: planned.plan.migrationStreamId,
        releaseId: '0.4.0',
        manifestDigest: 'a'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'a'.repeat(64)}/manifest.json`,
        bindingRef: planned.plan.bindingRef,
        dataRole: planned.plan.dataRole,
        residencyPartition: planned.plan.residencyPartition,
        migrationGeneration: 1,
      },
    ];
    repository.provisioningAuthority = {
      automaticProvisioningEnabled: false,
      tokenOwnership: 'none',
      capabilityState: 'disabled',
    };
    const controlEnv = env();
    controlEnv.AUTHRIM_AUTOMATIC_PROVISIONING = 'false';
    delete controlEnv.CLOUDFLARE_D1_API_TOKEN;
    delete controlEnv.CLOUDFLARE_WORKERS_API_TOKEN;
    const apply = vi.fn();
    const service = new ControlService({
      repository,
      env: controlEnv,
      now: () => NOW,
      createMigrationEngine: () => ({ apply }),
    });

    await expect(service.reconcilePending()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(repository.operations.get(planned.plan.operationId)).toMatchObject({
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
