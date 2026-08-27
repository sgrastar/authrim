import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type {
  AdminAuthContext,
  ControlCapacityProvisioningPreview,
  ControlCapacityProvisioningResult,
  ControlLookupHmacRotationView,
  ControlProvisioningOperationDetail,
  ControlShardCleanupView,
  ControlStorageTopology,
  ControlTenantDisasterRecoveryView,
  ControlTenantDisasterRecoveryStartRequest,
  ControlTenantPlacementPolicyActivationRequest,
  ControlWorkerInventoryDriftFinding,
  Env,
} from '@authrim/ar-lib-core';

const { audit, resolveRuntimeRoute, publishRouteState } = vi.hoisted(() => ({
  audit: vi.fn(),
  resolveRuntimeRoute: vi.fn(),
  publishRouteState: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: audit }));
vi.mock('../admin-tenants', () => ({
  resolveActiveTenantRuntimeRouteObservation: resolveRuntimeRoute,
}));
vi.mock('../tenant-runtime-registry-route-state', () => ({
  publishTenantRuntimeRegistryRouteState: publishRouteState,
  publishTenantRuntimeRegistryReactivation: vi.fn(),
}));

import { controlPlaneOperationsRouter } from '../routes/admin-management/control-plane-operations';

const finding: ControlWorkerInventoryDriftFinding = {
  findingId: 'drift:test:actual_only:test-unmanaged',
  environmentId: 'test',
  workerScriptName: 'test-unmanaged',
  findingKind: 'actual_only',
  severity: 'warning',
  reviewState: 'unreviewed',
  notificationState: 'acknowledged',
  firstObservedAt: 100,
  lastObservedAt: 110,
  resolvedAt: null,
  notifiedAt: 105,
};

const operation: ControlProvisioningOperationDetail = {
  operationId: 'operation-1',
  operationKind: 'provision_shard',
  status: 'blocked',
  attemptCount: 3,
  nextAttemptAt: null,
  lastErrorCode: 'cloudflare_d1_request_rejected',
  createdAt: 100,
  updatedAt: 120,
  availableActions: ['retry_create_d1', 'cancel'],
  steps: [
    {
      stepKey: 'create_d1',
      displayOrder: 10,
      status: 'blocked',
      attemptCount: 3,
      nextAttemptAt: null,
      lastErrorCode: 'cloudflare_d1_request_rejected',
      observedResourceId: null,
      progressCurrent: null,
      progressTotal: null,
      startedAt: 101,
      completedAt: null,
      updatedAt: 120,
    },
  ],
};

const capacityPreview: ControlCapacityProvisioningPreview = {
  dryRun: true,
  profile: 'recommended',
  scope: 'shared_pool',
  tenantId: null,
  available: true,
  reasonCode: null,
  capacityUnitsAdded: 1,
  d1DatabasesAdded: 1,
  projectedEnvironmentD1Count: 11,
  targets: [
    {
      unitKey: 'residency-default:jp:tenant_core/users',
      unitIndex: 1,
      workerScripts: ['test-ar-auth'],
      operationId: 'capacity-operation-1',
      environmentId: 'test',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      lookupCapacityDomainId: null,
      logicalShardId: 'users:jp:capacity-1',
      databaseName: 'test-authrim-tenant-users-jp-capacity-1-db',
      bindingRef: 'TEST_TDB_USERS_CAPACITY_1_CORE',
      readReplicationMode: 'disabled',
      migrationStreamId: 'd1-core',
    },
  ],
};

const capacityResult: ControlCapacityProvisioningResult = {
  preview: capacityPreview,
  operations: [
    {
      operationId: 'capacity-operation-1',
      status: 'blocked',
      attemptCount: 0,
      nextAttemptAt: null,
      lastErrorCode: 'operator_action_required',
      createdAt: 1_800_000_000,
      updatedAt: 1_800_000_000,
    },
  ],
};

const storageTopology: ControlStorageTopology = {
  environmentId: 'test',
  generatedAt: 1_800_000_000,
  policy: {
    maxConcurrentProvisioning: 2,
    maxReadySpares: 1,
    maxD1Resources: 100,
    dailyD1CreateBudget: 50,
    targetAccountCount: 500,
  },
  summary: {
    providerInventoryAvailable: true,
    providerD1Count: 2,
    controlManagedD1Count: 2,
    tenantShardCount: 1,
    lookupShardCount: 1,
    activeTenantShardCount: 1,
    readySpareCount: 0,
    provisioningD1Count: 0,
    failedD1Count: 0,
    accountCount: 1,
    inFlightOperationCount: 0,
    blockedOperationCount: 0,
  },
  tenants: [
    {
      tenantId: 'tenant-1',
      isolationPolicy: 'shared_pool',
      policyState: 'active',
      accountCount: 1,
      assignedShardCount: 1,
    },
  ],
  tenantShards: [
    {
      shardId: 'shard-1',
      desiredResourceId: 'desired-1',
      databaseName: 'test-authrim-users-1',
      providerDatabaseId: 'database-1',
      dataRole: 'tenant_core/users',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      residencyPartition: 'default',
      status: 'active',
      healthStatus: 'healthy',
      allocationStatus: 'eligible',
      targetAccountCount: 500,
      allocatedAccountCount: 1,
      observedAccountCount: 1,
      storageBytes: 4096,
      activeAssignmentCount: 1,
      createdAt: 100,
      updatedAt: 110,
    },
  ],
  lookupShards: [
    {
      lookupShardId: 'lookup-1',
      desiredResourceId: 'desired-lookup-1',
      databaseName: 'test-authrim-lookup-1',
      providerDatabaseId: 'database-lookup-1',
      residencyPartition: 'default',
      status: 'active',
      capacityWeight: 1,
      activeBucketCount: 4096,
      createdAt: 100,
      updatedAt: 110,
    },
  ],
  operations: [
    {
      operationId: 'operation-storage-1',
      tenantId: null,
      dataRole: 'tenant_core/users',
      databaseName: 'test-authrim-users-1',
      providerDatabaseId: 'database-1',
      provisioningState: 'active',
      status: 'succeeded',
      attemptCount: 1,
      lastErrorCode: null,
      decidedAt: 100,
      createStartedAt: 101,
      readyAt: 110,
      updatedAt: 110,
    },
  ],
  providerDatabases: [
    {
      databaseId: 'database-1',
      databaseName: 'test-authrim-users-1',
      createdAt: '2026-08-28T00:00:00.000Z',
      fileSizeBytes: 4096,
      managedByControl: true,
    },
    {
      databaseId: 'database-lookup-1',
      databaseName: 'test-authrim-lookup-1',
      createdAt: '2026-08-28T00:00:01.000Z',
      fileSizeBytes: 2048,
      managedByControl: true,
    },
  ],
};

const retriedOperation: ControlProvisioningOperationDetail = {
  ...operation,
  status: 'running',
  lastErrorCode: null,
  updatedAt: 130,
  availableActions: [],
  steps: operation.steps.map((step) => ({
    ...step,
    status: 'running' as const,
    lastErrorCode: null,
    updatedAt: 130,
  })),
};

const canceledOperation: ControlProvisioningOperationDetail = {
  ...operation,
  status: 'canceled',
  lastErrorCode: null,
  updatedAt: 130,
  availableActions: [],
  steps: operation.steps.map((step) => ({
    ...step,
    status: 'canceled' as const,
    completedAt: 130,
    updatedAt: 130,
  })),
};

