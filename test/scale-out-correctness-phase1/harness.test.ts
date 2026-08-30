import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildControlQueryBatch,
  diffControlSnapshots,
  diffProviderSnapshots,
  observePhase1,
  phase1ObservationRetryCode,
} from './observe.js';
import { buildPhase1CleanupPlan } from './cleanup.js';
import { evaluatePhase1Preflight } from './preflight.js';
import { PHASE1_PREPARE_CONFIRMATION, preparePhase1Policy } from './prepare.js';
import { buildPhase1ProvisioningEvidence, buildPhase1Report } from './report.js';
import {
  executePhase1Harness,
  phase1ResumeAccountIndices,
  runAccountCreation,
  type Phase1AccountResult,
} from './run.js';
import {
  PHASE1_EXECUTION_CONFIRMATION,
  assertPhase1EvidenceIsSecretFree,
  deriveLogicalAccountIdentity,
  parsePhase1HarnessConfig,
  redactPhase1Config,
  sha256,
  type Phase1ControlSnapshot,
  type Phase1HarnessConfig,
  type Phase1IntegrityResult,
  type Phase1ProviderSnapshot,
  type Phase1RequestEvent,
} from './schemas.js';
import {
  countInProgressControlOperations,
  countManualInterventions,
  countNewBlockedCapacityOperations,
  countRoleBoundaryCrossings,
  duplicateForecastDecisions,
  evaluateRoleProvisioningBound,
  normalizePhase1EpochSeconds,
  recomputeLookupForecastTransition,
  reconcilePublicationCounterSeries,
  verifyLookupForecastEvents,
  waitForExactLookupRouteReadiness,
  waitForPhase1Quiescence,
} from './verify.js';

function config(overrides: Partial<Phase1HarnessConfig['load']> = {}): Phase1HarnessConfig {
  const attestedAt = new Date().toISOString();
  return parsePhase1HarnessConfig({
    schemaVersion: 1,
    profile: 'custom',
    environment: {
      environmentId: 'phase1-test',
      baseUrl: 'https://phase1.example.invalid/',
      tenantId: 'tenant-test',
      placementPolicy: 'shared_pool',
      disposable: true,
      executionConfirmation: PHASE1_EXECUTION_CONFIRMATION,
      emailDomain: 'accounts.phase1.test.invalid',
      sourceCommit: 'abcdef0',
      controlDatabaseId: 'control-database-id',
    },
    credentials: {
      adminTokenEnv: 'AUTHRIM_PHASE1_ADMIN_TOKEN',
      cloudflareAccountIdEnv: 'AUTHRIM_PHASE1_CLOUDFLARE_ACCOUNT_ID',
      cloudflareD1ReadTokenEnv: 'AUTHRIM_PHASE1_D1_READ_TOKEN',
      cloudflareD1WriteTokenEnv: 'AUTHRIM_PHASE1_D1_WRITE_TOKEN',
      seedEnv: 'AUTHRIM_PHASE1_SEED',
    },
    load: {
      accountCount: 2,
      ratePerSecond: 2,
      maximumInFlight: 2,
      retryWindowSeconds: 30,
      requestTimeoutMs: 1_000,
      ...overrides,
    },
    expectedPolicy: {
      targetAccountCount: 100,
      maxConcurrentProvisioning: 8,
      maxReadySpares: 1,
      maxD1Resources: 100,
      dailyD1CreateBudget: 50,
      lookupTargetActiveRouteCount: 250,
      lookupForecastHorizonSeconds: 300,
      lookupEwmaAlphaBps: 2_500,
      lookupHeadroomBps: 2_000,
      lookupPolicyGeneration: 2,
      expectedLookupRoutesPerAccount: 2,
      minimumLookupAdditions: 1,
      minimumLookupUsedAssignmentTransitions: 1,
      minimumRoleBoundaryCrossings: 1,
    },
    observation: {
      controlIntervalMs: 250,
      providerIntervalMs: 250,
      quiescenceTimeoutSeconds: 10,
      quiescenceStableWindows: 2,
    },
    attestations: {
      workersPaidPlan: true,
      scheduledTriggerLastSucceededAt: attestedAt,
      noManualInterventionFrom: attestedAt,
    },
  });
}

function snapshot(): Phase1ControlSnapshot {
  return {
    schemaVersion: 1,
    observedAt: '2026-08-27T00:00:00.000Z',
    environment: {
      environment_id: 'phase1-test',
      environment_name: 'phase1-test',
      lifecycle_state: 'active',
      automatic_provisioning_enabled: 1,
      provisioning_capability_state: 'ready',
      provisioning_token_ownership: 'account',
      active_tenant_count: 1,
      current_environment_d1_count: 4,
      daily_d1_create_used: 0,
    },
    resourcePolicy: {
      target_account_count: 100,
      max_concurrent_provisioning: 8,
      max_ready_spares: 1,
      max_d1_resources: 100,
      daily_d1_create_budget: 50,
      lookup_target_active_route_count: 250,
      lookup_forecast_horizon_seconds: 300,
      lookup_registration_ewma_alpha_bps: 2_500,
      lookup_scale_out_headroom_bps: 2_000,
      lookup_scale_out_policy_generation: 2,
    },
    tenantPolicy: {
      tenant_id: 'tenant-test',
      isolation_policy: 'shared_pool',
      policy_state: 'active',
    },
    residencyPartitions: [
      {
        residency_policy_id: 'default',
        residency_partition: 'default',
        lookup_capacity_domain_id: 'lookup:default',
        jurisdiction: null,
        location_hint: null,
        status: 'active',
      },
    ],
    shardCapacities: [
      {
        shard_id: 'default-core-1',
        data_role: 'tenant_core/default',
        allocation_scope: 'shared_pool',
        status: 'active',
        target_account_count: 100,
        allocated_account_count: 0,
        observed_account_count: 0,
        health_status: 'healthy',
        allocation_status: 'eligible',
        d1_desired_resource_id: 'default-core-desired',
        deterministic_name: 'default-core',
        provider_resource_id: 'default-core-db',
      },
      {
        shard_id: 'core-1',
        data_role: 'tenant_core/users',
        allocation_scope: 'shared_pool',
        status: 'active',
        target_account_count: 100,
        allocated_account_count: 0,
        observed_account_count: 0,
        health_status: 'healthy',
        allocation_status: 'eligible',
        d1_desired_resource_id: 'core-desired',
        deterministic_name: 'core',
        provider_resource_id: 'core-db',
      },
      {
        shard_id: 'pii-1',
        data_role: 'tenant_pii',
        allocation_scope: 'shared_pool',
        status: 'active',
        target_account_count: 100,
        allocated_account_count: 0,
        observed_account_count: 0,
        health_status: 'healthy',
        allocation_status: 'eligible',
        d1_desired_resource_id: 'pii-desired',
        deterministic_name: 'pii',
        provider_resource_id: 'pii-db',
      },
    ],
    tenantAssignments: [
      {
        data_role: 'tenant_core/default',
        assignment_state: 'active',
        assignment_generation: 1,
        shard_id: 'default-core-1',
      },
      {
        data_role: 'tenant_core/users',
        assignment_state: 'active',
        assignment_generation: 1,
        shard_id: 'core-1',
      },
      {
        data_role: 'tenant_pii',
        assignment_state: 'active',
        assignment_generation: 1,
        shard_id: 'pii-1',
      },
    ],
    tenantAllocations: [
      {
        row_kind: 'summary',
        data_role: null,
        selected_shard_id: null,
        reservation_state: null,
        allocation_count: 0,
        distinct_account_count: 0,
        invalid_state_count: 0,
        missing_capacity_count: 0,
        invalid_shard_count: 0,
        invalid_account_role_count: 0,
      },
    ],
    operations: [],
    operationSteps: [],
    desiredResources: [
      { desired_resource_id: 'default-core-desired', deterministic_name: 'default-core' },
      { desired_resource_id: 'core-desired', deterministic_name: 'core' },
      { desired_resource_id: 'pii-desired', deterministic_name: 'pii' },
      { desired_resource_id: 'lookup-desired', deterministic_name: 'lookup' },
    ],
    observedResources: [
      {
        observed_resource_id: 'core-observed',
        desired_resource_id: 'core-desired',
        provider_resource_id: 'core-db',
        observed_state: 'present',
      },
      {
        observed_resource_id: 'pii-observed',
        desired_resource_id: 'pii-desired',
        provider_resource_id: 'pii-db',
        observed_state: 'present',
      },
      {
        observed_resource_id: 'lookup-observed',
        desired_resource_id: 'lookup-desired',
        provider_resource_id: 'lookup-db',
        observed_state: 'present',
      },
    ],
    lookupForecasts: [],
    accountForecasts: [],
    lookupShards: [
      {
        lookup_shard_id: 'lookup-1',
        status: 'active',
        capacity_weight: 1,
        d1_desired_resource_id: 'lookup-desired',
        deterministic_name: 'lookup',
        provider_resource_id: 'lookup-db',
      },
    ],
    lookupAssignments: Array.from({ length: 4_096 }, (_, virtualBucket) => ({
      virtual_bucket: virtualBucket,
      lookup_shard_id: 'lookup-1',
      assignment_generation: 1,
      state: 'active',
    })),
    workerBindingDrift: [],
  };
}

