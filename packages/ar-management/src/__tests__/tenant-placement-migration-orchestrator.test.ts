import type { ControlTenantPlacementMigrationView, Env } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TenantPlacementMigrationJobLease,
  TenantPlacementMigrationJobRepository,
  TenantPlacementMigrationJobView,
} from '../tenant-placement-migration-job';

const mocks = vi.hoisted(() => ({ processLookup: vi.fn() }));

vi.mock('../tenant-placement-lookup-cutover', () => ({
  processTenantPlacementLookupCutoverPage: mocks.processLookup,
}));

import { runTenantPlacementMigrationSaga } from '../tenant-placement-migration-orchestrator';

function migration(
  state: ControlTenantPlacementMigrationView['state'],
  routeCutoverStarted: boolean
): ControlTenantPlacementMigrationView {
  const shardState = state === 'cutover_ready' ? 'write_fenced' : 'cutover_committed';
  return {
    operationId: 'control-a',
    tenantId: 'tenant-a',
    state,
    sourceIsolationPolicy: 'shared_pool',
    targetIsolationPolicy: 'tenant_exclusive',
    sourcePolicyGeneration: 1,
    targetPolicyGeneration: 2,
    writeFenceState: 'active',
    routeCutoverStarted,
    canCancel: !routeCutoverStarted,
    canApprovePurge: false,
    sourceRetentionExpiresAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    shards: (['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const).map(
      (dataRole, index) => ({
        dataRole,
        residencyPolicyId: 'builtin:residency:default',
        residencyPartition: 'default',
        sourceShardId: `source-${index}`,
        sourceAssignmentGeneration: 1,
        targetShardId: `target-${index}`,
        target: {
          shardId: `target-${index}`,
          assignmentGeneration: 2,
          routeGeneration: 2,
          bindingRef: `TDB_TARGET_${index}`,
          databaseId: `target-db-${index}`,
          databaseName: `target-db-${index}`,
        },
        state: shardState,
        inventoryTableCount: 1,
        sourceRowCount: 1,
        targetRowCount: 1,
        lastObservedSourceSequence: 0,
        lastAppliedSourceSequence: 0,
        lastErrorCode: null,
        updatedAt: 1,
      })
    ),
  };
}

function job(): TenantPlacementMigrationJobView {
  return {
    operationId: 'job-a',
    environmentId: 'test',
    tenantId: 'tenant-a',
    controlOperationId: 'control-a',
    targetIsolationPolicy: 'tenant_exclusive',
    status: 'running',
    currentStep: 'wait_control',
    lookupCursor: null,
    lookupPreparedRowCount: 0,
    lookupActivatedRowCount: 0,
    lookupVerifiedRowCount: 0,
    requestHash: 'a'.repeat(64),
    idempotencyKey: 'request-a',
    attemptCount: 1,
    retryBudgetStartedAt: 1,
    nextAttemptAt: null,
    lastErrorCode: null,
    fencingToken: 1,
    requestedBy: 'admin-a',
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
  };
}

describe('tenant placement migration orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processLookup.mockResolvedValue({
      phase: 'prepare',
      processedRows: 2,
      complete: true,
      cursor: null,
    });
  });

  it('runs the fail-closed route activation sequence before source quarantine', async () => {
    const order: string[] = [];
    const ready = migration('cutover_ready', false);
    const leased = migration('cutover_ready', true);
    const committed = migration('cutover_committed', true);
    const finalized = {
      ...committed,
      state: 'source_quarantined' as const,
      writeFenceState: 'released' as const,
      routeCutoverStarted: false,
    };
    const control = {
      getTenantPlacementMigration: vi.fn(async () => ready),
      beginTenantPlacementRouteCutover: vi.fn(async () => {
        order.push('lease');
        return leased;
      }),
      commitTenantPlacementMigration: vi.fn(async () => {
        order.push('commit');
        return committed;
      }),
      finalizeTenantPlacementMigrationCutover: vi.fn(async () => {
        order.push('finalize');
        return finalized;
      }),
    };
    mocks.processLookup.mockImplementation(async (_env, input: { phase: string }) => {
      order.push(`lookup:${input.phase}`);
      return { phase: input.phase, processedRows: 2, complete: true, cursor: null };
    });
    const checkpoint = vi.fn(async () => {});
    const repository = { checkpoint } as unknown as TenantPlacementMigrationJobRepository;
    const lease: TenantPlacementMigrationJobLease = {
      job: job(),
      ownerId: 'worker-a',
      fencingToken: 1,
    };

    await runTenantPlacementMigrationSaga({
      env: { CONTROL: control } as unknown as Env,
      repository,
      lease,
      dependencies: {
        prepareAlias: vi.fn(async () => {
          order.push('alias:prepare');
        }),
        publishRegistry: vi.fn(async () => {
          order.push('registry');
        }),
        activateAlias: vi.fn(async () => {
          order.push('alias:activate');
        }),
      },
      now: () => 10,
    });

    expect(order).toEqual([
      'lease',
      'lease',
      'lookup:prepare',
      'alias:prepare',
      'commit',
      'registry',
      'alias:activate',
      'lookup:activate',
      'lookup:verify',
      'finalize',
    ]);
    expect(checkpoint).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        currentStep: 'finalize_source',
        nextStep: 'complete',
        status: 'succeeded',
      })
    );
  });

  it('blocks a route outside the frozen migration inventory', async () => {
    const ready = migration('cutover_ready', true);
    mocks.processLookup.mockRejectedValueOnce(
      new Error('tenant_placement_lookup_source_route_unmapped')
    );
    const checkpoint = vi.fn(async () => {});
    const lease: TenantPlacementMigrationJobLease = {
      job: { ...job(), currentStep: 'prepare_lookup' },
      ownerId: 'worker-a',
      fencingToken: 1,
    };

    await runTenantPlacementMigrationSaga({
      env: {
        CONTROL: {
          getTenantPlacementMigration: vi.fn(async () => ready),
          beginTenantPlacementRouteCutover: vi.fn(async () => ready),
          commitTenantPlacementMigration: vi.fn(),
          finalizeTenantPlacementMigrationCutover: vi.fn(),
        },
      } as unknown as Env,
      repository: { checkpoint } as unknown as TenantPlacementMigrationJobRepository,
      lease,
      dependencies: {
        prepareAlias: vi.fn(),
        publishRegistry: vi.fn(),
        activateAlias: vi.fn(),
      },
      now: () => 10,
    });

    expect(checkpoint).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        currentStep: 'prepare_lookup',
        status: 'blocked',
        errorCode: 'tenant_placement_lookup_source_route_unmapped',
      })
    );
  });

  it.each([
    [
      'unknown migration state',
      (value: ControlTenantPlacementMigrationView) => {
        value.state = 'unexpected' as ControlTenantPlacementMigrationView['state'];
      },
    ],
    [
      'unsafe target binding',
      (value: ControlTenantPlacementMigrationView) => {
        value.shards[0].target!.bindingRef = 'unsafe-binding';
      },
    ],
    [
      'duplicate default role',
      (value: ControlTenantPlacementMigrationView) => {
        value.shards[1].dataRole = 'tenant_core/default';
      },
    ],
    [
      'target shard mismatch',
      (value: ControlTenantPlacementMigrationView) => {
        value.shards[0].target!.shardId = 'different-target';
      },
    ],
    [
      'cancelable migration after route cutover starts',
      (value: ControlTenantPlacementMigrationView) => {
        value.canCancel = true;
      },
    ],
  ])('blocks a malformed Control response with %s', async (_name, mutate) => {
    const malformed = structuredClone(migration('cutover_ready', true));
    mutate(malformed);
    const checkpoint = vi.fn(async () => {});
    const lease: TenantPlacementMigrationJobLease = {
      job: { ...job(), currentStep: 'prepare_lookup' },
      ownerId: 'worker-a',
      fencingToken: 1,
    };

    await runTenantPlacementMigrationSaga({
      env: {
        CONTROL: {
          getTenantPlacementMigration: vi.fn(async () => malformed),
          beginTenantPlacementRouteCutover: vi.fn(),
          commitTenantPlacementMigration: vi.fn(),
          finalizeTenantPlacementMigrationCutover: vi.fn(),
        },
      } as unknown as Env,
      repository: { checkpoint } as unknown as TenantPlacementMigrationJobRepository,
      lease,
      dependencies: {
        prepareAlias: vi.fn(),
        publishRegistry: vi.fn(),
        activateAlias: vi.fn(),
      },
      now: () => 10,
    });

    expect(mocks.processLookup).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        currentStep: 'prepare_lookup',
        status: 'blocked',
        errorCode: 'tenant_placement_migration_control_response_invalid',
      })
    );
  });
});