const restoreEligibleOperation: ControlProvisioningOperationDetail = {
  ...operation,
  lastErrorCode: 'control_worker_rollback_failed',
  availableActions: ['restore_previous_settings'],
  steps: [
    {
      ...operation.steps[0],
      stepKey: 'reconcile_worker_bindings',
      displayOrder: 30,
      lastErrorCode: 'control_worker_rollback_failed',
    },
  ],
};

const restoreRequestedOperation: ControlProvisioningOperationDetail = {
  ...restoreEligibleOperation,
  status: 'running',
  lastErrorCode: null,
  updatedAt: 130,
  availableActions: [],
  steps: restoreEligibleOperation.steps.map((step) => ({
    ...step,
    status: 'running' as const,
    lastErrorCode: null,
    updatedAt: 130,
  })),
};

const lookupHmacRotation: ControlLookupHmacRotationView = {
  operationId: 'hmac-rotation-1',
  state: 'distributing',
  source: {
    generation: 1,
    keyId: 'lookup-v1',
    slot: 'A',
    fingerprint: 'a'.repeat(64),
  },
  candidate: {
    generation: 2,
    keyId: 'lookup-v2',
    slot: 'B',
    fingerprint: 'b'.repeat(64),
  },
  checkpoint: {},
  sourceRowCount: null,
  currentRowCount: null,
  verificationAttemptCount: 0,
  graceExpiresAt: null,
  ownerId: 'admin:admin-1',
  fencingToken: 1,
  leaseExpiresAt: 1_800_000_120,
  mutationStarted: false,
  updatedAt: 1_800_000_000,
};

const cleanupCandidate: ControlShardCleanupView = {
  environmentId: 'test',
  shardId: 'retired-shard-1',
  dataRole: 'tenant_core/default',
  residencyPartition: 'global',
  bindingRef: 'TEST_TDB_DEFAULT_RETIRED_1',
  databaseId: 'database-retired-1',
  databaseName: 'test-tenant-core-retired-1',
  shardStatus: 'retired',
  quarantineOperationId: 'quarantine-operation-1',
  quarantineState: 'quarantined',
  quarantineOperationState: 'ready_for_cleanup',
  denyRegistryGeneration: 8,
  drainNotBefore: 1_800_000_000,
  registryVerifiedAt: 1_800_000_100,
  referencesVerifiedAt: 1_800_000_100,
  cleanupOperationId: null,
  cleanupState: null,
  exportMode: null,
  deleteDatabase: null,
  destructiveOperationsEnabled: false,
  availableActions: ['approve_cleanup'],
  bindings: [],
  lastErrorCode: null,
  createdAt: 1_799_999_000,
  updatedAt: 1_800_000_100,
};

const approvedCleanupCandidate: ControlShardCleanupView = {
  ...cleanupCandidate,
  shardStatus: 'deleting',
  cleanupOperationId: 'cleanup-operation-1',
  cleanupState: 'approved',
  exportMode: 'skipped',
  deleteDatabase: true,
  destructiveOperationsEnabled: true,
  availableActions: [],
  bindings: [
    {
      workerScriptName: 'test-ar-auth',
      bindingRef: cleanupCandidate.bindingRef,
      state: 'pending',
      lastErrorCode: null,
      updatedAt: 1_800_000_110,
    },
  ],
  updatedAt: 1_800_000_110,
};

const tenantRecovery: ControlTenantDisasterRecoveryView = {
  operationId: 'tenant-dr:abc123',
  environmentId: 'test',
  tenantId: 'tenant-1',
  state: 'reprojecting_lookup',
  pinnedRouteGeneration: 7,
  denyRuntimeGeneration: 8,
  denyRegistryGeneration: 9,
  denyObservedAt: 1_800_000_000,
  drainNotBefore: 1_800_001_800,
  restoreReferenceRecorded: true,
  restoredAt: 1_800_001_900,
  migrationVerifiedAt: 1_800_001_910,
  lookupReprojectedAt: null,
  lookupReprojection: {
    stage: 'email_exact',
    targetIndex: 1,
    afterCreatedAt: 1_800_000_100,
    afterId: 'email-row-1',
    afterRowId: 0,
    projectedRows: 25,
    verifiedRows: 0,
    registryDigestPinned: true,
    leaseActive: true,
  },
  bindingSmokeVerifiedAt: null,
  reactivatedRuntimeGeneration: null,
  reactivatedAt: null,
  lastErrorCode: null,
  canCancel: false,
  canConfirmRestore: false,
  canVerify: false,
  canReactivate: false,
  targets: [
    {
      shardId: 'shard-1',
      dataRole: 'tenant_core/users',
      residencyPartition: 'apac',
      assignmentGeneration: 2,
      shardGeneration: 7,
      bindingRef: 'TEST_TDB_USERS_1234_CORE',
      providerDatabaseId: '11111111-1111-4111-8111-111111111111',
      migrationStreamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: 'd'.repeat(64),
      restoreConfirmedAt: 1_800_001_900,
      migrationVerifiedAt: 1_800_001_910,
      lookupReprojectedAt: null,
      bindingSmokeVerifiedAt: null,
    },
  ],
  createdAt: 1_800_000_000,
  updatedAt: 1_800_001_920,
};