function provider(): Phase1ProviderSnapshot {
  return {
    schemaVersion: 1,
    observedAt: '2026-08-27T00:00:00.000Z',
    databases: [
      {
        uuid: 'default-core-db',
        name: 'phase1-test-authrim-tenant-default-core',
        createdAt: null,
        fileSize: 1,
      },
      {
        uuid: 'core-db',
        name: 'phase1-test-authrim-tenant-users-core',
        createdAt: null,
        fileSize: 1,
      },
      {
        uuid: 'pii-db',
        name: 'phase1-test-authrim-tenant-pii',
        createdAt: null,
        fileSize: 1,
      },
      {
        uuid: 'lookup-db',
        name: 'phase1-test-authrim-tenant-lookup',
        createdAt: null,
        fileSize: 1,
      },
    ],
  };
}

describe('Phase 1 evidence contracts', () => {
  it('pins the publishable scenario profile to 5,000 accounts', () => {
    const standard = structuredClone(config());
    standard.profile = 'standard';
    standard.load.accountCount = 5_000;

    expect(parsePhase1HarnessConfig(standard).load.accountCount).toBe(5_000);
    standard.load.accountCount = 1_000;
    expect(() => parsePhase1HarnessConfig(standard)).toThrow(
      'phase1_standard_account_count_mismatch'
    );
  });

  it('pins the reduced main demonstration to 50,000 accounts', () => {
    const main = structuredClone(config());
    main.profile = 'main';
    main.load.accountCount = 50_000;

    expect(parsePhase1HarnessConfig(main).load.accountCount).toBe(50_000);
    main.load.accountCount = 100_000;
    expect(() => parsePhase1HarnessConfig(main)).toThrow('phase1_main_account_count_mismatch');
  });

  it('rejects a policy that disables automatic account shard replenishment', () => {
    const invalid = structuredClone(config());
    invalid.expectedPolicy.maxReadySpares = 0;

    expect(() => parsePhase1HarnessConfig(invalid)).toThrow('phase1_ready_spares_invalid');
  });

  it('rejects a provisioning concurrency outside the Control policy range', () => {
    const invalid = structuredClone(config());
    invalid.expectedPolicy.maxConcurrentProvisioning = 33;

    expect(() => parsePhase1HarnessConfig(invalid)).toThrow(
      'phase1_max_concurrent_provisioning_invalid'
    );
  });

  it('rejects a retry window shorter than the quiescence timeout', () => {
    const invalid = structuredClone(config());
    invalid.load.retryWindowSeconds = 9;
    invalid.observation.quiescenceTimeoutSeconds = 10;

    expect(() => parsePhase1HarnessConfig(invalid)).toThrow(
      'phase1_retry_window_below_quiescence_timeout'
    );
  });

  it('accepts ready user-owned automatic provisioning credentials', () => {
    const control = snapshot();
    if (control.environment) control.environment.provisioning_token_ownership = 'user';
    const baseline = evaluatePhase1Preflight({
      config: config(),
      control,
      provider: provider(),
      runId: 'run-user-token',
      now: new Date(),
    });
    expect(
      baseline.preflight.checks.find((check) => check.name === 'automatic_provisioning_ready')
        ?.passed
    ).toBe(true);
  });

  it('accepts a selected exclusive tenant in a mixed-placement environment', () => {
    const exclusiveConfig = config();
    exclusiveConfig.environment.placementPolicy = 'tenant_exclusive';
    const control = snapshot();
    if (!control.environment || !control.tenantPolicy) {
      throw new Error('phase1_test_snapshot_incomplete');
    }
    control.environment.active_tenant_count = 2;
    control.tenantPolicy.isolation_policy = 'tenant_exclusive';
    for (const shard of control.shardCapacities) {
      if (shard.data_role === 'tenant_core/users' || shard.data_role === 'tenant_pii') {
        shard.allocation_scope = 'tenant_exclusive';
        shard.owner_tenant_id = exclusiveConfig.environment.tenantId;
      }
    }

    const baseline = evaluatePhase1Preflight({
      config: exclusiveConfig,
      control,
      provider: provider(),
      runId: 'run-exclusive',
      now: new Date(),
    });

    expect(
      baseline.preflight.checks.find((check) => check.name === 'tenant_placement_active')?.passed
    ).toBe(true);
    expect(
      baseline.preflight.checks.find((check) => check.name === 'selected_tenant_is_active')?.passed
    ).toBe(true);
  });

  it('rejects a tenant with existing allocations as a publishable clean baseline', () => {
    const control = snapshot();
    const allocationSummary = control.tenantAllocations[0];
    if (!allocationSummary) throw new Error('fixture_allocation_summary_missing');
    allocationSummary.allocation_count = 2;
    allocationSummary.distinct_account_count = 1;

    const baseline = evaluatePhase1Preflight({
      config: config(),
      control,
      provider: provider(),
      runId: 'run-dirty-allocation-baseline',
      now: new Date(),
    });

    expect(
      baseline.preflight.checks.find((check) => check.name === 'clean_tenant_allocation_baseline')
        ?.passed
    ).toBe(false);
  });

  it('rejects a run when the remaining daily D1 create budget is insufficient', () => {
    const control = snapshot();
    if (!control.environment) throw new Error('fixture_environment_missing');
    control.environment.daily_d1_create_used = 49;

    const baseline = evaluatePhase1Preflight({
      config: config(),
      control,
      provider: provider(),
      runId: 'run-exhausted-daily-budget',
      now: new Date(),
    });

    expect(
      baseline.preflight.checks.find((check) => check.name === 'remaining_daily_d1_create_budget')
    ).toMatchObject({ passed: false });
  });

  it('uses the environment-managed D1 count instead of unrelated account inventory', () => {
    const providerSnapshot = provider();
    providerSnapshot.databases.push(
      ...Array.from({ length: 200 }, (_, index) => ({
        uuid: `unrelated-${index}`,
        name: `another-app-${index}`,
        createdAt: null,
        fileSize: 1,
      }))
    );

    const baseline = evaluatePhase1Preflight({
      config: config(),
      control: snapshot(),
      provider: providerSnapshot,
      runId: 'run-account-inventory-noise',
      now: new Date(),
    });

    expect(
      baseline.preflight.checks.find((check) => check.name === 'environment_d1_resource_limit')
    ).toMatchObject({ passed: true });
  });

  it('observes allocation integrity as bounded aggregates instead of raw account rows', () => {
    const allocationStatement = buildControlQueryBatch(config()).find((statement) =>
      statement.sql.includes("'summary' AS row_kind")
    );
    const allocationQuery = allocationStatement?.sql ?? '';

    expect(allocationQuery).toContain("'summary' AS row_kind");
    expect(allocationQuery).toContain('COUNT(DISTINCT account_id_blind_digest)');
    expect(allocationQuery).toContain("a.data_role IN ('tenant_core/users', 'tenant_pii')");
    expect(allocationQuery).not.toMatch(/SELECT\s+allocation_id/iu);
    expect(allocationStatement?.params).toEqual(['phase1-test', 'tenant-test', 1]);
    expect(
      buildControlQueryBatch(config(), { includeTenantAllocations: false }).find((statement) =>
        statement.sql.includes("'summary' AS row_kind")
      )?.params
    ).toEqual(['phase1-test', 'tenant-test', 0]);
  });

  it('ignores historical blocked operations but rejects blocks inside the intervention window', () => {
    const testConfig = config();
    const now = new Date(testConfig.attestations.noManualInterventionFrom);
    const control = snapshot();
    control.operations.push({ status: 'blocked', updated_at: 1 });
    const historical = evaluatePhase1Preflight({
      config: testConfig,
      control,
      provider: provider(),
      runId: 'historical-block',
      now,
    });
    expect(
      historical.preflight.checks.find(
        (check) => check.name === 'no_nonterminal_control_operations'
      )?.passed
    ).toBe(true);

    const blockedOperation = control.operations[0];
    if (!blockedOperation) throw new Error('fixture_blocked_operation_missing');
    blockedOperation.updated_at = Math.floor(now.getTime() / 1_000);
    const current = evaluatePhase1Preflight({
      config: testConfig,
      control,
      provider: provider(),
      runId: 'current-block',
      now,
    });
    expect(
      current.preflight.checks.find((check) => check.name === 'no_nonterminal_control_operations')
        ?.passed
    ).toBe(false);
  });

  it('prepares account and Lookup policies atomically and verifies exact readback', async () => {
    const previousPolicy = {
      environment_id: 'phase1-test',
      lifecycle_state: 'active',
      target_account_count: 100_000,
      max_concurrent_provisioning: 2,
      max_ready_spares: 1,
      max_d1_resources: 1_000,
      daily_d1_create_budget: 20,
      lookup_target_active_route_count: 100_000,
      lookup_forecast_horizon_seconds: 86_400,
      lookup_registration_ewma_alpha_bps: 2_500,
      lookup_scale_out_headroom_bps: 2_000,
      lookup_scale_out_policy_generation: 1,
    };
    const previousCapacities = [
      {
        shard_id: 'core-1',
        data_role: 'tenant_core/users',
        target_account_count: 100_000,
      },
      { shard_id: 'pii-1', data_role: 'tenant_pii', target_account_count: 100_000 },
    ];
    const desiredPolicy = {
      ...previousPolicy,
      target_account_count: 100,
      max_concurrent_provisioning: 8,
      max_d1_resources: 100,
      daily_d1_create_budget: 50,
      lookup_target_active_route_count: 250,
      lookup_forecast_horizon_seconds: 300,
      lookup_scale_out_policy_generation: 2,
    };
    const desiredCapacities = previousCapacities.map((row) => ({
      ...row,
      target_account_count: 100,
    }));
    let call = 0;
    const batches: ReadonlyArray<{ sql: string; params?: unknown[] }>[] = [];
    const client = {
      queryD1Batch: async (
        _databaseId: string,
        batch: ReadonlyArray<{ sql: string; params?: unknown[] }>
      ) => {
        batches.push(batch);
        call += 1;
        if (call === 1) {
          return [
            { success: true, results: [previousPolicy] },
            { success: true, results: previousCapacities },
          ];
        }
        if (call === 2) return batch.map(() => ({ success: true, results: [] }));
        return [
          { success: true, results: [desiredPolicy] },
          { success: true, results: desiredCapacities },
        ];
      },
    };

    const evidence = await preparePhase1Policy({
      config: config(),
      client,
      execute: true,
      confirmation: PHASE1_PREPARE_CONFIRMATION,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(evidence.executed).toBe(true);
    expect(evidence.previous.policy.lookup_scale_out_policy_generation).toBe(1);
    expect(evidence.requested.maxConcurrentProvisioning).toBe(8);
    expect(evidence.readback?.policy.lookup_scale_out_policy_generation).toBe(2);
    expect(batches[0]?.[1]?.params).toEqual([
      'phase1-test',
      'shared_pool',
      'shared_pool',
      'shared_pool',
      'tenant-test',
    ]);
    expect(batches[1]).toHaveLength(3);
    expect(batches[1]?.[0]?.params?.[1]).toBe(8);
    expect(batches[1]?.[0]?.sql).toContain(
      'lookup_scale_out_policy_generation = ?, updated_at = ?'
    );
    expect(
      batches[1]?.slice(1).every((query) => query.sql.includes('control_shard_capacity'))
    ).toBe(true);
  });

  it('rejects policy preparation when the requested generation skips ahead', async () => {
    const requested = config();
    requested.expectedPolicy.lookupPolicyGeneration = 4;
    const client = {
      queryD1Batch: async () => [
        {
          success: true,
          results: [
            {
              environment_id: 'phase1-test',
              lifecycle_state: 'active',
              target_account_count: 100_000,
              max_concurrent_provisioning: 2,
              max_ready_spares: 1,
              max_d1_resources: 1_000,
              daily_d1_create_budget: 20,
              lookup_target_active_route_count: 100_000,
              lookup_forecast_horizon_seconds: 86_400,
              lookup_registration_ewma_alpha_bps: 2_500,
              lookup_scale_out_headroom_bps: 2_000,
              lookup_scale_out_policy_generation: 1,
            },
          ],
        },
        {
          success: true,
          results: [
            {
              shard_id: 'core-1',
              data_role: 'tenant_core/users',
              target_account_count: 100_000,
            },
            { shard_id: 'pii-1', data_role: 'tenant_pii', target_account_count: 100_000 },
          ],
        },
      ],
    };

    await expect(
      preparePhase1Policy({ config: requested, client, execute: false })
    ).rejects.toThrow('phase1_prepare_policy_generation_not_next');
  });

  it('includes existing ready spares in the policy preparation plan', async () => {
    const client = {
      queryD1Batch: async () => [
        {
          success: true,
          results: [
            {
              environment_id: 'phase1-test',
              lifecycle_state: 'active',
              target_account_count: 100_000,
              max_concurrent_provisioning: 2,
              max_ready_spares: 1,
              max_d1_resources: 1_000,
              daily_d1_create_budget: 20,
              lookup_target_active_route_count: 100_000,
              lookup_forecast_horizon_seconds: 86_400,
              lookup_registration_ewma_alpha_bps: 2_500,
              lookup_scale_out_headroom_bps: 2_000,
              lookup_scale_out_policy_generation: 1,
            },
          ],
        },
        {
          success: true,
          results: [
            {
              shard_id: 'core-1',
              data_role: 'tenant_core/users',
              target_account_count: 100_000,
            },
            {
              shard_id: 'core-spare',
              data_role: 'tenant_core/users',
              target_account_count: 100_000,
            },
            { shard_id: 'pii-1', data_role: 'tenant_pii', target_account_count: 100_000 },
          ],
        },
      ],
    };

    const plan = await preparePhase1Policy({ config: config(), client, execute: false });
    expect(plan.previous.shardCapacities.map((row) => row.shard_id)).toEqual([
      'core-1',
      'core-spare',
      'pii-1',
    ]);
  });

  it('builds cleanup only from matching non-production completed evidence', () => {
    const baseline = evaluatePhase1Preflight({
      config: config(),
      control: snapshot(),
      provider: provider(),
      runId: 'run-cleanup',
      now: new Date(),
    });
    const summary = {
      schemaVersion: 1 as const,
      runId: 'run-cleanup',
      profile: 'custom' as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      passed: false,
      metrics: {
        scheduled: 1,
        attempts: 1,
        accepted201: 0,
        accepted202: 0,
        capacity503: 0,
        registryPropagation503: 0,
        bindingPropagation503: 0,
        server5xx: 0,
        retries: 0,
        terminalFailures: 1,
        eventualSuccessRate: 0,
        immediate201Rate: 0,
      },
      provisioning: {
        events: [],
        readyLatencyMs: {
          count: 0,
          minimum: null,
          p50: null,
          p95: null,
          maximum: null,
          mean: null,
        },
      },
      integrity: {} as Phase1IntegrityResult,
    };
    expect(
      buildPhase1CleanupPlan({
        baseline,
        summary,
        providerEvents: [
          {
            kind: 'provider_database_change',
            databaseUuid: 'added-db',
            previous: null,
            current: {},
          },
        ],
      })
    ).toMatchObject({
      runId: 'run-cleanup',
      environmentId: 'phase1-test',
      providerDatabaseIdsAddedDuringRun: ['added-db'],
    });
  });

  it('derives replay-stable identities while rejecting raw email evidence', () => {
    const left = deriveLogicalAccountIdentity({
      seed: 'private-seed',
      runId: 'run-a',
      accountIndex: 4,
      emailDomain: 'accounts.phase1.test.invalid',
    });
    const right = deriveLogicalAccountIdentity({
      seed: 'private-seed',
      runId: 'run-a',
      accountIndex: 4,
      emailDomain: 'accounts.phase1.test.invalid',
    });
    expect(left).toEqual(right);
    expect(left.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(left.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(() => assertPhase1EvidenceIsSecretFree({ email: left.email })).toThrow(
      'phase1_evidence_sensitive_key'
    );
    expect(() => assertPhase1EvidenceIsSecretFree({ value: `Bearer ${'x'.repeat(40)}` })).toThrow(
      'phase1_evidence_sensitive_value'
    );
    expect(() => assertPhase1EvidenceIsSecretFree({ emailDigest: left.emailDigest })).not.toThrow();
  });

  it('fails closed for production and writes only credential environment names', () => {
    const raw = JSON.parse(JSON.stringify(config())) as Record<string, unknown>;
    (raw.environment as Record<string, unknown>).environmentId = 'production';
    expect(() => parsePhase1HarnessConfig(raw)).toThrow('phase1_production_environment_rejected');
    const redacted = redactPhase1Config(config());
    expect(stableString(redacted)).not.toContain('private-seed');
    expect(() => assertPhase1EvidenceIsSecretFree(redacted)).not.toThrow();
  });

  it('creates a validation-only run without reading credentials', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'authrim-phase1-test-'));
    const result = await executePhase1Harness({
      config: config(),
      outputDirectory: directory,
      execute: false,
      environment: {},
      runId: 'phase1-validation-only',
    });
    expect(result.passed).toBeNull();
    const persisted: unknown = JSON.parse(
      await readFile(resolve(result.runDirectory, 'config.redacted.json'), 'utf8')
    );
    expect(() => assertPhase1EvidenceIsSecretFree(persisted)).not.toThrow();
  });

  it('rejects a run ID that could escape the evidence root', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'authrim-phase1-safe-path-'));
    await expect(
      executePhase1Harness({
        config: config(),
        outputDirectory: directory,
        execute: false,
        environment: {},
        runId: '../escaped',
      })
    ).rejects.toThrow('phase1_run_id_invalid');
  });

  it('runs the complete harness against independent fake Admin, Control, and D1 surfaces', async () => {
    const testConfig = config();
    const initial = snapshot();
    const final = structuredClone(initial);
    final.observedAt = '2026-08-27T00:00:10.000Z';
    for (const role of ['tenant_core/users', 'tenant_pii'] as const) {
      const prefix = role === 'tenant_core/users' ? 'core' : 'pii';
      const existing = final.shardCapacities.find((row) => row.shard_id === `${prefix}-1`);
      if (!existing) throw new Error('fixture_shard_missing');
      // Six rows belong to an existing tenant in the shared shard. Control capacity
      // counters and the integrity verifier must compare the physical shard total.
      existing.allocated_account_count = 7;
      existing.observed_account_count = 7;
      final.shardCapacities.push({
        shard_id: `${prefix}-2`,
        data_role: role,
        allocation_scope: 'shared_pool',
        status: 'active',
        target_account_count: 100,
        allocated_account_count: 1,
        observed_account_count: 1,
        health_status: 'healthy',
        allocation_status: 'eligible',
        d1_desired_resource_id: `${prefix}-desired-2`,
        deterministic_name: `${prefix}-2`,
        provider_resource_id: `${prefix}-db-2`,
      });
      final.tenantAssignments.push({
        data_role: role,
        assignment_state: 'active',
        assignment_generation: 2,
        shard_id: `${prefix}-2`,
      });
    }
    final.lookupShards.push({
      lookup_shard_id: 'lookup-2',
      status: 'active',
      capacity_weight: 1,
      d1_desired_resource_id: 'lookup-desired-2',
      deterministic_name: 'lookup-2',
      provider_resource_id: 'lookup-db-2',
    });
    for (const prefix of ['core', 'pii', 'lookup']) {
      final.desiredResources.push({
        desired_resource_id: `${prefix}-desired-2`,
        deterministic_name: `${prefix}-2`,
      });
      final.observedResources.push({
        observed_resource_id: `${prefix}-observed-2`,
        desired_resource_id: `${prefix}-desired-2`,
        provider_resource_id: `${prefix}-db-2`,
        observed_state: 'present',
      });
    }
    const migratedBucket = final.lookupAssignments.find((row) => row.virtual_bucket === 1);
    if (!migratedBucket) throw new Error('fixture_lookup_bucket_missing');
    migratedBucket.lookup_shard_id = 'lookup-2';
    migratedBucket.assignment_generation = 2;
    final.lookupForecasts.push({
      lookup_capacity_domain_id: 'lookup:default',
      decision_state: 'stable',
      decision_generation: 1,
      observed_at: 100,
      observed_active_route_count: 2,
      observed_successful_publication_count: 2,
      sample_interval_seconds: 0,
      sample_rate_microrows_per_second: 0,
      ewma_rate_microrows_per_second: 0,
      forecast_horizon_seconds: 300,
      forecast_new_route_count: 0,
      projected_active_route_count: 2,
      usable_capacity_route_count: 400,
      capacity_unit_count: 2,
    });
    final.tenantAllocations = [
      {
        row_kind: 'summary',
        data_role: null,
        selected_shard_id: null,
        reservation_state: null,
        allocation_count: 4,
        distinct_account_count: 2,
        invalid_state_count: 0,
        missing_capacity_count: 0,
        invalid_shard_count: 0,
        invalid_account_role_count: 0,
      },
      ...['tenant_core/users', 'tenant_pii'].flatMap((role) =>
        [1, 2].map((generation) => ({
          row_kind: 'distribution',
          data_role: role,
          selected_shard_id: `${role === 'tenant_core/users' ? 'core' : 'pii'}-${generation}`,
          reservation_state: 'committed',
          allocation_count: 1,
          distinct_account_count: 1,
          invalid_state_count: 0,
          missing_capacity_count: 0,
          invalid_shard_count: 0,
          invalid_account_role_count: 0,
        }))
      ),
    ];
    let controlBatchReads = 0;
    let providerReads = 0;
    const createdUsers = new Map<string, string>();
    const client = {
      async queryD1Batch(
        databaseId: string,
        batch: ReadonlyArray<{ sql: string; params?: unknown[] }>
      ) {
        if (databaseId === testConfig.environment.controlDatabaseId) {
          const assignmentPage =
            batch.length === 1 && batch[0]?.sql.includes('FROM control_lookup_bucket_assignments');
          const round = assignmentPage
            ? Math.max(0, Math.floor((controlBatchReads - 1) / 4))
            : Math.floor(controlBatchReads / 4);
          const current = round === 0 ? initial : final;
          if (assignmentPage) {
            const offset = Number(batch[0]?.params?.[2] ?? 0);
            return queryResult(current.lookupAssignments.slice(offset, offset + 1_024));
          }
          controlBatchReads += 1;
          const canonical = buildControlQueryBatch(testConfig);
          const fullResults = controlResults(current);
          return batch.map((statement) => {
            const index = canonical.findIndex((candidate) => candidate.sql === statement.sql);
            const result = fullResults[index];
            if (!result) throw new Error('fixture_control_query_missing');
            return result;
          });
        }
        return Promise.all(
          batch.map(async (statement) => {
            const results = await client.queryD1(databaseId, statement.sql, statement.params);
            const result = results[0];
            if (!result) throw new Error('fixture_batch_result_missing');
            return result;
          })
        );
      },
      async listD1Databases() {
        const baseline = provider().databases.map((database) => ({
          uuid: database.uuid,
          name: database.name,
          file_size: database.fileSize ?? undefined,
        }));
        if (providerReads++ === 0) return baseline;
        return [
          ...baseline,
          {
            uuid: 'core-db-2',
            name: 'phase1-test-authrim-tenant-users-core-2',
            file_size: 1,
          },
          { uuid: 'pii-db-2', name: 'phase1-test-authrim-tenant-pii-2', file_size: 1 },
          { uuid: 'lookup-db-2', name: 'phase1-test-authrim-tenant-lookup-2', file_size: 1 },
          { uuid: 'other-app-db', name: 'another-app-created-during-run', file_size: 1 },
        ];
      },
      async queryD1(databaseId: string, sql: string, params: unknown[] = []) {
        const userRows = [...createdUsers.values()].map((id, index) => ({
          id,
          tenant_id: 'tenant-test',
          databaseId: index === 0 ? 1 : 2,
        }));
        if (sql.includes('FROM identity_accounts account')) {
          const expected = databaseId === 'core-db' ? 1 : 2;
          return queryResult(
            userRows
              .filter((row) => row.databaseId === expected)
              .map((row) => ({
                ...row,
                email_verified: 1,
                phone_number_verified: 0,
                is_active: 1,
                user_type: 'end_user',
              }))
          );
        }
        if (sql.includes("MAX(CASE WHEN value_key = 'email'")) {
          const expected = databaseId === 'pii-db' ? 1 : 2;
          const emailById = new Map([...createdUsers.entries()].map(([email, id]) => [id, email]));
          return queryResult(
            userRows
              .filter((row) => row.databaseId === expected)
              .map((row) => {
                const email = emailById.get(row.id);
                if (!email) throw new Error('fixture_email_missing');
                return {
                  ...row,
                  email_json: JSON.stringify(email),
                  preferred_username_json: JSON.stringify(`phase1-${sha256(email).slice(0, 24)}`),
                };
              })
          );
        }
        if (sql.includes('FROM lookup_bucket_counters c')) {
          return queryResult(
            (params as number[]).map((virtualBucket) => {
              const onUsedTarget = databaseId === 'lookup-db-2' && virtualBucket === 1;
              const count = onUsedTarget ? createdUsers.size : 0;
              return {
                virtual_bucket: virtualBucket,
                successful_route_publication_count: count,
                active_route_count: count,
              };
            })
          );
        }
        if (
          sql.includes('COUNT(*) AS row_count FROM identity_accounts') ||
          sql.includes('COUNT(DISTINCT owner_id) AS row_count')
        ) {
          if (params.length !== 0 || sql.includes('WHERE tenant_id')) {
            throw new Error(`shared_shard_count_must_be_global:${databaseId}`);
          }
          return queryResult([{ row_count: databaseId.endsWith('-db') ? 7 : 1 }]);
        }
        if (sql.includes('FROM account_creation_operations')) {
          if (databaseId !== 'default-core-db') {
            throw new Error(`account_operations_wrong_role:${databaseId}`);
          }
          return queryResult(
            (params as string[]).map((id) => ({ account_id: `account-${id}`, status: 'succeeded' }))
          );
        }
        if (sql.includes('FROM account_routing_outbox')) {
          if (databaseId === 'default-core-db') {
            throw new Error(`routing_outbox_wrong_role:${databaseId}`);
          }
          return queryResult([]);
        }
        throw new Error(`unexpected_query:${databaseId}:${sql}`);
      },
    };
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'authrim-phase1-e2e-'));
    const execution = await executePhase1Harness({
      config: testConfig,
      outputDirectory,
      execute: true,
      environment: {
        AUTHRIM_PHASE1_ADMIN_TOKEN: 'private-admin-token',
        AUTHRIM_PHASE1_CLOUDFLARE_ACCOUNT_ID: 'account-id',
        AUTHRIM_PHASE1_D1_READ_TOKEN: 'private-d1-token',
        AUTHRIM_PHASE1_SEED: 'private-seed',
      },
      runId: 'phase1-fake-e2e',
      client,
      fetcher: async (url, init) => {
        const parsed =
          url instanceof URL ? url : typeof url === 'string' ? new URL(url) : new URL(url.url);
        if (init?.method === 'POST') {
          if (typeof init.body !== 'string') throw new Error('fixture_body_invalid');
          const body = JSON.parse(init.body) as { email: string };
          const id = `user-${createdUsers.size}`;
          createdUsers.set(body.email, id);
          return new Response(JSON.stringify({ user: { id } }), { status: 201 });
        }
        const email = parsed.searchParams.get('search') ?? '';
        const id = createdUsers.get(email);
        return new Response(JSON.stringify({ users: id ? [{ id }] : [] }), { status: 200 });
      },
    });
    expect(execution.passed).toBe(true);
    const summary: unknown = JSON.parse(
      await readFile(resolve(execution.runDirectory, 'summary.json'), 'utf8')
    );
    expect(summary).toMatchObject({ passed: true, metrics: { scheduled: 2 } });
    expect(() => assertPhase1EvidenceIsSecretFree(summary)).not.toThrow();
    await expect(
      readFile(resolve(execution.runDirectory, 'runner-checkpoint.json'), 'utf8')
    ).resolves.toContain('"accounts"');
    await expect(
      readFile(resolve(execution.runDirectory, 'timeline.svg'), 'utf8')
    ).resolves.toContain('<svg');
    await expect(
      readFile(resolve(execution.runDirectory, 'provisioning-evidence.json'), 'utf8')
    ).resolves.toContain('readyLatencyMs');
    await expect(
      readFile(resolve(execution.runDirectory, 'final-state.json'), 'utf8')
    ).resolves.toContain('lookupBuckets');
    await expect(
      readFile(resolve(execution.runDirectory, 'requests.jsonl'), 'utf8')
    ).resolves.toEqual(expect.any(String));
    await expect(
      readFile(resolve(execution.runDirectory, 'control-events.jsonl'), 'utf8')
    ).resolves.toEqual(expect.any(String));
    await expect(
      readFile(resolve(execution.runDirectory, 'provider-events.jsonl'), 'utf8')
    ).resolves.toEqual(expect.any(String));

    for (const artifact of [
      'integrity.json',
      'final-state.json',
      'summary.json',
      'summary.md',
      'timeline.svg',
      'provisioning-evidence.json',
      'cleanup.json',
    ]) {
      await rm(resolve(execution.runDirectory, artifact));
    }
    const postsBeforeResume = createdUsers.size;
    const resumed = await executePhase1Harness({
      config: testConfig,
      outputDirectory,
      execute: true,
      resumeRunDirectory: execution.runDirectory,
      environment: {
        AUTHRIM_PHASE1_ADMIN_TOKEN: 'private-admin-token',
        AUTHRIM_PHASE1_CLOUDFLARE_ACCOUNT_ID: 'account-id',
        AUTHRIM_PHASE1_D1_READ_TOKEN: 'private-d1-token',
        AUTHRIM_PHASE1_SEED: 'private-seed',
      },
      client,
      fetcher: async (url) => {
        const parsed =
          url instanceof URL ? url : typeof url === 'string' ? new URL(url) : new URL(url.url);
        const email = parsed.searchParams.get('search') ?? '';
        const id = createdUsers.get(email);
        return new Response(JSON.stringify({ users: id ? [{ id }] : [] }), { status: 200 });
      },
    });
    expect(resumed.passed).toBe(true);
    expect(createdUsers.size).toBe(postsBeforeResume);
  });
});

describe('Phase 1 runner', () => {
  it('retries terminal checkpoint entries while preserving successful accounts on resume', () => {
    const result = (overrides: Partial<Phase1AccountResult>): Phase1AccountResult => ({
      accountIndex: 0,
      emailDigest: 'email-digest',
      requestDigest: 'request-digest',
      userId: 'user-0',
      operationId: null,
      firstResponseStatus: 201,
      attempts: 1,
      retries: 0,
      capacity503: 0,
      terminalErrorCode: null,
      completedAt: '2026-08-28T00:00:00.000Z',
      ...overrides,
    });

    expect(
      phase1ResumeAccountIndices(4, [
        result({ accountIndex: 0 }),
        result({
          accountIndex: 1,
          userId: null,
          firstResponseStatus: 503,
          terminalErrorCode: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
        }),
        result({ accountIndex: 3 }),
      ])
    ).toEqual([1, 2]);
  });

  it('replays a capacity 503 with the exact same request and idempotency key', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const requests: Array<{ body: string; key: string }> = [];
    const responses = [
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }),
      new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 }),
    ];
    const events: unknown[] = [];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-replay',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        fetcher: async (_url, init) => {
          const headers = new Headers(init?.headers);
          if (typeof init?.body !== 'string') throw new Error('fixture_body_invalid');
          requests.push({ body: init.body, key: headers.get('Idempotency-Key') ?? '' });
          return responses.shift() ?? new Response(null, { status: 500 });
        },
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });
    expect(result.metrics).toMatchObject({ capacity503: 1, retries: 1, terminalFailures: 0 });
    expect(result.accounts[0]).toMatchObject({ userId: 'user-1', attempts: 2, retries: 1 });
    expect(requests[0]).toEqual(requests[1]);
    expect(() => assertPhase1EvidenceIsSecretFree(events)).not.toThrow();
  });

  it('replays a transient create 5xx with the exact same request and records it', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const requests: Array<{ body: string; key: string }> = [];
    const responses = [
      new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }),
      new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 }),
    ];
    const events: Phase1RequestEvent[] = [];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-server-5xx-replay',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        fetcher: async (_url, init) => {
          const headers = new Headers(init?.headers);
          if (typeof init?.body !== 'string') throw new Error('fixture_body_invalid');
          requests.push({ body: init.body, key: headers.get('Idempotency-Key') ?? '' });
          return responses.shift() ?? new Response(null, { status: 500 });
        },
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });

    expect(result.metrics).toMatchObject({
      capacity503: 0,
      registryPropagation503: 0,
      bindingPropagation503: 0,
      server5xx: 1,
      retries: 1,
      terminalFailures: 0,
    });
    expect(result.accounts[0]).toMatchObject({ userId: 'user-1', attempts: 2, retries: 1 });
    expect(requests[0]).toEqual(requests[1]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'server_5xx', status: 500 }));
    expect(() => assertPhase1EvidenceIsSecretFree(events)).not.toThrow();
  });

  it('records registry propagation 503 separately from unexpected server 5xx', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const responses = [
      new Response(JSON.stringify({ error: 'snapshot_generation_propagating' }), {
        status: 503,
        headers: { 'Retry-After': '1' },
      }),
      new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 }),
    ];
    const events: Phase1RequestEvent[] = [];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-registry-propagation-503-replay',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        fetcher: async () => responses.shift() ?? new Response(null, { status: 500 }),
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });

    expect(result.metrics).toMatchObject({
      capacity503: 0,
      registryPropagation503: 1,
      bindingPropagation503: 0,
      server5xx: 0,
      retries: 1,
      terminalFailures: 0,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'registry_propagation_503',
        status: 503,
        errorCode: 'snapshot_generation_propagating',
      })
    );
  });

  it('records runtime binding propagation 503 separately from unexpected server 5xx', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const responses = [
      new Response(JSON.stringify({ error: 'runtime_binding_propagating' }), {
        status: 503,
        headers: { 'Retry-After': '1' },
      }),
      new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 }),
    ];
    const events: Phase1RequestEvent[] = [];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-binding-propagation-503-replay',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        fetcher: async () => responses.shift() ?? new Response(null, { status: 500 }),
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });

    expect(result.metrics).toMatchObject({
      capacity503: 0,
      registryPropagation503: 0,
      bindingPropagation503: 1,
      server5xx: 0,
      retries: 1,
      terminalFailures: 0,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'binding_propagation_503',
        status: 503,
        errorCode: 'runtime_binding_propagating',
      })
    );
  });

  it('replays a fail-closed release status 503 with Retry-After and the same identity', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const requests: Array<{ body: string; key: string; at: number }> = [];
    const responses = [
      new Response(JSON.stringify({ error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE' }), {
        status: 503,
        headers: { 'Retry-After': '5' },
      }),
      new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 }),
    ];
    const events: Phase1RequestEvent[] = [];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-release-status-503-replay',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        fetcher: async (_url, init) => {
          const headers = new Headers(init?.headers);
          if (typeof init?.body !== 'string') throw new Error('fixture_body_invalid');
          requests.push({
            body: init.body,
            key: headers.get('Idempotency-Key') ?? '',
            at: now,
          });
          return responses.shift() ?? new Response(null, { status: 500 });
        },
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });

    expect(result.metrics).toMatchObject({
      capacity503: 1,
      registryPropagation503: 0,
      bindingPropagation503: 0,
      server5xx: 0,
      retries: 1,
      terminalFailures: 0,
    });
    expect(result.accounts[0]).toMatchObject({ userId: 'user-1', attempts: 2, retries: 1 });
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(requests[0]?.key).toBe(requests[1]?.key);
    expect((requests[1]?.at ?? 0) - (requests[0]?.at ?? 0)).toBe(5_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'capacity_503',
        status: 503,
        errorCode: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
      })
    );
  });

  it('applies Retry-After as a runner-wide capacity gate', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const startedAt = now;
    const requestTimes: number[] = [];
    const responses = [
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
        status: 503,
        headers: { 'Retry-After': '10' },
      }),
      new Response(JSON.stringify({ user: { id: 'user-2' } }), { status: 201 }),
      new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 }),
    ];

    const result = await runAccountCreation({
      config: config({ accountCount: 2, ratePerSecond: 2, maximumInFlight: 2 }),
      runId: 'run-capacity-gate',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 2,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        random: () => 0.5,
        fetcher: async () => {
          requestTimes.push(now - startedAt);
          return responses.shift() ?? new Response(null, { status: 500 });
        },
        writeEvent: async () => {},
      },
    });

    expect(result.metrics).toMatchObject({ capacity503: 1, terminalFailures: 0 });
    expect(requestTimes).toEqual([500, 500, 10_500]);
  });

  it('polls a valid 202 operation and records only a digest of its status path', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const events: Phase1RequestEvent[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          status: 'pending',
          operation_id: 'operation-1',
          status_url: '/api/admin/users/operations/operation-1',
        }),
        { status: 202 }
      ),
      new Response(JSON.stringify({ state: 'succeeded', user_id: 'user-1' }), { status: 200 }),
    ];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-pending',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetcher: async () => responses.shift() ?? new Response(null, { status: 500 }),
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });
    expect(result.metrics).toMatchObject({ accepted202: 1, retries: 1, terminalFailures: 0 });
    expect(result.accounts[0]).toMatchObject({ operationId: 'operation-1', userId: 'user-1' });
    const pending = events.find((event) => event.kind === 'accepted_202');
    expect(pending?.statusPathDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(stableString(events)).not.toContain('/api/admin/users/operations/operation-1');
  });

  it('classifies a named rollout 503 while polling as expected capacity retry', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const requests: Array<{ method: string; at: number }> = [];
    const events: Phase1RequestEvent[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          status: 'pending',
          operation_id: 'operation-rollout-retry',
          status_url: '/api/admin/users/operations/operation-rollout-retry',
        }),
        { status: 202 }
      ),
      new Response(JSON.stringify({ error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE' }), {
        status: 503,
        headers: { 'Retry-After': '5' },
      }),
      new Response(JSON.stringify({ state: 'succeeded', user_id: 'user-1' }), { status: 200 }),
    ];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-pending-rollout-retry',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetcher: async (_url, init) => {
          requests.push({ method: init?.method ?? 'GET', at: now });
          return responses.shift() ?? new Response(null, { status: 500 });
        },
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });

    expect(result.metrics).toMatchObject({
      accepted202: 1,
      capacity503: 1,
      server5xx: 0,
      retries: 2,
      terminalFailures: 0,
    });
    expect(result.accounts[0]).toMatchObject({ userId: 'user-1', attempts: 3, retries: 2 });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'GET']);
    expect((requests[2]?.at ?? 0) - (requests[1]?.at ?? 0)).toBe(5_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'capacity_503',
        status: 503,
        errorCode: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
      })
    );
  });

  it('preserves a named unexpected server error while polling', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const events: Phase1RequestEvent[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          status: 'pending',
          operation_id: 'operation-server-error',
          status_url: '/api/admin/users/operations/operation-server-error',
        }),
        { status: 202 }
      ),
      new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }),
      new Response(JSON.stringify({ state: 'succeeded', user_id: 'user-1' }), { status: 200 }),
    ];
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-pending-server-error',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetcher: async () => responses.shift() ?? new Response(null, { status: 500 }),
        writeEvent: async (event) => {
          events.push(event);
        },
      },
    });

    expect(result.metrics).toMatchObject({
      accepted202: 1,
      capacity503: 0,
      server5xx: 1,
      retries: 2,
      terminalFailures: 0,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'server_5xx',
        status: 503,
        errorCode: 'server_error',
      })
    );
  });

  it('periodically resumes a pending operation with the original request identity', async () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    let responseIndex = 0;
    const posts: Array<{ body: string; key: string }> = [];
    const pending = () =>
      new Response(JSON.stringify({ state: 'directory_pending' }), { status: 200 });
    const accepted = () =>
      new Response(
        JSON.stringify({
          status: 'pending',
          operation_id: 'operation-resume',
          status_url: '/api/admin/users/operations/operation-resume',
        }),
        { status: 202 }
      );
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-resume',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetcher: async (_url, init) => {
          const current = responseIndex++;
          if (init?.method === 'POST') {
            if (typeof init.body !== 'string') throw new Error('fixture_body_invalid');
            posts.push({
              body: init.body,
              key: new Headers(init.headers).get('Idempotency-Key') ?? '',
            });
            return accepted();
          }
          if (current <= 20) return pending();
          return new Response(JSON.stringify({ state: 'succeeded', user_id: 'user-resumed' }), {
            status: 200,
          });
        },
        writeEvent: async () => undefined,
      },
    });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(result.metrics.accepted202).toBe(1);
    expect(result.accounts[0]).toMatchObject({
      userId: 'user-resumed',
      operationId: 'operation-resume',
    });
  });

  it('treats a conflict as terminal instead of replacing the logical account', async () => {
    const result = await runAccountCreation({
      config: config({ accountCount: 1, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-conflict',
      seed: 'private-seed',
      adminToken: 'private-token',
      count: 1,
      dependencies: {
        fetcher: async () => new Response(JSON.stringify({ error: 'conflict' }), { status: 409 }),
        writeEvent: async () => undefined,
      },
    });
    expect(result.metrics).toMatchObject({ scheduled: 1, attempts: 1, terminalFailures: 1 });
    expect(result.accounts[0]).toMatchObject({ userId: null, terminalErrorCode: 'conflict' });
  });

  it('can schedule only missing account indices during process resume', async () => {
    const postedEmails: string[] = [];
    const result = await runAccountCreation({
      config: config({ accountCount: 3, ratePerSecond: 1, maximumInFlight: 1 }),
      runId: 'run-missing-index',
      seed: 'private-seed',
      adminToken: 'private-token',
      accountIndices: [1],
      dependencies: {
        fetcher: async (_url, init) => {
          if (typeof init?.body !== 'string') throw new Error('fixture_body_invalid');
          const body = JSON.parse(init.body) as { email: string };
          postedEmails.push(body.email);
          return new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 201 });
        },
        writeEvent: async () => undefined,
      },
    });
    expect(result.metrics.scheduled).toBe(1);
    expect(result.accounts.map((account) => account.accountIndex)).toEqual([1]);
    expect(postedEmails).toHaveLength(1);
  });
});