function createApp(input?: {
  roles?: string[];
  actorType?: AdminAuthContext['actorType'];
  authMethod?: AdminAuthContext['authMethod'];
  principalType?: AdminAuthContext['principalType'];
  clientId?: string;
  permissions?: string[];
  environmentId?: string;
  control?: Partial<NonNullable<Env['CONTROL']>>;
}) {
  const listWorkerInventoryDriftFindings = vi.fn(async () => [finding]);
  const reviewWorkerInventoryDriftFinding = vi.fn(async () => ({
    ...finding,
    reviewState: 'reviewed' as const,
  }));
  const getProvisioningOperation = vi.fn(async () => operation);
  const getReleaseMigrationRolloutStatus = vi.fn(async () => ({
    operationId: 'release-rollout-1',
    sourceVersion: '0.4.0',
    targetVersion: '0.5.0',
    phase: 'database_rollout' as const,
    completedTargets: 3,
    totalTargets: 12,
    blockedTargetCount: 0,
    blockedTargets: [],
    adminMutationMode: 'read_only' as const,
    lastErrorCode: null,
    updatedAt: 1_800_000_000,
  }));
  const retryReleaseMigrationRolloutTarget = vi.fn(async () => ({
    ...(await getReleaseMigrationRolloutStatus()),
    phase: 'database_rollout' as const,
    lastErrorCode: null,
    blockedTargetCount: 0,
    blockedTargets: [],
  }));
  const getProvisioningAuthorityStatus = vi.fn(async () => ({
    automaticProvisioningEnabled: false,
    tokenOwnership: 'none' as const,
    capabilityState: 'disabled' as const,
    automaticExecutionAvailable: false,
    activeExecutor: 'setup_operator' as const,
  }));
  const getStorageTopology = vi.fn(async () => storageTopology);
  const previewCapacityProvisioning = vi.fn(async () => capacityPreview);
  const requestCapacityProvisioning = vi.fn(async () => capacityResult);
  const retryProvisioningOperationStep = vi.fn(async () => retriedOperation);
  const cancelProvisioningOperation = vi.fn(async () => canceledOperation);
  const restoreProvisioningOperationPreviousSettings = vi.fn(async () => restoreRequestedOperation);
  const startLookupHmacRotation = vi.fn(async () => lookupHmacRotation);
  const getLookupHmacRotation = vi.fn(async () => lookupHmacRotation);
  const getLookupHmacVerificationStatus = vi.fn(
    async (input: { phase: 'distribution' | 'generation' }) => ({
      phase: input.phase,
      expected: 5,
      succeeded: 5,
      failed: 0,
      pending: [],
      complete: true,
    })
  );
  const activateLookupHmacRotation = vi.fn(async () => ({
    ...lookupHmacRotation,
    state: 'activation_dual_write' as const,
    mutationStarted: true,
  }));
  const observeLookupHmacRotationGeneration = vi.fn(async () => ({
    ...lookupHmacRotation,
    state: 'dual_read' as const,
    mutationStarted: true,
  }));
  const listShardCleanupCandidates = vi.fn(async () => [cleanupCandidate]);
  const getShardCleanupCandidate = vi.fn(async () => cleanupCandidate);
  const quarantineShard = vi.fn(async () => ({
    ...cleanupCandidate,
    quarantineState: 'quarantining' as const,
    quarantineOperationState: 'draining' as const,
    availableActions: [],
  }));
  const retryShardQuarantine = vi.fn(async () => ({
    ...cleanupCandidate,
    quarantineState: 'quarantining' as const,
    quarantineOperationState: 'draining' as const,
    availableActions: [],
  }));
  const approveShardCleanup = vi.fn(async () => approvedCleanupCandidate);
  const retryShardCleanup = vi.fn(async () => ({
    ...approvedCleanupCandidate,
    cleanupState: 'approved' as const,
  }));
  const getTenantDisasterRecovery = vi.fn(async () => tenantRecovery);
  const getTenantPlacementPolicy = vi.fn(async () => ({
    tenantId: 'tenant-1',
    isolationPolicy: 'tenant_exclusive' as const,
    policyGeneration: 1,
    state: 'active' as const,
    pendingIsolationPolicy: null,
    pendingPolicyGeneration: null,
    migrationOperationId: null,
    sourceOperationId: 'tenant-create-1',
    createdAt: 1,
    updatedAt: 2,
  }));
  const activateTenantPlacementPolicy = vi.fn(
    async (_request: ControlTenantPlacementPolicyActivationRequest) => getTenantPlacementPolicy()
  );
  const startTenantDisasterRecovery = vi.fn(
    async (_request: ControlTenantDisasterRecoveryStartRequest) => tenantRecovery
  );
  const observeTenantDisasterRecoveryDeny = vi.fn(async () => tenantRecovery);
  const recordTenantDisasterRecoveryVerification = vi.fn(async () => tenantRecovery);
  const requestTenantDisasterRecoveryReactivation = vi.fn(async () => ({
    ...tenantRecovery,
    state: 'reactivating' as const,
  }));
  const completeTenantDisasterRecoveryReactivation = vi.fn(async () => ({
    ...tenantRecovery,
    state: 'succeeded' as const,
  }));
  const control = {
    getReleaseMigrationRolloutStatus,
    retryReleaseMigrationRolloutTarget,
    listWorkerInventoryDriftFindings,
    reviewWorkerInventoryDriftFinding,
    getProvisioningOperation,
    getProvisioningAuthorityStatus,
    getStorageTopology,
    previewCapacityProvisioning,
    requestCapacityProvisioning,
    retryProvisioningOperationStep,
    cancelProvisioningOperation,
    restoreProvisioningOperationPreviousSettings,
    startLookupHmacRotation,
    getLookupHmacRotation,
    getLookupHmacVerificationStatus,
    activateLookupHmacRotation,
    observeLookupHmacRotationGeneration,
    listShardCleanupCandidates,
    getShardCleanupCandidate,
    quarantineShard,
    retryShardQuarantine,
    approveShardCleanup,
    retryShardCleanup,
    getTenantDisasterRecovery,
    getTenantPlacementPolicy,
    activateTenantPlacementPolicy,
    startTenantDisasterRecovery,
    observeTenantDisasterRecoveryDeny,
    recordTenantDisasterRecoveryVerification,
    requestTenantDisasterRecoveryReactivation,
    completeTenantDisasterRecoveryReactivation,
    ...input?.control,
  } as unknown as NonNullable<Env['CONTROL']>;
  const env = {
    CONTROL: control,
    AUTHRIM_ENVIRONMENT_NAME: input?.environmentId ?? 'test',
  } as unknown as Env;
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: input?.authMethod ?? 'session',
      actorType: input?.actorType ?? 'human',
      principalType: input?.principalType,
      clientId: input?.clientId,
      roles: input?.roles ?? ['system_admin'],
      permissions: input?.permissions ?? [],
    });
    await next();
  });
  app.route('/api/admin/platform/control-plane', controlPlaneOperationsRouter);
  return {
    app,
    env,
    listWorkerInventoryDriftFindings,
    reviewWorkerInventoryDriftFinding,
    getProvisioningOperation,
    getReleaseMigrationRolloutStatus,
    retryReleaseMigrationRolloutTarget,
    getProvisioningAuthorityStatus,
    getStorageTopology,
    previewCapacityProvisioning,
    requestCapacityProvisioning,
    retryProvisioningOperationStep,
    cancelProvisioningOperation,
    restoreProvisioningOperationPreviousSettings,
    startLookupHmacRotation,
    getLookupHmacRotation,
    getLookupHmacVerificationStatus,
    activateLookupHmacRotation,
    observeLookupHmacRotationGeneration,
    listShardCleanupCandidates,
    getShardCleanupCandidate,
    quarantineShard,
    retryShardQuarantine,
    approveShardCleanup,
    retryShardCleanup,
    getTenantDisasterRecovery,
    getTenantPlacementPolicy,
    activateTenantPlacementPolicy,
    startTenantDisasterRecovery,
    observeTenantDisasterRecoveryDeny,
    recordTenantDisasterRecoveryVerification,
    requestTenantDisasterRecoveryReactivation,
    completeTenantDisasterRecoveryReactivation,
  };
}