describe('Phase 1 observation, forecast, and report calculations', () => {
  it('records transient observation timeouts and continues instead of aborting the run', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'authrim-phase1-observer-'));
    const controlEventsPath = resolve(directory, 'control-events.jsonl');
    const providerEventsPath = resolve(directory, 'provider-events.jsonl');
    const controller = new AbortController();
    let sleeps = 0;
    try {
      const result = await observePhase1({
        config: config(),
        client: {
          queryD1Batch: async () => {
            throw new Error('Request timeout after 30000ms');
          },
          listD1Databases: async () => [],
        },
        initialControl: snapshot(),
        initialProvider: provider(),
        controlEventsPath,
        providerEventsPath,
        signal: controller.signal,
        sleep: async (_ms, signal) => {
          sleeps += 1;
          if (sleeps === 2) controller.abort();
          if (signal.aborted) throw new Error('aborted');
        },
      });

      expect(result.latestControl).toEqual(snapshot());
      expect(await readFile(controlEventsPath, 'utf8')).toContain(
        '"kind":"control_observation_retry"'
      );
      expect(phase1ObservationRetryCode(new Error('schema mismatch'))).toBeNull();
      expect(phase1ObservationRetryCode(new Error('cloudflare_d1_list_pagination_invalid'))).toBe(
        'cloudflare_inventory_pagination_inconsistent'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('tolerates a transient quiescence read timeout but still requires stable windows', async () => {
    let attempts = 0;
    let now = 0;
    const final = await waitForPhase1Quiescence({
      config: config(),
      client: {
        queryD1Batch: async () => [],
        listD1Databases: async () => [],
      },
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      collectControl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Request timeout after 30000ms');
        return snapshot();
      },
    });

    expect(final).toEqual(snapshot());
    expect(attempts).toBe(4);
  });

  it('does not declare quiescence before a Lookup assignment reaches a new shard', async () => {
    let attempts = 0;
    let now = 0;
    const initial = snapshot();
    const baseline = evaluatePhase1Preflight({
      config: config(),
      control: initial,
      provider: provider(),
      runId: 'run-lookup-transition-quiescence',
      now: new Date('2026-08-27T00:00:00.000Z'),
    });
    const transitioned = structuredClone(initial);
    transitioned.lookupShards.push({
      lookup_shard_id: 'lookup-2',
      status: 'active',
      capacity_weight: 1,
      d1_desired_resource_id: 'lookup-desired-2',
      deterministic_name: 'lookup-2',
      provider_resource_id: 'lookup-db-2',
    });
    transitioned.lookupAssignments[0] = {
      ...transitioned.lookupAssignments[0],
      lookup_shard_id: 'lookup-2',
      assignment_generation: 2,
    };

    const final = await waitForPhase1Quiescence({
      config: config(),
      client: {
        queryD1Batch: async () => [],
        listD1Databases: async () => [],
      },
      baseline,
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      collectControl: async () => {
        attempts += 1;
        return attempts === 1 ? initial : transitioned;
      },
    });

    expect(final).toEqual(transitioned);
    expect(attempts).toBe(4);
  });

  it('waits for a retryable runtime route refresh before exact Lookup verification', async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: 503,
          headers: { 'Retry-After': '1', 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ users: [{ id: 'user-1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await expect(
      waitForExactLookupRouteReadiness({
        config: config(),
        runId: 'phase1-readiness',
        seed: 'readiness-seed',
        account: {
          accountIndex: 1,
          emailDigest: 'a'.repeat(64),
          requestDigest: 'b'.repeat(64),
          userId: 'user-1',
          operationId: null,
          firstResponseStatus: 503,
          attempts: 2,
          retries: 1,
          capacity503: 1,
          terminalErrorCode: null,
          completedAt: '2026-01-01T00:00:00.000Z',
        },
        getToken: async () => 'token',
        fetcher,
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('includes baseline Lookup routes when budgeting predicted D1 additions', () => {
    const control = snapshot();
    control.lookupForecasts.push({
      lookup_capacity_domain_id: 'lookup:default',
      observed_active_route_count: 1_000,
      projected_active_route_count: 1_000,
    });

    const baseline = evaluatePhase1Preflight({
      config: config(),
      control,
      provider: provider(),
      runId: 'run-existing-lookup-routes',
      now: new Date(),
    });

    expect(baseline.preflight.expectedMinimumD1Creates).toBe(13);
    expect(
      baseline.preflight.checks.find(
        (check) => check.name === 'lookup_addition_acceptance_reachable'
      )?.detail
    ).toBe('11:1');
  });

  it('fails preflight when lookup forecast additions cannot reach acceptance', () => {
    const impossible = config();
    impossible.expectedPolicy.minimumLookupAdditions = 100;
    const baseline = evaluatePhase1Preflight({
      config: impossible,
      control: snapshot(),
      provider: provider(),
      runId: 'run-a',
      now: new Date('2026-08-27T00:01:00.000Z'),
    });
    expect(baseline.preflight.passed).toBe(false);
    expect(
      baseline.preflight.checks.find(
        (check) => check.name === 'lookup_addition_acceptance_reachable'
      )?.passed
    ).toBe(false);
  });

  it('does not report automatic route observations or baseline operations as manual work', () => {
    const control = snapshot();
    control.operations.push({
      operation_id: 'existing-admin-operation',
      requested_by_type: 'admin',
      idempotency_key: 'operator-before-baseline',
      created_at: 1_787_785_100,
      status: 'running',
    });
    const baseline = evaluatePhase1Preflight({
      config: config(),
      control,
      provider: provider(),
      runId: 'run-manual-classification',
      now: new Date('2026-08-27T00:20:00.000Z'),
    });
    const finalControl = structuredClone(control);
    finalControl.operations[0].status = 'succeeded';
    finalControl.operations.push(
      {
        operation_id: 'automatic-route-observation',
        requested_by_type: 'admin',
        idempotency_key: 'tenant-runtime-route:observation-1',
        created_at: 1_787_790_100,
        status: 'succeeded',
      },
      {
        operation_id: 'operator-during-run',
        requested_by_type: 'setup',
        idempotency_key: 'setup-deploy-during-run',
        created_at: 1_787_790_200,
        status: 'succeeded',
      }
    );

    expect(countManualInterventions({ baseline, finalControl })).toBe(1);
  });

  it('emits stable control/provider changes and detects role boundaries', () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.observedAt = '2026-08-27T00:00:05.000Z';
    after.tenantAssignments.push({
      data_role: 'tenant_core/users',
      assignment_state: 'active',
      assignment_generation: 2,
      shard_id: 'core-2',
    });
    expect(diffControlSnapshots(before, after)).toEqual([
      expect.objectContaining({ entity: 'tenantAssignments', key: 'tenant_core/users:2:core-2' }),
    ]);
    expect(countRoleBoundaryCrossings(before, after, 'tenant_core/users')).toBe(1);
    const providerAfter = provider();
    providerAfter.databases.push({ uuid: 'new-db', name: 'new', createdAt: null, fileSize: 0 });
    expect(diffProviderSnapshots(provider(), providerAfter)).toEqual([
      expect.objectContaining({ databaseUuid: 'new-db', previous: null }),
    ]);
  });

  it('waits only for operations that can still progress', () => {
    const control = snapshot();
    control.operations = [
      { operation_id: 'old-blocked', status: 'blocked' },
      { operation_id: 'done', status: 'succeeded' },
      { operation_id: 'canceled', status: 'canceled' },
    ];
    expect(countInProgressControlOperations(control)).toBe(0);
    control.operations.push({ operation_id: 'retrying', status: 'waiting_retry' });
    expect(countInProgressControlOperations(control)).toBe(1);
  });

  it('recomputes integer EWMA/forecast and reconciles monotonic counters', () => {
    const previous = {
      observed_at: 100,
      observed_successful_publication_count: 100,
      ewma_rate_microrows_per_second: 0,
    };
    const current = {
      observed_at: 110,
      observed_active_route_count: 120,
      observed_successful_publication_count: 120,
      sample_interval_seconds: 10,
      sample_rate_microrows_per_second: 2_000_000,
      ewma_rate_microrows_per_second: 500_000,
      forecast_new_route_count: 150,
      projected_active_route_count: 270,
      usable_capacity_route_count: 80,
      capacity_unit_count: 1,
    };
    expect(
      recomputeLookupForecastTransition({
        previous,
        current,
        policy: {
          lookup_forecast_horizon_seconds: 300,
          lookup_registration_ewma_alpha_bps: 2_500,
          lookup_scale_out_headroom_bps: 2_000,
          lookup_target_active_route_count: 100,
        },
        capacityWeightMilliunits: 1_000,
      })
    ).toBe(true);
    expect(
      reconcilePublicationCounterSeries({
        observations: [
          { at: 100, counter: 10, successfulEventIds: [] },
          { at: 110, counter: 12, successfulEventIds: ['a', 'b'] },
          { at: 120, counter: 11, successfulEventIds: ['b', 'b'] },
        ],
      })
    ).toEqual({ decreases: 1, deltaMismatches: 1, duplicateEventIds: 1 });
  });

  it('ignores state-only and observer-gap forecast events while rejecting time regressions', () => {
    const previous = {
      lookup_capacity_domain_id: 'lookup:default',
      observed_at: 100,
      observed_successful_publication_count: 10,
      capacity_unit_count: 1,
    };
    const event = (observedAt: number, sampleInterval: number) => ({
      entity: 'lookupForecasts',
      previous,
      current: {
        ...previous,
        observed_at: observedAt,
        sample_interval_seconds: sampleInterval,
      },
    });
    expect(
      verifyLookupForecastEvents({
        events: [event(100, 10), event(130, 10)],
        policy: {},
      })
    ).toBe(0);
    expect(
      verifyLookupForecastEvents({
        events: [event(99, 10)],
        policy: {},
      })
    ).toBe(1);
  });

  it('normalizes Control operation timestamps expressed in seconds or milliseconds', () => {
    expect(normalizePhase1EpochSeconds(1_787_770_581)).toBe(1_787_770_581);
    expect(normalizePhase1EpochSeconds(1_787_770_581_899)).toBe(1_787_770_581);
    expect(normalizePhase1EpochSeconds('1787770581899')).toBeNull();
  });

  it('detects duplicate forecast idempotency and produces deterministic headline metrics', () => {
    const current = snapshot();
    current.operations = [
      { operation_id: 'a', idempotency_key: 'lookup-forecast:domain:1:1' },
      { operation_id: 'b', idempotency_key: 'lookup-forecast:domain:1:1' },
    ];
    expect(duplicateForecastDecisions(current)).toBe(1);
    const integrity: Phase1IntegrityResult = {
      schemaVersion: 1,
      runId: 'run-report',
      verifiedAt: '2026-08-27T00:01:00.000Z',
      submittedAccounts: 2,
      succeededAccounts: 2,
      uniqueUserIds: 2,
      terminalFailures: 0,
      lostAccounts: 0,
      duplicateCoreAccounts: 0,
      duplicatePiiAccounts: 0,
      lookupRouteMismatches: 0,
      crossTenantWrites: 0,
      orphanD1Resources: 0,
      resourceMappingMismatches: 0,
      pendingAccountOperations: 0,
      pendingRoutingOutbox: 0,
      blockedCapacityOperations: 0,
      duplicateProvisioningDecisions: 0,
      publicationCounterDecreases: 0,
      publicationCounterDeltaMismatches: 0,
      lookupForecastMismatches: 0,
      controlPhysicalCountMismatches: 0,
      allocationMismatches: 0,
      fieldLevelMismatches: 0,
      coreBoundaryCrossings: 1,
      piiBoundaryCrossings: 1,
      corePhysicalAdditions: 1,
      piiPhysicalAdditions: 1,
      excessCoreProvisioning: 0,
      excessPiiProvisioning: 0,
      lookupPhysicalAdditions: 1,
      lookupUsedAssignmentTransitions: 1,
      provisionedD1Resources: 3,
      manualIntervention: 0,
      checks: [{ name: 'all', passed: true, detail: 'ok' }],
      passed: true,
    };
    const report = buildPhase1Report({
      config: config(),
      runId: 'run-report',
      integrity,
      runner: {
        startedAt: '2026-08-27T00:00:00.000Z',
        finishedAt: '2026-08-27T00:01:00.000Z',
        accounts: [result(0, 201), result(1, 201)],
        metrics: {
          scheduled: 2,
          attempts: 2,
          accepted201: 2,
          accepted202: 0,
          capacity503: 0,
          registryPropagation503: 0,
          bindingPropagation503: 0,
          server5xx: 0,
          retries: 0,
          terminalFailures: 0,
        },
      },
    });
    expect(report.summary).toMatchObject({ passed: true, metrics: { immediate201Rate: 1 } });
    expect(report.markdown).toContain('Account creation eventual success | 100.000%');
  });

  it('records forecast-at-decision and decision-to-ready timing for public evidence', () => {
    const baseline = evaluatePhase1Preflight({
      config: config(),
      control: snapshot(),
      provider: provider(),
      runId: 'run-provisioning-evidence',
      now: new Date('2026-08-27T00:00:00.000Z'),
    });
    const desired = {
      desired_resource_id: 'desired-lookup-new',
      resource_kind: 'd1',
      deterministic_name: 'scaleout-authrim-tenant-lookup-default-db-new',
      origin_operation_id: 'operation-lookup-new',
      created_at: 1_787_770_000,
      updated_at: 1_787_770_000,
      provisioning_state: 'requested',
    };
    const evidence = buildPhase1ProvisioningEvidence({
      baseline,
      finalControl: {
        ...snapshot(),
        desiredResources: [
          ...snapshot().desiredResources,
          {
            ...desired,
            provisioning_state: 'ready',
            updated_at: 1_787_770_008,
          },
        ],
      },
      controlEvents: [
        {
          entity: 'lookupForecasts',
          observedAt: '2026-08-27T00:00:00.000Z',
          current: {
            requested_operation_id: 'operation-lookup-new',
            decision_generation: 4,
            observed_active_route_count: 90,
            observed_successful_publication_count: 120,
            sample_rate_microrows_per_second: 2_000_000,
            ewma_rate_microrows_per_second: 500_000,
            forecast_horizon_seconds: 300,
            forecast_new_route_count: 150,
            projected_active_route_count: 240,
            usable_capacity_route_count: 100,
          },
        },
        {
          entity: 'desiredResources',
          observedAt: '2026-08-27T00:00:01.000Z',
          current: desired,
        },
      ],
    });
    expect(evidence.readyLatencyMs).toMatchObject({
      count: 1,
      minimum: 8_000,
      p50: 8_000,
      p95: 8_000,
      maximum: 8_000,
    });
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0]).toMatchObject({
      desiredResourceId: 'desired-lookup-new',
      dataRole: 'lookup',
      decisionToReadyMs: 8_000,
      timingSource: 'control_state',
    });
    expect(evidence.events[0]?.lookupForecast).toMatchObject({
      forecastNewRouteCount: 150,
      projectedActiveRouteCount: 240,
      usableCapacityRouteCount: 100,
    });
  });

  it('detects Core/PII over-provisioning beyond required capacity and ready spares', () => {
    const baseline = snapshot();
    const baselineCore = baseline.shardCapacities.find(
      (row) => row.data_role === 'tenant_core/users'
    );
    if (!baselineCore) throw new Error('expected_core_shard');
    baselineCore.owner_tenant_id = null;
    baselineCore.allocated_account_count = 90;
    const current = structuredClone(baseline);
    current.shardCapacities.push(
      ...[2, 3, 4].map((generation) => ({
        ...structuredClone(baselineCore),
        shard_id: `core-${generation}`,
        d1_desired_resource_id: `core-desired-${generation}`,
        provider_resource_id: `core-db-${generation}`,
        deterministic_name: `core-${generation}`,
        allocated_account_count: 0,
      }))
    );

    expect(
      evaluateRoleProvisioningBound({
        baseline,
        current,
        config: config({ accountCount: 20 }),
        role: 'tenant_core/users',
        submittedAccounts: 20,
      })
    ).toEqual({ physicalAdditions: 3, maximumAdditions: 2, excessProvisioning: 1 });
  });

  it('ignores historical blocked operations when checking run capacity convergence', () => {
    const baseline = snapshot();
    baseline.operations = [
      {
        operation_id: 'historical-setup',
        operation_kind: 'setup_worker_deployment',
        status: 'blocked',
      },
    ];
    const current = snapshot();
    current.operations = [
      ...baseline.operations,
      {
        operation_id: 'new-capacity',
        operation_kind: 'provision_shard',
        status: 'waiting_retry',
      },
      {
        operation_id: 'new-unrelated',
        operation_kind: 'release_update',
        status: 'blocked',
      },
    ];

    expect(countNewBlockedCapacityOperations(baseline, current)).toBe(1);
    current.operations[1] = { ...current.operations[1], status: 'succeeded' };
    expect(countNewBlockedCapacityOperations(baseline, current)).toBe(0);
  });

  it('keeps immediate 201 as informational while raw server 5xx remains failing', () => {
    const integrity = {
      schemaVersion: 1 as const,
      runId: 'run-informational-immediate',
      verifiedAt: '2026-08-27T00:01:00.000Z',
      submittedAccounts: 1,
      succeededAccounts: 1,
      uniqueUserIds: 1,
      terminalFailures: 0,
      lostAccounts: 0,
      duplicateCoreAccounts: 0,
      duplicatePiiAccounts: 0,
      lookupRouteMismatches: 0,
      crossTenantWrites: 0,
      orphanD1Resources: 0,
      resourceMappingMismatches: 0,
      pendingAccountOperations: 0,
      pendingRoutingOutbox: 0,
      blockedCapacityOperations: 0,
      duplicateProvisioningDecisions: 0,
      publicationCounterDecreases: 0,
      publicationCounterDeltaMismatches: 0,
      lookupForecastMismatches: 0,
      controlPhysicalCountMismatches: 0,
      allocationMismatches: 0,
      fieldLevelMismatches: 0,
      coreBoundaryCrossings: 1,
      piiBoundaryCrossings: 1,
      corePhysicalAdditions: 1,
      piiPhysicalAdditions: 1,
      excessCoreProvisioning: 0,
      excessPiiProvisioning: 0,
      lookupPhysicalAdditions: 1,
      lookupUsedAssignmentTransitions: 1,
      provisionedD1Resources: 3,
      manualIntervention: 0,
      checks: [{ name: 'all', passed: true, detail: 'ok' }],
      passed: true,
    } satisfies Phase1IntegrityResult;
    const report = buildPhase1Report({
      config: config(),
      runId: integrity.runId,
      integrity,
      runner: {
        startedAt: '2026-08-27T00:00:00.000Z',
        finishedAt: '2026-08-27T00:01:00.000Z',
        accounts: [{ ...result(0, 503), attempts: 2, retries: 1, capacity503: 1 }],
        metrics: {
          scheduled: 1,
          attempts: 2,
          accepted201: 1,
          accepted202: 0,
          capacity503: 1,
          registryPropagation503: 0,
          bindingPropagation503: 0,
          server5xx: 0,
          retries: 1,
          terminalFailures: 0,
        },
      },
    });

    expect(report.summary).toMatchObject({ passed: true, metrics: { immediate201Rate: 0 } });
  });
});

function stableString(value: unknown): string {
  return JSON.stringify(value);
}

function result(accountIndex: number, firstResponseStatus: number) {
  return {
    accountIndex,
    emailDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    userId: `user-${accountIndex}`,
    operationId: null,
    firstResponseStatus,
    attempts: 1,
    retries: 0,
    capacity503: 0,
    terminalErrorCode: null,
    completedAt: '2026-08-27T00:00:01.000Z',
  };
}

function queryResult(rows: Record<string, unknown>[]) {
  return [{ success: true, results: rows }];
}

function controlResults(value: Phase1ControlSnapshot) {
  return [
    queryResult([{ ...value.environment, ...value.resourcePolicy }])[0],
    queryResult(value.tenantPolicy ? [value.tenantPolicy] : [])[0],
    queryResult(value.residencyPartitions)[0],
    queryResult(value.shardCapacities)[0],
    queryResult(value.tenantAssignments)[0],
    queryResult(value.operations)[0],
    queryResult(value.operationSteps)[0],
    queryResult(value.desiredResources)[0],
    queryResult(value.observedResources)[0],
    queryResult(value.lookupForecasts)[0],
    queryResult(value.lookupShards)[0],
    queryResult(value.lookupAssignments)[0],
    queryResult(value.workerBindingDrift)[0],
    queryResult(value.tenantAllocations)[0],
    queryResult(value.accountForecasts)[0],
  ];
}