describe('control-plane operations admin router', () => {
  beforeEach(() => {
    audit.mockReset();
    audit.mockResolvedValue('audit-1');
    resolveRuntimeRoute.mockReset();
    resolveRuntimeRoute.mockResolvedValue({
      runtimeGeneration: 7,
      registryPublicationGeneration: 7,
      tenantLifecycleState: 'active',
      routeStatus: 'active',
      targets: [
        {
          dataRole: 'tenant_core/default',
          shardId: 'shard-default',
          bindingRef: 'TEST_TDB_DEFAULT_CORE',
          generation: 7,
        },
        {
          dataRole: 'tenant_core/users',
          shardId: 'shard-users',
          bindingRef: 'TEST_TDB_USERS_CORE',
          generation: 7,
        },
        {
          dataRole: 'tenant_pii',
          shardId: 'shard-pii',
          bindingRef: 'TEST_TDB_PII',
          generation: 7,
        },
      ],
    });
    publishRouteState.mockReset();
  });

  it('repairs the Control route from verified runtime evidence before starting recovery', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/tenant-recovery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'tenant-dr-start-1',
        },
        body: JSON.stringify({
          tenantId: 'tenant-1',
          confirmation: 'START_TENANT_RECOVERY:tenant-1',
        }),
      },
      target.env
    );

    expect(response.status).toBe(202);
    expect(resolveRuntimeRoute).toHaveBeenCalledWith(target.env, 'tenant-1');
    expect(target.activateTenantPlacementPolicy.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-1',
      sourceOperationId: 'tenant-create-1',
      runtimeRoute: { runtimeGeneration: 7 },
    });
    const activationOrder = target.activateTenantPlacementPolicy.mock.invocationCallOrder[0];
    const startOrder = target.startTenantDisasterRecovery.mock.invocationCallOrder[0];
    if (activationOrder === undefined || startOrder === undefined) {
      throw new Error('expected tenant DR calls');
    }
    expect(activationOrder).toBeLessThan(startOrder);
  });

  it('returns the secret-free effective provisioning executor status', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/provisioning-authority',
      {},
      target.env
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      authority: {
        automaticProvisioningEnabled: false,
        tokenOwnership: 'none',
        capabilityState: 'disabled',
        automaticExecutionAvailable: false,
        activeExecutor: 'setup_operator',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('tokenValue');
  });

  it('returns a secret-free storage topology for Control Plane readers', async () => {
    const target = createApp({ roles: ['viewer'], permissions: ['admin:control_plane:read'] });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/storage-topology',
      {},
      target.env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ topology: storageTopology });
    expect(target.getStorageTopology).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed storage topology and unauthorized machines', async () => {
    const malformed = createApp({
      control: {
        getStorageTopology: vi.fn(async () => ({ ...storageTopology, bootstrapToken: 'secret' })),
      },
    });
    const malformedResponse = await malformed.app.request(
      '/api/admin/platform/control-plane/storage-topology',
      {},
      malformed.env
    );
    expect(malformedResponse.status).toBe(503);

    const unauthorized = createApp({
      roles: [],
      permissions: [],
      actorType: 'machine',
      authMethod: 'machine_access_token',
    });
    const unauthorizedResponse = await unauthorized.app.request(
      '/api/admin/platform/control-plane/storage-topology',
      {},
      unauthorized.env
    );
    expect(unauthorizedResponse.status).toBe(403);
  });

  it('returns release migration progress for Admin UI polling', async () => {
    const target = createApp({ roles: ['viewer'], permissions: [] });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/release-rollout',
      {},
      target.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rollout: {
        operationId: 'release-rollout-1',
        sourceVersion: '0.4.0',
        targetVersion: '0.5.0',
        phase: 'database_rollout',
        completedTargets: 3,
        totalTargets: 12,
        blockedTargetCount: 0,
        blockedTargets: [],
        adminMutationMode: 'read_only',
        lastErrorCode: null,
        updatedAt: 1_800_000_000,
      },
    });
    expect(target.getReleaseMigrationRolloutStatus).toHaveBeenCalledTimes(1);
  });

  it('audits and retries one blocked release target while the mutation fence is active', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/release-rollout/release-rollout-1/targets/target-1/retry',
      { method: 'POST', headers: { 'Idempotency-Key': 'retry-target-1' } },
      target.env
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      auditId: 'audit-1',
      rollout: { phase: 'database_rollout', blockedTargetCount: 0 },
    });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      target.retryReleaseMigrationRolloutTarget.mock.invocationCallOrder[0]
    );
    expect(target.retryReleaseMigrationRolloutTarget).toHaveBeenCalledWith({
      operationId: 'release-rollout-1',
      targetId: 'target-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_retry_release_target',
      idempotencyKey: 'retry-target-1',
    });
  });

  it('does not retry a release target when the Admin audit cannot be persisted', async () => {
    audit.mockResolvedValueOnce(null);
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/release-rollout/release-rollout-1/targets/target-1/retry',
      { method: 'POST', headers: { 'Idempotency-Key': 'retry-target-2' } },
      target.env
    );

    expect(response.status).toBe(503);
    expect(target.retryReleaseMigrationRolloutTarget).not.toHaveBeenCalled();
  });

  it('rejects machine actors from release target recovery', async () => {
    const target = createApp({ actorType: 'machine', authMethod: 'machine_access_token' });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/release-rollout/release-rollout-1/targets/target-1/retry',
      { method: 'POST', headers: { 'Idempotency-Key': 'retry-target-machine' } },
      target.env
    );

    expect(response.status).toBe(403);
    expect(target.retryReleaseMigrationRolloutTarget).not.toHaveBeenCalled();
  });

  it('returns bounded Lookup reprojection progress and rejects malformed Control evidence', async () => {
    const target = createApp();
    const response = await target.app.request(
      `/api/admin/platform/control-plane/tenant-recovery/${tenantRecovery.operationId}`,
      {},
      target.env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recovery: tenantRecovery });

    const malformed = createApp({
      control: {
        getTenantDisasterRecovery: vi.fn(async () => ({
          ...tenantRecovery,
          lookupReprojection: { ...tenantRecovery.lookupReprojection, projectedRows: -1 },
        })) as NonNullable<Env['CONTROL']>['getTenantDisasterRecovery'],
      },
    });
    const malformedResponse = await malformed.app.request(
      `/api/admin/platform/control-plane/tenant-recovery/${tenantRecovery.operationId}`,
      {},
      malformed.env
    );
    expect(malformedResponse.status).toBe(503);
  });

  it('requires audit evidence before migration verification', async () => {
    const verifying = {
      ...tenantRecovery,
      state: 'verifying_restore' as const,
      canVerify: true,
    };
    const target = createApp({
      control: { getTenantDisasterRecovery: vi.fn(async () => verifying) },
    });
    const response = await target.app.request(
      `/api/admin/platform/control-plane/tenant-recovery/${tenantRecovery.operationId}/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'migration' }),
      },
      target.env
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ recovery: tenantRecovery, auditId: 'audit-1' });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'control_plane.tenant_recovery.migration_verification_requested',
        resourceId: tenantRecovery.tenantId,
        metadata: {
          operationId: tenantRecovery.operationId,
          pinnedRouteGeneration: tenantRecovery.pinnedRouteGeneration,
          targetCount: tenantRecovery.targets.length,
        },
      })
    );
    expect(target.recordTenantDisasterRecoveryVerification).toHaveBeenCalledOnce();

    audit.mockResolvedValueOnce(null);
    const unavailable = await target.app.request(
      `/api/admin/platform/control-plane/tenant-recovery/${tenantRecovery.operationId}/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'migration' }),
      },
      target.env
    );
    expect(unavailable.status).toBe(503);
    expect(target.recordTenantDisasterRecoveryVerification).toHaveBeenCalledTimes(1);
  });

  it('does not request tenant reactivation when audit storage is unavailable', async () => {
    audit.mockResolvedValueOnce(null);
    const ready = {
      ...tenantRecovery,
      state: 'ready_for_reactivation' as const,
      canReactivate: true,
    };
    const target = createApp({
      control: { getTenantDisasterRecovery: vi.fn(async () => ready) },
    });
    const response = await target.app.request(
      `/api/admin/platform/control-plane/tenant-recovery/${tenantRecovery.operationId}/reactivate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'reactivate-1',
        },
        body: JSON.stringify({
          confirmation: `REACTIVATE_RECOVERED_TENANT:${tenantRecovery.tenantId}`,
        }),
      },
      target.env
    );
    expect(response.status).toBe(503);
    expect(target.requestTenantDisasterRecoveryReactivation).not.toHaveBeenCalled();
    expect(target.completeTenantDisasterRecoveryReactivation).not.toHaveBeenCalled();
  });

  it('previews and requests server-owned capacity without raw resource input', async () => {
    const target = createApp();
    const body = { profile: 'recommended', scope: 'shared_pool', tenantId: null };
    const previewResponse = await target.app.request(
      '/api/admin/platform/control-plane/capacity/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      target.env
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toEqual({ preview: capacityPreview });
    expect(target.previewCapacityProvisioning).toHaveBeenCalledWith(body);

    const requestResponse = await target.app.request(
      '/api/admin/platform/control-plane/capacity/requests',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'capacity-request-1',
        },
        body: JSON.stringify(body),
      },
      target.env
    );
    expect(requestResponse.status).toBe(202);
    expect(await requestResponse.json()).toEqual({ result: capacityResult, auditId: 'audit-1' });
    expect(target.requestCapacityProvisioning).toHaveBeenCalledWith({
      ...body,
      requestedById: 'admin-1',
      idempotencyKey: 'capacity-request-1',
    });
  });

  it('fails closed for raw resource input, machine mutation, and missing audit', async () => {
    const target = createApp();
    const rawInput = await target.app.request(
      '/api/admin/platform/control-plane/capacity/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'recommended',
          scope: 'shared_pool',
          tenantId: null,
          databaseName: 'operator-selected',
        }),
      },
      target.env
    );
    expect(rawInput.status).toBe(400);
    expect(target.previewCapacityProvisioning).not.toHaveBeenCalled();

    const machine = createApp({ actorType: 'machine', permissions: ['admin:*'] });
    const machineResponse = await machine.app.request(
      '/api/admin/platform/control-plane/capacity/requests',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'machine-capacity-1',
        },
        body: JSON.stringify({ profile: 'recommended', scope: 'shared_pool', tenantId: null }),
      },
      machine.env
    );
    expect(machineResponse.status).toBe(403);
    expect(machine.requestCapacityProvisioning).not.toHaveBeenCalled();

    for (const identity of [
      { principalType: 'setup_tool' as const, clientId: 'other-setup' },
      { principalType: 'internal_service' as const, clientId: 'authrim-setup' },
    ]) {
      const impersonator = createApp({
        actorType: 'machine',
        authMethod: 'machine_access_token',
        principalType: identity.principalType,
        clientId: identity.clientId,
        permissions: ['admin:control_plane:provision'],
      });
      const impersonatorResponse = await impersonator.app.request(
        '/api/admin/platform/control-plane/capacity/requests',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `wrong-${identity.clientId}`,
          },
          body: JSON.stringify({ profile: 'recommended', scope: 'shared_pool', tenantId: null }),
        },
        impersonator.env
      );
      expect(impersonatorResponse.status).toBe(403);
      expect(impersonator.requestCapacityProvisioning).not.toHaveBeenCalled();
    }

    const setupMachine = createApp({
      actorType: 'machine',
      authMethod: 'machine_access_token',
      principalType: 'setup_tool',
      clientId: 'authrim-setup',
      permissions: ['admin:control_plane:provision'],
    });
    const setupResponse = await setupMachine.app.request(
      '/api/admin/platform/control-plane/capacity/requests',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'setup-capacity-1',
        },
        body: JSON.stringify({ profile: 'recommended', scope: 'shared_pool', tenantId: null }),
      },
      setupMachine.env
    );
    expect(setupResponse.status).toBe(202);
    expect(setupMachine.requestCapacityProvisioning).toHaveBeenCalledWith({
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
      requestedById: 'admin-1',
      idempotencyKey: 'setup-capacity-1',
    });

    audit.mockRejectedValueOnce(new Error('audit_unavailable'));
    const auditFailure = createApp();
    const auditResponse = await auditFailure.app.request(
      '/api/admin/platform/control-plane/capacity/requests',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'capacity-audit-failure',
        },
        body: JSON.stringify({ profile: 'minimum', scope: 'shared_pool', tenantId: null }),
      },
      auditFailure.env
    );
    expect(auditResponse.status).toBe(503);
    expect(auditFailure.requestCapacityProvisioning).not.toHaveBeenCalled();
  });

  it('allows only explicitly scoped setup-machine access to start a Lookup HMAC rotation', async () => {
    const target = createApp({
      actorType: 'machine',
      roles: [],
      permissions: ['admin:control_plane:rotate'],
    });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'setup-lookup-hmac-2',
        },
        body: JSON.stringify({ candidate: lookupHmacRotation.candidate }),
      },
      target.env
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      rotation: lookupHmacRotation,
      auditId: 'audit-1',
    });
    expect(target.startLookupHmacRotation).toHaveBeenCalledWith({
      candidate: lookupHmacRotation.candidate,
      idempotencyKey: 'setup-lookup-hmac-2',
      ownerId: 'admin:admin-1',
    });
    expect(JSON.stringify(target.startLookupHmacRotation.mock.calls)).not.toContain('secret');

    const denied = createApp({ actorType: 'machine', roles: [], permissions: [] });
    const deniedResponse = await denied.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'setup-lookup-hmac-denied',
        },
        body: JSON.stringify({ candidate: lookupHmacRotation.candidate }),
      },
      denied.env
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.startLookupHmacRotation).not.toHaveBeenCalled();
  });

  it('rejects secret-bearing Lookup HMAC requests before audit or Control', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'setup-lookup-hmac-secret',
        },
        body: JSON.stringify({
          candidate: lookupHmacRotation.candidate,
          key: 'forbidden-key-material',
        }),
      },
      target.env
    );
    expect(response.status).toBe(400);
    expect(audit).not.toHaveBeenCalled();
    expect(target.startLookupHmacRotation).not.toHaveBeenCalled();
  });

  it('reads and advances a Lookup HMAC rotation through narrow Control RPCs', async () => {
    const target = createApp();
    const read = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1',
      {},
      target.env
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({ rotation: lookupHmacRotation });

    const verification = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1/verifications/distribution',
      {},
      target.env
    );
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toEqual({
      status: {
        phase: 'distribution',
        expected: 5,
        succeeded: 5,
        failed: 0,
        pending: [],
        complete: true,
      },
    });
    expect(target.getLookupHmacVerificationStatus).toHaveBeenCalledWith({
      operationId: 'hmac-rotation-1',
      phase: 'distribution',
    });

    const activated = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1/activate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'lookup-hmac-activate-1',
        },
        body: JSON.stringify({ fencingToken: 1 }),
      },
      target.env
    );
    expect(activated.status).toBe(200);
    expect(target.activateLookupHmacRotation).toHaveBeenCalledWith({
      operationId: 'hmac-rotation-1',
      ownerId: 'admin:admin-1',
      fencingToken: 1,
    });

    const observed = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1/observe-generation',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'lookup-hmac-observe-1',
        },
        body: JSON.stringify({ fencingToken: 1 }),
      },
      target.env
    );
    expect(observed.status).toBe(200);
    expect(target.observeLookupHmacRotationGeneration).toHaveBeenCalledWith({
      operationId: 'hmac-rotation-1',
      ownerId: 'admin:admin-1',
      fencingToken: 1,
    });
  });

  it('requires explicit read scope and validates Lookup HMAC verification evidence', async () => {
    const denied = createApp({ actorType: 'machine', roles: [], permissions: [] });
    const deniedResponse = await denied.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1/verifications/generation',
      {},
      denied.env
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.getLookupHmacVerificationStatus).not.toHaveBeenCalled();

    const malformed = createApp({
      control: {
        getLookupHmacVerificationStatus: vi.fn(async () => ({
          phase: 'generation' as const,
          expected: 5,
          succeeded: 5,
          failed: 1,
          pending: [],
          complete: true,
        })),
      },
    });
    const malformedResponse = await malformed.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1/verifications/generation',
      {},
      malformed.env
    );
    expect(malformedResponse.status).toBe(503);
  });

  it('maps incomplete candidate evidence to a conflict without exposing the Control error', async () => {
    const target = createApp({
      control: {
        activateLookupHmacRotation: vi.fn(async () => {
          throw new Error('lookup_hmac_candidate_verification_incomplete');
        }),
      },
    });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/lookup-hmac/rotations/hmac-rotation-1/activate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'lookup-hmac-activate-incomplete',
        },
        body: JSON.stringify({ fencingToken: 1 }),
      },
      target.env
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'CONTROL_PLANE_LOOKUP_HMAC_ROTATION_CONFLICT',
    });
  });

  it('lists validated active findings only for platform administrators', async () => {
    const allowed = createApp();
    const response = await allowed.app.request(
      '/api/admin/platform/control-plane/drift-findings',
      {},
      allowed.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [finding], count: 1 });

    const denied = createApp({ roles: ['tenant_admin'] });
    const deniedResponse = await denied.app.request(
      '/api/admin/platform/control-plane/drift-findings',
      {},
      denied.env
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.listWorkerInventoryDriftFindings).not.toHaveBeenCalled();
  });

  it('inspects one environment-scoped provisioning operation with strict response validation', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/operations/operation-1',
      {},
      target.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ operation });
    expect(target.getProvisioningOperation).toHaveBeenCalledWith('operation-1');

    const malformed = createApp({
      control: {
        getProvisioningOperation: vi.fn(async () => ({
          ...operation,
          environmentId: 'other',
        })) as NonNullable<Env['CONTROL']>['getProvisioningOperation'],
      },
    });
    const malformedResponse = await malformed.app.request(
      '/api/admin/platform/control-plane/operations/operation-1',
      {},
      malformed.env
    );
    expect(malformedResponse.status).toBe(503);

    const mismatchedRestore = createApp({
      control: {
        getProvisioningOperation: vi.fn(async () => ({
          ...operation,
          availableActions: ['restore_previous_settings'],
        })) as NonNullable<Env['CONTROL']>['getProvisioningOperation'],
      },
    });
    const mismatchedRestoreResponse = await mismatchedRestore.app.request(
      '/api/admin/platform/control-plane/operations/operation-1',
      {},
      mismatchedRestore.env
    );
    expect(mismatchedRestoreResponse.status).toBe(503);

    const missing = createApp({
      control: { getProvisioningOperation: vi.fn(async () => null) },
    });
    const missingResponse = await missing.app.request(
      '/api/admin/platform/control-plane/operations/operation-1',
      {},
      missing.env
    );
    expect(missingResponse.status).toBe(404);
  });

  it('audits before sending a narrow review request to Control', async () => {
    const target = createApp();
    const response = await target.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'drift-review-1',
        },
        body: JSON.stringify({ disposition: 'reviewed' }),
      },
      target.env
    );
    expect(response.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'control_plane.worker_inventory.review_requested',
        resourceId: finding.findingId,
        after: { disposition: 'reviewed' },
      })
    );
    expect(target.reviewWorkerInventoryDriftFinding).toHaveBeenCalledWith({
      findingId: finding.findingId,
      disposition: 'reviewed',
      reviewedBy: 'admin-1',
      idempotencyKey: 'drift-review-1',
    });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      target.reviewWorkerInventoryDriftFinding.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('audits before retrying one allowlisted blocked operation step', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/retry-step',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'operation-retry-1',
        },
        body: JSON.stringify({ stepKey: 'create_d1' }),
      },
      target.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: retriedOperation,
      auditId: 'audit-1',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'control_plane.operation.retry_step_requested',
        resourceId: 'operation-1',
        before: { status: 'blocked', stepStatus: 'blocked' },
        after: { status: 'running', stepStatus: 'running' },
        metadata: {
          execution: 'control_service_binding',
          stepKey: 'create_d1',
          reasonCode: 'operator_retry',
        },
      })
    );
    expect(target.retryProvisioningOperationStep).toHaveBeenCalledWith({
      operationId: 'operation-1',
      stepKey: 'create_d1',
      requestedById: 'admin-1',
      reasonCode: 'operator_retry',
      idempotencyKey: 'operation-retry-1',
    });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      target.retryProvisioningOperationStep.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('allows only the exact setup provisioning machine to request a retry', async () => {
    const target = createApp({
      actorType: 'machine',
      authMethod: 'machine_access_token',
      principalType: 'setup_tool',
      clientId: 'authrim-setup',
      roles: [],
      permissions: ['admin:control_plane:provision'],
    });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/retry-step',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'operation-retry-setup-1',
        },
        body: JSON.stringify({ stepKey: 'reconcile_worker_bindings' }),
      },
      target.env
    );

    expect(response.status).toBe(200);
    expect(target.retryProvisioningOperationStep).toHaveBeenCalledWith({
      operationId: 'operation-1',
      stepKey: 'reconcile_worker_bindings',
      requestedById: 'admin-1',
      reasonCode: 'operator_retry',
      idempotencyKey: 'operation-retry-setup-1',
    });
  });

  it('fails closed for invalid, non-human, unaudited, and conflicting retries', async () => {
    const invalid = createApp();
    const invalidResponse = await invalid.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/retry-step',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-invalid' },
        body: JSON.stringify({ stepKey: 'smoke_bindings' }),
      },
      invalid.env
    );
    expect(invalidResponse.status).toBe(400);
    expect(invalid.retryProvisioningOperationStep).not.toHaveBeenCalled();

    const machine = createApp({ actorType: 'machine' });
    const machineResponse = await machine.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/retry-step',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-machine' },
        body: JSON.stringify({ stepKey: 'create_d1' }),
      },
      machine.env
    );
    expect(machineResponse.status).toBe(403);
    expect(machine.retryProvisioningOperationStep).not.toHaveBeenCalled();

    audit.mockResolvedValueOnce(null);
    const unaudited = createApp();
    const unauditedResponse = await unaudited.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/retry-step',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-unaudited' },
        body: JSON.stringify({ stepKey: 'create_d1' }),
      },
      unaudited.env
    );
    expect(unauditedResponse.status).toBe(503);
    expect(unaudited.retryProvisioningOperationStep).not.toHaveBeenCalled();

    const conflict = createApp({
      control: {
        retryProvisioningOperationStep: vi.fn(async () => {
          throw new Error('control_operation_retry_conflict');
        }),
      },
    });
    const conflictResponse = await conflict.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/retry-step',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-conflict' },
        body: JSON.stringify({ stepKey: 'create_d1' }),
      },
      conflict.env
    );
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      error: 'CONTROL_PLANE_OPERATION_RETRY_CONFLICT',
    });
  });

  it('audits before canceling an allowlisted blocked provisioning operation', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/cancel',
      {
        method: 'POST',
        headers: { 'idempotency-key': 'operation-cancel-1' },
      },
      target.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: canceledOperation,
      auditId: 'audit-1',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'control_plane.operation.cancel_requested',
        resourceId: 'operation-1',
        before: { status: 'blocked' },
        after: { status: 'canceled' },
        metadata: {
          execution: 'control_service_binding',
          reasonCode: 'operator_cancel',
          retainedResources: true,
        },
      })
    );
    expect(target.cancelProvisioningOperation).toHaveBeenCalledWith({
      operationId: 'operation-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_cancel',
      idempotencyKey: 'operation-cancel-1',
    });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      target.cancelProvisioningOperation.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('fails closed before Control for non-human, unaudited, or disallowed cancels', async () => {
    const machine = createApp({ actorType: 'machine' });
    const machineResponse = await machine.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/cancel',
      { method: 'POST', headers: { 'idempotency-key': 'cancel-machine' } },
      machine.env
    );
    expect(machineResponse.status).toBe(403);
    expect(machine.cancelProvisioningOperation).not.toHaveBeenCalled();

    audit.mockResolvedValueOnce(null);
    const unaudited = createApp();
    const unauditedResponse = await unaudited.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/cancel',
      { method: 'POST', headers: { 'idempotency-key': 'cancel-unaudited' } },
      unaudited.env
    );
    expect(unauditedResponse.status).toBe(503);
    expect(unaudited.cancelProvisioningOperation).not.toHaveBeenCalled();

    const disallowed = createApp({
      control: {
        cancelProvisioningOperation: vi.fn(async () => {
          throw new Error('control_operation_cancel_not_allowed');
        }),
      },
    });
    const disallowedResponse = await disallowed.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/cancel',
      { method: 'POST', headers: { 'idempotency-key': 'cancel-disallowed' } },
      disallowed.env
    );
    expect(disallowedResponse.status).toBe(409);
    await expect(disallowedResponse.json()).resolves.toMatchObject({
      error: 'CONTROL_PLANE_OPERATION_CANCEL_NOT_ALLOWED',
    });
  });

  it('audits before requesting a guarded previous-settings restore', async () => {
    const target = createApp({
      control: { getProvisioningOperation: vi.fn(async () => restoreEligibleOperation) },
    });
    const response = await target.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/restore-previous-settings',
      {
        method: 'POST',
        headers: { 'idempotency-key': 'operation-restore-1' },
      },
      target.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: restoreRequestedOperation,
      auditId: 'audit-1',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'control_plane.operation.restore_previous_settings_requested',
        resourceId: 'operation-1',
        before: { status: 'blocked', bindingState: 'blocked' },
        after: { status: 'running', bindingState: 'rollback_required' },
        metadata: {
          execution: 'control_service_binding_reconciler',
          reasonCode: 'operator_restore_previous_settings',
          settingsSnapshotExposed: false,
        },
      })
    );
    expect(target.restoreProvisioningOperationPreviousSettings).toHaveBeenCalledWith({
      operationId: 'operation-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_restore_previous_settings',
      idempotencyKey: 'operation-restore-1',
    });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      target.restoreProvisioningOperationPreviousSettings.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('fails closed before restore for non-human, unaudited, or disallowed requests', async () => {
    const machine = createApp({ actorType: 'machine' });
    const machineResponse = await machine.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/restore-previous-settings',
      { method: 'POST', headers: { 'idempotency-key': 'restore-machine' } },
      machine.env
    );
    expect(machineResponse.status).toBe(403);
    expect(machine.restoreProvisioningOperationPreviousSettings).not.toHaveBeenCalled();

    audit.mockResolvedValueOnce(null);
    const unaudited = createApp();
    const unauditedResponse = await unaudited.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/restore-previous-settings',
      { method: 'POST', headers: { 'idempotency-key': 'restore-unaudited' } },
      unaudited.env
    );
    expect(unauditedResponse.status).toBe(503);
    expect(unaudited.restoreProvisioningOperationPreviousSettings).not.toHaveBeenCalled();

    const disallowed = createApp({
      control: {
        restoreProvisioningOperationPreviousSettings: vi.fn(async () => {
          throw new Error('control_operation_restore_not_allowed');
        }),
      },
    });
    const disallowedResponse = await disallowed.app.request(
      '/api/admin/platform/control-plane/operations/operation-1/restore-previous-settings',
      { method: 'POST', headers: { 'idempotency-key': 'restore-disallowed' } },
      disallowed.env
    );
    expect(disallowedResponse.status).toBe(409);
    await expect(disallowedResponse.json()).resolves.toMatchObject({
      error: 'CONTROL_PLANE_OPERATION_RESTORE_NOT_ALLOWED',
    });
  });

  it('fails closed before Control for non-human, malformed, or unaudited requests', async () => {
    const machine = createApp({ actorType: 'machine' });
    const machineResponse = await machine.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-machine' },
        body: JSON.stringify({ disposition: 'reviewed' }),
      },
      machine.env
    );
    expect(machineResponse.status).toBe(403);

    const malformed = createApp();
    const malformedResponse = await malformed.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-malformed' },
        body: JSON.stringify({ disposition: 'reviewed', apiToken: 'forbidden' }),
      },
      malformed.env
    );
    expect(malformedResponse.status).toBe(400);

    audit.mockResolvedValueOnce(null);
    const unaudited = createApp();
    const unauditedResponse = await unaudited.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-unaudited' },
        body: JSON.stringify({ disposition: 'dismissed' }),
      },
      unaudited.env
    );
    expect(unauditedResponse.status).toBe(503);
    expect(unaudited.reviewWorkerInventoryDriftFinding).not.toHaveBeenCalled();

    audit.mockRejectedValueOnce(new Error('audit_storage_unavailable'));
    const auditFailure = createApp();
    const auditFailureResponse = await auditFailure.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-audit-error' },
        body: JSON.stringify({ disposition: 'dismissed' }),
      },
      auditFailure.env
    );
    expect(auditFailureResponse.status).toBe(503);
    expect(auditFailure.reviewWorkerInventoryDriftFinding).not.toHaveBeenCalled();
  });

  it('rejects cross-environment and secret-bearing Control responses', async () => {
    const crossEnvironment = createApp({
      control: {
        listWorkerInventoryDriftFindings: vi.fn(async () => [
          {
            ...finding,
            environmentId: 'other',
            findingId: 'drift:other:actual_only:test-unmanaged',
          },
        ]),
      },
    });
    const crossResponse = await crossEnvironment.app.request(
      '/api/admin/platform/control-plane/drift-findings',
      {},
      crossEnvironment.env
    );
    expect(crossResponse.status).toBe(503);

    const secretBearing = createApp({
      control: {
        listWorkerInventoryDriftFindings: vi.fn(async () => [
          { ...finding, cloudflareApiToken: 'secret' },
        ]) as NonNullable<Env['CONTROL']>['listWorkerInventoryDriftFindings'],
      },
    });
    const secretResponse = await secretBearing.app.request(
      '/api/admin/platform/control-plane/drift-findings',
      {},
      secretBearing.env
    );
    expect(secretResponse.status).toBe(503);

    const duplicated = createApp({
      control: {
        listWorkerInventoryDriftFindings: vi.fn(async () => [finding, finding]),
      },
    });
    const duplicatedResponse = await duplicated.app.request(
      '/api/admin/platform/control-plane/drift-findings',
      {},
      duplicated.env
    );
    expect(duplicatedResponse.status).toBe(503);

    const invalidEnvironment = createApp({ environmentId: '../invalid' });
    const invalidEnvironmentResponse = await invalidEnvironment.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-invalid-env' },
        body: JSON.stringify({ disposition: 'reviewed' }),
      },
      invalidEnvironment.env
    );
    expect(invalidEnvironmentResponse.status).toBe(503);
    expect(invalidEnvironment.reviewWorkerInventoryDriftFinding).not.toHaveBeenCalled();
  });

  it('maps review conflicts and missing Control capabilities to stable errors', async () => {
    const conflict = createApp({
      control: {
        reviewWorkerInventoryDriftFinding: vi.fn(async () => {
          throw new Error('control_worker_inventory_drift_review_conflict');
        }),
      },
    });
    const conflictResponse = await conflict.app.request(
      `/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(finding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-conflict' },
        body: JSON.stringify({ disposition: 'reviewed' }),
      },
      conflict.env
    );
    expect(conflictResponse.status).toBe(409);

    const unavailable = createApp({
      control: {
        listWorkerInventoryDriftFindings: undefined,
        reviewWorkerInventoryDriftFinding: undefined,
      },
    });
    const unavailableResponse = await unavailable.app.request(
      '/api/admin/platform/control-plane/drift-findings',
      {},
      unavailable.env
    );
    expect(unavailableResponse.status).toBe(503);
  });

  it('lists strict shard cleanup candidates and starts quarantine with durable audit first', async () => {
    const target = createApp();
    const list = await target.app.request(
      '/api/admin/platform/control-plane/shard-cleanup',
      {},
      target.env
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ items: [cleanupCandidate], count: 1 });

    const failedTarget = createApp({
      control: {
        listShardCleanupCandidates: vi.fn(
          async (): Promise<ControlShardCleanupView[]> => [
            {
              ...cleanupCandidate,
              shardStatus: 'failed',
              quarantineOperationId: null,
              quarantineState: 'none',
              quarantineOperationState: null,
              denyRegistryGeneration: null,
              drainNotBefore: null,
              registryVerifiedAt: null,
              referencesVerifiedAt: null,
              availableActions: ['quarantine'],
            },
          ]
        ),
      },
    });
    const failedList = await failedTarget.app.request(
      '/api/admin/platform/control-plane/shard-cleanup',
      {},
      failedTarget.env
    );
    expect(failedList.status).toBe(200);

    const preActivationQuarantine = createApp({
      control: {
        listShardCleanupCandidates: vi.fn(
          async (): Promise<ControlShardCleanupView[]> => [
            {
              ...cleanupCandidate,
              shardStatus: 'failed',
              quarantineOperationId: 'quarantine-pre-activation',
              quarantineState: 'quarantining',
              quarantineOperationState: 'draining',
              denyRegistryGeneration: 0,
              drainNotBefore: 1_800_001_800,
              registryVerifiedAt: null,
              referencesVerifiedAt: null,
              availableActions: [],
            },
          ]
        ),
      },
    });
    const preActivationList = await preActivationQuarantine.app.request(
      '/api/admin/platform/control-plane/shard-cleanup',
      {},
      preActivationQuarantine.env
    );
    expect(preActivationList.status).toBe(200);

    const response = await target.app.request(
      '/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/quarantine',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'quarantine-request-1',
        },
        body: '{}',
      },
      target.env
    );
    expect(response.status).toBe(202);
    expect(target.quarantineShard).toHaveBeenCalledWith({
      shardId: 'retired-shard-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_quarantine',
      idempotencyKey: 'quarantine-request-1',
    });
    expect(audit).toHaveBeenCalledBefore(target.quarantineShard);
  });

  it('approves destructive cleanup only for a human with exact confirmation and export evidence', async () => {
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/approve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'cleanup-approval-1',
        },
        body: JSON.stringify({
          quarantineOperationId: cleanupCandidate.quarantineOperationId,
          confirmation: 'DELETE_RETIRED_TENANT_SHARD',
          exportMode: 'manual_verified',
          exportEvidenceId: 'export-evidence-1',
          deleteDatabase: true,
        }),
      },
      target.env
    );
    expect(response.status).toBe(202);
    expect(target.approveShardCleanup).toHaveBeenCalledWith({
      quarantineOperationId: 'quarantine-operation-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_approve_cleanup',
      idempotencyKey: 'cleanup-approval-1',
      confirmation: 'DELETE_RETIRED_TENANT_SHARD',
      exportMode: 'manual_verified',
      exportEvidenceId: 'export-evidence-1',
      deleteDatabase: true,
    });

    const machine = createApp({ actorType: 'machine', permissions: ['admin:*'] });
    const denied = await machine.app.request(
      '/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/approve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'cleanup-machine-denied',
        },
        body: JSON.stringify({
          quarantineOperationId: cleanupCandidate.quarantineOperationId,
          confirmation: 'DELETE_RETIRED_TENANT_SHARD',
          exportMode: 'skipped',
          exportEvidenceId: null,
          deleteDatabase: true,
        }),
      },
      machine.env
    );
    expect(denied.status).toBe(403);
    expect(machine.approveShardCleanup).not.toHaveBeenCalled();

    const invalidEvidence = createApp();
    const invalid = await invalidEvidence.app.request(
      '/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/approve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'cleanup-invalid-evidence',
        },
        body: JSON.stringify({
          quarantineOperationId: cleanupCandidate.quarantineOperationId,
          confirmation: 'DELETE_RETIRED_TENANT_SHARD',
          exportMode: 'manual_verified',
          exportEvidenceId: null,
          deleteDatabase: true,
        }),
      },
      invalidEvidence.env
    );
    expect(invalid.status).toBe(400);
    expect(invalidEvidence.approveShardCleanup).not.toHaveBeenCalled();
  });

  it('does not mutate shard cleanup state when audit persistence fails', async () => {
    audit.mockRejectedValueOnce(new Error('audit_storage_unavailable'));
    const target = createApp();
    const response = await target.app.request(
      '/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/retry-quarantine',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'retry-quarantine-audit-failure',
        },
        body: JSON.stringify({ quarantineOperationId: 'quarantine-operation-1' }),
      },
      target.env
    );
    expect(response.status).toBe(503);
    expect(target.retryShardQuarantine).not.toHaveBeenCalled();
  });

  it('rejects malformed or cross-environment shard cleanup responses and maps conflicts', async () => {
    const crossEnvironment = createApp({
      control: {
        listShardCleanupCandidates: vi.fn(async () => [
          { ...cleanupCandidate, environmentId: 'other' },
        ]),
      },
    });
    const crossResponse = await crossEnvironment.app.request(
      '/api/admin/platform/control-plane/shard-cleanup',
      {},
      crossEnvironment.env
    );
    expect(crossResponse.status).toBe(503);

    const secretBearing = createApp({
      control: {
        listShardCleanupCandidates: vi.fn(async () => [
          { ...cleanupCandidate, cloudflareApiToken: 'forbidden' },
        ]) as NonNullable<Env['CONTROL']>['listShardCleanupCandidates'],
      },
    });
    const secretResponse = await secretBearing.app.request(
      '/api/admin/platform/control-plane/shard-cleanup',
      {},
      secretBearing.env
    );
    expect(secretResponse.status).toBe(503);

    const conflict = createApp({
      control: {
        retryShardCleanup: vi.fn(async () => {
          throw new Error('shard_cleanup_not_ready');
        }),
      },
    });
    const conflictResponse = await conflict.app.request(
      '/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/retry-cleanup',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'retry-cleanup-conflict',
        },
        body: JSON.stringify({ cleanupOperationId: 'cleanup-operation-1' }),
      },
      conflict.env
    );
    expect(conflictResponse.status).toBe(409);
  });
});
